"""Provider payload parsing and status reporting."""

import base64
import copy
import gzip
import json
from pathlib import Path
import re
import urllib.parse

from .common import MAX_CONFIG, Failure, atomic, clean_error


class ProviderMixin:
    def parse_share_link(self, link):
            parsed = urllib.parse.urlsplit(link.strip())
            scheme = parsed.scheme.lower()
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            tag = urllib.parse.unquote(parsed.fragment or '').strip()
            if scheme == 'vless':
                if not parsed.hostname or not parsed.username:
                    raise Failure('VLESS 节点缺少服务器或 UUID')
                outbound = {
                    'type': 'vless', 'tag': tag or parsed.hostname,
                    'server': parsed.hostname, 'server_port': int(parsed.port or 443),
                    'uuid': urllib.parse.unquote(parsed.username), 'packet_encoding': 'xudp'
                }
                flow = (query.get('flow') or [''])[0]
                if flow:
                    outbound['flow'] = flow
                transport = self.provider_transport(query)
                if transport:
                    outbound['transport'] = transport
                tls = self.provider_tls(query, parsed.hostname)
                if tls:
                    outbound['tls'] = tls
                return outbound
            if scheme == 'trojan':
                if not parsed.hostname or parsed.username is None:
                    raise Failure('Trojan 节点缺少服务器或密码')
                outbound = {
                    'type': 'trojan', 'tag': tag or parsed.hostname,
                    'server': parsed.hostname, 'server_port': int(parsed.port or 443),
                    'password': urllib.parse.unquote(parsed.username)
                }
                transport = self.provider_transport(query)
                if transport:
                    outbound['transport'] = transport
                tls = self.provider_tls(query, parsed.hostname, enabled=True)
                if tls:
                    outbound['tls'] = tls
                return outbound
            if scheme == 'vmess':
                encoded = link.strip()[8:].split('#', 1)[0]
                try:
                    raw = base64.b64decode(encoded + '=' * (-len(encoded) % 4))
                    value = json.loads(raw.decode('utf-8'))
                except (ValueError, UnicodeDecodeError) as exc:
                    raise Failure('VMess 节点数据无效') from exc
                server = str(value.get('add') or '')
                if not server or not value.get('id'):
                    raise Failure('VMess 节点缺少服务器或 UUID')
                outbound = {
                    'type': 'vmess', 'tag': str(value.get('ps') or tag or server),
                    'server': server, 'server_port': int(value.get('port') or 443),
                    'uuid': str(value['id']), 'security': str(value.get('scy') or 'auto'),
                    'alter_id': int(value.get('aid') or 0), 'packet_encoding': 'xudp'
                }
                net = str(value.get('net') or 'tcp').lower()
                if net == 'ws':
                    transport = {'type': 'ws', 'path': str(value.get('path') or '/')}
                    if value.get('host'):
                        transport['headers'] = {'Host': str(value['host'])}
                    outbound['transport'] = transport
                elif net == 'grpc':
                    outbound['transport'] = {'type': 'grpc', 'service_name': str(value.get('path') or '')}
                elif net in ('http', 'h2'):
                    transport = {'type': 'http', 'path': str(value.get('path') or '/')}
                    if value.get('host'):
                        transport['host'] = [str(value['host'])]
                    outbound['transport'] = transport
                if str(value.get('tls') or '').lower() in ('tls', 'reality'):
                    tls = {'enabled': True, 'server_name': str(value.get('sni') or value.get('host') or server)}
                    if str(value.get('allowInsecure') or '') in ('1', 'true'):
                        tls['insecure'] = True
                    if value.get('fp'):
                        tls['utls'] = {'enabled': True, 'fingerprint': str(value['fp'])}
                    outbound['tls'] = tls
                return outbound
            if scheme == 'ss':
                body = link.strip()[5:]
                body, _, fragment = body.partition('#')
                body = body.split('?', 1)[0]
                tag = urllib.parse.unquote(fragment or '')
                try:
                    if '@' in body:
                        user, server_part = body.rsplit('@', 1)
                        user = urllib.parse.unquote(user)
                        if ':' not in user:
                            user = base64.b64decode(user + '=' * (-len(user) % 4)).decode('utf-8')
                        parts = urllib.parse.urlsplit('//' + server_part)
                    else:
                        decoded = base64.b64decode(body + '=' * (-len(body) % 4)).decode('utf-8')
                        user, server_part = decoded.rsplit('@', 1)
                        parts = urllib.parse.urlsplit('//' + server_part)
                    method, password = user.split(':', 1)
                except (ValueError, UnicodeDecodeError) as exc:
                    raise Failure('Shadowsocks 节点数据无效') from exc
                if not parts.hostname or not parts.port:
                    raise Failure('Shadowsocks 节点缺少服务器或端口')
                return {'type': 'shadowsocks', 'tag': tag or parts.hostname,
                        'server': parts.hostname, 'server_port': int(parts.port),
                        'method': method, 'password': password}
            raise Failure('暂不支持协议：' + (scheme or 'unknown'))

    def parse_provider_payload(self, source):
            value = str(source or '').strip().lstrip('\ufeff')
            if not value:
                raise Failure('订阅内容为空')
            candidates = [value]
            compact = re.sub(r'\s+', '', value)
            if '://' not in compact and compact:
                try:
                    decoded = base64.b64decode(compact + '=' * (-len(compact) % 4)).decode('utf-8')
                    candidates.insert(0, decoded.lstrip('\ufeff'))
                except (ValueError, UnicodeDecodeError, base64.binascii.Error):
                    pass
            data = None
            for candidate in candidates:
                try:
                    parsed = json.loads(candidate)
                    if isinstance(parsed, dict) and isinstance(parsed.get('outbounds'), list):
                        data = parsed['outbounds']
                    elif isinstance(parsed, list):
                        data = parsed
                    if data is not None:
                        break
                except ValueError:
                    continue
            skipped = []
            if data is None:
                data = []
                for line in candidates[0].replace('\r', '').splitlines():
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue
                    try:
                        data.append(self.parse_share_link(line))
                    except Failure as exc:
                        skipped.append({'line': line[:96], 'error': str(exc)})
            outbounds = []
            used = set()
            for index, item in enumerate(data):
                if not isinstance(item, dict) or not item.get('type'):
                    skipped.append({'line': 'item-%d' % (index + 1), 'error': '节点对象缺少 type'})
                    continue
                outbound = copy.deepcopy(item)
                tag = str(outbound.get('tag') or '').strip() or 'node-%d' % (index + 1)
                base_tag = tag
                suffix = 2
                while tag in used:
                    tag = '%s (%d)' % (base_tag, suffix)
                    suffix += 1
                outbound['tag'] = tag
                used.add(tag)
                outbounds.append(outbound)
            if not outbounds:
                detail = skipped[0]['error'] if skipped else '未识别到受支持的节点链接或 Provider JSON'
                raise Failure('没有可导入的节点：' + detail)
            if len(outbounds) > 5000:
                raise Failure('单次最多导入 5000 个节点')
            return outbounds, skipped

    def import_provider(self, request):
            if not isinstance(request, dict):
                raise Failure('Provider 导入请求格式错误')
            tag = str(request.get('tag') or '').strip()
            path = self.provider_file_path(tag, request.get('path'))
            source_type = str(request.get('source_type') or 'text')
            source = str(request.get('source') or '')
            if source_type == 'url':
                url = source.strip()
                parsed = urllib.parse.urlsplit(url)
                if parsed.scheme not in ('http', 'https') or not parsed.netloc:
                    raise Failure('解析链接必须是 HTTP/HTTPS URL')
                import urllib.error
                import urllib.request
                req = urllib.request.Request(url, headers={'User-Agent': 'singbox-dash/1.0'})
                try:
                    with urllib.request.urlopen(req, timeout=35) as response:
                        raw = response.read(MAX_CONFIG + 1)
                except (urllib.error.URLError, OSError, ValueError) as exc:
                    raise Failure('解析链接下载失败：' + clean_error(exc)) from exc
                if len(raw) > MAX_CONFIG:
                    raise Failure('解析链接内容超过 10 MB')
                if raw[:2] == b'\x1f\x8b':
                    try:
                        raw = gzip.decompress(raw)
                    except OSError as exc:
                        raise Failure('解析链接 gzip 内容损坏') from exc
                source = raw.decode('utf-8-sig', 'replace')
            elif source_type != 'text':
                raise Failure('Provider 导入方式不合法')
            if len(source.encode('utf-8')) > MAX_CONFIG:
                raise Failure('节点内容超过 10 MB')
            outbounds, skipped = self.parse_provider_payload(source)
            payload = {'outbounds': outbounds}
            encoded = (json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
            atomic(path, encoded, 0o600)
            return {'ok': True, 'type': 'local', 'tag': tag, 'path': str(path),
                    'count': len(outbounds), 'tags': [item['tag'] for item in outbounds],
                    'skipped': skipped[:20]}

    def provider_status(self, config=None):
            active = self.active()
            if not active.is_file():
                raise Failure('当前配置不存在')
            if not isinstance(config, dict):
                config = self.parse(active.read_bytes())
            providers = config.get('providers') if isinstance(config.get('providers'), list) else []
            manifests = []
            total_nodes = 0
            latest = 0
            for item in providers:
                if not isinstance(item, dict):
                    continue
                tag = str(item.get('tag') or '')
                kind = 'local' if item.get('type') == 'local' else 'remote'
                raw_path = str(item.get('path') or '')
                path = self.conf / 'providers' / Path(raw_path).name if raw_path else None
                nodes = []
                error = ''
                size = 0
                mtime = 0
                if path and path.is_file() and not path.is_symlink():
                    try:
                        stat_result = path.stat()
                        size = stat_result.st_size
                        mtime = int(stat_result.st_mtime)
                        latest = max(latest, mtime)
                        payload = self.parse(path.read_bytes())
                        source = payload.get('outbounds') if isinstance(payload, dict) else []
                        for outbound in source if isinstance(source, list) else []:
                            if not isinstance(outbound, dict):
                                continue
                            tag_name = str(outbound.get('tag') or '')
                            if not tag_name:
                                continue
                            tls = outbound.get('tls') if isinstance(outbound.get('tls'), dict) else {}
                            transport = outbound.get('transport') if isinstance(outbound.get('transport'), dict) else {}
                            nodes.append({
                                'tag': tag_name,
                                'type': str(outbound.get('type') or 'Unknown'),
                                'server': str(outbound.get('server') or ''),
                                'port': outbound.get('server_port'),
                                'tls': bool(tls.get('enabled')),
                                'transport': str(transport.get('type') or ''),
                                'source': tag,
                            })
                    except (Failure, OSError, ValueError) as exc:
                        error = clean_error(exc) or '节点文件读取失败'
                total_nodes += len(nodes)
                manifests.append({
                    'tag': tag,
                    'kind': kind,
                    'url': str(item.get('url') or ''),
                    'path': raw_path,
                    'update_interval': str(item.get('update_interval') or ''),
                    'include': str(item.get('include') or ''),
                    'exclude': str(item.get('exclude') or ''),
                    'http_client': str(item.get('http_client') or ''),
                    'health_check': item.get('health_check') if isinstance(item.get('health_check'), dict) else {},
                    'node_count': len(nodes),
                    'nodes': nodes,
                    'file_exists': bool(path and path.is_file()),
                    'file_size': size,
                    'updated': mtime,
                    'error': error,
                })
            try:
                providers_api = self.clash_request({'method': 'GET', 'path': '/providers/proxies'}, config)
                api_items = providers_api.get('providers') if isinstance(providers_api, dict) else {}
                api_items = api_items if isinstance(api_items, dict) else {}
                for item in manifests:
                    clash_item = api_items.get(item.get('tag'))
                    if not isinstance(clash_item, dict):
                        continue
                    item['clash_vehicle'] = str(clash_item.get('vehicleType') or '')
                    item['clash_updated'] = str(clash_item.get('updatedAt') or '')
                    info = clash_item.get('subscriptionInfo')
                    if isinstance(info, dict):
                        upload = max(0, int(info.get('Upload') or 0))
                        download = max(0, int(info.get('Download') or 0))
                        total = max(0, int(info.get('Total') or 0))
                        used = upload + download
                        expire = max(0, int(info.get('Expire') or 0))
                        item['traffic'] = {
                            'upload': upload,
                            'download': download,
                            'used': used,
                            'total': total,
                            'remaining': max(0, total - used) if total else 0,
                            'percent': round(min(100.0, used * 100.0 / total), 1) if total else 0,
                            'expire': expire,
                        }
            except Failure:
                pass
            groups = {'selector', 'urltest', 'smart', 'smart-loadbalance', 'loadbalance', 'direct', 'block', 'dns'}
            manual = []
            for outbound in config.get('outbounds') or []:
                if not isinstance(outbound, dict):
                    continue
                if str(outbound.get('type') or '').lower() in groups:
                    continue
                tag_name = str(outbound.get('tag') or '')
                if not tag_name:
                    continue
                tls = outbound.get('tls') if isinstance(outbound.get('tls'), dict) else {}
                transport = outbound.get('transport') if isinstance(outbound.get('transport'), dict) else {}
                manual.append({
                    'tag': tag_name,
                    'type': str(outbound.get('type') or 'Unknown'),
                    'server': str(outbound.get('server') or ''),
                    'port': outbound.get('server_port'),
                    'tls': bool(tls.get('enabled')),
                    'transport': str(transport.get('type') or ''),
                    'source': '手动节点',
                })
            total_nodes += len(manual)
            return {
                'ok': True,
                'providers': manifests,
                'manual_nodes': manual,
                'counts': {
                    'providers': len(manifests),
                    'remote': sum(1 for item in manifests if item['kind'] == 'remote'),
                    'local': sum(1 for item in manifests if item['kind'] == 'local'),
                    'nodes': total_nodes,
                },
                'subscription': self.subscription_info(active),
                'latest_update': latest,
            }

