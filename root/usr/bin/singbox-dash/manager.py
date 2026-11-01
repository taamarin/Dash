#!/usr/bin/python3
"""singbox-dash backend.

Every destructive configuration or kernel operation is staged, validated,
journaled and rolled back when the post-change health check fails.
"""

import base64
import contextlib
import copy
import gzip
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid

try:
    import yaml
except ImportError:
    yaml = None

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from sbdlib.capabilities import CapabilityMixin  # noqa: E402
from sbdlib.common import (  # noqa: E402
    MAX_CONFIG, Failure, append_error_log, atomic, clean_error, digest, file_digest,
    read_json, write_json,
)
from sbdlib.diagnostics import DiagnosticsMixin  # noqa: E402
from sbdlib.providers import ProviderMixin  # noqa: E402
from sbdlib.releases import ReleaseMixin  # noqa: E402


APP = 'singbox-dash'
VERSION = '1.0.4'
CORE_SOURCES = {
    'michongs': {'repo': 'MiChongs/sing-box', 'label': 'MiChongs'},
    'ref1nd': {'repo': 'reF1nd/sing-box-releases', 'label': 'reF1nd'},
}
REPO = CORE_SOURCES['michongs']['repo']
MODES = ('ebpf', 'tun', 'tproxy', 'redirect')
MODE_VARIANTS = {'ebpf': 'socket_assign', 'ebpf_cgroup': 'cgroup'}
SELECTABLE_MODES = MODES + ('ebpf_cgroup',)
TERMINAL = {'done', 'failed', 'rolled_back', 'rollback_failed', 'cancelled'}
MAX_KERNEL = 160 * 1024 * 1024
UPLOAD_PREFIXES = ('/tmp/singbox-dash-',)
UPLOAD_ROOT = Path(os.environ.get('SBD_UPLOAD_DIR', '/tmp'))
MAX_UPLOAD_CHUNK = 1024 * 1024
CONFIG_BACKUP_LIMIT = 10
KERNEL_BACKUP_LIMIT = 10
UPLOAD_SESSION_TTL = 15 * 60
ACTIVE_FILE = '.dash-active.json'

# Optional fields introduced by the 1.15 testing line.  They are safe to omit
# when a stable 1.14 kernel is selected, while removing them preserves the
# routing and proxy semantics of the rest of the configuration.
CORE_115_ONLY_OPTIONAL_KEYS = frozenset({
    'tcp_concurrent', 'resolve_on_detour', 'udp_gso', 'buffer_size',
    'flush_interval', 'bypass_exclude', 'default_interface',
    'client_certificate_sha256', 'certificate_sha256', 'query_server_name'
})
# Fields from the stable schema that are no longer accepted by 1.15.
CORE_115_REMOVED_KEYS = frozenset({'rdrc_timeout', 'stack'})
CORE_FAMILY_OPTIONAL_KEYS = {
    # reF1nd 1.15 added this optional QUIC tuning field; MiChongs does not
    # expose the same field. It is safe to omit when switching field sets.
    'michongs': frozenset({'h3_congestion_control'}),
}




class CoreLoader(getattr(yaml, 'SafeLoader', object)):
    pass


if yaml is not None:
    # YAML 1.2-like booleans; never create timestamps or arbitrary objects.
    CoreLoader.yaml_implicit_resolvers = {
        k: [(tag, pattern) for tag, pattern in values
            if tag not in ('tag:yaml.org,2002:bool', 'tag:yaml.org,2002:timestamp')]
        for k, values in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }
    CoreLoader.add_implicit_resolver(
        'tag:yaml.org,2002:bool',
        re.compile(r'^(?:true|false|True|False|TRUE|FALSE)$'), list('tTfF'))



















class Manager(CapabilityMixin, DiagnosticsMixin, ProviderMixin, ReleaseMixin):
    def __init__(self, root='/'):
        self.root = Path(root)
        self.conf = self.root / 'etc/sing-box'
        self.uci_file = self.root / 'etc/config/singbox-dash'
        self.state = self.conf / '.dash-state'
        self.jobs = self.state / 'jobs'
        self.backups = self.state / 'backups'
        self.kernel_backups = self.state / 'kernel-backups'
        self.upload_sessions = self.state / 'uploads'
        self.bin = Path(os.environ.get('SBD_SINGBOX_BIN', str(self.root / 'usr/bin/sing-box')))
        self.helper_dir = self.root / 'usr/bin/singbox-dash'
        self.mode_helper = self.helper_dir / 'mode.sh'
        self.core_helper = self.helper_dir / 'core.sh'
        self.job_init = self.root / 'etc/init.d/singbox-dash-job'
        self.core_init = self.root / 'etc/init.d/sing-box'
        self.fallback_core_init = self.root / 'etc/init.d/singbox-dash-core'
        self.env = os.environ.copy()
        self.env.setdefault('PATH', '/usr/sbin:/usr/bin:/sbin:/bin')
        self.env['SINGBOX_DASH_ROOT'] = str(self.root)
        for folder in (self.state, self.jobs, self.backups, self.kernel_backups,
                       self.upload_sessions):
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                os.chmod(folder, 0o700)
            except OSError:
                pass

    def run(self, args, timeout=40, check=True, input_data=None, env=None):
        try:
            result = subprocess.run(
                [str(x) for x in args], input=input_data, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=timeout, env=env or self.env)
        except subprocess.TimeoutExpired as exc:
            raise Failure('操作超时：' + Path(str(args[0])).name) from exc
        except OSError as exc:
            raise Failure('无法运行：' + Path(str(args[0])).name + '：' + clean_error(exc)) from exc
        if check and result.returncode:
            message = (result.stderr or result.stdout).decode('utf-8', 'replace')
            raise Failure(clean_error(message) or ('命令失败：' + Path(str(args[0])).name))
        return result

    def cache_get(self, name, key=None, max_age=None):
        value = read_json(self.state / name, {})
        if not isinstance(value, dict):
            return None
        if key is not None and value.get('key') != key:
            return None
        if max_age is not None:
            try:
                if int(time.time()) - int(value.get('time') or 0) > max_age:
                    return None
            except (TypeError, ValueError):
                return None
        return value.get('value')

    def cache_set(self, name, key, value):
        try:
            write_json(self.state / name, {
                'time': int(time.time()), 'key': key, 'value': value
            })
        except OSError:
            pass

    def binary_key(self, executable=None):
        path = Path(executable or self.bin)
        stat_result = path.stat()
        return {'path': str(path), 'mtime_ns': stat_result.st_mtime_ns,
                'size': stat_result.st_size}

    def file_signature(self, path):
        try:
            item = Path(path).stat()
            return {'mtime_ns': item.st_mtime_ns, 'size': item.st_size,
                    'ino': item.st_ino, 'ctime_ns': item.st_ctime_ns}
        except OSError:
            return {'mtime_ns': 0, 'size': 0, 'ino': 0, 'ctime_ns': 0}

    def binary_revision(self):
        try:
            stat_result = self.bin.stat()
            return '%x-%x' % (stat_result.st_size, stat_result.st_mtime_ns)
        except OSError:
            return ''

    def rc_enabled(self, service):
        try:
            return any(item.name.startswith('S') and item.name.endswith(service)
                       for item in (self.root / 'etc/rc.d').iterdir())
        except OSError:
            return False

    def uci_get(self, option, default=''):
        result = self.run(['uci', '-q', 'get', 'singbox-dash.main.' + option],
                          timeout=8, check=False)
        value = result.stdout.decode('utf-8', 'replace').strip()
        return value if value else default

    def uci_set(self, option, value):
        self.run(['uci', 'set', 'singbox-dash.main.%s=%s' % (option, value)], timeout=8)
        self.run(['uci', 'commit', 'singbox-dash'], timeout=8)

    @contextlib.contextmanager
    def lock(self, name='operation'):
        path = self.state / (name + '.lock')
        with open(path, 'a+') as stream:
            try:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except ImportError:
                pass
            except BlockingIOError as exc:
                raise Failure('另一个操作正在进行，请等待完成') from exc
            yield

    def parse(self, data, require_object=True):
        if isinstance(data, bytes):
            try:
                text = data.decode('utf-8')
            except UnicodeDecodeError as exc:
                raise Failure('配置不是 UTF-8 文本') from exc
        else:
            text = str(data)
        if not text.strip():
            raise Failure('配置为空')
        try:
            value = json.loads(text)
        except ValueError:
            if yaml is None:
                raise Failure('缺少 PyYAML，无法解析 YAML 配置')
            try:
                value = yaml.load(text, Loader=CoreLoader)
            except Exception as exc:
                raise Failure('配置语法错误：' + clean_error(exc)) from exc
        if require_object and (not isinstance(value, dict) or not value):
            raise Failure('配置根节点必须是非空对象')
        return value

    def serialize(self, obj, original=b''):
        if original.lstrip().startswith(b'{'):
            return (json.dumps(obj, ensure_ascii=False, indent=2) + '\n').encode()
        if yaml is None:
            raise Failure('缺少 PyYAML，无法写入 YAML 配置')
        return yaml.safe_dump(obj, allow_unicode=True, sort_keys=False,
                              default_flow_style=False, width=4096).encode()

    def validate(self, data, executable=None):
        config = self.parse(data)
        executable = Path(executable or self.bin)
        if not executable.exists():
            raise Failure('内核文件不存在')
        with tempfile.NamedTemporaryFile(prefix='.dash-check-', dir=self.state,
                                         delete=False) as stream:
            stream.write(data if isinstance(data, bytes) else data.encode())
            temp = Path(stream.name)
        try:
            os.chmod(temp, 0o600)
            try:
                self.run([executable, 'check', '-c', temp, '-D', self.conf], timeout=16)
            except Failure as exc:
                if str(exc).startswith('操作超时：'):
                    raise Failure('sing-box 配置检查超过 16 秒，请到“诊断工具 → 运行日志”查看具体错误') from exc
                raise Failure(self.explain_config_error(str(exc))) from exc
        finally:
            temp.unlink(missing_ok=True)
        return config

    def slot_names(self):
        names = []
        for name in ('config.yaml', 'config2.json', 'config3.json'):
            if (self.conf / name).is_file():
                names.append(name)
        try:
            for path in sorted(self.conf.iterdir(), key=lambda p: p.name.lower()):
                if (path.is_file() and not path.is_symlink()
                        and not path.name.startswith('.')
                        and path.suffix.lower() in ('.yaml', '.yml', '.json')
                        and path.stat().st_size <= MAX_CONFIG):
                    if path.name not in names:
                        names.append(path.name)
        except OSError:
            pass
        return names

    def target(self, name):
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,80}\.(?:ya?ml|json)', name):
            raise Failure('配置文件名不合法')
        path = self.conf / name
        if path.parent != self.conf or path.is_symlink():
            raise Failure('配置路径不合法')
        return path

    def active(self, pid=None):
        if pid is None:
            pid = self.primary_pid()
        if pid:
            try:
                args = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
                for index, arg in enumerate(args[:-1]):
                    if arg == b'-c' and index + 1 < len(args):
                        value = args[index + 1].decode('utf-8', 'replace')
                        path = Path(value)
                        if path.is_file() and path.parent == self.conf:
                            return path
            except OSError:
                pass
        result = self.run(['uci', '-q', 'get', 'sing-box.main.conffile'], timeout=8, check=False)
        value = result.stdout.decode('utf-8', 'replace').strip()
        if value:
            path = Path(value)
            if path.parent == self.conf and path.is_file() and not path.is_symlink():
                return path
        default = self.conf / 'config.yaml'
        return default

    def all_pids(self):
        result = self.run(['pidof', 'sing-box'], timeout=5, check=False)
        return [int(v) for v in result.stdout.decode('ascii', 'replace').split() if v.isdigit()]

    def pid_config(self, pid):
        try:
            args = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
            values = [item.decode('utf-8', 'replace') for item in args if item]
        except OSError:
            return None
        for index, value in enumerate(values[:-1]):
            if value == '-c':
                return Path(values[index + 1])
        return None

    def configured_active(self):
        value = self.uci_get('conffile', '')
        if value:
            path = Path(value)
            if path.parent == self.conf and path.is_file() and not path.is_symlink():
                return path
        return self.conf / 'config.yaml'

    def pids(self):
        active = self.configured_active()
        try:
            active_path = active.resolve()
        except OSError:
            active_path = active
        managed = []
        fallback = []
        for pid in self.all_pids():
            config = self.pid_config(pid)
            if config is not None:
                try:
                    if config.resolve() == active_path:
                        managed.append(pid)
                except OSError:
                    if config == active:
                        managed.append(pid)
                continue
            try:
                if Path('/proc/%d/exe' % pid).resolve() == self.bin.resolve():
                    fallback.append(pid)
            except OSError:
                pass
        return managed if managed else fallback

    def primary_pid(self):
        values = self.pids()
        return values[0] if values else None

    def external_pids(self):
        managed = set(self.pids())
        return [pid for pid in self.all_pids() if pid not in managed]

    def process_running(self):
        # pids() already verifies that the process uses the current config (or,
        # as a fallback, the managed binary).  Comparing /proc/PID/exe again is
        # brittle: distributions may expose /usr/sbin/sing-box while the
        # dashboard manages /usr/bin/sing-box, or the executable may be bind
        # mounted.  Keep the detailed exe_match flag for diagnostics, but use
        # process liveness for health checks.
        for pid in self.pids():
            try:
                Path('/proc/%d/stat' % pid).read_text()
                return True
            except OSError:
                continue
        return False

    def process_meta(self, pid):
        if not pid:
            return {'uptime': 0, 'rss_kb': 0, 'exe_match': False}
        uptime = 0
        try:
            ticks = os.sysconf('SC_CLK_TCK')
            fields = (Path('/proc') / str(pid) / 'stat').read_text().split()
            start = int(fields[21]) / ticks
            boot = float(Path('/proc/uptime').read_text().split()[0])
            uptime = max(0, int(boot - start))
        except (OSError, ValueError, IndexError):
            pass
        rss = 0
        try:
            for line in (Path('/proc') / str(pid) / 'status').read_text().splitlines():
                if line.startswith('VmRSS:'):
                    rss = int(line.split()[1])
                    break
        except (OSError, ValueError):
            pass
        match = False
        try:
            match = Path('/proc/%d/exe' % pid).resolve() == self.bin.resolve()
        except OSError:
            pass
        return {'uptime': uptime, 'rss_kb': rss, 'exe_match': match}

    def core_hash_short(self):
        try:
            key = self.binary_key(self.bin)
        except OSError:
            return ''
        cached = self.cache_get('core-hash.json', key=key)
        if isinstance(cached, dict) and isinstance(cached.get('hash'), str):
            return cached['hash']
        value = file_digest(self.bin)[:16]
        self.cache_set('core-hash.json', key, {'hash': value})
        return value




    def core_version(self, executable=None):
        executable = Path(executable or self.bin)
        try:
            key = self.binary_key(executable)
        except OSError:
            return ''
        cached = self.cache_get('core-version.json', key=key)
        if isinstance(cached, dict) and isinstance(cached.get('text'), str):
            return cached['text']
        result = self.run([executable, 'version'], timeout=12, check=False)
        text = (result.stdout + b'\n' + result.stderr).decode('utf-8', 'replace').strip()
        self.cache_set('core-version.json', key, {'text': text})
        return text

    def core_family(self, version=None):
        text = str(version if version is not None else self.core_version()).lower()
        if 'ref1nd' in text:
            return 'ref1nd'
        if 'xiaobaf14g' in text or 'michongs' in text:
            return 'michongs'
        return 'unknown'

    def core_source_info(self, source=None):
        family = self.core_family()
        requested = str(source or '').strip().lower()
        if not requested:
            requested = family if family in CORE_SOURCES else 'michongs'
        if requested == 'unknown' or requested not in CORE_SOURCES:
            return {'id': 'unknown', 'label': '未知', 'repo': '',
                    'installed': False, 'current_family': family}
        info = CORE_SOURCES[requested]
        return {'id': requested, 'label': info['label'], 'repo': info['repo'],
                'installed': requested == family, 'current_family': family}

    def core_sources(self):
        return [self.core_source_info(source) for source in CORE_SOURCES]

    def core_series(self, executable=None):
        match = re.search(r'(?i)sing-box\s+version\s+(\d+)\.(\d+)',
                          self.core_version(executable))
        return tuple(map(int, match.groups())) if match else ()

    def schema_resolve(self, node, schema, depth=0):
        if not isinstance(node, dict) or depth > 24:
            return node
        ref = node.get('$ref')
        if isinstance(ref, str) and ref.startswith('#/$defs/'):
            target = (schema.get('$defs') or {}).get(ref.rsplit('/', 1)[-1])
            if isinstance(target, dict):
                merged = dict(target)
                merged.update({key: value for key, value in node.items() if key != '$ref'})
                return merged
        return node

    def schema_literal_values(self, node, schema, depth=0):
        node = self.schema_resolve(node, schema, depth)
        if not isinstance(node, dict) or depth > 24:
            return set()
        if 'const' in node:
            return {str(node['const'])}
        if isinstance(node.get('enum'), list):
            return {str(item) for item in node['enum']}
        values = set()
        for key in ('oneOf', 'anyOf', 'allOf'):
            for child in node.get(key) or []:
                values.update(self.schema_literal_values(child, schema, depth + 1))
        return values

    def schema_type_values(self, node, schema, depth=0):
        node = self.schema_resolve(node, schema, depth)
        if not isinstance(node, dict) or depth > 32:
            return set()
        type_node = (node.get('properties') or {}).get('type')
        if isinstance(type_node, dict):
            values = self.schema_literal_values(type_node, schema, depth + 1)
            if values:
                return values
        values = set()
        for key in ('oneOf', 'anyOf', 'allOf'):
            for child in node.get(key) or []:
                values.update(self.schema_type_values(child, schema, depth + 1))
        return values

    def schema_array_type_values(self, root_schema, path):
        node = root_schema
        for part in path:
            node = self.schema_resolve(node, root_schema)
            if not isinstance(node, dict):
                return set()
            if part == '[]':
                node = node.get('items')
            else:
                node = (node.get('properties') or {}).get(part)
        return self.schema_type_values(node, root_schema)

    def compatibility_details(self, config):
        report = {
            'core_version': '', 'core_series': [], 'schema_available': False,
            'supported': True, 'removed': [], 'unsupported': [], 'messages': []
        }
        clean = copy.deepcopy(config)
        series = self.core_series()
        report['core_version'] = self.core_version().splitlines()[0] if self.core_version() else ''
        report['core_series'] = list(series)
        report['core_family'] = self.core_family(report['core_version'])
        report['core_family_label'] = self.core_source_info(report['core_family'])['label']
        keys = (CORE_115_REMOVED_KEYS if series >= (1, 15)
                else CORE_115_ONLY_OPTIONAL_KEYS if series else frozenset())
        family = self.core_family(report['core_version'])
        keys = frozenset(keys) | CORE_FAMILY_OPTIONAL_KEYS.get(family, frozenset())

        def remove_unknown(node, path=''):
            if isinstance(node, dict):
                for key in list(node):
                    child = path + '.' + key if path else key
                    if key in keys:
                        node.pop(key, None)
                        report['removed'].append(child)
                    else:
                        remove_unknown(node[key], child)
            elif isinstance(node, list):
                for index, child in enumerate(node):
                    remove_unknown(child, path + '[' + str(index) + ']')

        remove_unknown(clean)
        try:
            schema = self.core_schema()
            report['schema_available'] = True
        except Exception:
            schema = None

        if schema:
            checks = (
                ('inbounds', ['inbounds', '[]'], clean.get('inbounds')),
                ('outbounds', ['outbounds', '[]'], clean.get('outbounds')),
                ('endpoints', ['endpoints', '[]'], clean.get('endpoints')),
                ('services', ['services', '[]'], clean.get('services')),
                ('dns.servers', ['dns', 'servers', '[]'],
                 (clean.get('dns') or {}).get('servers') if isinstance(clean.get('dns'), dict) else None),
            )
            for label, path, items in checks:
                if not isinstance(items, list):
                    continue
                allowed = self.schema_array_type_values(schema, path)
                if not allowed:
                    continue
                for index, item in enumerate(items):
                    if not isinstance(item, dict):
                        continue
                    item_type = str(item.get('type') or '').strip().lower()
                    if item_type and item_type not in allowed:
                        location = '%s[%d]' % (label, index)
                        detail = '当前内核不支持 %s 的类型 “%s”' % (location, item_type)
                        if item_type == 'ebpf' and 'with_ebpf' not in self.core_version():
                            detail += '；该内核没有 with_ebpf 构建能力'
                        report['unsupported'].append({
                            'path': location, 'type': item_type,
                            'message': detail + '。请升级内核或修改配置。'
                        })
                        report['messages'].append(detail + '。请升级内核或修改配置。')
        version_line = self.core_version()
        inbounds = clean.get('inbounds')
        if isinstance(inbounds, list) and 'with_ebpf' not in version_line:
            for index, item in enumerate(inbounds):
                if isinstance(item, dict) and str(item.get('type') or '').lower() == 'ebpf':
                    location = 'inbounds[%d]' % index
                    message = ('当前内核没有 with_ebpf 构建能力，无法运行 %s。'
                               '请安装 eBPF 构建或切换运行模式。' % location)
                    if not any(entry.get('path') == location
                               for entry in report['unsupported']):
                        report['unsupported'].append({
                            'path': location, 'type': 'ebpf', 'message': message
                        })
                        report['messages'].append(message)
        report['supported'] = not report['unsupported']
        report['_config'] = clean
        return report

    def prepare_config_for_core(self, data):
        raw = data if isinstance(data, bytes) else str(data).encode()
        config = self.parse(raw)
        report = self.compatibility_details(config)
        if not report.get('supported', True):
            raise Failure(report['unsupported'][0]['message'])
        clean = report.pop('_config')
        force_json = bool(report.get('core_series')
                          and tuple(report['core_series']) < (1, 15))
        must_serialize = bool(report.get('removed')) or (
            force_json and not raw.lstrip().startswith(b'{'))
        if must_serialize:
            if force_json:
                prepared = (json.dumps(clean, ensure_ascii=False, indent=2) + '\n').encode()
            else:
                prepared = self.serialize(clean, raw)
        else:
            prepared = raw
        report['format'] = 'json' if prepared.lstrip().startswith(b'{') else 'yaml'
        report['converted'] = bool(must_serialize and prepared != raw)
        return prepared, clean, report

    def explain_config_error(self, text):
        message = clean_error(text)
        match = re.search(
            r'([A-Za-z0-9_.\[\]-]+): unknown (transport|inbound|outbound|endpoint|service) type:\s*([A-Za-z0-9_.-]+)',
            message, re.I)
        if match:
            path, kind, name = match.groups()
            hint = '。请升级内核或修改配置。'
            if name.lower() == 'ebpf' and 'with_ebpf' not in self.core_version():
                hint = '。当前内核没有 with_ebpf 构建能力，请安装 eBPF 构建或切换运行模式。'
            family = self.core_source_info()['label']
            return '%s 内核不支持 %s 的 %s 类型 “%s”%s' % (family, path, kind, name, hint)
        match = re.search(r'([A-Za-z0-9_.\[\]-]+): json: unknown field "([^"]+)"', message, re.I)
        if not match:
            match = re.search(r'json: unknown field "([^"]+)"', message, re.I)
            if match:
                return '配置字段 “%s” 与当前内核不兼容，请升级内核或删除该字段。' % match.group(1)
        else:
            return '配置字段 “%s” 与当前内核不兼容（%s），请升级内核或删除该字段。' % (
                match.group(2), match.group(1))
        if 'invalid character' in message.lower() and 'yaml' not in message.lower():
            return '当前内核无法解析该配置格式，请重新导入 YAML / JSON 配置后再试。'
        return message

    def mode_details(self, data):
        try:
            config = data if isinstance(data, dict) else self.parse(data)
            inbounds = [item for item in (config.get('inbounds') or [])
                        if isinstance(item, dict)]
            typed = [item for item in inbounds if item.get('type') in MODES]
            types = {item.get('type') for item in typed}
            if 'redirect' in types:
                mode = 'redirect'
            elif 'tproxy' in types:
                mode = 'tproxy'
            elif 'ebpf' in types:
                mode = 'ebpf'
            elif 'tun' in types:
                mode = 'tun'
            else:
                mode = 'custom'
            primary = None
            udp = None
            if mode == 'redirect':
                primary = next((item for item in typed if item.get('type') == 'redirect'), None)
                udp = next((item for item in typed
                            if item.get('tag') == 'redirect-udp-in'
                            or (item.get('type') == 'tproxy'
                                and item.get('network') in ('udp', ['udp']))), None)
            elif mode == 'tproxy':
                candidates = [item for item in typed if item.get('type') == 'tproxy']
                primary = (next((item for item in candidates if item.get('tag') == 'tproxy-in'), None)
                           or next((item for item in candidates
                                    if item.get('network') not in ('udp', ['udp'])), None)
                           or (candidates[0] if candidates else None))
            elif mode in ('ebpf', 'tun'):
                primary = next((item for item in typed if item.get('type') == mode), None)
            details = {'mode': mode, 'inbounds': []}
            for inbound in typed:
                details['inbounds'].append({
                    'type': inbound.get('type'), 'tag': inbound.get('tag'),
                    'port': inbound.get('listen_port'),
                    'network': inbound.get('network'),
                    'interface': (inbound.get('interface_name') or inbound.get('interface')
                                  or ((inbound.get('shared') or {}).get('interface')
                                      if isinstance(inbound.get('shared'), dict) else None))
                })
            details['port'] = int(primary.get('listen_port')) if primary and primary.get('listen_port') else None
            details['udp_port'] = int(udp.get('listen_port')) if udp and udp.get('listen_port') else None
            details['interface'] = ((primary.get('interface_name') or primary.get('interface'))
                                    if primary and mode == 'tun' else '')
            details['tag'] = primary.get('tag') if primary else ''
            details['data_plane'] = ''
            details['shared_data_plane'] = ''
            if mode == 'ebpf' and isinstance(primary, dict):
                local = primary.get('local') if isinstance(primary.get('local'), dict) else {}
                shared = primary.get('shared') if isinstance(primary.get('shared'), dict) else {}
                details['data_plane'] = str(local.get('data_plane') or '')
                details['shared_data_plane'] = str(shared.get('data_plane') or '')
                details['variant'] = 'ebpf_cgroup' if details['data_plane'] == 'cgroup' else 'ebpf'
            details.setdefault('variant', mode)
            return details
        except (Failure, TypeError, ValueError):
            return {'mode': 'unknown', 'inbounds': [], 'port': None,
                    'udp_port': None, 'interface': '', 'tag': '',
                    'data_plane': '', 'shared_data_plane': '', 'variant': 'unknown'}

    def api_details(self, data):
        result = {
            'endpoint': '', 'host': '', 'port': None, 'scheme': 'http',
            'enabled': False, 'valid': False, 'secret_set': False,
            'wildcard': False, 'error': ''
        }
        try:
            config = data if isinstance(data, dict) else self.parse(data)
            experimental = config.get('experimental')
            api = experimental.get('clash_api') if isinstance(experimental, dict) else None
            if not isinstance(api, dict):
                api = config.get('clash_api')
            if not isinstance(api, dict):
                api = {}
            endpoint = str(api.get('external_controller') or '').strip()
            result['endpoint'] = endpoint
            result['secret_set'] = bool(str(api.get('secret') or ''))
            result['enabled'] = bool(endpoint)
            if not endpoint:
                return result

            # sing-box accepts the common host:port form.  Also tolerate a bare
            # port and full URLs so imports fail clearly instead of silently
            # falling back to the old 9090 assumption.
            raw = endpoint
            if re.fullmatch(r'\d+', raw):
                scheme = 'http'
                host = ''
                port = int(raw)
                path = ''
            else:
                parsed = urllib.parse.urlsplit(raw if '://' in raw else '//' + raw)
                scheme = str(parsed.scheme or 'http').lower()
                host = str(parsed.hostname or '').strip().lower()
                port = parsed.port
                path = parsed.path or ''
            if scheme not in ('http', 'https'):
                raise ValueError('只支持 http 或 https')
            if path not in ('', '/'):
                raise ValueError('external_controller 不能包含路径')
            if port is None:
                raise ValueError('缺少端口号')
            if not 1 <= int(port) <= 65535:
                raise ValueError('端口号必须在 1-65535 之间')
            result.update({
                'host': host, 'port': int(port), 'scheme': scheme,
                'valid': True,
                'wildcard': host in ('', '*', '0.0.0.0', '::')
            })
        except (Failure, TypeError, ValueError) as exc:
            result['valid'] = False
            result['error'] = clean_error(exc) or 'Clash API 地址无效'
        return result

    def validated_api_details(self, data):
        details = self.api_details(data)
        if details.get('endpoint') and not details.get('valid'):
            raise Failure('Clash API 配置错误：' + (details.get('error') or '地址无效'))
        return details

    def clash_connect_host(self, details):
        import socket
        host = str(details.get('host') or '').strip().lower()
        if details.get('wildcard') or host in ('', '*', '0.0.0.0', '::'):
            return '127.0.0.1'
        if host == 'localhost':
            return '127.0.0.1'
        try:
            address = ipaddress.ip_address(host.split('%', 1)[0])
        except ValueError:
            address = None
        if address and (address.is_loopback or address.is_unspecified):
            return '::1' if address.version == 6 else '127.0.0.1'

        local = set()
        try:
            for entry in socket.getaddrinfo(socket.gethostname(), None):
                local.add(entry[4][0].split('%', 1)[0])
        except OSError:
            pass
        try:
            result = self.run(['ip', '-o', 'addr', 'show'], timeout=4, check=False)
            for line in result.stdout.decode('utf-8', 'replace').splitlines():
                fields = line.split()
                for index, field in enumerate(fields[:-1]):
                    if field in ('inet', 'inet6'):
                        local.add(fields[index + 1].split('/', 1)[0].split('%', 1)[0])
        except Failure:
            pass
        if address and str(address) in local:
            return str(address)
        if address:
            raise Failure('Clash API 仅允许连接本机或路由器本地地址')
        try:
            resolved = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except OSError as exc:
            raise Failure('无法解析 Clash API 地址：' + host) from exc
        for entry in resolved:
            candidate = entry[4][0].split('%', 1)[0]
            if candidate in local or ipaddress.ip_address(candidate).is_loopback:
                return candidate
        raise Failure('Clash API 仅允许连接本机或路由器本地地址')

    def core_schema(self):
        schema_path = self.state / 'schema.json'
        meta_path = self.state / 'schema-meta.json'
        try:
            stat_result = self.bin.stat()
            key = {'mtime_ns': stat_result.st_mtime_ns, 'size': stat_result.st_size,
                   'version': self.core_version()}
        except OSError as exc:
            raise Failure('内核文件不存在') from exc
        family = self.core_family(key.get('version') or '')
        family_info = self.core_source_info(family)
        if schema_path.is_file() and read_json(meta_path, {}) == key:
            value = read_json(schema_path)
            if isinstance(value, dict):
                value['x-sbd-core-family'] = family
                value['x-sbd-core-family-label'] = family_info['label']
                value['x-sbd-core-repository'] = family_info['repo']
                return value
        temp = self.state / ('.schema-' + uuid.uuid4().hex + '.json')
        try:
            self.run([self.bin, 'schema', '-o', temp], timeout=45)
            if not temp.is_file() or temp.stat().st_size > 8 * 1024 * 1024:
                raise Failure('内核没有生成有效的 JSON Schema')
            raw = temp.read_bytes()
            try:
                value = json.loads(raw.decode('utf-8'))
            except (UnicodeDecodeError, ValueError) as exc:
                raise Failure('内核生成的 JSON Schema 无效') from exc
            if not isinstance(value, dict) or not isinstance(value.get('properties'), dict):
                raise Failure('内核 JSON Schema 缺少根节点属性')
            value['x-sbd-core-family'] = family
            value['x-sbd-core-family-label'] = family_info['label']
            value['x-sbd-core-repository'] = family_info['repo']
            atomic(schema_path, (json.dumps(value, ensure_ascii=False) + '\n').encode(), 0o600)
            write_json(meta_path, key)
            return value
        finally:
            temp.unlink(missing_ok=True)

    def build_tags(self):
        line = next((item for item in self.core_version().splitlines()
                     if item.strip().startswith('Tags:')), '')
        value = line.split(':', 1)[1] if ':' in line else ''
        return {item.strip() for item in value.split(',') if item.strip()}

    def capabilities(self):
        schema = self.core_schema()
        tags = sorted(self.build_tags())
        missing = [tag for tag in (
            'with_tailscale', 'with_wireguard', 'with_dhcp', 'with_acme',
            'with_openvpn', 'with_openconnect', 'with_easytier',
            'with_naive_outbound', 'with_cloudflared', 'with_ocm', 'with_ccm',
            'with_usbip', 'with_v2ray_api'
        ) if tag not in tags]
        return {
            'ok': True,
            'version': self.core_version().splitlines()[0] if self.core_version() else '',
            'core_family': self.core_family(),
            'core_family_label': self.core_source_info()['label'],
            'core_sources': self.core_sources(),
            'tags': tags,
            'missing_optional_tags': missing,
            'schema_id': schema.get('$id', ''),
            'sections': sorted((schema.get('properties') or {}).keys()),
            'definitions': len(schema.get('$defs') or {})
        }

    def schema_with_capabilities(self):
        schema = copy.deepcopy(self.core_schema())
        tags = self.build_tags()
        missing = {tag for tag in (
            'with_tailscale', 'with_wireguard', 'with_dhcp', 'with_acme',
            'with_openvpn', 'with_openconnect', 'with_easytier',
            'with_naive_outbound', 'with_cloudflared', 'with_ocm', 'with_ccm',
            'with_usbip', 'with_v2ray_api', 'with_quic', 'with_utls',
            'with_ebpf', 'with_clash_api', 'with_xhttp'
        ) if tag not in tags}
        requirements = {
            'with_tailscale': {
                'Inbound': {'tailcat'}, 'Outbound': {'tailcat'},
                'Endpoint': {'tailscale'}, 'Service': {'derp'},
                'DNSServer': {'tailscale'}, 'CertificateProvider': {'tailscale'}
            },
            'with_wireguard': {'Endpoint': {'wireguard'}},
            'with_dhcp': {'DNSServer': {'dhcp'}},
            'with_acme': {'CertificateProvider': {'acme'}},
            'with_openvpn': {
                'Endpoint': {'openvpn-client', 'openvpn-server'},
                'DNSServer': {'openvpn'}
            },
            'with_openconnect': {'Endpoint': {'openconnect'}, 'DNSServer': {'openconnect'}},
            'with_easytier': {'Endpoint': {'easytier'}, 'DNSServer': {'easytier'}},
            'with_naive_outbound': {'Outbound': {'naive'}},
            'with_cloudflared': {'Inbound': {'cloudflared'}},
            'with_ocm': {'Service': {'ocm'}},
            'with_ccm': {'Service': {'ccm'}},
            'with_usbip': {'Service': {'usbip-client', 'usbip-server'}},
            'with_v2ray_api': {'Experimental': {'v2ray_api'}},
            'with_quic': {
                'Inbound': {'quicx', 'nowhere'}, 'Outbound': {'quicx', 'nowhere'},
                'DNSServer': {'quic', 'h3', 'https'}, 'V2RayTransport': {'quic'}
            },
            'with_utls': {'TLS': {'utls'}},
            'with_ebpf': {'Inbound': {'ebpf'}},
            'with_clash_api': {'Experimental': {'clash_api'}},
            'with_xhttp': {'V2RayTransport': {'xhttp'}}
        }

        def variant_type(branch):
            prop = ((branch or {}).get('properties') or {}).get('type') or {}
            if 'const' in prop:
                return str(prop['const'])
            enum = prop.get('enum')
            return str(enum[0]) if isinstance(enum, list) and enum else ''

        def mark(defname, types):
            definition = schema.get('$defs', {}).get(defname)
            if not isinstance(definition, dict):
                return

            def visit(branch):
                if not isinstance(branch, dict):
                    return
                if variant_type(branch) in types:
                    branch['x-sbd-unsupported'] = True
                for key in ('oneOf', 'anyOf'):
                    for child in branch.get(key) or []:
                        visit(child)

            for branch in definition.get('oneOf') or definition.get('anyOf') or []:
                visit(branch)

        for tag in missing:
            for defname, types in requirements.get(tag, {}).items():
                if defname == 'Experimental':
                    props = ((schema.get('$defs', {}).get('ExperimentalOptions') or {}).get('properties') or {})
                    for key in types:
                        if key in props:
                            props[key]['x-sbd-unsupported'] = True
                elif defname == 'TLS':
                    for definition in (schema.get('$defs') or {}).values():
                        props = (definition.get('properties') or {}) if isinstance(definition, dict) else {}
                        if 'utls' in props:
                            props['utls']['x-sbd-unsupported'] = True
                else:
                    mark(defname, types)
        schema['x-sbd-build-tags'] = sorted(tags)
        schema['x-sbd-missing-tags'] = sorted(missing)
        schema['x-sbd-capabilities'] = self.capabilities()
        return schema

    def status(self):
        pids = self.pids()
        pid = pids[0] if pids else None
        active = self.active(pid)
        active_text = b''
        if active.is_file() and not active.is_symlink():
            active_text = active.read_bytes()
        active_hash = digest(active_text) if active_text else ''
        details = self.cache_get(
            'active-details.json', key={'hash': active_hash, 'version': 4}, max_age=86400
        ) if active_hash else None
        if not (isinstance(details, dict)
                and isinstance(details.get('mode'), dict)
                and isinstance(details.get('api'), dict)):
            config = self.parse(active_text) if active_text else {}
            details = {'mode': self.mode_details(config), 'api': self.api_details(config)}
            if active_hash:
                self.cache_set('active-details.json', {'hash': active_hash, 'version': 4}, details)
        version = self.core_version() if self.bin.is_file() else ''
        current_mode = details.get('mode') if isinstance(details.get('mode'), dict) else {}
        if pid and current_mode.get('mode') not in ('', 'custom', 'unknown', None):
            self.record_mode_runtime(current_mode, True, '当前运行配置已成功启动')
        release = {}
        try:
            for line in (self.root / 'etc/openwrt_release').read_text().splitlines():
                if '=' in line:
                    key, value = line.split('=', 1)
                    release[key] = value.strip("'\"")
        except OSError:
            pass
        return {
            'ok': True, 'app': APP, 'version': VERSION,
            'running': bool(pid), 'pid': pid, 'pids': pids,
            'core_count': len(pids), 'external_pids': self.external_pids(),
            'process': self.process_meta(pid),
            'active': active.name if active.exists() else '',
            'active_hash': active_hash,
            'kernel_key': self.binary_revision(),
            'core_family': self.core_family(version),
            'core_family_label': self.core_source_info(self.core_family(version))['label'],
            'mode': details['mode'],
            'mode_capabilities': self.mode_capabilities_snapshot(version),
            'version_line': version,
            'ebpf': 'with_ebpf' in version,
            'enabled': self.core_service_enabled(),
            'arch': os.uname().machine if hasattr(os, 'uname') else os.environ.get('PROCESSOR_ARCHITECTURE', ''),
            'release': release,
            'api': details['api'],
            'update': read_json(self.state / 'update.json', {}),
            'job': self.job(),
            'slots': [{'name': name, 'active': name == active.name,
                       'size': (self.conf / name).stat().st_size}
                      for name in self.slot_names()]
        }

    def mode_plan(self, data, mode, validate_result=True):
        if mode not in SELECTABLE_MODES:
            raise Failure('未知接管模式')
        physical_mode = 'ebpf' if mode in MODE_VARIANTS else mode
        capability = self.mode_capabilities_snapshot().get(mode, {})
        if capability and capability.get('available') is False:
            raise Failure(capability.get('reason') or '当前系统不支持此接管模式')
        config = copy.deepcopy(self.parse(data))
        inbounds = config.get('inbounds')
        if not isinstance(inbounds, list):
            inbounds = []
        existing = None
        if physical_mode == 'redirect':
            existing = next((copy.deepcopy(item) for item in inbounds
                             if isinstance(item, dict) and item.get('type') == 'redirect'), None)
        elif physical_mode == 'tproxy':
            candidates = [copy.deepcopy(item) for item in inbounds
                          if isinstance(item, dict) and item.get('type') == 'tproxy'
                          and item.get('tag') != 'redirect-udp-in']
            existing = (next((item for item in candidates if item.get('tag') == 'tproxy-in'), None)
                        or next((item for item in candidates
                                 if item.get('network') not in ('udp', ['udp'])), None)
                        or (candidates[0] if candidates else None))
        else:
            existing = next((copy.deepcopy(item) for item in inbounds
                             if isinstance(item, dict) and item.get('type') == physical_mode), None)

        version_line = self.core_version()
        match = re.search(r'version\s+(\d+)\.(\d+)', version_line)
        if not match:
            raise Failure('无法确认内核版本，已拒绝生成模式参数')
        version = tuple(map(int, match.groups()))
        if version < (1, 14):
            raise Failure('接管模式需要 sing-box 1.14 或更新版本')

        saved = read_json(self.state / 'mode-profiles.json', {})
        if isinstance(saved, dict) and int(saved.get('version') or 0) >= 2:
            profiles = saved.get('profiles') if isinstance(saved.get('profiles'), dict) else {}
        else:
            profiles = saved if isinstance(saved, dict) else {}
        if not existing:
            existing = copy.deepcopy(profiles.get(mode) or profiles.get(physical_mode))
        ipv6 = (self.root / 'proc/net/if_inet6').exists() or Path('/proc/net/if_inet6').exists()

        if physical_mode == 'ebpf':
            if 'with_ebpf' not in version_line:
                raise Failure('当前内核没有 with_ebpf 构建能力')
            members = self.lan_members()
            if not members:
                raise Failure('无法识别 LAN 成员接口，无法启用 eBPF 共享接管')
            inbound = existing or {}
            inbound.update({
                'type': 'ebpf', 'tag': inbound.get('tag') or 'ebpf-in',
                'network': ['tcp', 'udp'], 'fakeip_icmp': 'reply'
            })
            local = inbound.setdefault('local', {})
            local_plane = str(capability.get('local_data_plane') or '')
            if not local_plane:
                local_plane = str(self.ebpf_local_plane().get('plane') or '')
            if local_plane not in ('tc', 'socket_assign', 'cgroup'):
                raise Failure('无法识别当前内核版本的 eBPF 本地数据面参数')
            local.update({'enabled': True, 'data_plane': local_plane, 'dns_mode': 'hijack',
                          'ipv6': ipv6, 'bypass_private_address': True})
            shared = inbound.setdefault('shared', {})
            shared.update({'enabled': True, 'data_plane': 'packet_rewrite',
                           'interface': members, 'dns_mode': 'hijack', 'ipv6': ipv6,
                           'bypass_private_address': True})
        elif physical_mode == 'tun':
            inbound = existing or {}
            inbound.update({
                'type': 'tun', 'tag': inbound.get('tag') or 'tun-in',
                'interface_name': inbound.get('interface_name') or 'singtun0',
                'address': inbound.get('address') or ['172.18.0.1/30', 'fdfe:dcba:9876::1/126'],
                'auto_route': True, 'strict_route': True, 'dns_mode': 'hijack',
                'route_exclude_address': inbound.get('route_exclude_address')
                    or ['192.168.0.0/16', 'fc00::/7']
            })
            inbound.pop('stack', None)
        else:
            inbound = existing or {}
            inbound.update({
                'type': physical_mode, 'tag': inbound.get('tag') or (physical_mode + '-in'),
                'listen': '0.0.0.0', 'listen_port': int(inbound.get('listen_port') or 7895)
            })
            if physical_mode == 'tproxy':
                inbound['network'] = ['tcp', 'udp']
            else:
                inbound.pop('network', None)
        for key in ('sniff', 'sniff_override_destination', 'sniff_timeout',
                    'domain_strategy', 'udp_disable_domain_unmapping'):
            inbound.pop(key, None)
        inbound.setdefault('tag', physical_mode + '-in')

        removed = {item.get('tag') for item in inbounds
                   if isinstance(item, dict) and item.get('type') in MODES}
        keep = [item for item in inbounds
                if not (isinstance(item, dict) and item.get('type') in MODES)]
        keep.append(inbound)
        replacement = [inbound['tag']]
        if physical_mode == 'redirect':
            used = {int(item.get('listen_port')) for item in keep
                    if isinstance(item, dict) and item.get('listen_port')}
            udp_port = int(inbound['listen_port']) + 1
            while udp_port in used and udp_port < 65535:
                udp_port += 1
            udp = next((copy.deepcopy(item) for item in inbounds
                        if isinstance(item, dict) and item.get('tag') == 'redirect-udp-in'), None)
            if not isinstance(udp, dict) or udp.get('type') != 'tproxy':
                udp = {}
            udp.update({'type': 'tproxy', 'tag': 'redirect-udp-in',
                        'listen': '0.0.0.0', 'listen_port': udp_port,
                        'network': ['udp']})
            keep.append(udp)
            replacement.append(udp['tag'])
        config['inbounds'] = keep

        def remap(value):
            if isinstance(value, dict):
                for key, child in list(value.items()):
                    if key == 'inbound':
                        if isinstance(child, str) and child in removed:
                            value[key] = replacement if len(replacement) > 1 else inbound['tag']
                        elif isinstance(child, list):
                            value[key] = list(dict.fromkeys(
                                item for old in child
                                for item in (replacement if old in removed else [old])))
                    else:
                        remap(child)
            elif isinstance(value, list):
                for child in value:
                    remap(child)

        remap(config.get('route', {}))
        remap(config.get('dns', {}))
        route = config.setdefault('route', {})
        rules = route.setdefault('rules', [])
        def has_sniff(rule):
            return (isinstance(rule, dict) and
                    (rule.get('action') == 'sniff' or any(has_sniff(x) for x in rule.get('rules', []))))
        if not any(has_sniff(rule) for rule in rules):
            rules.insert(0, {'action': 'sniff'})
        text = self.serialize(config, data if isinstance(data, bytes) else data.encode())
        text, _, _ = self.prepare_config_for_core(text)
        if validate_result:
            self.validate(text)
        return text

    def lan_interface(self):
        result = self.run(['uci', '-q', 'get', 'network.lan.device'], timeout=8, check=False)
        value = result.stdout.decode('utf-8', 'replace').strip()
        return value.split()[0] if value else 'br-lan'

    def lan_members(self):
        result = self.run(['uci', '-q', 'get', 'network.lan.device'], timeout=8, check=False)
        configured = result.stdout.decode('utf-8', 'replace').strip().split()
        if not configured:
            result = self.run(['uci', '-q', 'get', 'network.lan.ports'], timeout=8, check=False)
            configured = result.stdout.decode('utf-8', 'replace').strip().split()
        members = []
        queue = list(configured) or [self.lan_interface()]
        seen = set()
        while queue and len(members) < 32:
            interface = queue.pop(0).strip()
            if (not interface or interface in seen
                    or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', interface)):
                continue
            seen.add(interface)
            bridge = self.root / 'sys/class/net' / interface / 'brif'
            try:
                ports = sorted(path.name for path in bridge.iterdir()
                               if re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', path.name))
            except OSError:
                ports = []
            if ports:
                queue[0:0] = ports
            else:
                members.append(interface)
        return list(dict.fromkeys(members))







    def annotate_runtime_evidence(self, value):
        if not isinstance(value, dict):
            return value
        runtime = self.read_mode_runtime()
        modes = runtime.get('modes') if isinstance(runtime.get('modes'), dict) else {}
        pairs = []
        if isinstance(value.get('ebpf'), dict):
            pairs.append(('ebpf', value['ebpf'],
                          'ebpf:' + str(value.get('ebpf_local_plane') or 'unknown')))
        if isinstance(value.get('ebpf_cgroup'), dict):
            pairs.append(('ebpf_cgroup', value['ebpf_cgroup'], 'ebpf:cgroup'))
        for name in ('tun', 'tproxy', 'redirect'):
            if isinstance(value.get(name), dict):
                pairs.append((name, value[name], name))
        for name, cap, key in pairs:
            evidence = modes.get(key) if isinstance(modes.get(key), dict) else None
            warnings = [item.get('title') or item.get('name')
                        for item in (cap.get('issues') or [])
                        if str(item.get('severity') or '').lower() == 'warn'
                        and str(item.get('requirement') or '').lower() == 'required']
            cap['required_warnings'] = warnings
            cap['runtime_checked_at'] = int(evidence.get('time') or 0) if evidence else 0
            cap['runtime_reason'] = str(evidence.get('reason') or '') if evidence else ''
            if evidence and evidence.get('state') == 'success':
                cap['runtime_verified'] = True
                cap['runtime_state'] = 'success'
                cap['available'] = True
            elif evidence and evidence.get('state') == 'failed':
                cap['runtime_verified'] = False
                cap['runtime_state'] = 'failed'
                cap['available'] = False
                cap['reason'] = '不可用：实际启动失败：' + (cap['runtime_reason'] or 'sing-box 未能启动')
            elif cap.get('available'):
                cap['runtime_verified'] = True
                cap['runtime_state'] = 'success'
        return value







    def provider_file_path(self, tag, value=''):
        base = (self.conf / 'providers').resolve()
        base.mkdir(parents=True, exist_ok=True, mode=0o700)
        tag = str(tag or '').strip()
        if not re.fullmatch(r'[^\x00-\x1f/]{1,80}', tag):
            raise Failure('Provider 标签不合法')
        raw = str(value or '').strip()
        if raw:
            candidate = Path(raw)
            if not candidate.is_absolute():
                candidate = base / candidate.name
        else:
            slug = re.sub(r'[^A-Za-z0-9._-]+', '-', tag).strip('.-_')[:48] or 'provider'
            candidate = base / (slug + '.yaml')
        if candidate.parent.resolve() != base:
            raise Failure('本地 Provider 文件必须位于 /etc/sing-box/providers/')
        if candidate.suffix.lower() not in ('.yaml', '.yml', '.json'):
            candidate = candidate.with_suffix('.yaml')
        if candidate.exists() and candidate.is_symlink():
            raise Failure('Provider 文件不能是符号链接')
        return candidate

    def provider_transport(self, query):
        kind = (query.get('type') or query.get('net') or [''])[0].lower()
        host = (query.get('host') or [''])[0]
        path = (query.get('path') or [''])[0] or '/'
        if kind == 'ws':
            transport = {'type': 'ws', 'path': path}
            if host:
                transport['headers'] = {'Host': host}
            return transport
        if kind == 'httpupgrade':
            transport = {'type': 'httpupgrade', 'path': path}
            if host:
                transport['headers'] = {'Host': host}
            return transport
        if kind == 'grpc':
            return {'type': 'grpc', 'service_name': (query.get('serviceName') or query.get('service_name') or [''])[0]}
        if kind in ('http', 'h2'):
            transport = {'type': 'http', 'path': path}
            if host:
                transport['host'] = [item.strip() for item in host.split(',') if item.strip()]
            return transport
        return None

    def provider_tls(self, query, server_name, enabled=None):
        security = (query.get('security') or [''])[0].lower()
        if enabled is None:
            enabled = security in ('tls', 'reality')
        if not enabled:
            return None
        tls = {'enabled': True}
        sni = (query.get('sni') or query.get('serverName') or [''])[0] or server_name
        if sni:
            tls['server_name'] = sni
        insecure = (query.get('insecure') or query.get('allowInsecure') or [''])[0]
        if str(insecure).lower() in ('1', 'true', 'yes'):
            tls['insecure'] = True
        alpn = (query.get('alpn') or [''])[0]
        if alpn:
            tls['alpn'] = [item.strip() for item in urllib.parse.unquote(alpn).split(',') if item.strip()]
        fp = (query.get('fp') or query.get('fingerprint') or [''])[0]
        if fp:
            tls['utls'] = {'enabled': True, 'fingerprint': fp}
        if security == 'reality':
            public_key = (query.get('pbk') or query.get('publicKey') or [''])[0]
            short_id = (query.get('sid') or query.get('shortId') or [''])[0]
            if not public_key:
                raise Failure('Reality 节点缺少 public key')
            tls['reality'] = {'enabled': True, 'public_key': public_key}
            if short_id:
                tls['reality']['short_id'] = short_id
        return tls





    def upload_dir(self):
        try:
            UPLOAD_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        except OSError:
            pass
        return UPLOAD_ROOT

    def upload_path(self, value):
        if not value:
            raise Failure('缺少上传文件')
        path = Path(value)
        base = self.upload_dir()
        try:
            resolved = path.resolve(strict=True)
        except OSError as exc:
            raise Failure('上传文件必须位于 %s/singbox-dash-*' % base) from exc
        allowed = any(str(resolved).startswith(prefix)
                      for prefix in (str(base) + '/singbox-dash-',))
        safe_name = re.fullmatch(r'singbox-dash-[A-Za-z0-9_.-]+', path.name)
        if (not allowed or path.is_symlink() or not path.is_file()
                or not safe_name or path.parent != base):
            raise Failure('上传文件必须位于 %s/singbox-dash-*' % base)
        if path.stat().st_size > MAX_KERNEL:
            raise Failure('上传文件超过 160 MB')
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return path

    def upload_token(self, kind='config'):
        if kind not in ('config', 'kernel'):
            raise Failure('上传类型不合法')
        token = uuid.uuid4().hex
        now = int(time.time())
        write_json(self.upload_sessions / (token + '.json'), {
            'kind': kind, 'created': now, 'expires': now + UPLOAD_SESSION_TTL
        })
        try:
            for path in self.upload_sessions.glob('*.json'):
                meta = read_json(path, {})
                if int(meta.get('expires') or 0) < now:
                    path.unlink(missing_ok=True)
        except OSError:
            pass
        return token

    def verify_upload_session(self, token, kind):
        path = self.upload_sessions / (token + '.json')
        meta = read_json(path, {})
        if not meta or meta.get('kind') != kind:
            raise Failure('上传会话不存在或类型不匹配')
        if int(meta.get('expires') or 0) < int(time.time()):
            path.unlink(missing_ok=True)
            raise Failure('上传会话已过期，请重新上传')
        return path

    def assemble_upload(self, request):
        if not isinstance(request, dict):
            raise Failure('上传请求格式错误')
        token = str(request.get('token') or '')
        kind = str(request.get('kind') or '')
        if not re.fullmatch(r'[a-f0-9]{32}', token):
            raise Failure('上传会话不合法')
        if kind not in ('config', 'kernel'):
            raise Failure('上传类型不合法')
        session = self.verify_upload_session(token, kind)
        pattern = re.compile(r'^singbox-dash-upload-%s-(\d{5})\.b64$' % token)
        chunks = []
        for path in self.upload_dir().iterdir():
            match = pattern.fullmatch(path.name)
            if match and path.is_file() and not path.is_symlink():
                chunks.append((int(match.group(1)), path))
        chunks.sort()
        if not chunks:
            raise Failure('没有收到上传分片')
        if [index for index, _ in chunks] != list(range(len(chunks))):
            self.cleanup_upload_chunks(token)
            raise Failure('上传分片不连续，请重新上传')
        limit = MAX_CONFIG if kind == 'config' else MAX_KERNEL
        data = bytearray()
        try:
            for _, path in chunks:
                if path.stat().st_size > MAX_UPLOAD_CHUNK * 2:
                    raise Failure('上传分片过大')
                try:
                    block = base64.b64decode(path.read_bytes(), validate=True)
                except (ValueError, OSError) as exc:
                    raise Failure('上传分片编码错误') from exc
                data.extend(block)
                if len(data) > limit:
                    raise Failure('上传文件超过大小限制')
            if not data:
                raise Failure('上传文件为空')
            target = self.upload_dir() / ('singbox-dash-%s-%s' % (kind, token))
            atomic(target, bytes(data), 0o600)
            return {'ok': True, 'path': str(target), 'size': len(data),
                    'kind': kind, 'token': token}
        finally:
            self.cleanup_upload_chunks(token)
            session.unlink(missing_ok=True)

    def cleanup_upload_chunks(self, token):
        if not re.fullmatch(r'[a-f0-9]{32}', str(token or '')):
            return
        try:
            for path in self.upload_dir().glob('singbox-dash-upload-%s-*.b64' % token):
                if path.is_file() and not path.is_symlink():
                    path.unlink(missing_ok=True)
        except OSError:
            pass

    def job(self, jid=None):
        if not jid:
            jid = read_json(self.state / ACTIVE_FILE, {}).get('id')
        if not jid:
            return None
        if not re.fullmatch(r'[a-f0-9]{32}', jid):
            raise Failure('任务 ID 不合法')
        return read_json(self.jobs / jid / 'status.json')

    def phase(self, job, phase, **extra):
        status = {'id': job['id'], 'action': job['action'],
                  'target': job.get('target', ''), 'phase': phase,
                  'updated': int(time.time()), **extra}
        write_json(self.jobs / job['id'] / 'status.json', status)
        return status

    def prune_backups(self, folder, keep, predicate):
        try:
            files = sorted((p for p in folder.iterdir()
                            if p.is_file() and predicate(p.name)),
                           key=lambda p: p.stat().st_mtime, reverse=True)
            for path in files[keep:]:
                path.unlink(missing_ok=True)
                Path(str(path) + '.meta').unlink(missing_ok=True)
        except OSError:
            pass

    def backup_config(self, name):
        path = self.target(name)
        if not path.is_file():
            raise Failure('目标配置不存在')
        data = path.read_bytes()
        stamp = time.strftime('%Y%m%d-%H%M%S')
        suffix = '.json' if data.lstrip().startswith(b'{') else '.yaml'
        backup = 'config-%s-%s%s' % (stamp, uuid.uuid4().hex[:8], suffix)
        atomic(self.backups / backup, data)
        write_json(self.backups / (backup + '.meta'), {
            'slot': name, 'hash': digest(data), 'time': int(time.time()),
            'size': len(data)
        })
        self.prune_backups(self.backups, CONFIG_BACKUP_LIMIT,
                           lambda n: bool(re.fullmatch(r'config-\d{8}-\d{6}-[a-f0-9]{8}\.(?:yaml|json)', n)))
        return backup

    def backup_list(self):
        result = []
        self.prune_backups(self.backups, CONFIG_BACKUP_LIMIT,
                           lambda n: bool(re.fullmatch(r'config-\d{8}-\d{6}-[a-f0-9]{8}\.(?:yaml|json)', n)))
        try:
            for path in self.backups.iterdir():
                if (not path.is_file() or path.is_symlink()
                        or not re.fullmatch(r'config-\d{8}-\d{6}-[a-f0-9]{8}\.(?:yaml|json)', path.name)):
                    continue
                meta = read_json(Path(str(path) + '.meta'), {})
                result.append({'name': path.name, 'size': path.stat().st_size,
                               'time': int(path.stat().st_mtime),
                               'slot': meta.get('slot', 'config.yaml'),
                               'hash': meta.get('hash', '')})
        except OSError:
            pass
        return sorted(result, key=lambda item: item['time'], reverse=True)

    def valid_backup(self, name):
        return bool(re.fullmatch(r'config-\d{8}-\d{6}-[a-f0-9]{8}\.(?:yaml|json)', str(name or '')))

    def delete_config_backup(self, name):
        name = str(name or '')
        if not self.valid_backup(name):
            raise Failure('备份名称不合法')
        path = self.backups / name
        if not path.is_file() or path.is_symlink():
            raise Failure('配置备份不存在')
        path.unlink()
        Path(str(path) + '.meta').unlink(missing_ok=True)
        return {'ok': True, 'deleted': name, 'kind': 'config'}

    def delete_kernel_backup(self, name):
        name = str(name or '')
        pattern = r'sing-box-[A-Za-z0-9._-]+-[a-f0-9]{8}'
        if not re.fullmatch(pattern, name):
            raise Failure('内核备份名称不合法')
        path = self.kernel_backups / name
        if not path.is_file() or path.is_symlink():
            raise Failure('内核备份不存在')
        path.unlink()
        Path(str(path) + '.meta').unlink(missing_ok=True)
        return {'ok': True, 'deleted': name, 'kind': 'kernel'}

    def network_snapshot(self, folder):
        files = ('etc/config/network', 'etc/config/firewall', 'etc/config/sing-box',
                 'etc/sysctl.d/99-singbox-dash.conf', 'etc/singbox-dash.nft')
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        manifest = {}
        for index, relative in enumerate(files):
            source = self.root / relative
            entry = {'exists': source.is_file() and not source.is_symlink()}
            if entry['exists']:
                name = 'file-%02d' % index
                atomic(folder / name, source.read_bytes(), 0o600)
                entry.update({'file': name, 'mode': stat.S_IMODE(source.stat().st_mode)})
            manifest[relative] = entry
        write_json(folder / 'manifest.json', manifest)
        return folder

    def network_restore(self, folder):
        folder = Path(folder)
        manifest = read_json(folder / 'manifest.json', {})
        if not isinstance(manifest, dict):
            raise Failure('网络状态快照损坏')
        for relative, entry in manifest.items():
            target = self.root / relative
            if not isinstance(entry, dict):
                continue
            if entry.get('exists'):
                source = folder / str(entry.get('file') or '')
                if not source.is_file() or source.is_symlink():
                    raise Failure('网络状态快照缺少文件')
                atomic(target, source.read_bytes(), int(entry.get('mode') or 0o644))
            else:
                target.unlink(missing_ok=True)
        for service in ('network', 'firewall'):
            self.run(['uci', 'commit', service], timeout=8, check=False)
        if self.mode_helper.exists():
            self.run([self.mode_helper, 'restore-runtime'], timeout=45, check=False)
        for init in ('network', 'firewall'):
            path = self.root / 'etc/init.d' / init
            if path.exists():
                self.run([path, 'reload'], timeout=30, check=False)


    def port_open(self, port):
        if not port:
            return True
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1)
        try:
            return sock.connect_ex(('127.0.0.1', int(port))) == 0
        except OSError:
            return False
        finally:
            sock.close()

    def wait_for_core(self, api_port=None, timeout=25, details=None):
        deadline = time.time() + timeout
        last_error = ''
        if details is None:
            active = self.active()
            details = self.mode_details(active.read_bytes()) if active.is_file() else {'mode': 'custom'}
        while time.time() < deadline:
            all_pids = self.all_pids()
            pid = self.primary_pid()
            if not all_pids:
                last_error = 'sing-box 进程未启动'
                time.sleep(1)
                continue
            if not pid:
                last_error = '检测到 sing-box 进程，但未使用当前配置'
                time.sleep(1)
                continue
            if not self.process_running():
                last_error = 'sing-box 进程已退出'
                time.sleep(1)
                continue
            if api_port and not self.port_open(api_port):
                last_error = 'Clash API 端口未就绪'
                time.sleep(1)
                continue
            mode = details.get('mode') or 'custom'
            if mode not in ('custom', 'unknown') and self.mode_helper.exists():
                args = [self.mode_helper, 'verify-runtime', mode,
                        str(details.get('port') or 0), self.lan_interface(),
                        str(details.get('interface') or 'singtun0'),
                        str(details.get('udp_port') or '')]
                result = self.run(args, timeout=30, check=False)
                if result.returncode:
                    last_error = clean_error((result.stderr or result.stdout).decode('utf-8', 'replace'))
                    time.sleep(1)
                    continue
            return True
        raise Failure('sing-box 运行检查失败：' + (last_error or '超时'))

    def core_service_init(self):
        return self.core_init if self.core_init.is_file() else self.fallback_core_init

    def core_service_enabled(self):
        init = self.core_service_init()
        if init == self.core_init:
            return self.rc_enabled('sing-box')
        return self.rc_enabled('singbox-dash-core')

    def prepare_core_runtime(self, details):
        mode = details.get('mode') or 'custom'
        if mode == 'tun':
            repaired = self.ensure_tun_device()
            if not repaired.get('ok'):
                raise Failure(repaired.get('reason') or 'TUN 设备准备失败')
        if mode not in ('custom', 'unknown') and self.mode_helper.exists():
            self.run([self.mode_helper, 'apply', mode,
                      str(details.get('port') or 0), self.lan_interface(),
                      str(details.get('interface') or 'singtun0'),
                      str(details.get('udp_port') or '')], timeout=60)

    def prepare_boot(self):
        active = self.active()
        if not active.is_file():
            raise Failure('当前配置不存在')
        raw = active.read_bytes()
        prepared, config, compatibility = self.prepare_config_for_core(raw)
        if prepared != raw:
            self.backup_config(active.name)
            atomic(active, prepared, 0o600)
        details = self.mode_details(config)
        self.prepare_core_runtime(details)
        return {'ok': True, 'mode': details.get('mode') or 'custom',
                'config': str(active), 'compatibility': compatibility}

    def restart_core(self, was_running=True, api_port=None, details=None):
        if not was_running:
            return True
        if details is None:
            active = self.active()
            details = self.mode_details(active.read_bytes()) if active.is_file() else {'mode': 'custom'}
        try:
            result = self.run([self.core_service_init(), 'restart'], timeout=65, check=False)
            if result.returncode != 0:
                raise Failure(clean_error((result.stderr or result.stdout).decode('utf-8', 'replace'))
                              or 'sing-box 重启失败')
            self.wait_for_core(api_port, timeout=35, details=details)
            self.record_mode_runtime(details, True, '实际重启并运行成功')
        except Exception as exc:
            self.record_mode_runtime(details, False, exc)
            raise


    def dispatch_job_worker(self):
        result = self.run([self.job_init, 'start'], timeout=10, check=False)
        if result.returncode == 0:
            return
        manager = self.root / 'usr/bin/singbox-dash/manager.py'
        if not manager.is_file():
            raise Failure('任务服务启动失败，且找不到后台管理脚本')
        try:
            subprocess.Popen(
                [sys.executable, str(manager), 'worker'],
                env=self.env, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                close_fds=True, start_new_session=True)
        except OSError as exc:
            raise Failure('任务服务启动失败：' + clean_error(exc)) from exc

    def create_job(self, action, target, candidate, **extra):
        with self.lock('submit'):
            current = self.job()
            if current and current.get('phase') not in TERMINAL:
                raise Failure('已有任务正在执行，请稍后再试')
            jid = uuid.uuid4().hex
            folder = self.jobs / jid
            folder.mkdir(parents=True, mode=0o700)
            job = {'id': jid, 'action': action, 'target': target,
                   'created': int(time.time()), **extra}
            atomic(folder / 'candidate', candidate)
            write_json(folder / 'request.json', job)
            queued = self.phase(job, 'queued')
            if isinstance(extra.get('api'), dict):
                queued['api'] = {
                    key: extra['api'].get(key) for key in
                    ('endpoint', 'host', 'port', 'scheme', 'enabled', 'valid',
                     'secret_set', 'wildcard', 'error')
                }
                write_json(folder / 'status.json', queued)
            if isinstance(extra.get('compatibility'), dict):
                queued['compatibility'] = extra['compatibility']
                write_json(folder / 'status.json', queued)
            write_json(self.state / ACTIVE_FILE, {'id': jid})
        try:
            if os.environ.get('SBD_SYNC') == '1':
                self.worker()
            else:
                self.dispatch_job_worker()
        except Exception as exc:
            self.phase(job, 'failed', error=clean_error(exc))
            raise
        return self.job(jid)

    def submit_save(self, request):
        action = request.get('action')
        if action not in ('save', 'apply', 'restore', 'mode'):
            raise Failure('不允许的配置操作')
        target = self.target(request.get('target'))
        expected = request.get('expected')
        if not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected):
            raise Failure('缺少配置基线，请重新载入')
        old = target.read_bytes() if target.exists() else b''
        if digest(old) != expected:
            raise Failure('配置已被其他页面或后台更新，请重新载入')
        if action == 'restore':
            name = request.get('backup', '')
            if not self.valid_backup(name):
                raise Failure('备份名称不合法')
            candidate = (self.backups / name).read_bytes()
        else:
            candidate = self.upload_path(request.get('source')).read_bytes()
        if not candidate or len(candidate) > MAX_CONFIG:
            raise Failure('配置为空或超过 10 MB')
        config = self.parse(candidate)
        mode = request.get('mode')
        if action == 'mode':
            if mode not in SELECTABLE_MODES:
                raise Failure('未知接管模式')
            candidate = self.mode_plan(candidate, mode, validate_result=False)
        candidate, config, compatibility = self.prepare_config_for_core(candidate)
        api = self.validated_api_details(config)
        job = self.create_job(action, target.name, candidate,
                              expected=expected, mode=mode,
                              api_port=api.get('port'), api=api,
                              compatibility=compatibility)
        source = Path(request.get('source', ''))
        if action != 'restore' and source:
            source.unlink(missing_ok=True)
        return job

    def prepare_config_object(self, value):
        if not isinstance(value, dict) or not value:
            raise Failure('可视化配置根节点必须是非空对象')
        active = self.active()
        original = active.read_bytes() if active.is_file() else b''
        candidate = self.serialize(value, original)
        if len(candidate) > MAX_CONFIG:
            raise Failure('配置超过 10 MB')
        candidate, preview, compatibility = self.prepare_config_for_core(candidate)
        self.validated_api_details(preview)
        return candidate, preview, compatibility

    def validate_config_object(self, value):
        candidate, preview, compatibility = self.prepare_config_object(value)
        parsed = self.validate(candidate)
        return candidate, parsed, compatibility

    def submit_config_object(self, request):
        if not isinstance(request, dict):
            raise Failure('配置请求格式错误')
        action = request.get('action')
        if action not in ('save', 'apply'):
            raise Failure('不允许的可视化配置操作')
        target = self.target(request.get('target'))
        expected = request.get('expected')
        if not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected):
            raise Failure('缺少配置基线，请重新载入')
        old = target.read_bytes() if target.exists() else b''
        if digest(old) != expected:
            raise Failure('配置已被其他页面或后台更新，请重新载入')
        candidate, preview, compatibility = self.prepare_config_object(request.get('data'))
        api = self.validated_api_details(preview)
        return self.create_job(action, target.name, candidate,
                               expected=expected, api_port=api.get('port'), api=api,
                               compatibility=compatibility)

    def apply_config_job(self, job):
        folder = self.jobs / job['id']
        try:
            self.phase(job, 'preparing')
            return self._apply_config_job(job, folder)
        except Exception as exc:
            append_error_log('config-task', exc)
            return self.phase(job, 'failed', error=clean_error(exc))

    def _apply_config_job(self, job, folder):
        target = self.target(job['target'])
        candidate = (folder / 'candidate').read_bytes()
        candidate, candidate_config, compatibility = self.prepare_config_for_core(candidate)
        candidate_api = self.validated_api_details(candidate_config)
        new_config = self.validate(candidate)
        expected = job['expected']
        current = target.read_bytes() if target.exists() else b''
        if digest(current) != expected:
            raise Failure('配置在任务排队期间发生变化，已取消写入')
        active = self.active()
        is_active = target == active
        was_running = bool(self.pids())
        old_details = self.mode_details(active.read_bytes()) if active.is_file() else {'mode': 'custom'}
        new_details = self.mode_details(new_config)
        api = candidate_api
        old_api = self.api_details(active.read_bytes()) if active.is_file() else {}
        backup_name = self.backup_config(target.name) if target.exists() else ''
        network = None
        if job['action'] in ('apply', 'mode', 'restore') and is_active:
            network = self.network_snapshot(folder / 'network')
        journal = {'changed': False, 'backup': backup_name,
                   'target': target.name, 'is_active': is_active,
                   'was_running': was_running, 'network': str(network) if network else ''}
        write_json(folder / 'journal.json', journal)
        try:
            self.phase(job, 'writing')
            atomic(target, candidate, 0o600)
            journal['changed'] = True
            write_json(folder / 'journal.json', journal)
            if job['action'] in ('apply', 'mode', 'restore') and is_active and was_running:
                self.phase(job, 'network')
                mode = new_details.get('mode') or 'custom'
                if mode not in ('custom', 'unknown'):
                    if not self.mode_helper.exists():
                        raise Failure('模式管理脚本缺失')
                    self.run([self.mode_helper, 'apply', mode,
                              str(new_details.get('port') or 0), self.lan_interface(),
                              str(new_details.get('interface') or 'singtun0'),
                              str(new_details.get('udp_port') or '')], timeout=60)
                self.phase(job, 'restarting')
                self.restart_core(True, api.get('port'), details=new_details)
                self.phase(job, 'verifying')
            if job['action'] == 'mode':
                stored = read_json(self.state / 'mode-profiles.json', {})
                profiles = (stored.get('profiles')
                            if isinstance(stored, dict) and int(stored.get('version') or 0) >= 2
                            else stored)
                if not isinstance(profiles, dict):
                    profiles = {}
                config = self.parse(candidate)
                job_mode = job['mode']
                profile_type = 'ebpf' if job_mode in MODE_VARIANTS else job_mode
                profile = next((copy.deepcopy(item) for item in config.get('inbounds', [])
                                if isinstance(item, dict)
                                and item.get('type') == profile_type), {})
                profiles[job_mode] = profile
                if job_mode == 'redirect':
                    udp = next((copy.deepcopy(item) for item in config.get('inbounds', [])
                                if isinstance(item, dict)
                                and item.get('tag') == 'redirect-udp-in'), {})
                    profiles['redirect_udp'] = udp
                write_json(self.state / 'mode-profiles.json',
                           {'version': 2, 'profiles': profiles})
            if job['action'] == 'mode' and not was_running:
                message = '模式已保存，下次启动生效'
            elif was_running and is_active and job['action'] in ('apply', 'mode', 'restore'):
                message = '配置已应用'
            else:
                message = '配置已保存'
            return self.phase(job, 'done', message=message, backup=backup_name)
        except Exception as exc:
            try:
                self.phase(job, 'rolling_back', error=clean_error(exc))
                if journal.get('changed'):
                    if backup_name:
                        atomic(target, (self.backups / backup_name).read_bytes(), 0o600)
                    elif target.exists():
                        target.unlink()
                if network:
                    self.network_restore(Path(network))
                if was_running:
                    self.restart_core(True, old_api.get('port'), details=old_details)
                status = self.phase(job, 'rolled_back',
                                    error=clean_error(exc), message='已恢复原配置')
            except Exception as rollback_exc:
                append_error_log('config-rollback', rollback_exc)
                status = self.phase(job, 'rollback_failed',
                                    error=clean_error(exc), rollback_error=clean_error(rollback_exc))
            return status

    def worker(self):
        marker = read_json(self.state / ACTIVE_FILE, {})
        jid = marker.get('id')
        if not jid or not re.fullmatch(r'[a-f0-9]{32}', str(jid)):
            raise Failure('没有待执行任务')
        folder = self.jobs / jid
        job = read_json(folder / 'request.json')
        if not job:
            raise Failure('任务请求不存在')
        current = self.job(jid)
        if current and current.get('phase') in TERMINAL:
            return current
        with self.lock():
            if job['action'] in ('save', 'apply', 'mode', 'restore'):
                return self.apply_config_job(job)
            if job['action'] == 'kernel':
                return self.apply_kernel_job(job)
            raise Failure('未知任务类型')


    # ---- kernel, service and control-plane helpers ---------------------

    def openwrt_release(self):
        release = {}
        try:
            for line in (self.root / 'etc/openwrt_release').read_text(encoding='utf-8').splitlines():
                if '=' in line:
                    key, value = line.split('=', 1)
                    release[key] = value.strip().strip("'\"")
        except OSError:
            pass
        return release

    @staticmethod
    def loader_libc(name):
        name = str(name or '').lower()
        if re.search(r'(^|/)ld-musl-[^/]+\.so', name) or 'libc.musl-' in name:
            return 'musl'
        if re.search(r'(^|/)ld-linux[^/]*\.so', name) or re.search(r'(^|/)ld64\.so', name):
            return 'glibc'
        return ''

    def detect_libc(self):
        # The interpreter embedded in an executable is more reliable than
        # guessing from filenames, especially on 32/64-bit multiarch systems.
        for relative in ('bin/sh', 'usr/bin/python3', 'usr/bin/sing-box',
                         'usr/sbin/sing-box', 'bin/busybox'):
            candidate = self.root / relative
            if not candidate.is_file():
                continue
            try:
                info = self.elf_info(candidate)
            except (Failure, OSError):
                continue
            interp = info.get('interpreter', '')
            if interp:
                detected = self.loader_libc(interp)
                if detected:
                    return detected, 'ELF interpreter: ' + interp

        # Static executables have no interpreter. In that case look for the
        # dynamic loader actually shipped by the system in common lib dirs.
        loaders = []
        for relative in ('lib', 'lib64', 'lib32', 'usr/lib', 'usr/lib64'):
            folder = self.root / relative
            try:
                for item in folder.iterdir():
                    detected = self.loader_libc(item.name)
                    if detected:
                        loaders.append((detected, str(item)))
            except OSError:
                continue
        if loaders:
            detected, path = loaders[0]
            return detected, 'loader: ' + path
        return 'unknown', ''

    def platform(self):
        machine = (os.uname().machine if hasattr(os, 'uname') else
                   os.environ.get('PROCESSOR_ARCHITECTURE', '')).lower()
        arch_map = {
            'x86_64': ('amd64', 64, 'little'), 'amd64': ('amd64', 64, 'little'),
            'i386': ('386', 32, 'little'), 'i486': ('386', 32, 'little'),
            'i586': ('386', 32, 'little'), 'i686': ('386', 32, 'little'),
            'aarch64': ('arm64', 64, 'little'), 'arm64': ('arm64', 64, 'little'),
            'armv7l': ('armv7', 32, 'little'), 'armv7': ('armv7', 32, 'little'),
            'armv6l': ('armv6', 32, 'little'), 'mips': ('mips', 32, 'big'),
            'mipsel': ('mipsle', 32, 'little'), 'mips64': ('mips64', 64, 'big'),
            'mips64el': ('mips64le', 64, 'little'),
            'riscv64': ('riscv64', 64, 'little'),
            'loongarch64': ('loong64', 64, 'little'),
        }
        core_arch, bits, endian = arch_map.get(machine, (machine, 0, ''))
        libc, libc_source = self.detect_libc()
        return {
            'machine': machine, 'core_arch': core_arch, 'bits': bits,
            'endian': endian, 'libc': libc, 'libc_source': libc_source,
            'distrib_arch': self.openwrt_release().get('DISTRIB_ARCH', ''),
            'kernel': os.uname().release if hasattr(os, 'uname') else ''
        }



    def elf_info(self, executable):
        executable = Path(executable)
        try:
            with open(executable, 'rb') as stream:
                header = stream.read(64)
                if len(header) < 52 or header[:4] != b'\x7fELF':
                    raise Failure('文件不是有效的 ELF 内核')
                elf_class = {1: 32, 2: 64}.get(header[4], 0)
                byte_order = {1: 'little', 2: 'big'}.get(header[5], '')
                if elf_class not in (32, 64) or not byte_order:
                    raise Failure('ELF 文件头无效')
                endian = '<' if byte_order == 'little' else '>'
                machine = struct.unpack(endian + 'H', header[18:20])[0]
                if elf_class == 64:
                    phoff = struct.unpack(endian + 'Q', header[32:40])[0]
                    phentsize = struct.unpack(endian + 'H', header[54:56])[0]
                    phnum = struct.unpack(endian + 'H', header[56:58])[0]
                    min_entry = 56
                else:
                    phoff = struct.unpack(endian + 'I', header[28:32])[0]
                    phentsize = struct.unpack(endian + 'H', header[42:44])[0]
                    phnum = struct.unpack(endian + 'H', header[44:46])[0]
                    min_entry = 32
                interp = ''
                if 0 < phnum <= 128 and phentsize >= min_entry and phoff < (1 << 31):
                    stream.seek(phoff)
                    for _ in range(phnum):
                        entry = stream.read(phentsize)
                        if len(entry) < min_entry:
                            break
                        p_type = struct.unpack(endian + 'I', entry[:4])[0]
                        if p_type != 3:  # PT_INTERP
                            continue
                        if elf_class == 64:
                            offset = struct.unpack(endian + 'Q', entry[8:16])[0]
                            size = struct.unpack(endian + 'Q', entry[32:40])[0]
                        else:
                            offset = struct.unpack(endian + 'I', entry[4:8])[0]
                            size = struct.unpack(endian + 'I', entry[16:20])[0]
                        if 0 < size <= 4096:
                            stream.seek(offset)
                            raw = stream.read(size).split(b'\0', 1)[0]
                            interp = raw.decode('utf-8', 'replace').strip()
                        break
        except Failure:
            raise
        except (OSError, struct.error) as exc:
            raise Failure('无法读取内核文件：' + clean_error(exc)) from exc
        machine_names = {
            3: 'x86', 8: 'mips', 10: 'mips64', 40: 'arm', 62: 'x86_64',
            183: 'aarch64', 243: 'riscv64', 258: 'loongarch64'
        }
        interp_libc = self.loader_libc(interp)
        linkage = interp_libc if interp else 'static'
        return {'class': elf_class, 'endian': byte_order, 'machine': machine,
                'machine_name': machine_names.get(machine, str(machine)),
                'interpreter': interp, 'linkage': linkage}

    def check_elf(self, executable):
        info = self.elf_info(executable)
        platform = self.platform()
        expected = {
            'amd64': (62, 64, 'little'), '386': (3, 32, 'little'),
            'arm64': (183, 64, 'little'), 'armv7': (40, 32, 'little'),
            'armv6': (40, 32, 'little'), 'mipsle': (8, 32, 'little'),
            'mips64le': (10, 64, 'little'), 'riscv64': (243, 64, 'little'),
            'loong64': (258, 64, 'little')
        }.get(platform['core_arch'])
        if not expected:
            raise Failure('当前架构没有匹配的安全内核规则：' + platform['core_arch'])
        if (info['machine'], info['class'], info['endian']) != expected:
            raise Failure('内核架构不匹配：文件为 %s/%s-bit/%s-endian，设备需要 %s/%s-bit/%s-endian' % (
                info['machine_name'], info['class'], info['endian'],
                platform['core_arch'], expected[1], expected[2]))
        libc = self.platform()['libc']
        required = info.get('linkage', 'unknown')
        if libc in ('musl', 'glibc') and required in ('musl', 'glibc') and required != libc:
            raise Failure('内核依赖 %s，当前系统使用 %s' % (required, libc))
        return info

    def kernel_info(self):
        backups = []
        self.prune_backups(self.kernel_backups, KERNEL_BACKUP_LIMIT,
                           lambda n: bool(re.fullmatch(r'sing-box-[A-Za-z0-9._-]+-[a-f0-9]{8}', n)))
        try:
            for path in sorted(self.kernel_backups.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
                if path.is_file() and re.fullmatch(r'sing-box-[A-Za-z0-9._-]+-[a-f0-9]{8}', path.name):
                    meta = read_json(Path(str(path) + '.meta'), {})
                    backups.append({'name': path.name, 'size': path.stat().st_size,
                                    'time': int(path.stat().st_mtime),
                                    'version': meta.get('version', ''),
                                    'hash': meta.get('hash', '')})
        except OSError:
            pass
        try:
            binary = self.binary_key()
        except OSError:
            binary = {'path': str(self.bin), 'mtime_ns': 0, 'size': 0}
        backup_key = [[item['name'], item['time'], item['size']] for item in backups]
        cache_key = {'binary': binary, 'backups': backup_key, 'version': 3}
        cached = self.cache_get('kernel-info.json', key=cache_key)
        if isinstance(cached, dict) and cached.get('ok'):
            return cached
        exists = self.bin.is_file()
        version = self.core_version() if exists else ''
        ebpf_build = 'with_ebpf' in version if exists else False
        layout = self.ebpf_local_plane() if ebpf_build else {'plane': '', 'dialect': ''}
        result = {
            'ok': True, 'exists': exists,
            'path': str(self.bin), 'size': self.bin.stat().st_size if exists else 0,
            'hash': self.core_hash_short() if exists else '',
            'version': version,
            'core_family': self.core_family(version),
            'core_family_label': self.core_source_info(self.core_family(version))['label'],
            'core_sources': self.core_sources(),
            'ebpf_build': ebpf_build,
            'platform': self.platform(), 'backups': backups[:KERNEL_BACKUP_LIMIT],
            'ebpf': {'supported': ebpf_build, 'deferred': True,
                     'local_plane': layout.get('plane') or '',
                     'dialect': layout.get('dialect') or '',
                     'summary': ('构建标签包含 eBPF；本机数据面参数为 ' + layout['plane']
                                 if ebpf_build and layout.get('plane')
                                 else '构建标签包含 eBPF；运行能力请在诊断工具中验证' if ebpf_build
                                 else '当前内核不包含 eBPF 构建标签')}
        }
        self.cache_set('kernel-info.json', cache_key, result)
        return result

    def github_url(self, url, proxy=None):
        proxy = self.uci_get('github_proxy', '') if proxy is None else str(proxy)
        proxy = proxy.strip().rstrip('/')
        if not proxy:
            return url
        if '{url}' in proxy:
            return proxy.replace('{url}', urllib.parse.quote(url, safe=''))
        return proxy + '/' + url

    def github_json(self, url):
        import http.client
        import urllib.error
        import urllib.request
        headers = {'Accept': 'application/vnd.github+json',
                   'User-Agent': 'singbox-dash/1.0'}
        last_error = None
        for attempt in range(3):
            request = urllib.request.Request(self.github_url(url), headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=25) as response:
                    data = response.read(4 * 1024 * 1024)
                return json.loads(data.decode('utf-8'))
            except (urllib.error.URLError, OSError, ValueError,
                    UnicodeDecodeError, http.client.HTTPException) as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(0.8 * (attempt + 1))
                    continue
                break
        raise Failure('GitHub 请求失败：' + clean_error(last_error)) from last_error




    def download_url(self, url, target, limit=MAX_KERNEL):
        import urllib.error
        import urllib.request
        target = Path(target)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        headers = {'User-Agent': 'singbox-dash/1.0'}
        request = urllib.request.Request(self.github_url(url), headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=90) as response, open(target, 'wb') as stream:
                total = 0
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    total += len(block)
                    if total > limit:
                        raise Failure('下载文件超过大小限制')
                    stream.write(block)
                stream.flush()
                os.fsync(stream.fileno())
        except Failure:
            target.unlink(missing_ok=True)
            raise
        except (urllib.error.URLError, OSError, ValueError) as exc:
            target.unlink(missing_ok=True)
            raise Failure('下载失败：' + clean_error(exc)) from exc
        return target


    def safe_extract(self, source, folder):
        import tarfile
        import zipfile
        source = Path(source)
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        total = 0
        found = []

        def add_stream(name, stream, mode=0o700):
            nonlocal total
            child = folder / Path(name).name
            child = folder / (uuid.uuid4().hex[:8] + '-' + child.name)
            with open(child, 'wb') as output:
                while True:
                    block = stream.read(1024 * 1024)
                    if not block:
                        break
                    total += len(block)
                    if total > MAX_KERNEL:
                        raise Failure('解包内容超过 160 MB')
                    output.write(block)
            os.chmod(child, mode)
            if child.read_bytes()[:4] == b'\x7fELF':
                found.append(child)

        if source.read_bytes()[:4] == b'\x7fELF':
            target = folder / 'sing-box'
            shutil.copyfile(source, target)
            os.chmod(target, 0o700)
            return target
        if zipfile.is_zipfile(source):
            with zipfile.ZipFile(source) as archive:
                for info in archive.infolist():
                    name = info.filename
                    if info.is_dir():
                        continue
                    if name.startswith('/') or '..' in Path(name).parts:
                        raise Failure('压缩包包含不安全路径')
                    if info.file_size > MAX_KERNEL or (info.external_attr >> 16) & 0o170000 == stat.S_IFLNK:
                        continue
                    with archive.open(info) as stream:
                        add_stream(name, stream)
        elif tarfile.is_tarfile(source):
            with tarfile.open(source, 'r:*') as archive:
                for member in archive:
                    if not member.isfile() or member.issym() or member.islnk():
                        continue
                    if member.name.startswith('/') or '..' in Path(member.name).parts:
                        raise Failure('压缩包包含不安全路径')
                    stream = archive.extractfile(member)
                    if stream:
                        add_stream(member.name, stream)
        elif source.suffix.lower() in ('.gz', '.gzip'):
            with gzip.open(source, 'rb') as stream:
                add_stream('sing-box', stream)
        else:
            raise Failure('仅支持 ELF、tar.gz、tgz 或 zip 内核文件')
        if not found:
            raise Failure('压缩包中未找到 ELF 内核')
        if len(found) > 1:
            preferred = [item for item in found if 'sing-box' in item.name.lower()]
            found = preferred or found
        return max(found, key=lambda item: item.stat().st_size)

    def prepare_kernel(self, source, folder, release=None):
        source = Path(source)
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        if source.stat().st_size > MAX_KERNEL:
            raise Failure('内核文件超过 160 MB')
        if source.read_bytes()[:4] == b'\x7fELF':
            kernel = folder / 'sing-box'
            shutil.copyfile(source, kernel)
            os.chmod(kernel, 0o700)
        else:
            kernel = self.safe_extract(source, folder / 'extract')
        info = self.check_elf(kernel)
        result = self.run([kernel, 'version'], timeout=25, check=False)
        version = (result.stdout + b'\n' + result.stderr).decode('utf-8', 'replace').strip()
        if result.returncode or not re.search(r'(?i)sing-box\s+version\s+\d+\.\d+', version):
            raise Failure('内核无法运行：' + clean_error(version))
        active = self.active()
        if active.is_file():
            self.validate(active.read_bytes(), executable=kernel)
        return kernel, version, info

    def backup_kernel(self):
        if not self.bin.is_file():
            return ''
        data = self.bin.read_bytes()
        version = re.sub(r'[^A-Za-z0-9._-]+', '-', self.core_version() or 'unknown')[:70]
        name = 'sing-box-%s-%s' % (version, digest(data)[:8])
        target = self.kernel_backups / name
        atomic(target, data, 0o700)
        write_json(Path(str(target) + '.meta'), {
            'version': self.core_version(), 'hash': digest(data),
            'time': int(time.time()), 'size': len(data)
        })
        self.prune_backups(self.kernel_backups, KERNEL_BACKUP_LIMIT,
                           lambda n: bool(re.fullmatch(r'sing-box-[A-Za-z0-9._-]+-[a-f0-9]{8}', n)))
        return name

    def install_kernel(self, source, folder, release=None):
        kernel, version, elf = self.prepare_kernel(source, folder, release)
        was_running = bool(self.pids())
        active = self.active()
        old_details = self.mode_details(active.read_bytes()) if active.is_file() else {'mode': 'custom'}
        api = self.api_details(active.read_bytes()) if active.is_file() else {}
        had_binary = self.bin.is_file()
        original_hash = file_digest(self.bin) if had_binary else ''
        backup = self.backup_kernel() if had_binary else ''
        journal = {'changed': False, 'backup': backup, 'was_running': was_running,
                   'had_binary': had_binary, 'rollback_ok': False,
                   'original_hash': original_hash, 'version': version, 'elf': elf}
        write_json(folder / 'journal.json', journal)
        try:
            atomic(self.bin, kernel.read_bytes(), 0o755)
            journal['changed'] = True
            write_json(folder / 'journal.json', journal)
            installed = self.run([self.bin, 'version'], timeout=25, check=False)
            if installed.returncode:
                raise Failure('安装后的内核无法运行')
            installed_version = (installed.stdout + b'\n' + installed.stderr).decode(
                'utf-8', 'replace').strip()
            if not re.search(r'(?i)sing-box\s+version\s+\d+\.\d+', installed_version):
                raise Failure('安装后的内核版本输出无效')
            self.check_elf(self.bin)
            if active.is_file():
                self.validate(active.read_bytes())
            self.restart_core(was_running, api.get('port'), details=old_details)
            journal['installed_hash'] = file_digest(self.bin)
            write_json(folder / 'journal.json', journal)
            return installed_version
        except Exception as exc:
            rollback_ok = True
            try:
                if journal['changed']:
                    if backup:
                        atomic(self.bin, (self.kernel_backups / backup).read_bytes(), 0o755)
                    else:
                        self.bin.unlink(missing_ok=True)
                    if had_binary and (not self.bin.is_file()
                                       or file_digest(self.bin) != original_hash):
                        raise Failure('恢复后的内核哈希与原文件不一致')
                self.restart_core(was_running, api.get('port'), details=old_details)
            except Exception as rollback_exc:
                rollback_ok = False
                journal['rollback_error'] = clean_error(rollback_exc)
            journal['rollback_ok'] = bool(rollback_ok)
            write_json(folder / 'journal.json', journal)
            if not rollback_ok:
                raise Failure(clean_error(exc) + '；自动恢复失败：' +
                              journal.get('rollback_error', '未知原因')) from exc
            raise exc

    def apply_kernel_job(self, job):
        folder = self.jobs / job['id']
        descriptor = read_json(folder / 'candidate', {})
        try:
            self.phase(job, 'preparing')
            release = None
            source = None
            if isinstance(descriptor, dict) and descriptor.get('kind') == 'release':
                release_source = descriptor.get('source') or self.core_family()
                releases = self.releases('all', source=release_source)
                release = next((item for item in releases if item['tag'] == descriptor.get('tag')), None)
                if not release:
                    raise Failure('目标 Release 不存在')
                asset, reason = self.choose_asset(release, descriptor.get('asset', ''))
                self.phase(job, 'downloading', message=asset['name'], reason=reason)
                source = self.download_url(asset['download'], folder / 'download.tar.gz')
                expected = self.release_checksum(release, asset['name'], folder)
                if not expected:
                    raise Failure('Release 缺少目标内核的 SHA256 校验值')
                if file_digest(source) != expected:
                    raise Failure('内核 SHA256 校验失败')
                self.phase(job, 'installing', message='SHA256 校验通过')
            else:
                source = folder / 'candidate'
            version = self.install_kernel(source, folder, release)
            try:
                self.probe_mode_capabilities(version)
            except Exception as exc:
                append_error_log('kernel-capabilities', exc)
            return self.phase(job, 'done', message='内核已更新', version=version,
                              backup=read_json(folder / 'journal.json', {}).get('backup', ''))
        except Exception as exc:
            journal = read_json(folder / 'journal.json', {})
            if not journal.get('changed'):
                return self.phase(job, 'failed', error=clean_error(exc),
                                  message='内核安装失败，现有内核未被修改')
            if journal.get('rollback_ok'):
                if journal.get('had_binary'):
                    return self.phase(job, 'rolled_back', error=clean_error(exc),
                                      message='内核更新失败，已恢复原版本')
                return self.phase(job, 'failed', error=clean_error(exc),
                                  message='内核安装失败，未留下半安装文件')
            return self.phase(job, 'rollback_failed', error=clean_error(exc),
                              message='内核更新失败，且自动恢复失败')

    def rollback_kernel(self, name):
        if not re.fullmatch(r'sing-box-[A-Za-z0-9._-]+-[a-f0-9]{8}', str(name or '')):
            raise Failure('内核备份名称不合法')
        source = self.kernel_backups / name
        if not source.is_file():
            raise Failure('内核备份不存在')
        backup = source.read_bytes()
        folder = self.state / 'kernel-rollback-' + uuid.uuid4().hex
        folder.mkdir(parents=True, mode=0o700)
        atomic(folder / 'candidate', backup, 0o700)
        try:
            version = self.install_kernel(folder / 'candidate', folder)
        finally:
            shutil.rmtree(folder, ignore_errors=True)
        return {'ok': True, 'version': version, 'message': '已恢复 ' + name}

    def activate_config(self, name):
        target = self.target(name)
        if not target.is_file():
            raise Failure('目标配置不存在')
        raw = target.read_bytes()
        prepared, config, compatibility = self.prepare_config_for_core(raw)
        self.validate(prepared)
        if prepared != raw:
            self.backup_config(target.name)
            atomic(target, prepared, 0o600)
        active = self.active()
        if target == active:
            return {'ok': True, 'active': target.name,
                    'compatibility': compatibility}
        previous_file = self.uci_file.read_bytes() if self.uci_file.is_file() else None
        was_running = bool(self.pids())
        details = self.mode_details(config)
        old_details = self.mode_details(active.read_bytes()) if active.is_file() else {'mode': 'custom'}
        old_api = self.api_details(active.read_bytes()) if active.is_file() else {}
        snapshot = self.network_snapshot(self.state / ('activate-' + uuid.uuid4().hex)) if was_running else None
        try:
            if was_running and details.get('mode') not in ('custom', 'unknown'):
                self.run([self.mode_helper, 'apply', details.get('mode'),
                          str(details.get('port') or 0), self.lan_interface(),
                          str(details.get('interface') or 'singtun0'),
                          str(details.get('udp_port') or '')], timeout=60)
            self.run(['uci', 'set', 'sing-box.main.conffile=' + str(target)], timeout=8)
            self.run(['uci', 'commit', 'sing-box'], timeout=8)
            if was_running:
                self.restart_core(True, self.api_details(target.read_bytes()).get('port'),
                                  details=details)
        except Exception as exc:
            try:
                if previous_file is None:
                    self.uci_file.unlink(missing_ok=True)
                else:
                    atomic(self.uci_file, previous_file, 0o600)
                self.run(['uci', 'commit', 'sing-box'], timeout=8, check=False)
                if snapshot:
                    self.network_restore(snapshot)
                if was_running:
                    self.restart_core(True, old_api.get('port'), details=old_details)
            except Exception as rollback_exc:
                append_error_log('activate-config-rollback', rollback_exc)
                raise Failure(clean_error(exc) + '；自动恢复失败：' + clean_error(rollback_exc)) from exc
            finally:
                if snapshot:
                    shutil.rmtree(snapshot, ignore_errors=True)
            raise
        if snapshot:
            shutil.rmtree(snapshot, ignore_errors=True)
        return {'ok': True, 'active': target.name,
                'compatibility': compatibility}

    def uci_get_file(self):
        result = self.run(['uci', '-q', 'get', 'sing-box.main.conffile'], timeout=8, check=False)
        return result.stdout.decode('utf-8', 'replace').strip()

    def active_mode(self, config_path):
        if not config_path.is_file():
            return {'mode': 'custom', 'port': None, 'udp_port': None, 'interface': ''}
        return self.mode_details(config_path.read_bytes())

    def service_action(self, action):
        if action not in ('start', 'stop', 'restart', 'enable', 'disable'):
            raise Failure('不支持的服务操作')
        active = self.active()
        details = {'mode': 'custom', 'port': None, 'udp_port': None, 'interface': ''}
        api = {}
        compatibility = {}
        if action in ('start', 'restart'):
            if not active.is_file():
                raise Failure('当前配置不存在')
            raw = active.read_bytes()
            prepared, config, compatibility = self.prepare_config_for_core(raw)
            self.validate(prepared)
            if prepared != raw:
                self.backup_config(active.name)
                atomic(active, prepared, 0o600)
            details = self.mode_details(config)
            api = self.api_details(config)
            self.run(['uci', 'set', 'sing-box.main.conffile=' + str(active)], timeout=8, check=False)
            self.run(['uci', 'commit', 'sing-box'], timeout=8, check=False)
        was_running = bool(self.pids())
        snapshot = None
        try:
            if action in ('start', 'restart'):
                snapshot = self.network_snapshot(self.state / ('service-' + uuid.uuid4().hex))
                self.prepare_core_runtime(details)
            service_env = self.env.copy()
            service_env['SINGBOX_DASH_PREPARED'] = '1'
            result = self.run([self.core_service_init(), action], timeout=70, check=False,
                              env=service_env)
            if result.returncode:
                raise Failure(clean_error((result.stderr or result.stdout).decode('utf-8', 'replace'))
                              or ('服务操作失败：' + action))
            if action in ('start', 'restart'):
                self.wait_for_core(api.get('port'), timeout=35, details=details)
                self.record_mode_runtime(details, True, '实际启动并运行成功')
            elif action == 'stop':
                if self.mode_helper.exists():
                    self.run([self.mode_helper, 'clear-live'], timeout=35, check=False)
                deadline = time.time() + 12
                while self.pids() and time.time() < deadline:
                    time.sleep(1)
                if self.pids():
                    raise Failure('停止操作后 sing-box 进程仍然存在')
        except Exception as exc:
            if action in ('start', 'restart'):
                self.record_mode_runtime(details, False, exc)
            if snapshot:
                self.network_restore(snapshot)
            if action == 'start' and not was_running and self.pids():
                self.run([self.core_service_init(), 'stop'], timeout=35, check=False)
            if was_running and action in ('start', 'restart'):
                try:
                    self.restart_core(True, api.get('port'), details=details)
                except Exception as rollback_exc:
                    append_error_log('service-rollback', rollback_exc)
            raise
        finally:
            if snapshot:
                shutil.rmtree(snapshot, ignore_errors=True)
        return {'ok': True, 'action': action, 'running': bool(self.pids()),
                'enabled': self.core_service_enabled(),
                'service': str(self.core_service_init()),
                'compatibility': compatibility}

    def recent_logs(self, limit=300):
        def tail(path, count):
            try:
                return '\n'.join(Path(path).read_text(encoding='utf-8', errors='replace')
                                 .splitlines()[-count:])
            except OSError:
                return ''
        runtime = tail(self.root / 'var/log/sing-box.log', limit)
        lr = self.run(['logread', '-e', 'sing-box'], timeout=8, check=False)
        system = '\n'.join(lr.stdout.decode('utf-8', 'replace').splitlines()[-120:])
        errors = tail(self.state / 'errors.log', 160)
        errors = '\n'.join(line for line in errors.splitlines()
                           if not re.search(r'(?:未知命令：\s*$|empty-command:\s*缺少操作命令\s*$)', line))
        sections = []
        if runtime:
            sections.append('[sing-box 运行日志]\n' + runtime)
        if system:
            sections.append('[sing-box 系统日志]\n' + system)
        if errors:
            sections.append('[LuCI / sing-box 配置错误]\n' + errors)
        return {'ok': True, 'data': '\n\n'.join(sections) or '暂无 sing-box 日志'}


    def clash_request(self, request, config=None):
        import http.client
        if not isinstance(request, dict):
            raise Failure('API 请求格式错误')
        method = str(request.get('method') or 'GET').upper()
        path = str(request.get('path') or '')
        body = request.get('body')
        if method not in ('GET', 'PUT', 'PATCH', 'DELETE'):
            raise Failure('不允许的 API 方法')
        allowed = (path in ('/version', '/proxies', '/providers/proxies', '/configs',
                            '/rules', '/connections', '/providers/rules')
                   or re.fullmatch(r'/proxies/[^/?#]+/delay\?[^#]*', path)
                   or re.fullmatch(r'/group/[^/?#]+/delay\?[^#]*', path)
                   or re.fullmatch(r'/proxies/[^/?#]+', path)
                   or re.fullmatch(r'/connections/[^/?#]+', path))
        if not allowed:
            raise Failure('不允许的 API 路径')
        active = self.active()
        if not active.is_file():
            raise Failure('当前配置不存在')
        # Parse the running configuration once instead of reading and parsing
        # the same file twice for every Clash API request.
        if not isinstance(config, dict):
            config = self.parse(active.read_bytes())
        details = self.validated_api_details(config)
        if not details.get('enabled'):
            raise Failure('配置中未启用 Clash API')
        if not details.get('port'):
            raise Failure('Clash API 地址缺少端口')
        host = self.clash_connect_host(details)
        api = (((config.get('experimental') or {}).get('clash_api'))
               or config.get('clash_api') or {})
        headers = {'Accept': 'application/json', 'User-Agent': 'singbox-dash/1.0'}
        secret = str(api.get('secret') or '')
        if secret:
            headers['Authorization'] = 'Bearer ' + secret
        payload = None
        if body is not None:
            payload = json.dumps(body, ensure_ascii=False).encode()
            headers['Content-Type'] = 'application/json'
        connection_class = (http.client.HTTPSConnection
                            if details.get('scheme') == 'https'
                            else http.client.HTTPConnection)
        connection = connection_class(host, int(details['port']), timeout=6)
        try:
            connection.request(method, path, body=payload, headers=headers)
            response = connection.getresponse()
            raw = response.read(2 * 1024 * 1024)
            if response.status in (401, 403):
                raise Failure('Clash API 认证失败，请检查配置中的 secret')
            if response.status >= 400:
                raise Failure('Clash API 返回 HTTP %s' % response.status)
            if not raw:
                return {'ok': True, 'status': response.status}
            value = json.loads(raw.decode('utf-8'))
            if method == 'GET' and path == '/proxies' and isinstance(value, dict):
                # The dashboard only needs group relationships, node type and
                # the latest delay history. Drop provider and protocol metadata
                # that can make the UBus reply several megabytes.
                compact = {}
                for name, item in (value.get('proxies') or {}).items():
                    if not isinstance(item, dict):
                        continue
                    node = {'name': item.get('name') or name,
                            'type': item.get('type') or 'Unknown'}
                    for key in ('now', 'all'):
                        if key in item:
                            node[key] = item[key]
                    history = item.get('history')
                    if isinstance(history, list) and history:
                        node['history'] = history[-1:]
                    compact[name] = node
                value = {'proxies': compact}
            return value
        except Failure:
            raise
        except (OSError, ValueError, http.client.HTTPException) as exc:
            raise Failure('Clash API 请求失败：' + clean_error(exc)) from exc
        finally:
            connection.close()

    def trace_target_parts(self, value):
        raw = str(value or '').strip()
        if not raw:
            raise Failure('请输入 IP 或域名')
        if len(raw) > 2048:
            raise Failure('输入内容过长')
        port = 443
        host = raw
        try:
            address = ipaddress.ip_address(raw.strip('[]'))
            host = str(address)
        except ValueError:
            parsed = urllib.parse.urlsplit(raw if '://' in raw else '//' + raw)
            host = parsed.hostname or ''
            try:
                port = parsed.port or (80 if parsed.scheme.lower() == 'http' else 443)
            except ValueError as exc:
                raise Failure('端口格式不正确') from exc
        host = str(host or '').strip().rstrip('.').strip('[]')
        if not host:
            raise Failure('无法识别输入的 IP 或域名')
        try:
            address = ipaddress.ip_address(host)
            return {'kind': 'ip', 'display': host, 'match': str(address), 'port': port, 'network': 'tcp'}
        except ValueError:
            pass
        try:
            ascii_host = host.encode('idna').decode('ascii').lower()
        except UnicodeError as exc:
            raise Failure('域名格式不正确') from exc
        pattern = r'^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$'
        if not re.fullmatch(pattern, ascii_host, re.I):
            raise Failure('请输入有效的 IP、域名或 URL')
        return {'kind': 'domain', 'display': host, 'match': ascii_host, 'port': port, 'network': 'tcp'}

    def trace_rulesets(self, config):
        result = {}
        route = config.get('route') if isinstance(config.get('route'), dict) else {}
        entries = route.get('rule_set') if isinstance(route.get('rule_set'), list) else []
        conf_root = self.conf.resolve()
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            tags = entry.get('tag')
            if isinstance(tags, str):
                tags = [tags]
            if not isinstance(tags, list):
                continue
            template = str(entry.get('path') or '')
            if not template:
                continue
            fmt = str(entry.get('format') or 'source').lower()
            for tag in tags:
                if not isinstance(tag, str) or not tag:
                    continue
                candidate = Path(template.replace('{tag}', tag))
                if not candidate.is_absolute():
                    candidate = self.conf / candidate
                try:
                    resolved = candidate.resolve()
                    resolved.relative_to(conf_root)
                except (OSError, ValueError):
                    continue
                if resolved.is_file():
                    result[tag] = {'path': resolved, 'format': fmt if fmt in ('source', 'binary') else 'source'}
        return result

    @staticmethod
    def trace_port_match(payload, port):
        for item in str(payload or '').split(','):
            token = item.strip()
            if not token:
                continue
            try:
                if '-' in token:
                    start, end = token.split('-', 1)
                    if int(start) <= port <= int(end):
                        return True
                elif int(token) == port:
                    return True
            except ValueError:
                continue
        return False

    @staticmethod
    def trace_domain_match(kind, value, payload):
        if kind != 'domain':
            return False
        patterns = [part.strip().strip('.').lower() for part in str(payload or '').split(',') if part.strip()]
        return any(value == pattern or value.endswith('.' + pattern) for pattern in patterns)

    @staticmethod
    def trace_ip_match(kind, value, payload):
        if kind != 'ip':
            return False
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            return False
        for item in str(payload or '').split(','):
            try:
                if address in ipaddress.ip_network(item.strip(), strict=False):
                    return True
            except ValueError:
                continue
        return False

    def trace_rule_match(self, rule, target, mode, rulesets, ruleset_cache):
        if not isinstance(rule, dict):
            return None, ''
        rule_type = str(rule.get('type') or '').lower()
        payload = str(rule.get('payload') or '')
        kind = target['kind']
        value = target['match']
        if rule_type == 'domain':
            if kind != 'domain':
                return False, ''
            exact = {part.strip().strip('.').lower() for part in payload.split(',') if part.strip()}
            return value in exact, ''
        if rule_type == 'domainsuffix':
            return self.trace_domain_match(kind, value, payload), ''
        if rule_type == 'domainkeyword':
            if kind != 'domain':
                return False, ''
            return any(keyword.strip().lower() in value for keyword in payload.split(',') if keyword.strip()), ''
        if rule_type == 'domainregex':
            if kind != 'domain':
                return False, ''
            patterns = [payload] + ([part.strip() for part in payload.split(',') if part.strip()] if ',' in payload else [])
            for pattern in patterns:
                try:
                    if re.search(pattern, value, re.I):
                        return True, ''
                except re.error:
                    continue
            return False, ''
        if rule_type == 'ipcidr':
            return self.trace_ip_match(kind, value, payload), ''
        if rule_type == 'ipisprivate':
            if kind != 'ip':
                return False, ''
            try:
                return ipaddress.ip_address(value).is_private, ''
            except ValueError:
                return False, ''
        if rule_type == 'dstport':
            return self.trace_port_match(payload, target['port']), ''
        if rule_type == 'network':
            networks = {item.strip().lower() for item in payload.split(',') if item.strip()}
            return target['network'] in networks, ''
        if rule_type == 'clashmode':
            wanted = payload.strip().lower()
            return wanted in (mode, mode.lower()), ''
        if rule_type == 'match':
            return True, ''
        if rule_type == 'ruleset':
            tag = payload.strip()
            if tag in ruleset_cache:
                return ruleset_cache[tag]
            info = rulesets.get(tag)
            if not info:
                ruleset_cache[tag] = (None, '')
                return None, ''
            result = self.run([self.bin, 'rule-set', 'match', info['path'], value,
                               '--format', info['format']], timeout=8, check=False)
            detail = (result.stdout + result.stderr).decode('utf-8', 'replace').strip()
            if result.returncode or not detail.startswith('match'):
                ruleset_cache[tag] = (False, '')
                return False, ''
            detail = re.sub(r'\s+', ' ', detail.replace('=<binary>', ''))[:240]
            ruleset_cache[tag] = (True, detail)
            return True, detail
        return None, ''

    def trace_ruleset_matches(self, target, rulesets, tags):
        from concurrent.futures import ThreadPoolExecutor, as_completed
        tags = sorted({str(tag) for tag in tags if tag})
        if not tags:
            return {}

        def check(tag):
            info = rulesets.get(tag)
            if not info:
                return tag, (None, '')
            result = self.run([self.bin, 'rule-set', 'match', info['path'], target['match'],
                               '--format', info['format']], timeout=10, check=False)
            detail = (result.stdout + result.stderr).decode('utf-8', 'replace').strip()
            if result.returncode or not detail.startswith('match'):
                return tag, (False, '')
            detail = re.sub(r'\s+', ' ', detail.replace('=<binary>', ''))[:240]
            return tag, (True, detail)

        cache = {}
        with ThreadPoolExecutor(max_workers=min(8, len(tags))) as pool:
            futures = [pool.submit(check, tag) for tag in tags]
            for future in as_completed(futures):
                try:
                    tag, value = future.result()
                except Exception:
                    continue
                cache[tag] = value
        return cache

    def trace_proxy_chain(self, proxies, outbound):
        current = str(outbound or 'DIRECT')
        chain = []
        seen = set()
        special = {'direct': 'direct', 'reject': 'reject', 'bypass': 'bypass'}
        while current and current not in seen:
            seen.add(current)
            item = proxies.get(current) if isinstance(proxies, dict) else None
            if not isinstance(item, dict):
                key = current.lower()
                chain.append({'name': current, 'type': special.get(key, 'Outbound').upper(),
                              'kind': special.get(key, 'outbound')})
                break
            is_group = isinstance(item.get('all'), list) or bool(item.get('now'))
            chain.append({'name': current, 'type': str(item.get('type') or 'Unknown'),
                          'kind': 'group' if is_group else 'node'})
            if not is_group:
                break
            next_name = str(item.get('now') or '')
            if not next_name or next_name in seen:
                break
            current = next_name
        if not chain:
            chain.append({'name': str(outbound or 'DIRECT'), 'type': 'Outbound', 'kind': 'outbound'})
        return {'chain': chain, 'final': chain[-1]['name']}

    def trace_target(self, value):
        target = self.trace_target_parts(value)
        active = self.active()
        if not active.is_file():
            raise Failure('当前配置不存在')
        config = self.parse(active.read_bytes())
        rulesets = self.trace_rulesets(config)
        rules_response = self.clash_request({'method': 'GET', 'path': '/rules'}, config)
        rules = rules_response.get('rules') if isinstance(rules_response, dict) else []
        if not isinstance(rules, list):
            rules = []
        try:
            configs = self.clash_request({'method': 'GET', 'path': '/configs'}, config)
            mode = str(configs.get('mode') or 'rule').lower()
        except Failure:
            mode = 'rule'
        matched = None
        skipped = 0
        ruleset_tags = {
            str(item.get('payload') or '')
            for item in rules
            if isinstance(item, dict) and str(item.get('type') or '').lower() == 'ruleset'
        }
        ruleset_cache = self.trace_ruleset_matches(target, rulesets, ruleset_tags)
        for item in rules:
            result, detail = self.trace_rule_match(item, target, mode, rulesets, ruleset_cache)
            if result is None:
                skipped += 1
                continue
            if not result:
                continue
            matched = {
                'index': item.get('index'),
                'type': str(item.get('type') or ''),
                'payload': str(item.get('payload') or ''),
                'proxy': str(item.get('proxy') or item.get('target') or ''),
                'detail': detail,
            }
            break
        if matched is None:
            route = config.get('route') if isinstance(config.get('route'), dict) else {}
            matched = {'index': None, 'type': 'Final', 'payload': '', 'proxy': str(route.get('final') or 'DIRECT'),
                       'detail': '未命中显式规则，使用最终出站'}
        proxies_response = self.clash_request({'method': 'GET', 'path': '/proxies'}, config)
        proxies = proxies_response.get('proxies') if isinstance(proxies_response, dict) else {}
        resolved = self.trace_proxy_chain(proxies, matched.get('proxy'))
        return {
            'ok': True,
            'query': target['display'],
            'kind': target['kind'],
            'mode': mode,
            'port': target['port'],
            'network': target['network'],
            'matched': matched,
            'chain': resolved['chain'],
            'final': resolved['final'],
            'skipped': skipped,
            'assumptions': [
                '按 TCP/%d 模拟匹配' % target['port'],
                '未模拟客户端来源、进程条件和 DNS 解析结果',
            ],
        }


    def bootstrap(self, include_overview=False):
        result = {'ok': True, 'settings': self.settings_get()['settings'],
                  'status': self.status()}
        if include_overview:
            result['overview'] = self.overview()
        return result

    def overview(self, rate_interval=0.35):
        """Return dashboard data and a short live traffic sample."""
        active = self.active()
        if not active.is_file():
            raise Failure('当前配置不存在')
        config = self.parse(active.read_bytes())
        pids = self.pids()
        providers = None
        provider_error = ''
        try:
            providers = self.provider_status(config)
        except Failure as exc:
            provider_error = clean_error(exc)

        traffic = None
        traffic_rate = None
        traffic_error = ''
        if pids:
            try:
                before = self.clash_request(
                    {'method': 'GET', 'path': '/connections'}, config)
                started = time.monotonic()
                time.sleep(max(0.0, float(rate_interval)))
                traffic = self.clash_request(
                    {'method': 'GET', 'path': '/connections'}, config)
                elapsed = max(0.001, time.monotonic() - started)
                traffic_rate = {
                    'upload': max(0, int(traffic.get('uploadTotal') or 0)
                                  - int(before.get('uploadTotal') or 0)) / elapsed,
                    'download': max(0, int(traffic.get('downloadTotal') or 0)
                                    - int(before.get('downloadTotal') or 0)) / elapsed,
                    'sample_seconds': elapsed,
                }
            except (Failure, OSError, ValueError) as exc:
                traffic = None
                traffic_rate = None
                traffic_error = clean_error(exc)
        else:
            traffic_error = '受管内核未运行'
        return {
            'ok': True,
            'running': bool(pids),
            'providers': providers,
            'provider_error': provider_error,
            'traffic': traffic,
            'traffic_rate': traffic_rate,
            'traffic_error': traffic_error,
        }

    def config_get(self, name=''):
        target = self.target(name)
        if not target.is_file():
            raise Failure('配置不存在')
        cache_key = {'version': 2, 'name': target.name,
                     'file': self.file_signature(target),
                     'kernel': self.binary_revision()}
        cached = self.cache_get('config-get.json', key=cache_key)
        if isinstance(cached, dict) and cached.get('ok'):
            result = copy.deepcopy(cached)
            result['read_cached'] = True
            return result
        data = target.read_bytes()
        if len(data) > MAX_CONFIG:
            raise Failure('配置超过 10 MB')
        parsed = self.parse(data)
        result = {'ok': True, 'name': target.name, 'hash': digest(data),
                  'active': target == self.active(),
                  'data': data.decode('utf-8', 'replace'), 'parsed': parsed,
                  'core_family': self.core_family(),
                  'core_family_label': self.core_source_info()['label'],
                  'mode': self.mode_details(parsed), 'api': self.api_details(parsed),
                  'read_cached': False}
        self.cache_set('config-get.json', cache_key, result)
        return result

    def config_bundle(self, name='', include_schema=True):
        active = self.active()
        target = self.target(name) if name else active
        if not target.is_file():
            raise Failure('配置不存在')
        pid = self.primary_pid()
        runtime = self.active(pid) if pid else None
        backups = self.backup_list()
        backup_key = [[item.get('name'), item.get('time'), item.get('size')]
                      for item in backups]
        subscription_file = self.conf / ('url_' + target.name)
        update_interval = self.uci_get('update_interval', '0')
        cache_key = {
            'version': 2, 'name': target.name,
            'file': self.file_signature(target),
            'kernel': self.binary_revision(),
            'backups': backup_key,
            'subscription_file': self.file_signature(subscription_file),
            'update_interval': update_interval,
            'runtime': str(runtime) if runtime else ''
        }
        cached = self.cache_get('config-bundle.json', key=cache_key)
        runtime_match = bool(runtime and runtime == target)
        if isinstance(cached, dict) and cached.get('ok'):
            result = copy.deepcopy(cached)
            result['read_cached'] = True
            result['runtime_match'] = runtime_match
            return result
        data = target.read_bytes()
        if len(data) > MAX_CONFIG:
            raise Failure('配置超过 10 MB')
        parsed = self.parse(data)
        slots = [{'name': slot, 'active': slot == active.name,
                  'size': (self.conf / slot).stat().st_size}
                 for slot in self.slot_names()]
        result = {
            'ok': True,
            # Full Schema is intentionally served by its own RPC. Combining
            # Schema and config in one UBus reply exceeds the RPC size limit.
            'schema': None,
            'kernel_key': self.binary_revision(),
            'core_family': self.core_family(),
            'core_family_label': self.core_source_info()['label'],
            'repository': self.core_source_info()['repo'],
            'slots': slots,
            'config': {
                'ok': True, 'name': target.name, 'hash': digest(data),
                'active': target == active,
                'data': data.decode('utf-8', 'replace'), 'parsed': parsed,
                'mode': self.mode_details(parsed), 'api': self.api_details(parsed)
            },
            'backups': backups,
            'subscription': self.subscription_info(active),
            'read_cached': False,
            'runtime_match': runtime_match
        }
        self.cache_set('config-bundle.json', cache_key, result)
        return result

    def detect_singbox_dns_port(self):
        try:
            path = self.active()
            if not path.is_file():
                return ''
            config = self.parse(path.read_bytes())
        except Exception:
            return ''
        candidates = []
        for index, inbound in enumerate(config.get('inbounds') or []):
            if not isinstance(inbound, dict):
                continue
            try:
                port = int(inbound.get('listen_port'))
            except (TypeError, ValueError):
                continue
            if port < 1 or port > 65535:
                continue
            tag = str(inbound.get('tag') or '').lower()
            kind = str(inbound.get('type') or '').lower()
            listen = str(inbound.get('listen') or '').lower()
            score = 0
            if 'dns' in tag:
                score += 100
            if kind == 'dns':
                score += 80
            if kind == 'direct' and listen in ('127.0.0.1', '::1', 'localhost'):
                score += 30
            if score:
                candidates.append((score, -index, port))
        return str(max(candidates)[2]) if candidates else ''

    def settings_get(self):
        page = self.uci_get('default_page', 'overview')
        if page not in ('overview', 'proxies', 'subscriptions', 'connections', 'trace', 'rules', 'config', 'kernel', 'tools'):
            page = 'overview'
        return {'ok': True, 'settings': {
            'enabled': self.uci_get('enabled', '1'),
            'default_page': page,
            'update_interval': self.uci_get('update_interval', '0'),
            'prefer_ebpf': self.uci_get('prefer_ebpf', 'auto'),
            'github_proxy': self.uci_get('github_proxy', ''),
            'dns_failover': self.uci_get('dns_failover', '1'),
            'dns_singbox_port': self.uci_get('dns_singbox_port', ''),
            'dns_singbox_port_detected': self.detect_singbox_dns_port(),
            'dns_backup_port': self.uci_get('dns_backup_port', '') or self.uci_get('dns_smartdns_port', '1153'),
            'dns_fallback_server': self.uci_get('dns_fallback_server', '223.5.5.5'),
            'dns_guard_interval': self.uci_get('dns_guard_interval', '5'),
            'kernel_update_notice': self.uci_get('kernel_update_notice', '1')
        }}

    def settings_set(self, request):
        if not isinstance(request, dict):
            raise Failure('设置格式错误')
        allowed = {'enabled', 'default_page', 'update_interval', 'prefer_ebpf',
                   'github_proxy', 'dns_failover', 'dns_singbox_port',
                   'dns_backup_port', 'dns_fallback_server', 'dns_smartdns_port',
                   'dns_guard_interval', 'kernel_update_notice'}
        unknown = set(request) - allowed
        if unknown:
            raise Failure('包含不支持的设置项：' + ', '.join(sorted(unknown)))
        values = self.settings_get()['settings']
        for key, value in request.items():
            if key == 'dns_smartdns_port':
                values['dns_backup_port'] = str(value).strip()
            else:
                values[key] = str(value).strip()
        values.setdefault('kernel_update_notice', '1')
        if values['enabled'] not in ('0', '1'):
            raise Failure('开机启动必须为 0 或 1')
        if values['default_page'] not in ('overview', 'proxies', 'subscriptions', 'connections', 'trace', 'rules', 'config', 'kernel', 'tools'):
            raise Failure('默认页面不合法')
        if not values['update_interval'].isdigit() or int(values['update_interval']) > 10080:
            raise Failure('更新间隔必须为 0 到 10080 分钟')
        if values['prefer_ebpf'] not in ('auto', 'on', 'off'):
            raise Failure('内核偏好不合法')
        if values['github_proxy'] and not re.fullmatch(r'https://[^\s]+', values['github_proxy']):
            raise Failure('代理地址必须是 HTTPS URL')
        if values['dns_failover'] not in ('0', '1'):
            raise Failure('DNS 故障转移必须为 0 或 1')
        if values['dns_singbox_port'] and (not values['dns_singbox_port'].isdigit()
                                           or not 1 <= int(values['dns_singbox_port']) <= 65535):
            raise Failure('SingBox DNS 端口必须留空或为 1 到 65535')
        if not values['dns_backup_port'].isdigit() or not 1 <= int(values['dns_backup_port']) <= 65535:
            raise Failure('备份 DNS 服务端口必须为 1 到 65535')
        fallback = values['dns_fallback_server']
        if fallback:
            match = re.fullmatch(r'([A-Za-z0-9_.:-]+)(?:#(\d{1,5}))?', fallback)
            if not match or (match.group(2) and not 1 <= int(match.group(2)) <= 65535):
                raise Failure('兜底 DNS 格式不正确，例如 223.5.5.5 或 1.1.1.1#53')
        if not values['dns_guard_interval'].isdigit() or not 2 <= int(values['dns_guard_interval']) <= 60:
            raise Failure('DNS 检测间隔必须为 2 到 60 秒')
        if values['kernel_update_notice'] not in ('0', '1'):
            raise Failure('内核更新提醒必须为 0 或 1')

        old_file = self.uci_file.read_bytes() if self.uci_file.is_file() else None
        old_enabled = self.uci_get('enabled', '1') == '1'
        old_notice_enabled = self.uci_get('kernel_update_notice', '1') != '0'
        was_running = bool(self.pids())
        desired_enabled = values['enabled'] == '1'
        try:
            self.uci_file.parent.mkdir(parents=True, exist_ok=True)
            if not self.uci_file.exists():
                atomic(self.uci_file, b'', 0o600)
            for key in ('enabled', 'default_page', 'update_interval',
                        'prefer_ebpf', 'github_proxy', 'dns_failover',
                        'dns_singbox_port', 'dns_backup_port', 'dns_fallback_server',
                        'dns_guard_interval', 'kernel_update_notice'):
                self.run(['uci', 'set', 'singbox-dash.main.%s=%s' % (key, values[key])],
                         timeout=8)
            if values['kernel_update_notice'] == '1' and not old_notice_enabled:
                self.run(['uci', 'set', 'singbox-dash.main.kernel_update_skip='], timeout=8)
            self.run(['uci', 'commit', 'singbox-dash'], timeout=8)
            if desired_enabled != old_enabled:
                # This is only an autostart flag. Saving settings must never
                # start or stop the core; an intentionally stopped service
                # has to remain stopped.
                self.service_action('enable' if desired_enabled else 'disable')
            update_init = self.root / 'etc/init.d/singbox-dash-update'
            if update_init.exists():
                self.run([update_init, 'restart'], timeout=20, check=False)
            dns_guard_init = self.root / 'etc/init.d/singbox-dash-dns-guard'
            if dns_guard_init.exists():
                self.run([dns_guard_init, 'restart'], timeout=30, check=False)
        except Exception as exc:
            rollback_error = ''
            try:
                if old_file is None:
                    self.uci_file.unlink(missing_ok=True)
                else:
                    atomic(self.uci_file, old_file, 0o600)
                self.run(['uci', 'commit', 'singbox-dash'], timeout=8, check=False)
                self.run([self.core_service_init(), 'enable' if old_enabled else 'disable'],
                         timeout=20, check=False)
                if was_running and not self.pids():
                    self.service_action('start')
            except Exception as rollback_exc:
                rollback_error = clean_error(rollback_exc)
                append_error_log('settings-rollback', rollback_exc)
            if rollback_error:
                raise Failure(clean_error(exc) + '；设置回滚失败：' + rollback_error) from exc
            raise
        return {'ok': True, 'settings': self.settings_get()['settings']}

    def read_command_json(self, path):
        source = self.upload_path(path)
        if source.stat().st_size > 2 * 1024 * 1024:
            raise Failure('请求文件过大')
        try:
            return json.loads(source.read_text(encoding='utf-8'))
        except (OSError, ValueError) as exc:
            raise Failure('请求文件格式错误') from exc

    def submit_mode(self, target_name, mode):
        target = self.target(target_name)
        if not target.is_file():
            raise Failure('目标配置不存在')
        old = target.read_bytes()
        source = self.upload_dir() / ('singbox-dash-mode-' + uuid.uuid4().hex)
        atomic(source, old, 0o600)
        try:
            return self.submit_save({'action': 'mode', 'target': target.name,
                                     'expected': digest(old), 'source': str(source),
                                     'mode': mode})
        finally:
            source.unlink(missing_ok=True)

    def submit_kernel_release(self, source, tag, asset=''):
        source_info = self.core_source_info(source)
        if source_info['id'] == 'unknown':
            raise Failure('未知的内核来源')
        release = next((item for item in self.releases('all', source=source_info['id'])
                        if item['tag'] == tag), None)
        if not release:
            raise Failure('Release 不存在')
        chosen, reason = self.choose_asset(release, asset)
        request = {'kind': 'release', 'source': source_info['id'],
                   'tag': tag, 'asset': chosen['name']}
        return self.create_job('kernel', 'sing-box', json.dumps(request).encode(),
                               source_name=chosen['name'], reason=reason,
                               version_tag=tag)

    def submit_kernel_upload(self, path):
        source = self.upload_path(path)
        data = source.read_bytes()
        job = self.create_job('kernel', 'sing-box', data,
                              source_name=source.name, reason='本地上传')
        source.unlink(missing_ok=True)
        return job

    def subscription_info(self, active=None):
        active = active or self.active()
        source = self.conf / ('url_' + active.name)
        url = source.read_text(encoding='utf-8').strip() if source.is_file() else ''
        return {'url': url, 'source': source.name if source.is_file() else '',
                'enabled': self.uci_get('update_interval', '0') != '0',
                'interval': int(self.uci_get('update_interval', '0') or 0)}

    def set_subscription(self, url):
        url = str(url or '').strip()
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ('http', 'https') or not parts.netloc:
            raise Failure('订阅地址必须是有效的 HTTP/HTTPS URL')
        active = self.active()
        atomic(self.conf / ('url_' + active.name), (url + '\n').encode(), 0o600)
        return self.subscription_info()

    def fetch_subscription(self):
        import urllib.error
        import urllib.request
        info = self.subscription_info()
        if not info['url']:
            raise Failure('当前配置没有订阅地址')
        request = urllib.request.Request(info['url'], headers={'User-Agent': 'singbox-dash/1.0'})
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                data = response.read(MAX_CONFIG + 1)
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise Failure('订阅下载失败：' + clean_error(exc)) from exc
        if len(data) > MAX_CONFIG:
            raise Failure('订阅内容超过 10 MB')
        data, preview, _ = self.prepare_config_for_core(data)
        self.validated_api_details(preview)
        self.validate(data)
        return data, info

    def update_subscription(self):
        active = self.active()
        old = active.read_bytes()
        data, info = self.fetch_subscription()
        if digest(data) == digest(old) or self.parse(data) == self.parse(old):
            write_json(self.state / 'update.json', {
                'phase': 'unchanged', 'time': int(time.time()), 'message': '订阅内容没有变化'
            })
            return {'ok': True, 'phase': 'unchanged', 'message': '订阅内容没有变化'}
        source = self.upload_dir() / ('singbox-dash-subscription-' + uuid.uuid4().hex)
        atomic(source, data, 0o600)
        try:
            job = self.submit_save({'action': 'apply', 'target': active.name,
                                    'expected': digest(old), 'source': str(source)})
        finally:
            source.unlink(missing_ok=True)
        write_json(self.state / 'update.json', {
            'phase': job.get('phase'), 'time': int(time.time()), 'job': job.get('id')
        })
        return {'ok': True, 'job': job, 'subscription': info}

    def update_loop(self):
        failure = 0
        while True:
            interval = int(self.uci_get('update_interval', '0') or 0)
            if interval <= 0:
                return {'ok': True, 'phase': 'disabled'}
            try:
                self.update_subscription()
                failure = 0
            except Exception as exc:
                failure += 1
                write_json(self.state / 'update.json', {
                    'phase': 'failed', 'error': clean_error(exc), 'failures': failure,
                    'time': int(time.time()), 'kept_running': True
                })
            time.sleep(max(300, interval * 60))


def command_result(argv):
    manager = Manager(os.environ.get('SINGBOX_DASH_ROOT', '/'))
    if not argv or not str(argv[0]).strip():
        raise Failure('缺少操作命令')
    command = str(argv[0]).strip()
    if command == 'version':
        return {'ok': True, 'app': APP, 'version': VERSION}
    if command == 'upload-session':
        kind = argv[1] if len(argv) > 1 else 'config'
        token = manager.upload_token(kind)
        return {'ok': True, 'token': token, 'kind': kind,
                'max_chunk': MAX_UPLOAD_CHUNK,
                'expires': int(time.time()) + UPLOAD_SESSION_TTL}
    if command == 'assemble-upload':
        if len(argv) < 2:
            raise Failure('缺少上传请求文件')
        return manager.assemble_upload(manager.read_command_json(argv[1]))
    if command == 'status':
        return manager.status()
    if command == 'overview':
        return manager.overview()
    if command == 'bootstrap':
        return manager.bootstrap(len(argv) > 1 and argv[1] == 'overview')
    if command == 'config-bundle':
        name = argv[1] if len(argv) > 1 else ''
        include_schema = len(argv) < 3 or argv[2] != 'no-schema'
        return manager.config_bundle(name, include_schema)
    if command == 'meta':
        return manager.kernel_info()
    if command == 'validate':
        if len(argv) < 2:
            raise Failure('缺少配置文件')
        path = manager.upload_path(argv[1])
        if path.stat().st_size > MAX_CONFIG:
            raise Failure('配置超过 10 MB')
        data = path.read_bytes()
        data, preview, compatibility = manager.prepare_config_for_core(data)
        api = manager.validated_api_details(preview)
        config = manager.validate(data)
        return {'ok': True, 'mode': manager.mode_details(config),
                'api': api, 'compatibility': compatibility,
                'outbounds': len(config.get('outbounds') or []),
                'rules': len((config.get('route') or {}).get('rules') or [])}
    if command == 'config-get':
        return manager.config_get(argv[1] if len(argv) > 1 else '')
    if command == 'preview':
        if len(argv) < 3:
            raise Failure('缺少配置或模式')
        target = manager.target(argv[1])
        if not target.is_file():
            raise Failure('配置不存在')
        data = target.read_bytes()
        planned = manager.mode_plan(data, argv[2])
        return {'ok': True, 'target': target.name, 'mode': argv[2],
                'hash': digest(data), 'data': planned.decode('utf-8', 'replace'),
                'details': manager.mode_details(planned)}
    if command == 'schema':
        return {'ok': True, 'schema': manager.schema_with_capabilities()}
    if command == 'capabilities':
        return manager.capabilities()
    if command == 'capabilities-init':
        return manager.capabilities_init()
    if command == 'validate-object':
        if len(argv) < 2:
            raise Failure('缺少可视化配置请求文件')
        request = manager.read_command_json(argv[1])
        config = request.get('data') if isinstance(request, dict) else None
        candidate, parsed, compatibility = manager.validate_config_object(config)
        return {'ok': True, 'mode': manager.mode_details(candidate),
                'api': manager.validated_api_details(parsed),
                'compatibility': compatibility,
                'outbounds': len(parsed.get('outbounds') or []),
                'rules': len((parsed.get('route') or {}).get('rules') or [])}
    if command == 'submit':
        if len(argv) < 2:
            raise Failure('缺少请求文件')
        return manager.submit_save(manager.read_command_json(argv[1]))
    if command == 'submit-object':
        if len(argv) < 2:
            raise Failure('缺少可视化配置请求文件')
        return manager.submit_config_object(manager.read_command_json(argv[1]))
    if command == 'mode-apply':
        if len(argv) < 3:
            raise Failure('缺少配置或模式')
        return manager.submit_mode(argv[1], argv[2])
    if command == 'job':
        result = manager.job(argv[1] if len(argv) > 1 else None)
        if result is None:
            return {'ok': True, 'job': None}
        return {'ok': True, 'job': result}
    if command == 'worker':
        return {'ok': True, 'job': manager.worker()}
    if command == 'backups':
        return {'ok': True, 'backups': manager.backup_list()}
    if command == 'backup-delete':
        if len(argv) < 2:
            raise Failure('缺少配置备份名称')
        return manager.delete_config_backup(argv[1])
    if command == 'kernel-backup-delete':
        if len(argv) < 2:
            raise Failure('缺少内核备份名称')
        return manager.delete_kernel_backup(argv[1])
    if command == 'activate':
        if len(argv) < 2:
            raise Failure('缺少配置')
        return manager.activate_config(argv[1])
    if command == 'service':
        if len(argv) < 2:
            raise Failure('缺少服务操作')
        return manager.service_action(argv[1])
    if command == 'tun-repair':
        return manager.ensure_tun_device()
    if command == 'prepare-boot':
        return manager.prepare_boot()
    if command == 'provider-status':
        return manager.provider_status()
    if command == 'provider-import':
        if len(argv) < 2:
            raise Failure('缺少 Provider 导入请求文件')
        return manager.import_provider(manager.read_command_json(argv[1]))
    if command == 'diag':
        return manager.diagnostics(refresh=len(argv) > 1 and argv[1] == 'refresh')
    if command == 'logs':
        return manager.recent_logs()
    if command == 'logs-export':
        return manager.export_logs(argv[1] if len(argv) > 1 else 'all',
                                  argv[2] if len(argv) > 2 else 'all',
                                  argv[3] if len(argv) > 3 else '')
    if command == 'trace':
        if len(argv) < 2:
            raise Failure('缺少 IP 或域名')
        return manager.trace_target(argv[1])
    if command == 'api':
        if len(argv) < 2:
            raise Failure('缺少 API 请求文件')
        return manager.clash_request(manager.read_command_json(argv[1]))
    if command == 'subscription-info':
        return {'ok': True, 'subscription': manager.subscription_info()}
    if command == 'subscription-set':
        if len(argv) < 2:
            raise Failure('缺少订阅请求文件')
        request = manager.read_command_json(argv[1])
        return {'ok': True, 'subscription': manager.set_subscription(request.get('url'))}
    if command == 'subscription-update':
        return manager.update_subscription()
    if command == 'update-loop':
        return manager.update_loop()
    if command == 'settings-get':
        return manager.settings_get()
    if command == 'settings-set':
        if len(argv) < 2:
            raise Failure('缺少设置请求文件')
        return manager.settings_set(manager.read_command_json(argv[1]))
    if command == 'kernel-info':
        return manager.kernel_info()
    if command == 'kernel-releases':
        if len(argv) > 1 and argv[1] in CORE_SOURCES:
            source = argv[1]
            channel = argv[2] if len(argv) > 2 else 'all'
            refresh = 'refresh' in argv[3:]
        else:
            source = manager.core_family()
            channel = argv[1] if len(argv) > 1 else 'all'
            refresh = 'refresh' in argv[2:]
        return manager.release_view(channel, refresh, source=source)
    if command == 'kernel-update-notice':
        return manager.kernel_update_notice()
    if command == 'kernel-update-notice-set':
        if len(argv) < 2:
            raise Failure('缺少提醒设置请求文件')
        return manager.set_kernel_update_notice(manager.read_command_json(argv[1]))
    if command == 'kernel-install-release':
        if len(argv) < 2:
            raise Failure('缺少 Release 标签')
        if argv[1] in CORE_SOURCES:
            if len(argv) < 3:
                raise Failure('缺少 Release 标签')
            source, tag, asset = argv[1], argv[2], (argv[3] if len(argv) > 3 else '')
        else:
            source, tag, asset = manager.core_family(), argv[1], (argv[2] if len(argv) > 2 else '')
        return manager.submit_kernel_release(source, tag, asset)
    if command == 'kernel-install':
        if len(argv) < 2:
            raise Failure('缺少内核文件')
        return manager.submit_kernel_upload(argv[1])
    if command == 'kernel-rollback':
        if len(argv) < 2:
            raise Failure('缺少内核备份名称')
        return manager.rollback_kernel(argv[1])
    raise Failure('未知命令：' + command)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        result = command_result(argv)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
        return 0
    except Failure as exc:
        message = clean_error(exc)
        append_error_log(argv[0] if argv else 'unknown', message)
        sys.stdout.write(json.dumps({'ok': False, 'error': message},
                                    ensure_ascii=False, separators=(',', ':')) + '\n')
        return 2
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        message = '内部错误：' + clean_error(exc)
        append_error_log(argv[0] if argv else 'unknown', message)
        sys.stdout.write(json.dumps({'ok': False, 'error': message},
                                    ensure_ascii=False, separators=(',', ':')) + '\n')
        return 3


if __name__ == '__main__':
    sys.exit(main())
