"""Strict runtime capability probes and persisted verification state."""

import copy
import json
import os
from pathlib import Path
import re
import shutil
import time

from .common import Failure, clean_error, read_json, write_json


class CapabilityMixin:
    def ebpf_probe_mode(self, local_data_plane='socket_assign',
                              shared_data_plane='packet_rewrite', mode='all',
                              network=('tcp', 'udp'), ipv6=True, interfaces=None):
            """Run sing-box's native structured eBPF preflight.

            This mirrors NetProxy-Magisk: only ``tools ebpf status --json`` is an
            authoritative capability source.  Text output and filesystem hints are
            diagnostic details, never a positive conclusion.
            """
            if not self.bin.is_file():
                return {
                    'supported': False, 'result': 'error', 'preflight': False,
                    'exact_object_load': False, 'mode': mode,
                    'local_data_plane': local_data_plane,
                    'shared_data_plane': shared_data_plane,
                    'summary': '', 'counts': {}, 'issues': [{
                        'severity': 'fail', 'status': 'FAIL', 'scope': 'runner',
                        'requirement': 'required', 'name': 'eBPF 预检命令执行失败',
                        'title': '内核文件不存在', 'advice': '请先安装内核再检测 eBPF。',
                        'detail': ''
                    }], 'raw': ''
                }
            args = [self.bin, 'tools', 'ebpf', 'status', '--mode', mode,
                    '--local-data-plane', local_data_plane,
                    '--shared-data-plane', shared_data_plane,
                    '--network', ','.join(network or ('tcp', 'udp')),
                    '--ipv6=true' if ipv6 else '--ipv6=false', '--json']
            for interface in interfaces or []:
                args.extend(['--interface', str(interface)])
            try:
                result = self.run(args, timeout=35, check=False)
            except Failure as exc:
                return {
                    'supported': False, 'result': 'error', 'preflight': False,
                    'exact_object_load': False, 'mode': mode,
                    'local_data_plane': local_data_plane,
                    'shared_data_plane': shared_data_plane,
                    'summary': '', 'counts': {}, 'issues': [{
                        'severity': 'fail', 'status': 'FAIL', 'scope': 'runner',
                        'requirement': 'required',
                        'name': 'eBPF 预检命令执行失败',
                        'title': 'eBPF 预检命令执行失败',
                        'advice': '请检查核心文件、Root 权限和内核日志。',
                        'detail': clean_error(exc)
                    }], 'raw': clean_error(exc)
                }
            text = (result.stdout + b'\n' + result.stderr).decode('utf-8', 'replace')
            return self.parse_ebpf_json_report(text, result.returncode, mode,
                                               local_data_plane, shared_data_plane)

    def parse_ebpf_json_report(self, text, returncode=0, mode='all',
                                   local_data_plane='socket_assign',
                                   shared_data_plane='packet_rewrite'):
            raw = str(text or '').strip()
            base = {
                'supported': False, 'result': 'invalid', 'preflight': False,
                'exact_object_load': False, 'mode': mode,
                'local_data_plane': local_data_plane,
                'shared_data_plane': shared_data_plane,
                'summary': '', 'counts': {}, 'issues': [], 'raw': raw[-4000:]
            }
            try:
                report = json.loads(raw)
            except ValueError:
                base['issues'] = [{
                    'severity': 'fail', 'status': 'FAIL', 'scope': 'report',
                    'requirement': 'required', 'name': 'eBPF JSON 诊断报告无效',
                    'title': '无法读取 eBPF 诊断报告',
                    'advice': '请升级到支持 tools ebpf status --json 的 sing-box 内核。',
                    'detail': raw[-800:]
                }]
                return base
            if not isinstance(report, dict):
                base['issues'] = [{
                    'severity': 'fail', 'status': 'FAIL', 'scope': 'report',
                    'requirement': 'required', 'name': 'eBPF JSON 诊断报告无效',
                    'title': 'eBPF 诊断报告格式错误', 'advice': '请更换或升级 sing-box 内核。',
                    'detail': raw[-800:]
                }]
                return base

            result = str(report.get('result') or '').strip().lower()
            mode = str(report.get('mode') or mode).strip().lower()
            local_plane = str(report.get('local_data_plane') or '').strip().lower()
            shared_plane = str(report.get('shared_data_plane') or '').strip().lower()
            summary = report.get('summary') if isinstance(report.get('summary'), dict) else {}
            counts = {
                'PASS': max(0, int(summary.get('pass') or 0)),
                'WARN': max(0, int(summary.get('warn') or 0)),
                'FAIL': max(0, int(summary.get('fail') or 0)),
                'UNKNOWN': max(0, int(summary.get('unknown') or 0)),
                'REQUIRED_FAILURES': max(0, int(summary.get('required_failures') or 0)),
                'REQUIRED_UNKNOWNS': max(0, int(summary.get('required_unknowns') or 0)),
            }
            issues = []
            for item in report.get('findings') or []:
                if not isinstance(item, dict):
                    continue
                status = str(item.get('status') or '').strip().upper()
                if status not in ('PASS', 'WARN', 'FAIL', 'UNKNOWN'):
                    status = 'UNKNOWN'
                if status == 'PASS':
                    continue
                feature = str(item.get('feature') or item.get('name') or 'eBPF 检查项')
                issues.append({
                    'severity': status.lower(),
                    'status': status,
                    'scope': str(item.get('scope') or ''),
                    'requirement': str(item.get('importance') or ''),
                    'name': feature,
                    'reason': str(item.get('reason') or ''),
                    'detail': str(item.get('detail') or '')[:1000],
                    'title': feature,
                    'advice': ('该必需能力未通过，当前模式不能使用。'
                               if status in ('FAIL', 'UNKNOWN')
                               else '该问题需启动时继续验证，不能视为已确认可用。')
                })

            valid = (
                returncode == 0
                and bool(report.get('preflight'))
                and result in ('preflight_passed', 'inconclusive', 'unsupported')
                and mode in ('all', 'local', 'shared')
                and local_plane in ('cgroup', 'tc', 'socket_assign')
                and shared_plane in ('packet_rewrite', 'socket_assign')
                and all(str(finding.get('status') or '').upper() in
                        ('PASS', 'WARN', 'FAIL', 'UNKNOWN')
                        for finding in report.get('findings') or []
                        if isinstance(finding, dict))
            )
            if not valid:
                issues.append({
                    'severity': 'fail', 'status': 'FAIL', 'scope': 'report',
                    'requirement': 'required', 'name': 'eBPF 诊断报告未完成',
                    'title': 'eBPF 能力检测未完成',
                    'advice': '当前模式不能标记为可用，请根据技术详情修复后重新检测。',
                    'detail': ('exit=%d result=%s preflight=%s mode=%s local=%s shared=%s'
                               % (returncode, result or '-', bool(report.get('preflight')),
                                  mode or '-', local_plane or '-', shared_plane or '-'))
                })
                base.update({'result': 'invalid' if not result else result,
                             'mode': mode, 'local_data_plane': local_plane,
                             'shared_data_plane': shared_plane, 'counts': counts,
                             'issues': issues, 'preflight': False,
                             'exact_object_load': False})
                return base

            supported = (
                result == 'preflight_passed'
                and counts['FAIL'] == 0
                and counts['UNKNOWN'] == 0
                and counts['REQUIRED_FAILURES'] == 0
                and counts['REQUIRED_UNKNOWNS'] == 0
                and bool(report.get('exact_object_load'))
                and returncode == 0
            )
            if result == 'preflight_passed' and not report.get('exact_object_load'):
                issues.append({
                    'severity': 'unknown', 'status': 'UNKNOWN', 'scope': 'ebpf',
                    'requirement': 'required', 'name': '实际 eBPF 程序对象未加载',
                    'title': '未能加载实际 eBPF 程序对象',
                    'advice': '当前模式不能标记为可用，请升级内核后重新检测。',
                    'detail': 'exact_object_load=false。'
                })
            if result == 'unsupported' and not issues:
                issues.append({
                    'severity': 'fail', 'status': 'FAIL', 'scope': 'ebpf',
                    'requirement': 'required', 'name': 'eBPF 能力不支持',
                    'title': '当前内核缺少必需 eBPF 能力',
                    'advice': '请升级内核，或改用 TUN / TProxy / Redirect 模式。',
                    'detail': 'sing-box 返回 unsupported。'
                })
            if not supported and not issues:
                issues.append({
                    'severity': 'unknown', 'status': 'UNKNOWN', 'scope': 'ebpf',
                    'requirement': 'required', 'name': 'eBPF 能力未确认',
                    'title': 'eBPF 能力未确认',
                    'advice': '当前模式不能标记为可用，请修复后重新检测。',
                    'detail': '预检结果未满足“可用”的完整条件。'
                })
            base.update({
                'supported': supported, 'result': result,
                'preflight': bool(report.get('preflight')),
                'exact_object_load': bool(report.get('exact_object_load')),
                'mode': mode, 'local_data_plane': local_plane,
                'shared_data_plane': shared_plane,
                'summary': 'PASS=%d WARN=%d FAIL=%d UNKNOWN=%d REQUIRED_FAILURES=%d REQUIRED_UNKNOWNS=%d'
                           % (counts['PASS'], counts['WARN'], counts['FAIL'],
                              counts['UNKNOWN'], counts['REQUIRED_FAILURES'],
                              counts['REQUIRED_UNKNOWNS']),
                'counts': counts, 'issues': issues[:24]
            })
            return base

    def ebpf_local_plane(self):
            """Return the local data-plane keyword supported by this kernel build.

            MiChongs builds up to g.6 use ``tc``.  Builds from g.7 onward renamed
            the same feature to ``socket_assign`` and reject ``tc``.  Both builds
            report the same semantic version, so ask the installed binary instead
            of guessing from the version string.  The result is persisted by binary
            revision and is re-read only after the kernel file changes.
            """
            try:
                binary = self.binary_key()
            except OSError:
                return {'plane': '', 'dialect': '', 'reason': '内核未安装'}
            cached = self.cache_get('ebpf-local-plane.json', key=binary)
            if isinstance(cached, dict) and cached.get('plane') in ('tc', 'socket_assign'):
                return cached
            try:
                result = self.run([self.bin, 'tools', 'ebpf', 'status', '--help'],
                                  timeout=8, check=False)
            except Failure as exc:
                return {'plane': '', 'dialect': '', 'reason': '无法读取内核 eBPF 能力：' + clean_error(exc)}
            output = (result.stdout + b'\n' + result.stderr).decode('utf-8', 'replace')
            help_line = next((line for line in output.splitlines()
                              if '--local-data-plane' in line), '')
            plane = ''
            if 'socket_assign' in help_line:
                plane = 'socket_assign'
            elif re.search(r'(?<![A-Za-z0-9_])tc(?![A-Za-z0-9_])', help_line, re.I):
                plane = 'tc'
            if not plane:
                return {'plane': '', 'dialect': '', 'reason':
                        '无法识别当前内核版本的 eBPF 本地数据面参数'}
            value = {
                'plane': plane,
                'dialect': 'socket_assign' if plane == 'socket_assign' else 'legacy_tc',
                'reason': ''
            }
            self.cache_set('ebpf-local-plane.json', binary, value)
            return value

    def tun_probe(self):
            device = (self.root / 'dev/net/tun').exists() or Path('/dev/net/tun').exists()
            sys_class = (self.root / 'sys/class/misc/tun').exists() or Path('/sys/class/misc/tun').exists()
            module = (self.root / 'sys/module/tun').exists() or Path('/sys/module/tun').exists()
            proc_misc = False
            try:
                proc_misc = ' tun' in (' ' + (self.root / 'proc/misc').read_text())
            except OSError:
                pass
            return {'device_node': device, 'kernel_support': bool(device or sys_class or module or proc_misc),
                    'sys_class': sys_class, 'module': module, 'proc_misc': proc_misc}

    def ensure_tun_device(self):
            info = self.tun_probe()
            if info['device_node']:
                device = self.root / 'dev/net/tun'
                if not device.exists():
                    device = Path('/dev/net/tun')
                try:
                    if device.exists() and not device.is_char_device():
                        return {'ok': False, 'created': False, 'reason': '/dev/net/tun 存在但不是字符设备'}
                except OSError:
                    pass
                return {'ok': True, 'created': False, 'reason': '', 'device': str(device),
                        'kernel_support': True}
            if not info['kernel_support']:
                result = self.run(['modprobe', 'tun'], timeout=10, check=False)
                if result is None or result.returncode:
                    self.run(['kmodloader'], timeout=10, check=False)
                info = self.tun_probe()
            if not info['kernel_support']:
                return {'ok': False, 'created': False,
                        'reason': '内核没有检测到 TUN 支持，请安装 kmod-tun 或使用支持 TUN 的内核'}
            device = self.root / 'dev/net/tun'
            try:
                device.parent.mkdir(parents=True, exist_ok=True)
                result = self.run(['mknod', str(device), 'c', '10', '200'], timeout=10, check=False)
                if result is None or result.returncode:
                    detail = clean_error((result.stderr or result.stdout).decode('utf-8', 'replace')) if result else 'mknod 不可用'
                    return {'ok': False, 'created': False, 'reason': '无法创建 /dev/net/tun：' + detail}
                self.run(['chmod', '666', str(device)], timeout=5, check=False)
                os.chmod(device, 0o666)
            except OSError as exc:
                return {'ok': False, 'created': False, 'reason': '无法创建 /dev/net/tun：' + clean_error(exc)}
            verified = self.tun_probe()
            if not verified['device_node']:
                return {'ok': False, 'created': False, 'reason': '/dev/net/tun 创建后仍未检测到'}
            return {'ok': True, 'created': True, 'reason': '', 'device': str(device),
                    'kernel_support': True}

    def mode_runtime_key(self, details):
            mode = str((details or {}).get('mode') or '')
            if mode == 'ebpf':
                plane = str((details or {}).get('data_plane') or '')
                return 'ebpf:' + (plane or 'unknown')
            return mode

    def read_mode_runtime(self):
            try:
                binary = self.binary_key()
            except OSError:
                binary = {'path': str(self.bin), 'mtime_ns': 0, 'size': 0}
            value = read_json(self.state / 'mode-runtime.json', {})
            if not isinstance(value, dict) or value.get('version') != 1 or value.get('binary') != binary:
                return {'version': 1, 'binary': binary, 'modes': {}}
            if not isinstance(value.get('modes'), dict):
                value['modes'] = {}
            return value

    def reset_failed_runtime_modes(self):
            value = self.read_mode_runtime()
            changed = False
            for key, item in list(value.get('modes', {}).items()):
                if isinstance(item, dict) and item.get('state') == 'failed':
                    value['modes'].pop(key, None)
                    changed = True
            if changed:
                write_json(self.state / 'mode-runtime.json', value)
            return changed

    def record_mode_runtime(self, details, success, reason=''):
            key = self.mode_runtime_key(details)
            if key not in ('ebpf:tc', 'ebpf:socket_assign', 'ebpf:cgroup', 'tun',
                           'tproxy', 'redirect'):
                return
            value = self.read_mode_runtime()
            item = {'state': 'success' if success else 'failed',
                    'time': int(time.time()), 'reason': clean_error(reason)[:2400] if reason else ''}
            previous = value['modes'].get(key)
            if (success and isinstance(previous, dict)
                    and previous.get('state') == 'success'):
                return
            if (not success and isinstance(previous, dict)
                    and previous.get('state') == 'failed'
                    and previous.get('reason') == item['reason']):
                return
            value['modes'][key] = item
            write_json(self.state / 'mode-runtime.json', value)

    def capability_runtime_key(self, version, binary, local_plane=''):
            """Build the cheap runtime key used to tell whether a snapshot is stale."""
            tun_info = self.tun_probe()
            cgroup2 = (self.root / 'sys/fs/cgroup/cgroup.controllers').exists()
            bpffs = (self.root / 'sys/fs/bpf').exists()
            nft = bool(shutil.which('nft', path=self.env.get('PATH')))
            ip = bool(shutil.which('ip', path=self.env.get('PATH')))
            try:
                network = (self.root / 'etc/config/network').stat()
                network_key = [network.st_mtime_ns, network.st_size]
            except OSError:
                network_key = [0, 0]
            key = {'binary': binary, 'version': version,
                   'tun': tun_info['device_node'],
                   'tun_kernel': tun_info['kernel_support'], 'cgroup2': cgroup2,
                   'bpffs': bpffs, 'nft': nft, 'ip': ip,
                   'network': network_key, 'ebpf_plane': local_plane,
                   'capability_version': 7}
            return key, tun_info

    def mode_capabilities_unchecked(self, reason=''):
            reason = reason or '尚未检测设备能力，请点击“重新检测”'
            def item():
                return {'available': False, 'reason': reason}
            return {
                'schema': 8, 'checked': False, 'needs_check': True, 'stale': False,
                'checked_at': 0, 'snapshot_reason': reason,
                'ebpf_local_plane': '', 'ebpf_local_plane_dialect': '',
                'ebpf': dict(item(), interfaces=[], local_data_plane='',
                             shared_data_plane='packet_rewrite', issues=[],
                             preflight_summary='', preflight_counts={}),
                'ebpf_cgroup': dict(item(), interfaces=[], local_data_plane='cgroup',
                                    shared_data_plane='packet_rewrite', issues=[],
                                    preflight_summary='', preflight_counts={}),
                'tun': dict(item(), kernel_support=False, device_node=False,
                            repair_available=False, interface='singtun0'),
                'tproxy': item(), 'redirect': item()
            }

    def mode_capabilities_snapshot(self, version=None):
            """Read the persisted capability snapshot without probing the device.

            Only an explicit diagnostics refresh, package initialization or kernel
            replacement may run the expensive eBPF preflight.  Normal page loads and
            status polling always use this method.
            """
            cached = getattr(self, '_mode_capabilities_snapshot_cache', None)
            if isinstance(cached, dict):
                return copy.deepcopy(cached)
            bin_ready = self.bin.is_file()
            if version is None:
                version = self.core_version() if bin_ready else ''
            try:
                binary = self.binary_key()
            except OSError:
                binary = {'path': str(self.bin), 'mtime_ns': 0, 'size': 0}
            raw = read_json(self.state / 'mode-capabilities.json', {})
            value = raw.get('value') if isinstance(raw, dict) else None
            saved_key = raw.get('key') if isinstance(raw, dict) else None
            if not (isinstance(value, dict) and value.get('schema') == 8
                    and isinstance(saved_key, dict)
                    and isinstance(value.get('ebpf_cgroup'), dict)):
                result = self.mode_capabilities_unchecked()
                result = self.annotate_runtime_evidence(result)
                self._mode_capabilities_snapshot_cache = copy.deepcopy(result)
                return result
            saved_binary = saved_key.get('binary') if isinstance(saved_key.get('binary'), dict) else {}
            same_binary = (saved_binary.get('path') == binary.get('path')
                           and saved_binary.get('mtime_ns') == binary.get('mtime_ns')
                           and saved_binary.get('size') == binary.get('size'))
            if not same_binary:
                result = self.mode_capabilities_unchecked(
                    '内核已更新，请点击“重新检测”更新设备能力')
                result = self.annotate_runtime_evidence(result)
                self._mode_capabilities_snapshot_cache = copy.deepcopy(result)
                return result
            local_plane = str(value.get('ebpf_local_plane') or '')
            current_key, _ = self.capability_runtime_key(version, binary, local_plane)
            result = copy.deepcopy(value)
            result['checked'] = True
            result['checked_at'] = int(raw.get('time') or 0)
            result['stale'] = current_key != saved_key
            result['needs_check'] = bool(result['stale'])
            result['snapshot_reason'] = ('运行环境发生变化，当前显示上次检测结果；'
                                         '可点击“重新检测”更新'
                                         if result['stale'] else '使用上次检测结果')
            result = self.annotate_runtime_evidence(result)
            self._mode_capabilities_snapshot_cache = copy.deepcopy(result)
            return result

    def probe_mode_capabilities(self, version=None, reset_failures=False):
            """Run the full mode probe once and persist the resulting snapshot."""
            if reset_failures:
                self.reset_failed_runtime_modes()
            bin_ready = self.bin.is_file()
            if version is None:
                version = self.core_version() if bin_ready else ''
            try:
                binary = self.binary_key()
            except OSError:
                binary = {'path': str(self.bin), 'mtime_ns': 0, 'size': 0}
            layout = (self.ebpf_local_plane()
                      if bin_ready and 'with_ebpf' in version else
                      {'plane': '', 'dialect': '', 'reason': ''})
            local_plane = layout.get('plane') or ''
            cache_key, tun_info = self.capability_runtime_key(version, binary, local_plane)
            tun_ready = tun_info['device_node']
            cgroup2 = cache_key['cgroup2']
            bpffs = cache_key['bpffs']
            nft = cache_key['nft']
            ip = cache_key['ip']
            empty_probe = {'supported': False, 'summary': '', 'issues': [], 'counts': {}}
            members = self.lan_members()
            probe_tc = (self.ebpf_probe(local_plane, 'packet_rewrite', members)
                        if bin_ready and 'with_ebpf' in version and local_plane else empty_probe)
            probe_cgroup = (self.ebpf_probe('cgroup', 'packet_rewrite', members)
                            if bin_ready and 'with_ebpf' in version and cgroup2 else empty_probe)

            def ebpf_capability(probe, plane, dialect=''):
                reason = ''
                if not bin_ready:
                    reason = '内核未安装'
                elif 'with_ebpf' not in version:
                    reason = '当前内核不是 eBPF 构建'
                elif plane != 'cgroup' and not local_plane:
                    reason = layout.get('reason') or '无法识别当前内核版本的 eBPF 本地数据面参数'
                elif not bpffs:
                    reason = 'bpffs 未挂载'
                elif plane == 'cgroup' and not cgroup2:
                    reason = '系统未启用 cgroup v2'
                elif not probe.get('supported'):
                    blockers = [item.get('title') or item.get('name')
                                for item in (probe.get('issues') or [])
                                if item.get('severity') in ('fail', 'unknown')]
                    reason = ('；'.join(blockers[:4])) if blockers else (probe.get('summary') or 'eBPF 预检未通过')
                elif not members:
                    reason = '无法识别 LAN 成员接口'
                return {'available': not reason, 'reason': reason,
                        'interfaces': members, 'local_data_plane': plane,
                        'local_data_plane_dialect': dialect,
                        'shared_data_plane': 'packet_rewrite',
                        'issues': probe.get('issues') or [],
                        'preflight_summary': probe.get('summary') or '',
                        'preflight_counts': probe.get('counts') or {},
                        'result': probe.get('result') or '',
                        'preflight': bool(probe.get('preflight')),
                        'exact_object_load': bool(probe.get('exact_object_load'))}

            net_reason = ''
            if not bin_ready:
                net_reason = '内核未安装'
            elif not nft:
                net_reason = '缺少 nftables'
            elif not ip:
                net_reason = '缺少 iproute2'
            if not bin_ready:
                tun_reason = '内核未安装'
            elif not ip:
                tun_reason = '缺少 iproute2'
            elif not tun_ready:
                tun_reason = ('TUN 内核支持已启用，但 /dev/net/tun 设备节点不存在'
                              if tun_info['kernel_support'] else '系统未启用 TUN 内核支持')
            else:
                tun_reason = ''
            now = int(time.time())
            value = {
                'schema': 8,
                'checked': True, 'needs_check': False, 'stale': False,
                'checked_at': now, 'snapshot_reason': '刚完成设备能力检测',
                'ebpf_local_plane': local_plane,
                'ebpf_local_plane_dialect': layout.get('dialect') or '',
                'ebpf': ebpf_capability(probe_tc, local_plane, layout.get('dialect') or ''),
                'ebpf_cgroup': ebpf_capability(probe_cgroup, 'cgroup'),
                'ebpf_probe': probe_tc, 'ebpf_cgroup_probe': probe_cgroup,
                'tun': {'available': not tun_reason, 'reason': tun_reason,
                        'kernel_support': tun_info['kernel_support'],
                        'device_node': tun_info['device_node'],
                        'repair_available': not tun_info['device_node'],
                        'interface': 'singtun0'},
                'tproxy': {'available': not net_reason, 'reason': net_reason},
                'redirect': {'available': not net_reason, 'reason': net_reason}
            }
            value = self.annotate_runtime_evidence(value)
            self.cache_set('mode-capabilities.json', cache_key, value)
            self._mode_capabilities_snapshot_cache = copy.deepcopy(value)
            return value

    def mode_capabilities(self, version=None, refresh=False):
            # Compatibility entry point: ordinary reads are snapshot-only.  The
            # expensive probe requires refresh=True, which is only used by an
            # explicit diagnostics refresh, package initialization and kernel update.
            if refresh:
                return self.probe_mode_capabilities(version, reset_failures=True)
            return self.mode_capabilities_snapshot(version)

    def capabilities_init(self):
            snapshot = self.mode_capabilities_snapshot()
            if snapshot.get('checked') and not snapshot.get('needs_check'):
                return {'ok': True, 'cached': True, 'capabilities': snapshot}
            return {'ok': True, 'cached': False,
                    'capabilities': self.probe_mode_capabilities()}

    def parse_ebpf_report(self, text, returncode=0):
            issues = []
            current = None
            summary = ''
            counts = {}
            for raw_line in text.splitlines():
                line = raw_line.rstrip()
                stripped = line.strip()
                if stripped.startswith('Summary:'):
                    summary = (summary + ' ' + stripped).strip()
                    for key, value in re.findall(r'(PASS|WARN|FAIL|UNKNOWN|REQUIRED_FAILURES|REQUIRED_UNKNOWNS)=(\d+)', stripped):
                        counts[key] = int(value)
                    current = None
                    continue
                if stripped.startswith('Preflight result:'):
                    summary = (summary + ' ' + stripped).strip()
                    current = None
                    continue
                match = re.match(r'^(FAIL|UNKNOWN|WARN)\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.+)$', stripped)
                if match:
                    current = {
                        'severity': match.group(1).lower(),
                        'scope': match.group(2).strip(),
                        'requirement': match.group(3).strip(),
                        'name': match.group(4).strip(),
                        'detail': ''
                    }
                    issues.append(current)
                    continue
                if current and line[:1].isspace() and stripped:
                    if not stripped.startswith('---'):
                        current['detail'] = (current['detail'] + ' ' + stripped).strip()[:800]
                    continue
                if not stripped:
                    current = None
            if returncode and not any(item['severity'] == 'fail' for item in issues):
                plane_match = re.search(r'invalid eBPF local data plane:\s*([A-Za-z0-9_-]+)', text, re.I)
                if plane_match:
                    issues.append({'severity': 'fail', 'scope': 'data-plane', 'requirement': 'required',
                                   'name': 'invalid eBPF local data plane',
                                   'plane': plane_match.group(1).lower(),
                                   'detail': text.strip()[-800:]})
                else:
                    issues.append({'severity': 'fail', 'scope': 'runner', 'requirement': 'required',
                                   'name': 'eBPF 预检命令执行失败', 'detail': text.strip()[-800:]})
            friendly = {
                'tc namespace isolation': ('TC 网络隔离将在启动时确认',
                    '预检无法完全模拟隔离网络和虚拟网卡；sing-box 启动成功后会自动完成验证。'),
                'local tc interface': ('本机 TC 接口将在启动时自动确认',
                    '未提前指定接口时，sing-box 会自动选择默认接口并创建内部虚拟网卡。'),
                'downstream interface': ('LAN 接口转发将在启动时确认',
                    '预检不会绑定实际 LAN 接口；服务启动后会检查 TC 转发规则。'),
                'bpf_sk_assign': ('内核缺少 socket 分配能力',
                    '当前内核不支持 bpf_sk_assign，建议升级内核或改用 TUN / TProxy 模式。'),
                'ipv6 transparent udp sockets': ('IPv6 UDP 透明代理不可用',
                    '可以在配置中关闭 IPv6，或改用其他接管模式。'),
                'ipv6 transparent tcp sockets': ('IPv6 TCP 透明代理不可用',
                    '可以在配置中关闭 IPv6，或改用其他接管模式。'),
                'ipv4 transparent udp sockets': ('IPv4 UDP 透明代理不可用',
                    '请检查内核透明代理和网络命名空间能力，必要时改用 TUN 模式。'),
                'ipv4 transparent tcp sockets': ('IPv4 TCP 透明代理不可用',
                    '请检查内核透明代理能力，必要时改用 TUN 模式。'),
                'locked-memory limit': ('BPF 内存锁定受限',
                    '请提高内核 memlock 限制，或检查容器/系统资源限制。'),
                'route netlink access': ('路由配置权限不足',
                    '请确认 sing-box 以 root 运行并具备 NET_ADMIN 权限。'),
                'bpf jit': ('BPF JIT 未启用', '启用 BPF JIT 可以改善 eBPF 转发性能。')
            }
            for item in issues:
                key = str(item.get('name') or '').strip().lower()
                if key == 'invalid ebpf local data plane':
                    plane = str(item.get('plane') or '').lower()
                    plane_name = ('TC / socket_assign' if plane == 'socket_assign'
                                  else 'TC' if plane == 'tc'
                                  else 'Cgroup' if plane == 'cgroup' else plane)
                    item['title'] = '当前内核不支持 ' + plane_name + ' 本地数据面'
                    item['advice'] = '请改用另一种 eBPF 数据面，或升级到包含该数据面的内核构建。'
                    continue
                title, advice = friendly.get(key, (item.get('name') or '预检发现问题', ''))
                if not advice:
                    advice = ('该项必需能力未通过，请查看技术详情或切换接管模式。'
                              if item.get('severity') in ('fail', 'unknown')
                              else '该项仅影响性能或需要启动时进一步确认。')
                item['title'] = title
                item['advice'] = advice
            supported = (returncode == 0 and counts.get('FAIL', 0) == 0
                         and counts.get('REQUIRED_FAILURES', 0) == 0
                         and counts.get('REQUIRED_UNKNOWNS', 0) == 0)
            return {'supported': supported, 'summary': summary[-1200:],
                    'issues': issues[:20], 'counts': counts}

    def ebpf_probe(self, local_data_plane='socket_assign', shared_data_plane='packet_rewrite',
                        interfaces=None):
            if not self.bin.is_file():
                return {'supported': False, 'summary': '内核文件不存在', 'issues': [], 'counts': {},
                        'result': 'error', 'preflight': False, 'exact_object_load': False,
                        'mode': 'all', 'local_data_plane': local_data_plane,
                        'shared_data_plane': shared_data_plane}
            try:
                stat_result = self.bin.stat()
                cache_key = (str(self.bin), stat_result.st_mtime_ns, stat_result.st_size,
                             local_data_plane, shared_data_plane,
                             tuple(interfaces or ()))
            except OSError:
                cache_key = (str(self.bin), 0, 0, local_data_plane, shared_data_plane,
                             tuple(interfaces or ()))
            caches = getattr(self, '_ebpf_caches', {})
            if cache_key in caches:
                return copy.deepcopy(caches[cache_key])
            value = self.ebpf_probe_mode(local_data_plane, shared_data_plane, 'all',
                                         ('tcp', 'udp'), True, interfaces)
            caches[cache_key] = copy.deepcopy(value)
            self._ebpf_caches = caches
            return value

