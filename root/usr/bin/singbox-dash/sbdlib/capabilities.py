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
                        'requirement': 'required', 'name': 'Eksekusi perintah prapemeriksaan eBPF gagal',
                        'title': 'File kernel tidak ditemukan', 'advice': 'Pasang kernel sebelum memeriksa eBPF.',
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
                        'name': 'Eksekusi perintah prapemeriksaan eBPF gagal',
                        'title': 'Eksekusi perintah prapemeriksaan eBPF gagal',
                        'advice': 'Periksa file inti, hak akses root, dan log kernel.',
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
                    'requirement': 'required', 'name': 'Laporan diagnostik JSON eBPF tidak valid',
                    'title': 'Tidak dapat membaca laporan diagnostik eBPF',
                    'advice': 'Tingkatkan kernel sing-box ke versi yang mendukung tools ebpf status --json.',
                    'detail': raw[-800:]
                }]
                return base
            if not isinstance(report, dict):
                base['issues'] = [{
                    'severity': 'fail', 'status': 'FAIL', 'scope': 'report',
                    'requirement': 'required', 'name': 'Laporan diagnostik JSON eBPF tidak valid',
                    'title': 'Format laporan diagnostik eBPF tidak valid', 'advice': 'Ganti atau tingkatkan kernel sing-box.',
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
                feature = str(item.get('feature') or item.get('name') or 'Pemeriksaan eBPF')
                issues.append({
                    'severity': status.lower(),
                    'status': status,
                    'scope': str(item.get('scope') or ''),
                    'requirement': str(item.get('importance') or ''),
                    'name': feature,
                    'reason': str(item.get('reason') or ''),
                    'detail': str(item.get('detail') or '')[:1000],
                    'title': feature,
                    'advice': ('Kemampuan wajib ini tidak lulus; mode saat ini tidak dapat digunakan.'
                               if status in ('FAIL', 'UNKNOWN')
                               else 'Masalah ini harus diverifikasi saat mulai dan belum dapat dianggap tersedia.')
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
                    'requirement': 'required', 'name': 'Laporan diagnostik eBPF belum lengkap',
                    'title': 'Pemeriksaan kemampuan eBPF belum selesai',
                    'advice': 'Mode saat ini tidak dapat ditandai tersedia. Perbaiki masalah berdasarkan detail teknis, lalu periksa kembali.',
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
                    'requirement': 'required', 'name': 'Objek program eBPF yang sebenarnya tidak dimuat',
                    'title': 'Gagal memuat objek program eBPF yang sebenarnya',
                    'advice': 'Mode saat ini tidak dapat ditandai tersedia. Tingkatkan kernel, lalu periksa kembali.',
                    'detail': 'exact_object_load=false。'
                })
            if result == 'unsupported' and not issues:
                issues.append({
                    'severity': 'fail', 'status': 'FAIL', 'scope': 'ebpf',
                    'requirement': 'required', 'name': 'Kemampuan eBPF tidak didukung',
                    'title': 'Kernel saat ini tidak memiliki kemampuan eBPF yang diperlukan',
                    'advice': 'Tingkatkan kernel atau gunakan mode TUN / TProxy / Redirect.',
                    'detail': 'sing-box mengembalikan unsupported.'
                })
            if not supported and not issues:
                issues.append({
                    'severity': 'unknown', 'status': 'UNKNOWN', 'scope': 'ebpf',
                    'requirement': 'required', 'name': 'Kemampuan eBPF belum dikonfirmasi',
                    'title': 'Kemampuan eBPF belum dikonfirmasi',
                    'advice': 'Mode saat ini tidak dapat ditandai tersedia. Perbaiki masalah, lalu periksa kembali.',
                    'detail': 'Hasil prapemeriksaan belum memenuhi seluruh persyaratan untuk dinyatakan tersedia.'
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
                return {'plane': '', 'dialect': '', 'reason': 'Kernel belum dipasang'}
            cached = self.cache_get('ebpf-local-plane.json', key=binary)
            if isinstance(cached, dict) and cached.get('plane') in ('tc', 'socket_assign'):
                return cached
            try:
                result = self.run([self.bin, 'tools', 'ebpf', 'status', '--help'],
                                  timeout=8, check=False)
            except Failure as exc:
                return {'plane': '', 'dialect': '', 'reason': 'Tidak dapat membaca kemampuan eBPF kernel: ' + clean_error(exc)}
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
                        'Tidak dapat mengenali parameter data plane lokal eBPF pada versi kernel saat ini'}
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
                        return {'ok': False, 'created': False, 'reason': '/dev/net/tun ada tetapi bukan perangkat karakter'}
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
                        'reason': 'Dukungan TUN tidak terdeteksi di kernel; pasang kmod-tun atau gunakan kernel yang mendukung TUN'}
            device = self.root / 'dev/net/tun'
            try:
                device.parent.mkdir(parents=True, exist_ok=True)
                result = self.run(['mknod', str(device), 'c', '10', '200'], timeout=10, check=False)
                if result is None or result.returncode:
                    detail = clean_error((result.stderr or result.stdout).decode('utf-8', 'replace')) if result else 'mknod tidak tersedia'
                    return {'ok': False, 'created': False, 'reason': 'Tidak dapat membuat /dev/net/tun: ' + detail}
                self.run(['chmod', '666', str(device)], timeout=5, check=False)
                os.chmod(device, 0o666)
            except OSError as exc:
                return {'ok': False, 'created': False, 'reason': 'Tidak dapat membuat /dev/net/tun: ' + clean_error(exc)}
            verified = self.tun_probe()
            if not verified['device_node']:
                return {'ok': False, 'created': False, 'reason': '/dev/net/tun tetap tidak terdeteksi setelah dibuat'}
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
            reason = reason or 'Kemampuan perangkat belum diperiksa. Klik “Periksa kembali”.'
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
                    'Kernel diperbarui. Klik “Periksa kembali” untuk memperbarui kemampuan perangkat.')
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
            result['snapshot_reason'] = ('Lingkungan runtime berubah; hasil pemeriksaan sebelumnya ditampilkan. '
                                         'Klik “Periksa kembali” untuk memperbarui.'
                                         if result['stale'] else 'Menggunakan hasil pemeriksaan sebelumnya')
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
                    reason = 'Kernel belum dipasang'
                elif 'with_ebpf' not in version:
                    reason = 'Kernel saat ini bukan build eBPF'
                elif plane != 'cgroup' and not local_plane:
                    reason = layout.get('reason') or 'Tidak dapat mengenali parameter data plane lokal eBPF pada versi kernel saat ini'
                elif not bpffs:
                    reason = 'bpffs belum dipasang'
                elif plane == 'cgroup' and not cgroup2:
                    reason = 'cgroup v2 tidak diaktifkan pada sistem'
                elif not probe.get('supported'):
                    blockers = [item.get('title') or item.get('name')
                                for item in (probe.get('issues') or [])
                                if item.get('severity') in ('fail', 'unknown')]
                    reason = ('; '.join(blockers[:4])) if blockers else (probe.get('summary') or 'Prapemeriksaan eBPF tidak lulus')
                elif not members:
                    reason = 'Tidak dapat mengenali antarmuka anggota LAN'
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
                net_reason = 'Kernel belum dipasang'
            elif not nft:
                net_reason = 'nftables tidak tersedia'
            elif not ip:
                net_reason = 'iproute2 tidak tersedia'
            if not bin_ready:
                tun_reason = 'Kernel belum dipasang'
            elif not ip:
                tun_reason = 'iproute2 tidak tersedia'
            elif not tun_ready:
                tun_reason = ('Dukungan TUN kernel aktif, tetapi node perangkat /dev/net/tun tidak ada'
                              if tun_info['kernel_support'] else 'Dukungan TUN kernel tidak diaktifkan pada sistem')
            else:
                tun_reason = ''
            now = int(time.time())
            value = {
                'schema': 8,
                'checked': True, 'needs_check': False, 'stale': False,
                'checked_at': now, 'snapshot_reason': 'Pemeriksaan kemampuan perangkat baru saja selesai',
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
                                   'name': 'Eksekusi perintah prapemeriksaan eBPF gagal', 'detail': text.strip()[-800:]})
            friendly = {
                'tc namespace isolation': ('Isolasi jaringan TC dikonfirmasi saat mulai',
                    'Prapemeriksaan tidak dapat sepenuhnya menyimulasikan jaringan terisolasi dan antarmuka virtual; verifikasi otomatis dilakukan setelah sing-box berhasil dimulai.'),
                'local tc interface': ('Antarmuka TC lokal dikonfirmasi otomatis saat mulai',
                    'Jika antarmuka tidak ditentukan sebelumnya, sing-box akan memilih antarmuka default dan membuat antarmuka virtual internal secara otomatis.'),
                'downstream interface': ('Penerusan antarmuka LAN dikonfirmasi saat mulai',
                    'Prapemeriksaan tidak mengikat antarmuka LAN sebenarnya; aturan penerusan TC akan diperiksa setelah layanan dimulai.'),
                'bpf_sk_assign': ('Kernel tidak memiliki kemampuan alokasi socket',
                    'Kernel saat ini tidak mendukung bpf_sk_assign. Sebaiknya tingkatkan kernel atau gunakan mode TUN / TProxy.'),
                'ipv6 transparent udp sockets': ('Proxy transparan IPv6 UDP tidak tersedia',
                    'Nonaktifkan IPv6 dalam konfigurasi atau gunakan mode pengambilalihan lain.'),
                'ipv6 transparent tcp sockets': ('Proxy transparan IPv6 TCP tidak tersedia',
                    'Nonaktifkan IPv6 dalam konfigurasi atau gunakan mode pengambilalihan lain.'),
                'ipv4 transparent udp sockets': ('Proxy transparan IPv4 UDP tidak tersedia',
                    'Periksa kemampuan proxy transparan kernel dan namespace jaringan; jika perlu, gunakan mode TUN.'),
                'ipv4 transparent tcp sockets': ('Proxy transparan IPv4 TCP tidak tersedia',
                    'Periksa kemampuan proxy transparan kernel; jika perlu, gunakan mode TUN.'),
                'locked-memory limit': ('Batas penguncian memori BPF tercapai',
                    'Tingkatkan batas memlock kernel atau periksa batas sumber daya kontainer/sistem.'),
                'route netlink access': ('Izin konfigurasi rute tidak mencukupi',
                    'Pastikan sing-box berjalan sebagai root dan memiliki izin NET_ADMIN.'),
                'bpf jit': ('BPF JIT tidak diaktifkan', 'Mengaktifkan BPF JIT dapat meningkatkan performa penerusan eBPF.')
            }
            for item in issues:
                key = str(item.get('name') or '').strip().lower()
                if key == 'invalid ebpf local data plane':
                    plane = str(item.get('plane') or '').lower()
                    plane_name = ('TC / socket_assign' if plane == 'socket_assign'
                                  else 'TC' if plane == 'tc'
                                  else 'Cgroup' if plane == 'cgroup' else plane)
                    item['title'] = 'Kernel saat ini tidak mendukung data plane lokal ' + plane_name
                    item['advice'] = 'Gunakan data plane eBPF lain atau tingkatkan ke build kernel yang menyertakan data plane ini.'
                    continue
                title, advice = friendly.get(key, (item.get('name') or 'Masalah ditemukan saat prapemeriksaan', ''))
                if not advice:
                    advice = ('Kemampuan wajib ini tidak lulus. Periksa detail teknis atau alihkan mode pengambilalihan.'
                              if item.get('severity') in ('fail', 'unknown')
                              else 'Item ini hanya memengaruhi performa atau perlu dikonfirmasi lebih lanjut saat mulai.')
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
                return {'supported': False, 'summary': 'File kernel tidak ditemukan', 'issues': [], 'counts': {},
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
