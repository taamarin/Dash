"""Runtime diagnostics and redacted log export."""

import re
import shutil
import time
import uuid

from .common import Failure, atomic


class DiagnosticsMixin:
    def diagnostics(self, refresh=False):
            status = self.status()
            version = status.get('version_line') or ''
            capabilities = status.get('mode_capabilities') or {}
            if refresh or not capabilities:
                capabilities = self.mode_capabilities(version, refresh=bool(refresh))
            memory = {}
            try:
                for line in (self.root / 'proc/meminfo').read_text().splitlines():
                    key, value = line.split(':', 1)
                    if key in ('MemTotal', 'MemAvailable'):
                        memory[key] = int(value.split()[0])
            except (OSError, ValueError):
                pass
            disk = self.run(['df', '-k', '/overlay'], timeout=5, check=False)
            nft_ready = bool(shutil.which('nft', path=self.env.get('PATH')))
            ip_ready = bool(shutil.which('ip', path=self.env.get('PATH')))
            tun_info = self.tun_probe()
            tun_ready = tun_info['device_node']
            cgroup2 = (self.root / 'sys/fs/cgroup/cgroup.controllers').exists()
            bpffs = (self.root / 'sys/fs/bpf').exists()
            checks = {
                'nft': nft_ready,
                'tun': tun_ready,
                'tun_kernel': tun_info['kernel_support'],
                'cgroup2': cgroup2,
                'bpffs': bpffs,
                'ebpf': status.get('ebpf', False),
            }

            mode = status.get('mode') if isinstance(status.get('mode'), dict) else {}
            active_mode = mode.get('mode') or 'custom'
            active_ebpf_plane = mode.get('data_plane') or ''
            running = bool(status.get('running'))

            def check(name, value, ready):
                return {'name': name, 'value': value, 'ready': ready}

            def command_text(args):
                try:
                    result = self.run(args, timeout=4, check=False)
                except Failure:
                    return ''
                return (result.stdout + b'\n' + result.stderr).decode('utf-8', 'replace')

            def standby(name):
                return check(name, 'STANDBY', None)

            candidates = {}

            def ebpf_candidate(cap, plane_id, plane_label):
                interfaces = cap.get('interfaces') if isinstance(cap.get('interfaces'), list) else []
                active = active_mode == 'ebpf' and active_ebpf_plane == plane_id
                run_state = running and active
                checks_for_plane = [
                    check('内核构建', 'with_ebpf' if 'with_ebpf' in version else 'NOT BUILT', 'with_ebpf' in version),
                    check('本地数据面', plane_label, bool(cap.get('available'))),
                ]
                if plane_id == 'cgroup':
                    checks_for_plane.append(check('cgroup v2', 'READY' if cgroup2 else 'MISSING', cgroup2))
                runtime_state = str(cap.get('runtime_state') or 'failed')
                checks_for_plane.extend([
                    check('共享数据面', cap.get('shared_data_plane') or 'packet_rewrite', True),
                    check('BPF 文件系统', 'READY' if bpffs else 'MISSING', bpffs),
                    check('LAN 接口', ', '.join(interfaces) if interfaces else 'MISSING', bool(interfaces)),
                    check('结构化预检', 'PASS' if cap.get('available') else 'FAIL', bool(cap.get('available'))),
                    check('实际对象加载', 'PASS' if cap.get('exact_object_load', True) else 'FAIL',
                          bool(cap.get('exact_object_load', True))),
                    check('运行记录',
                          'RUNNING' if run_state else 'PASSED' if runtime_state == 'success' else 'FAILED',
                          True if run_state or runtime_state == 'success' else False),
                ])
                summary = ('当前接管中 · ' + plane_label if run_state
                           else cap.get('reason') or '不可用' if not cap.get('available')
                           else '可用')
                return {
                    'available': bool(cap.get('available')),
                    'reason': cap.get('reason') or '',
                    'active': active, 'running': run_state,
                    'data_plane': plane_id,
                    'runtime_verified': bool(cap.get('runtime_verified')),
                    'runtime_state': runtime_state,
                    'runtime_reason': cap.get('runtime_reason') or '',
                    'verified_reason': cap.get('verified_reason') or '',
                    'required_warnings': cap.get('required_warnings') or [],
                    'summary': summary,
                    'checks': checks_for_plane,
                    'issues': cap.get('issues') or [],
                    'preflight_summary': cap.get('preflight_summary') or '',
                    'preflight_counts': cap.get('preflight_counts') or {},
                    'exact_object_load': bool(cap.get('exact_object_load', True)),
                    'probe_result': cap.get('result') or '',
                }

            ebpf_cap = capabilities.get('ebpf') or {}
            ebpf_plane = str(ebpf_cap.get('local_data_plane') or capabilities.get('ebpf_local_plane') or '')
            ebpf_label = ('TC / ' + ebpf_plane if ebpf_plane == 'socket_assign'
                          else 'TC' if ebpf_plane == 'tc'
                          else 'TC（参数未识别）')
            candidates['ebpf'] = ebpf_candidate(ebpf_cap, ebpf_plane, ebpf_label)
            candidates['ebpf_cgroup'] = ebpf_candidate(capabilities.get('ebpf_cgroup') or {}, 'cgroup', 'Cgroup')

            tun_cap = capabilities.get('tun') or {}
            interface_name = mode.get('interface') or 'singtun0'
            kernel_support = bool(tun_cap.get('kernel_support'))
            tun_checks = [
                check('/dev/net/tun', 'READY' if tun_ready else 'MISSING', tun_ready),
                check('TUN 内核支持', 'READY' if kernel_support else 'MISSING', kernel_support),
                check('sing-box', 'READY' if self.bin.is_file() else 'MISSING', self.bin.is_file()),
                check('iproute2', 'READY' if ip_ready else 'MISSING', ip_ready),
                standby('运行接口 (' + interface_name + ')'),
            ]
            if active_mode == 'tun' and running:
                link_text = command_text(['ip', 'link', 'show', 'dev', interface_name]) if ip_ready else ''
                route_text = command_text(['ip', 'route', 'show', 'table', 'all']) if ip_ready else ''
                tun_checks[-1] = check('运行接口 (' + interface_name + ')',
                                       'READY' if link_text and ('dev ' + interface_name) in route_text else 'MISSING',
                                       bool(link_text and ('dev ' + interface_name) in route_text))
            elif active_mode == 'tun':
                tun_checks[-1] = check('运行接口 (' + interface_name + ')', 'STOPPED', None)
            candidates['tun'] = {
                'available': bool(tun_cap.get('available')),
                'reason': tun_cap.get('reason') or '',
                'repair_available': bool(tun_cap.get('repair_available')),
                'kernel_support': bool(tun_cap.get('kernel_support')),
                'device_node': bool(tun_cap.get('device_node')),
                'active': active_mode == 'tun', 'running': running and active_mode == 'tun',
                'runtime_verified': bool(tun_cap.get('runtime_verified')),
                'runtime_state': str(tun_cap.get('runtime_state') or 'failed'),
                'runtime_reason': tun_cap.get('runtime_reason') or '',
                'summary': ('当前接管中 · ' + interface_name if running and active_mode == 'tun'
                            else '配置已保存，服务启动后生效' if active_mode == 'tun'
                            else tun_cap.get('reason') or '依赖已就绪'),
                'checks': tun_checks,
            }

            policy_text = command_text(['nft', 'list', 'table', 'inet', 'singbox_dash']) if nft_ready else ''
            rule4_text = command_text(['ip', 'rule', 'show']) if ip_ready else ''
            rule6_text = command_text(['ip', '-6', 'rule', 'show']) if ip_ready else ''
            route4_text = command_text(['ip', 'route', 'show', 'table', '100']) if ip_ready else ''
            route6_text = command_text(['ip', '-6', 'route', 'show', 'table', '100']) if ip_ready else ''
            policy_ready = (rule4_text and 'fwmark 0x1' in rule4_text and 'lookup 100' in rule4_text
                            and rule6_text and 'fwmark 0x1' in rule6_text and 'lookup 100' in rule6_text
                            and 'local default' in route4_text and 'local default' in route6_text)
            for mode_id, label in (('tproxy', 'TProxy'), ('redirect', 'Redirect')):
                cap = capabilities.get(mode_id) or {}
                runtime_checks = [
                    check('nftables', 'READY' if nft_ready else 'MISSING', nft_ready),
                    check('策略路由', 'READY' if ip_ready else 'MISSING', ip_ready),
                    standby('nft 规则表'),
                    standby('IPv4 / IPv6 规则'),
                ]
                if active_mode == mode_id and running:
                    table_ready = bool(policy_text and 'table inet singbox_dash' in policy_text)
                    rules_ready = bool(policy_ready and route4_text and route6_text)
                    runtime_checks[-2] = check('nft 规则表', 'READY' if table_ready else 'MISSING', table_ready)
                    runtime_checks[-1] = check('IPv4 / IPv6 规则', 'READY' if rules_ready else 'MISSING', rules_ready)
                elif active_mode == mode_id:
                    runtime_checks[-2] = check('nft 规则表', 'STOPPED', None)
                    runtime_checks[-1] = check('IPv4 / IPv6 规则', 'STOPPED', None)
                else:
                    table_ready = bool(policy_text and 'table inet singbox_dash' in policy_text)
                    runtime_checks[-2] = check('nft 规则表', 'LOADED' if table_ready else 'STANDBY', None)
                candidates[mode_id] = {
                    'available': bool(cap.get('available')),
                    'reason': cap.get('reason') or '',
                    'active': active_mode == mode_id, 'running': running and active_mode == mode_id,
                    'summary': ('当前接管中' if running and active_mode == mode_id
                                else '配置已保存，服务启动后生效' if active_mode == mode_id
                                else cap.get('reason') or '依赖已就绪'),
                    'checks': runtime_checks,
                }

            return {'ok': True, 'status': status, 'memory_kb': memory,
                    'disk': disk.stdout.decode('utf-8', 'replace')[-800:] if disk else '',
                    'checks': checks, 'modes': candidates, 'time': int(time.time())}

    def export_logs(self, source='all', level='all', query=''):
            text = self.recent_logs(1000).get('data', '')
            source_labels = {
                'sing-box 运行日志': '内核运行',
                'sing-box 系统日志': '系统日志',
                'LuCI / sing-box 配置错误': '配置错误'
            }
            wanted_source = str(source or 'all').strip()
            wanted_level = str(level or 'all').strip().lower()
            wanted_query = str(query or '').strip().lower()

            def level_of(line):
                upper = line.upper()
                if re.search(r'\b(?:FATAL|PANIC|ERROR)\b', upper):
                    return 'error'
                if re.search(r'\bWARN(?:ING)?\b', upper):
                    return 'warn'
                if re.search(r'\bDEBUG\b|\bTRACE\b', upper):
                    return 'debug'
                if re.search(r'\bINFO\b', upper):
                    return 'info'
                return 'other'

            def redact(line):
                line = re.sub(r'(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+', r'\1[hidden]', line)
                line = re.sub(r'(?i)((?:token|secret|password|passwd|uuid|key)=)[^&\s]+',
                              r'\1[hidden]', line)
                return line

            entries = []
            for section in re.split(r'\n\n(?=\[)', text):
                match = re.match(r'\[([^\]]+)\]\s*\n?', section)
                raw_source = match.group(1) if match else ''
                label = source_labels.get(raw_source, raw_source or '其他')
                body = section[match.end():] if match else section
                for line in body.replace('\r', '').splitlines():
                    if not line.strip():
                        continue
                    severity = level_of(line)
                    if wanted_source not in ('', 'all') and label != wanted_source:
                        continue
                    if wanted_level not in ('', 'all') and severity != wanted_level:
                        continue
                    if wanted_query and wanted_query not in (label + ' ' + line).lower():
                        continue
                    entries.append('[%s] %s' % (label, redact(line)))
            if not entries:
                raise Failure('当前筛选条件没有可导出的日志')
            entries = entries[-1000:]
            base = self.upload_dir()
            now = time.time()
            for old in base.glob('singbox-dash-logs-*.log'):
                try:
                    if now - old.stat().st_mtime > 600:
                        old.unlink(missing_ok=True)
                except OSError:
                    pass
            path = base / ('singbox-dash-logs-' + uuid.uuid4().hex + '.log')
            atomic(path, ('\n'.join(entries) + '\n').encode('utf-8'), 0o600)
            return {'ok': True, 'path': str(path), 'name': path.name,
                    'lines': len(entries)}

