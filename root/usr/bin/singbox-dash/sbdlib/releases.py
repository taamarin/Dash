"""GitHub release discovery and platform asset selection."""

from pathlib import Path
import re
import time

from .common import Failure, atomic, natural_key, read_json, write_json


_UPSTREAM_VERSION_RE = re.compile(
    r'(?i)(?<!\d)(\d+)\.(\d+)\.(\d+)'
    r'(?:-((?:alpha|beta|rc)(?:[.-]?\d+)?))?'
)
_PREVIEW_STAGES = {'alpha': 0, 'beta': 1, 'rc': 2}


def parse_upstream_version(value):
    match = _UPSTREAM_VERSION_RE.search(str(value or ''))
    if not match:
        return None
    major, minor, patch = (int(match.group(index)) for index in (1, 2, 3))
    prerelease = str(match.group(4) or '').lower()
    if prerelease:
        preview = re.fullmatch(r'(alpha|beta|rc)[.-]?(\d+)?', prerelease)
        if not preview:
            return None
        label = preview.group(1)
        serial = int(preview.group(2) or 0)
        channel = 'preview'
        stage = _PREVIEW_STAGES[label]
        display = '%d.%d.%d-%s.%d' % (major, minor, patch, label, serial)
    else:
        stage = 3
        serial = 0
        channel = 'stable'
        display = '%d.%d.%d' % (major, minor, patch)
    return {
        'key': (major, minor, patch, stage, serial),
        'channel': channel,
        'version': display,
    }


class ReleaseMixin:
    def releases(self, channel='all', refresh=False, source=None):
            source_info = self.core_source_info(source)
            if source_info['id'] == 'unknown':
                source_info = self.core_source_info('michongs')
            source_id = source_info['id']
            repo = source_info['repo']
            cache = self.state / ('releases-%s.json' % source_id)
            cache_meta_path = self.state / ('releases-%s-meta.json' % source_id)
            cache_meta = read_json(cache_meta_path, {})
            cached_payload = None
            if cache.is_file() and cache_meta.get('repo') == repo:
                value = read_json(cache)
                if isinstance(value, list):
                    cached_payload = value
            cache_time = int(cache_meta.get('time') or 0)
            cache_used = False
            payload = None
            if (not refresh and cached_payload is not None
                    and time.time() - cache_time < 900):
                payload = cached_payload
                cache_used = True
            if payload is None:
                try:
                    payload = self.github_json(
                        'https://api.github.com/repos/%s/releases?per_page=30' % repo)
                    if isinstance(payload, dict) and isinstance(payload.get('releases'), list):
                        payload = payload['releases']
                    elif isinstance(payload, dict) and isinstance(payload.get('assets'), list):
                        payload = [payload]
                    if not isinstance(payload, list):
                        raise Failure('GitHub Release 数据格式异常')
                    cache_time = int(time.time())
                    write_json(cache, payload)
                    write_json(cache_meta_path, {'time': cache_time, 'repo': repo})
                except Failure:
                    # GitHub rate limits and transient outages must not blank the page
                    # when a previously fetched release list is available.
                    if cached_payload:
                        payload = cached_payload
                        cache_used = True
                    else:
                        raise
            self._release_cache_state = {'cached': cache_used, 'time': cache_time,
                                             'source': source_id, 'repo': repo}
            result = []
            for release in payload:
                if not isinstance(release, dict):
                    continue
                tag = str(release.get('tag_name') or '')
                prerelease = bool(release.get('prerelease')) or bool(re.search(
                    r'(?i)(alpha|beta|rc|preview)', tag))
                current_channel = 'preview' if prerelease else 'stable'
                if channel not in ('all', current_channel):
                    continue
                assets = []
                checksum_assets = []
                for asset in release.get('assets') or []:
                    name = str(asset.get('name') or '')
                    info = {
                        'name': name,
                        'size': int(asset.get('size') or 0),
                        'download': asset.get('browser_download_url', ''),
                        'digest': str(asset.get('digest') or ''),
                    }
                    if re.search(r'-linux-(?:386|amd64(?:-v[34])?|arm-v7|arm64|mipsle-softfloat|mips64le-softfloat|riscv64|loong64)(?:-(?:musl|glibc|ebpf))*\.tar\.gz$', name):
                        assets.append(info)
                    lower = name.lower()
                    if lower in ('sha256sums', 'sha256sums.txt', 'sha256sum.txt', 'checksums.txt', 'checksums.sha256') \
                            or lower.endswith(('.sha256', '.sha256sum')):
                        checksum_assets.append(info)
                result.append({
                    'tag': tag, 'name': release.get('name') or tag,
                    'published': release.get('published_at', ''),
                    'channel': current_channel, 'prerelease': prerelease,
                    'source': source_id, 'source_label': source_info['label'],
                    'repository': repo,
                    'body': str(release.get('body') or '')[:4000],
                    'assets': assets,
                    'checksum_assets': checksum_assets
                })
            result.sort(key=lambda item: item.get('published') or '', reverse=True)
            return result

    def choose_asset(self, release, requested=''):
            available = {item['name']: item for item in release.get('assets', [])}
            platform = self.platform()
            arch = platform['core_arch']
            aliases = {
                'amd64': 'amd64', '386': '386', 'arm64': 'arm64',
                'armv7': 'arm-v7', 'mipsle': 'mipsle-softfloat',
                'mips64le': 'mips64le-softfloat', 'riscv64': 'riscv64',
                'loong64': 'loong64'
            }
            name_arch = aliases.get(arch)
            if arch == 'armv6':
                raise Failure('设备为 ARMv6，Release 不提供兼容内核')
            if not name_arch:
                raise Failure('无法为架构选择内核：' + arch)

            def valid_platform_asset(name, manual=False):
                if not re.fullmatch(r'sing-box-[A-Za-z0-9._-]+-linux-[A-Za-z0-9._-]+\.tar\.gz', name):
                    return False
                marker = '-linux-' + name_arch
                if marker not in name:
                    return False
                tail = name.split(marker, 1)[1]
                if tail and tail[0] not in '-.':
                    return False
                tokens = name[:-len('.tar.gz')].split('-')
                if any(token in ('android', 'windows', 'darwin', 'freebsd', 'openbsd',
                                 'netbsd', 'easytier') for token in tokens):
                    return False
                if not manual and any(token in ('v2', 'v3', 'v4') for token in tokens):
                    return False
                if arch == 'amd64' and any(token in ('v2', 'v4') for token in tokens):
                    return False
                libc_token = 'musl' if 'musl' in tokens else ('glibc' if 'glibc' in tokens else '')
                if libc_token and libc_token != platform['libc']:
                    return False
                return True

            if requested:
                if requested not in available:
                    raise Failure('所选内核资产不属于该 Release')
                if not valid_platform_asset(requested, manual=True):
                    raise Failure('所选资产与当前设备架构或 libc 不兼容')
                return available[requested], '手动选择'
            profile = self.uci_get('prefer_ebpf', 'auto')
            ebpf = self.mode_capabilities_snapshot().get('ebpf', {}).get('available', False) if profile != 'off' else False
            if profile == 'on' and not ebpf:
                reason = self.mode_capabilities_snapshot().get('ebpf', {}).get('reason') or '系统未通过 eBPF 能力检查'
                raise Failure('已选择 eBPF 内核，但' + reason)
            candidates = []
            for name, asset in available.items():
                if not valid_platform_asset(name):
                    continue
                tokens = name[:-len('.tar.gz')].split('-')
                is_ebpf = 'ebpf' in tokens
                if is_ebpf and not ebpf:
                    continue
                score = 50
                if is_ebpf:
                    score += 40
                libc_token = 'musl' if 'musl' in tokens else ('glibc' if 'glibc' in tokens else '')
                if libc_token == platform['libc'] and libc_token:
                    score += 20
                candidates.append((score, name, asset))
            if not candidates:
                raise Failure('该 Release 没有适用于 %s/%s 的内核' % (arch, platform['libc']))
            score, name, asset = max(candidates, key=lambda item: (item[0], natural_key(item[1])))
            tokens = name[:-len('.tar.gz')].split('-')
            if release.get('source') == 'ref1nd':
                reason = '统一 eBPF 构建'
            else:
                reason = 'eBPF 构建' if 'ebpf' in tokens else '标准构建'
            libc_token = 'musl' if 'musl' in tokens else ('glibc' if 'glibc' in tokens else '')
            reason += ' / ' + (libc_token if libc_token else '静态兼容')
            return asset, reason

    def release_view(self, channel='all', refresh=False, source=None):
            releases = self.releases(channel, refresh, source=source)
            source_info = self.core_source_info(source)
            if source_info['id'] == 'unknown':
                source_info = self.core_source_info(releases[0].get('source') if releases else 'michongs')
            views = []
            for release in releases:
                views.append({'tag': release['tag'], 'name': release['name'],
                              'published': release['published'], 'channel': release['channel'],
                              'source': release.get('source') or '',
                              'source_label': release.get('source_label') or '',
                              'repository': release.get('repository') or '',
                              'assets': release['assets']})
            cache_state = getattr(self, '_release_cache_state', {})
            return {'ok': True, 'platform': self.platform(), 'releases': views[:20],
                    'source': source_info['id'], 'source_label': source_info['label'],
                    'core_family': self.core_family(),
                    'core_family_label': self.core_source_info(self.core_family())['label'],
                    'sources': self.core_sources(),
                    'repository': source_info['repo'],
                    'release_url': 'https://github.com/%s/releases' % source_info['repo'],
                    'cached': bool(cache_state.get('cached')),
                    'cache_time': int(cache_state.get('time') or 0),
                    'generated': int(time.time())}

    def release_has_compatible_asset(self, release):
            platform = self.platform()
            arch = platform.get('core_arch')
            name_arch = {
                'amd64': 'amd64', '386': '386', 'arm64': 'arm64',
                'armv7': 'arm-v7', 'mipsle': 'mipsle-softfloat',
                'mips64le': 'mips64le-softfloat', 'riscv64': 'riscv64',
                'loong64': 'loong64',
            }.get(arch)
            if not name_arch:
                return False
            libc = str(platform.get('libc') or '')
            for asset in release.get('assets') or []:
                name = str(asset.get('name') or '')
                marker = '-linux-' + name_arch
                if marker not in name or not name.endswith('.tar.gz'):
                    continue
                tail = name.split(marker, 1)[1]
                if tail and tail[0] not in '-.':
                    continue
                tokens = name[:-len('.tar.gz')].split('-')
                if any(token in ('android', 'windows', 'darwin', 'freebsd',
                                 'openbsd', 'netbsd', 'easytier') for token in tokens):
                    continue
                if arch == 'amd64' and any(token in ('v2', 'v3', 'v4') for token in tokens):
                    continue
                libc_token = 'musl' if 'musl' in tokens else ('glibc' if 'glibc' in tokens else '')
                if libc_token and libc and libc_token != libc:
                    continue
                return True
            return False

    def kernel_update_notice(self):
            enabled = self.uci_get('kernel_update_notice', '1') != '0'
            base = {'ok': True, 'enabled': enabled, 'available': False}
            if not enabled:
                return dict(base, reason='disabled')
            version_text = self.core_version()
            family = self.core_family(version_text)
            current = parse_upstream_version(version_text)
            if family == 'unknown' or current is None:
                return dict(base, reason='unknown-core')
            skipped = self.uci_get('kernel_update_skip', '')
            releases = self.releases(current['channel'], False, source=family)
            best = None
            for release in releases:
                target = parse_upstream_version(release.get('tag'))
                if target is None or target['channel'] != current['channel']:
                    continue
                if target['key'] <= current['key']:
                    continue
                if not self.release_has_compatible_asset(release):
                    continue
                if best is None or target['key'] > best[0]['key']:
                    best = (target, release)
            if best is None:
                return dict(base, reason='current')
            target, release = best
            notice_key = family + ':' + str(release.get('tag') or '')
            if skipped == notice_key:
                return dict(base, reason='skipped', skipped=True,
                            current_version=current['version'],
                            latest_version=target['version'],
                            latest_tag=release.get('tag') or '')
            return {
                'ok': True,
                'enabled': True,
                'available': True,
                'reason': 'update',
                'source': family,
                'source_label': self.core_source_info(family)['label'],
                'current_version': current['version'],
                'latest_version': target['version'],
                'latest_tag': release.get('tag') or '',
                'latest_name': release.get('name') or release.get('tag') or '',
                'channel': current['channel'],
                'published': release.get('published') or '',
                'notice_key': notice_key,
                'checked_at': int(time.time()),
            }

    def set_kernel_update_notice(self, request):
            if not isinstance(request, dict):
                raise Failure('提醒设置格式错误')
            action = str(request.get('action') or '').strip().lower()
            if action not in ('skip', 'disable', 'enable'):
                raise Failure('不支持的提醒操作')
            source = str(request.get('source') or '').strip().lower()
            tag = str(request.get('tag') or '').strip()
            if action == 'skip':
                source = source or self.core_family()
                families = {item['id'] for item in self.core_sources()}
                if source not in families or not re.fullmatch(r'[A-Za-z0-9._+\-]{1,128}', tag):
                    raise Failure('更新提醒标识无效')
            self.uci_file.parent.mkdir(parents=True, exist_ok=True)
            if not self.uci_file.exists():
                atomic(self.uci_file, b'', 0o600)
            if action == 'disable':
                self.run(['uci', 'set', 'singbox-dash.main.kernel_update_notice=0'], timeout=8)
            elif action == 'enable':
                self.run(['uci', 'set', 'singbox-dash.main.kernel_update_notice=1'], timeout=8)
                self.run(['uci', 'set', 'singbox-dash.main.kernel_update_skip='], timeout=8)
            else:
                self.run(['uci', 'set', 'singbox-dash.main.kernel_update_skip=' + source + ':' + tag], timeout=8)
            self.run(['uci', 'commit', 'singbox-dash'], timeout=8)
            return {'ok': True,
                    'enabled': self.uci_get('kernel_update_notice', '1') != '0',
                    'skipped': self.uci_get('kernel_update_skip', '')}

    def release_checksum(self, release, asset_name, target_dir):
            asset = next((item for item in release.get('assets', [])
                          if item.get('name') == asset_name), None)
            digest = str((asset or {}).get('digest') or '').strip().lower()
            match = re.fullmatch(r'sha256:([a-f0-9]{64})', digest)
            if match:
                return match.group(1)

            manifest_names = ('sha256sums', 'sha256sums.txt', 'sha256sum.txt', 'checksums.txt', 'checksums.sha256')
            candidates = list(release.get('checksum_assets') or [])
            for manifest_name in manifest_names:
                candidates.extend(item for item in release.get('assets', [])
                                  if str(item.get('name') or '').lower() == manifest_name)
            for suffix in ('.sha256', '.sha256sum'):
                candidates.extend(item for item in release.get('assets', [])
                                  if str(item.get('name') or '').lower() == (asset_name + suffix).lower())
            seen = set()
            target = Path(asset_name).name
            for item in candidates:
                name = str(item.get('name') or '')
                if not name or name in seen or not item.get('download'):
                    continue
                seen.add(name)
                path = self.download_url(item['download'], Path(target_dir) / ('checksum-' + name), 1024 * 1024)
                try:
                    text = path.read_text(encoding='utf-8', errors='replace')
                except OSError:
                    continue
                standalone = []
                for line in text.splitlines():
                    bsd = re.match(r'(?i)^SHA256\s*\((.+)\)\s*=\s*([a-f0-9]{64})\s*$', line.strip())
                    if bsd and Path(bsd.group(1).strip()).name == target:
                        return bsd.group(2).lower()
                    fields = line.split()
                    if len(fields) >= 2 and Path(fields[-1].lstrip('*')).name == target:
                        value = fields[0].strip().lower()
                        if re.fullmatch(r'[a-f0-9]{64}', value):
                            return value
                    hash_match = re.search(r'(?i)\b([a-f0-9]{64})\b', line)
                    if hash_match:
                        standalone.append(hash_match.group(1).lower())
                if name.lower() == (asset_name + '.sha256').lower() or name.lower() == (asset_name + '.sha256sum').lower():
                    if len(standalone) == 1:
                        return standalone[0]
            raise Failure('未找到目标内核的 SHA256 校验值')

