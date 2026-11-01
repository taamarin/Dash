import base64
import importlib.util
import json
import shutil
import tempfile
from types import SimpleNamespace
from pathlib import Path
project_root = Path(__file__).resolve().parents[1]
module_path = project_root / 'root/usr/bin/singbox-dash/manager.py'
spec = importlib.util.spec_from_file_location('sbd_manager', module_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
root = Path(tempfile.mkdtemp(prefix='sbd-test-'))
try:
    m = mod.Manager(str(root))
    m.core_version = lambda executable=None: 'sing-box version 1.15.0-alpha.12-xiaobaf14g-20261017\nTags: with_ebpf,with_purego'
    m.ebpf_local_plane = lambda: {'plane': 'socket_assign', 'dialect': 'socket_assign', 'reason': ''}
    m.validate = lambda data, executable=None: m.parse(data)
    def api_config(endpoint, secret=''):
        return {'experimental': {'clash_api': {
            'external_controller': endpoint, 'secret': secret
        }}}
    endpoint_cases = {
        '127.0.0.1:19090': ('127.0.0.1', 19090, 'http', False),
        '0.0.0.0:19091': ('0.0.0.0', 19091, 'http', True),
        ':19092': ('', 19092, 'http', True),
        '19093': ('', 19093, 'http', True),
        '[::]:19094': ('::', 19094, 'http', True),
        'http://localhost:19095': ('localhost', 19095, 'http', False),
        'https://[::1]:19096': ('::1', 19096, 'https', False),
    }
    for endpoint, expected in endpoint_cases.items():
        details = m.api_details(api_config(endpoint, 'test'))
        assert details['valid'], (endpoint, details)
        assert (details['host'], details['port'], details['scheme'], details['wildcard']) == expected, (endpoint, details)
        assert details['secret_set'] is True, details
    missing_api = m.api_details({'outbounds': []})
    assert not missing_api['enabled'] and not missing_api['valid'], missing_api
    bad_endpoint = m.api_details(api_config('127.0.0.1'))
    assert not bad_endpoint['valid'] and '端口' in bad_endpoint['error'], bad_endpoint
    try:
        m.validated_api_details(api_config('127.0.0.1'))
        raise AssertionError('invalid Clash API endpoint was accepted')
    except mod.Failure as exc:
        assert 'Clash API' in str(exc), exc
    print('Clash API endpoint tests OK')
    import http.server
    import threading
    class ApiHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            payload = json.dumps({'version': 'clash-port-test'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def log_message(self, *_args):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ApiHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        api_port = server.server_address[1]
        active_file = root / 'etc/sing-box/config.yaml'
        active_file.parent.mkdir(parents=True, exist_ok=True)
        active_config = api_config('127.0.0.1:' + str(api_port), 'secret')
        active_file.write_text(json.dumps(active_config), encoding='utf-8')
        m.active = lambda: active_file
        response = m.clash_request({'method': 'GET', 'path': '/version'}, active_config)
        assert response['version'] == 'clash-port-test', response
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    print('Clash API configured-port request OK')
    stable_schema = json.loads((Path(__file__).resolve().parent / 'fixtures/stable-1.14-schema.json').read_text(encoding='utf-8'))
    old_core_version = m.core_version
    old_core_schema = m.core_schema
    m.core_version = lambda executable=None: 'sing-box version 1.14.1-xiaobaf14g.1\nTags: with_clash_api'
    m.core_schema = lambda: stable_schema
    compatible_cfg = {
        'dns': {'tcp_concurrent': True, 'servers': [{'type': 'local', 'tag': 'local'}]},
        'inbounds': [{'type': 'mixed', 'tag': 'mixed', 'listen_port': 7890}],
        'outbounds': [{'type': 'direct', 'tag': 'direct'}]
    }
    prepared, cleaned, compat = m.prepare_config_for_core(json.dumps(compatible_cfg).encode())
    assert prepared.lstrip().startswith(b'{'), prepared
    assert 'tcp_concurrent' not in cleaned['dns'], cleaned
    assert 'dns.tcp_concurrent' in compat['removed'], compat
    easytier_cfg = dict(compatible_cfg)
    easytier_cfg['dns'] = {'servers': [{'type': 'easytier', 'tag': 'et'}]}
    try:
        m.prepare_config_for_core(json.dumps(easytier_cfg).encode())
        raise AssertionError('stable core accepted unsupported DNS transport')
    except mod.Failure as exc:
        assert 'easytier' in str(exc) and '升级内核' in str(exc), exc
    ebpf_cfg = dict(compatible_cfg)
    ebpf_cfg['inbounds'] = [{'type': 'ebpf', 'tag': 'in', 'network': ['tcp', 'udp']}]
    try:
        m.prepare_config_for_core(json.dumps(ebpf_cfg).encode())
        raise AssertionError('non-eBPF core accepted eBPF inbound')
    except mod.Failure as exc:
        assert 'with_ebpf' in str(exc), exc
    m.core_version = old_core_version
    m.core_schema = old_core_schema
    print('core compatibility tests OK')
    m.lan_members = lambda: ['eth0', 'eth1']
    m.mode_capabilities_snapshot = lambda: {'ebpf': {'available': True, 'reason': ''}}
    m.uci_get = lambda key, default='': 'auto'
    cfg = {
        'inbounds': [
            {'type': 'mixed', 'tag': 'mixed-in', 'listen': '0.0.0.0', 'listen_port': 7890},
            {'type': 'tproxy', 'tag': 'redirect-udp-in', 'listen': '0.0.0.0',
             'listen_port': 7896, 'network': ['udp']}
        ],
        'outbounds': [{'type': 'direct', 'tag': 'direct'}],
        'route': {'rules': [], 'final': 'direct'}
    }
    raw = json.dumps(cfg).encode()
    ebpf = json.loads(m.mode_plan(raw, 'ebpf'))
    ebpf_in = next(x for x in ebpf['inbounds'] if x['type'] == 'ebpf')
    assert ebpf_in['shared']['interface'] == ['eth0', 'eth1'], ebpf_in
    assert ebpf_in['local']['data_plane'] == 'socket_assign', ebpf_in
    redirect = json.loads(m.mode_plan(raw, 'redirect'))
    redirect_tcp = next(x for x in redirect['inbounds'] if x['type'] == 'redirect')
    redirect_udp = next(x for x in redirect['inbounds'] if x['tag'] == 'redirect-udp-in')
    assert redirect_tcp['listen_port'] == 7895, redirect_tcp
    assert redirect_udp['listen_port'] == 7896, redirect_udp
    assert redirect_tcp['listen_port'] != redirect_udp['listen_port']
    details = m.mode_details(json.dumps(redirect).encode())
    assert details['mode'] == 'redirect'
    assert details['port'] == 7895 and details['udp_port'] == 7896, details
    domain_target = m.trace_target_parts('www.google.com')
    assert domain_target == {'kind': 'domain', 'display': 'www.google.com', 'match': 'www.google.com', 'port': 443, 'network': 'tcp'}, domain_target
    url_target = m.trace_target_parts('http://www.huawei.com:8080/path')
    assert url_target['kind'] == 'domain' and url_target['port'] == 8080, url_target
    assert m.trace_domain_match('domain', 'www.huawei.com', 'cn,huawei.com')
    assert not m.trace_domain_match('domain', 'not-huawei.com', 'huawei.com')
    exact, _ = m.trace_rule_match({'type': 'Domain', 'payload': 'google.com'}, {'kind': 'domain', 'match': 'www.google.com', 'port': 443, 'network': 'tcp'}, 'rule', {}, {})
    assert exact is False, exact
    assert m.trace_ip_match('ip', '142.250.72.14', '142.250.72.0/24')
    mode_match, _ = m.trace_rule_match({'type': 'ClashMode', 'payload': 'Global'}, {'kind': 'domain', 'match': 'example.com', 'port': 443, 'network': 'tcp'}, 'global', {}, {})
    assert mode_match is True
    proxies = {
        'Google': {'name': 'Google', 'type': 'Selector', 'now': 'ALL', 'all': ['ALL']},
        'ALL': {'name': 'ALL', 'type': 'Selector', 'now': 'US', 'all': ['US']},
        'US': {'name': 'US', 'type': 'Selector', 'now': 'node-1', 'all': ['node-1']},
        'node-1': {'name': 'node-1', 'type': 'VLESS'}
    }
    resolved = m.trace_proxy_chain(proxies, 'Google')
    assert [hop['name'] for hop in resolved['chain']] == ['Google', 'ALL', 'US', 'node-1'], resolved
    assert resolved['final'] == 'node-1', resolved
    print('mode tests OK', details)
    release = {'assets': [
        {'name': 'sing-box-1.14.1-xiaobaf14g.1-linux-arm64.tar.gz', 'download': 'a'},
        {'name': 'sing-box-1.14.1-xiaobaf14g.1-linux-arm64-ebpf.tar.gz', 'download': 'b'},
        {'name': 'sing-box-1.14.1-xiaobaf14g.1-linux-amd64.tar.gz', 'download': 'c'},
        {'name': 'sing-box-1.14.1-xiaobaf14g.1-linux-amd64-v3-ebpf.tar.gz', 'download': 'd'},
        {'name': 'sing-box-1.14.1-xiaobaf14g.1-linux-mipsle-softfloat.tar.gz', 'download': 'e'},
        {'name': 'sing-box-1.14.1-xiaobaf14g.1-linux-mips64le-softfloat-ebpf.tar.gz', 'download': 'f'},
    ]}
    m.mode_capabilities_snapshot = lambda: {'ebpf': {'available': True, 'reason': ''}}
    m.uci_get = lambda key, default='': 'auto'
    m.platform = lambda: {'core_arch': 'arm64', 'libc': 'musl'}
    chosen, reason = m.choose_asset(release)
    assert chosen['name'].endswith('-linux-arm64-ebpf.tar.gz'), chosen
    m.platform = lambda: {'core_arch': 'amd64', 'libc': 'musl'}
    chosen, reason = m.choose_asset(release)
    assert chosen['name'].endswith('-linux-amd64.tar.gz'), chosen
    m.platform = lambda: {'core_arch': 'mipsle', 'libc': 'musl'}
    chosen, reason = m.choose_asset(release)
    assert chosen['name'].endswith('-linux-mipsle-softfloat.tar.gz'), chosen
    print('asset tests OK')
    ui_root = project_root / 'htdocs/luci-static/resources/view/singbox-dash/v70'
    assert (ui_root / 'index.js').is_file(), ui_root
    for script in ui_root.rglob('*.js'):
        source = script.read_text(encoding='utf-8')
        assert 'singbox-dash.v51' not in source, script
        assert all(release not in source for release in ('v1.0-r84', 'v1.0-r85', 'v1.0-r86', 'v1.0-r87', 'v1.0-r88', 'v1.0-r89')), script
    menu = (project_root / 'root/usr/share/luci/menu.d/luci-app-singbox-dash.json').read_text(encoding='utf-8')
    assert 'singbox-dash/v70/index' in menu, menu
    entry = (ui_root / 'index.js').read_text(encoding='utf-8')
    assert "module: pageModule('overview')" in entry, entry
    assert 'await L.require(definition.module)' in entry, entry
    assert 'pages.overview as overviewPage' not in entry, entry
    assert 'warmPageData' not in entry, entry
    assert '.gz?v=' in entry, entry
    assert 'const ASSET_VERSION = ' in entry, entry
    overview_source = (ui_root / 'pages/overview.js').read_text(encoding='utf-8')
    assert 'statusTimer' not in overview_source, overview_source
    assert "E('h2', { 'class': 'sbd-card-title' }" in (ui_root / 'lib/dom.js').read_text(encoding='utf-8')
    print('v70 lazy module paths and single status poller OK')
    old_family_version = m.core_version
    m.core_version = lambda executable=None: 'sing-box version 1.14.3-reF1nd\nTags: with_ebpf,with_clash_api'
    assert m.core_family() == 'ref1nd', m.core_family()
    source_info = m.core_source_info()
    assert source_info['repo'] == 'reF1nd/sing-box-releases', source_info
    ref_release = {
        'source': 'ref1nd', 'repository': 'reF1nd/sing-box-releases',
        'assets': [
            {'name': 'sing-box-1.14.3-reF1nd-linux-arm64-glibc.tar.gz', 'download': 'g', 'digest': ''},
            {'name': 'sing-box-1.14.3-reF1nd-linux-arm64-musl.tar.gz', 'download': 'm', 'digest': 'sha256:' + 'a' * 64},
            {'name': 'sing-box-1.14.3-reF1nd-linux-amd64-musl.tar.gz', 'download': 'x', 'digest': ''},
        ]
    }
    m.platform = lambda: {'core_arch': 'arm64', 'libc': 'musl'}
    chosen, reason = m.choose_asset(ref_release)
    assert chosen['name'].endswith('-linux-arm64-musl.tar.gz'), chosen
    assert reason.startswith('统一 eBPF 构建'), reason
    fetched_urls = []
    def fake_github(url):
        fetched_urls.append(url)
        return [{'tag_name': 'v1.14.3-reF1nd', 'name': 'reF1nd stable', 'prerelease': False,
                 'published_at': '2026-10-10T00:49:24Z', 'assets': ref_release['assets']}]
    m.github_json = fake_github
    ref_releases = m.releases('stable', True, source='ref1nd')
    assert ref_releases and ref_releases[0]['source'] == 'ref1nd', ref_releases
    assert 'reF1nd/sing-box-releases' in fetched_urls[0], fetched_urls
    m.core_version = lambda executable=None: 'sing-box version 1.15.0-alpha.12-xiaobaf14g-20261023\nTags: with_ebpf'
    assert m.core_family() == 'michongs', m.core_family()
    field_cfg = {'outbounds': [{'type': 'hysteria2', 'tag': 'h2', 'h3_congestion_control': 'bbr'}]}
    prepared, cleaned, compatibility = m.prepare_config_for_core(json.dumps(field_cfg).encode())
    assert 'outbounds[0].h3_congestion_control' in compatibility['removed'], compatibility
    assert 'h3_congestion_control' not in cleaned['outbounds'][0], cleaned
    m.core_version = old_family_version
    print('core source and reF1nd release tests OK')
    stopped_calls = []
    settings_values = {
        'enabled': '1', 'default_page': 'overview', 'update_interval': '0',
        'prefer_ebpf': 'auto', 'github_proxy': '', 'dns_failover': '1',
        'dns_singbox_port': '', 'dns_backup_port': '1153',
        'dns_fallback_server': '223.5.5.5', 'dns_guard_interval': '5',
        'dns_singbox_port_detected': '', 'dns_smartdns_port': '1153'
    }
    m.settings_get = lambda: {'settings': dict(settings_values)}
    m.uci_get = lambda key, default='': '1' if key == 'enabled' else default
    m.pids = lambda: []
    m.service_action = lambda action: stopped_calls.append(action)
    def stopped_run(args, **_kwargs):
        stopped_calls.append(list(args))
        return SimpleNamespace(returncode=0, stdout=b'', stderr=b'')
    m.run = stopped_run
    result = m.settings_set({'enabled': '1', 'default_page': 'overview'})
    assert result['ok'], result
    assert 'start' not in stopped_calls, stopped_calls
    assert ['enable', 'disable'] == [] or not any(item in ('enable', 'disable') for item in stopped_calls if isinstance(item, str)), stopped_calls

    stopped_target = m.conf / 'stopped-save.yaml'
    stopped_target.parent.mkdir(parents=True, exist_ok=True)
    old_cfg = {'inbounds': [], 'outbounds': [{'type': 'direct', 'tag': 'direct'}]}
    new_cfg = {'inbounds': [], 'outbounds': [{'type': 'direct', 'tag': 'new-direct'}]}
    stopped_target.write_text(json.dumps(old_cfg), encoding='utf-8')
    job_id = 'a' * 32
    job_folder = m.jobs / job_id
    job_folder.mkdir(parents=True, exist_ok=True)
    candidate = json.dumps(new_cfg).encode()
    (job_folder / 'candidate').write_bytes(candidate)
    job = {'id': job_id, 'action': 'save', 'target': stopped_target.name,
           'expected': mod.digest(stopped_target.read_bytes()), 'mode': ''}
    m.active = lambda: stopped_target
    m.pids = lambda: []
    m.prepare_config_for_core = lambda data: (data, m.parse(data), {'supported': True, 'removed': []})
    m.validated_api_details = lambda config: {'endpoint': '', 'port': None, 'enabled': False}
    m.validate = lambda data, executable=None: m.parse(data)
    m.mode_details = lambda data: {'mode': 'custom', 'port': None, 'udp_port': None, 'interface': ''}
    m.api_details = lambda data: {'endpoint': '', 'port': None}
    m.backup_config = lambda name: ''
    job_status = m.apply_config_job(job)
    assert job_status['phase'] == 'done', job_status
    assert json.loads(stopped_target.read_text(encoding='utf-8')) == new_cfg
    assert 'start' not in [item for item in stopped_calls if isinstance(item, str)], stopped_calls
    print('stopped-core settings and config save tests OK')
    async_target = m.conf / 'async-save.yaml'
    async_target.parent.mkdir(parents=True, exist_ok=True)
    async_old = json.dumps({'outbounds': [{'type': 'direct', 'tag': 'old'}]}).encode()
    async_target.write_bytes(async_old)
    async_candidate = json.dumps({'outbounds': [{'type': 'direct', 'tag': 'new'}]}).encode()
    upload = m.upload_dir() / 'singbox-dash-async-test'
    upload.write_bytes(async_candidate)
    captured = {}
    def capture_job(action, target, candidate, **extra):
        captured.update({'action': action, 'target': target,
                         'candidate': candidate, 'extra': extra})
        return {'id': 'b' * 32, 'action': action, 'phase': 'queued'}
    m.upload_path = lambda value: upload
    m.prepare_config_for_core = lambda data: (data, m.parse(data), {'supported': True, 'removed': []})
    m.validated_api_details = lambda config: {'endpoint': '', 'port': None, 'enabled': False}
    m.create_job = capture_job
    validate_before_async = m.validate
    m.validate = lambda data, executable=None: (_ for _ in ()).throw(
        AssertionError('submit path must not run sing-box check synchronously'))
    queued = m.submit_save({'action': 'save', 'target': async_target.name,
                            'expected': mod.digest(async_old), 'source': str(upload)})
    assert queued['phase'] == 'queued', queued
    assert captured['candidate'] == async_candidate, captured
    async_job_folder = m.jobs / ('c' * 32)
    async_job_folder.mkdir(parents=True, exist_ok=True)
    m._apply_config_job = lambda job, folder: (_ for _ in ()).throw(mod.Failure('模拟异步校验失败'))
    failed = m.apply_config_job({'id': 'c' * 32, 'action': 'save', 'target': async_target.name})
    assert failed['phase'] == 'failed' and '模拟异步校验失败' in failed['error'], failed
    m.validate = validate_before_async
    print('async validation and task failure tests OK')
    links = '\n'.join([
        'vless://11111111-2222-3333-4444-555555555555@example.com:443?type=tcp&security=reality&flow=xtls-rprx-vision&fp=chrome&sni=example.com&pbk=public-key&sid=abcd#Node-A',
        'trojan://secret@example.net:443?sni=example.net#Node-B'
    ])
    parsed, skipped = m.parse_provider_payload(base64.b64encode(links.encode()).decode())
    assert len(parsed) == 2 and not skipped, (parsed, skipped)
    assert parsed[0]['type'] == 'vless' and parsed[0]['tag'] == 'Node-A', parsed
    assert parsed[0]['tls']['reality']['public_key'] == 'public-key', parsed
    assert parsed[1]['type'] == 'trojan' and parsed[1]['password'] == 'secret', parsed
    print('provider parser tests OK')
    failed_report = '\n'.join([
        'FAIL    [common        ] [required   ] bpf_sk_assign',
        '        Kernel does not expose bpf_sk_assign.',
        'UNKNOWN [common        ] [required   ] IPv6 transparent UDP sockets',
        '        Probe result is unknown.',
        'Summary: PASS=42 WARN=1 FAIL=1 UNKNOWN=1 REQUIRED_FAILURES=1 REQUIRED_UNKNOWNS=1',
        'Preflight result: failed'
    ])
    probe = m.parse_ebpf_report(failed_report, 0)
    assert not probe['supported'], probe
    assert len(probe['issues']) == 2, probe
    assert probe['issues'][0]['name'] == 'bpf_sk_assign', probe
    assert 'does not expose' in probe['issues'][0]['detail'], probe
    assert probe['counts']['REQUIRED_UNKNOWNS'] == 1, probe
    print('eBPF report parser tests OK')
    passed_json = json.dumps({
        'platform': 'OpenWrt', 'kernel_release': 'test', 'architecture': 'arm64',
        'mode': 'all', 'local_data_plane': 'socket_assign',
        'shared_data_plane': 'packet_rewrite', 'network': ['tcp', 'udp'],
        'ipv6': True, 'findings': [], 'preflight': True,
        'exact_object_load': True,
        'summary': {'pass': 1, 'warn': 0, 'fail': 0, 'unknown': 0,
                    'required_failures': 0, 'required_unknowns': 0},
        'result': 'preflight_passed'
    }).encode()
    report = m.parse_ebpf_json_report(passed_json.decode(), 0)
    assert report['supported'] and report['result'] == 'preflight_passed', report
    assert report['exact_object_load'] and report['preflight'], report
    report = m.parse_ebpf_json_report(passed_json.decode().replace('preflight_passed', 'unsupported'), 0)
    assert not report['supported'] and report['issues'], report
    report = m.parse_ebpf_json_report('not-json', 1)
    assert not report['supported'] and report['result'] == 'invalid', report
    report = m.parse_ebpf_json_report(passed_json.decode().replace('"exact_object_load": true', '"exact_object_load": false'), 0)
    assert not report['supported'] and report['issues'], report
    print('structured eBPF probe parser tests OK')
    invalid_plane = m.parse_ebpf_report('FATAL invalid eBPF local data plane: socket_assign', 1)
    assert not invalid_plane['supported'], invalid_plane
    assert invalid_plane['issues'][0]['title'] == '当前内核不支持 TC / socket_assign 本地数据面', invalid_plane
    m.ebpf_local_plane = type(m).ebpf_local_plane.__get__(m, type(m))
    modern_bin = root / 'usr/bin/sing-box-modern'
    modern_bin.parent.mkdir(parents=True, exist_ok=True)
    modern_bin.write_bytes(b'modern')
    m.bin = modern_bin
    def fake_help(args, timeout=8, check=False, input_data=None, env=None):
        return SimpleNamespace(
            returncode=0,
            stdout=b'      --local-data-plane string   Local data plane: socket_assign or cgroup\n',
            stderr=b'')
    m.run = fake_help
    modern_plane = m.ebpf_local_plane()
    assert modern_plane['plane'] == 'socket_assign', modern_plane
    legacy_bin = root / 'usr/bin/sing-box-legacy'
    legacy_bin.write_bytes(b'legacy')
    m.bin = legacy_bin
    def fake_legacy_help(args, timeout=8, check=False, input_data=None, env=None):
        return SimpleNamespace(
            returncode=0,
            stdout=b'      --local-data-plane string   Local data plane: tc or cgroup\n',
            stderr=b'')
    m.run = fake_legacy_help
    legacy_plane = m.ebpf_local_plane()
    assert legacy_plane['plane'] == 'tc', legacy_plane
    m.mode_capabilities_snapshot = type(m).mode_capabilities_snapshot.__get__(m, type(m))
    probe_calls = []
    def fake_probe(plane='socket_assign', shared='packet_rewrite', interfaces=None):
        probe_calls.append((plane, shared, tuple(interfaces or ())))
        return {'supported': True, 'result': 'preflight_passed', 'preflight': True,
                'exact_object_load': True,
                'summary': 'Summary: PASS=1 FAIL=0 REQUIRED_FAILURES=0 REQUIRED_UNKNOWNS=0',
                'issues': [], 'counts': {'PASS': 1, 'FAIL': 0, 'REQUIRED_FAILURES': 0, 'REQUIRED_UNKNOWNS': 0}}
    m.ebpf_probe = fake_probe
    unchecked = m.mode_capabilities()
    assert unchecked['checked'] is False and not probe_calls, unchecked
    checked = m.mode_capabilities(refresh=True)
    assert checked['checked'] is True and probe_calls, checked
    probe_calls.clear()
    snapshot = m.mode_capabilities()
    assert snapshot['checked'] is True and not probe_calls, snapshot
    assert snapshot['needs_check'] is False, snapshot
    runtime_details = {'mode': 'ebpf', 'data_plane': 'tc'}
    m.record_mode_runtime(runtime_details, False, 'TC network namespace unavailable')
    runtime_caps = {
        'ebpf_local_plane': 'tc',
        'ebpf': {'available': True, 'issues': [{'severity': 'warn', 'requirement': 'required',
                                                'title': 'TC namespace isolation'}]},
        'ebpf_cgroup': {'available': True, 'issues': []},
        'tun': {'available': True, 'issues': []},
        'tproxy': {'available': True, 'issues': []},
        'redirect': {'available': True, 'issues': []}
    }
    annotated = m.annotate_runtime_evidence(runtime_caps)
    assert annotated['ebpf']['runtime_state'] == 'failed', annotated
    assert annotated['ebpf']['available'] is False, annotated
    assert '实际启动失败' in annotated['ebpf']['reason'], annotated
    m.reset_failed_runtime_modes()
    warning_mode = m.annotate_runtime_evidence({
        'ebpf_local_plane': 'tc',
        'ebpf': {'available': True, 'issues': [{'severity': 'warn', 'requirement': 'required',
                                                'title': 'TC namespace isolation'}]},
        'ebpf_cgroup': {'available': True, 'issues': []},
        'tun': {'available': True, 'issues': []},
        'tproxy': {'available': True, 'issues': []},
        'redirect': {'available': True, 'issues': []}
    })
    assert warning_mode['ebpf']['runtime_state'] == 'success', warning_mode
    assert warning_mode['ebpf']['available'] is True, warning_mode
    no_runtime_evidence = m.annotate_runtime_evidence({
        'ebpf_local_plane': 'tc',
        'ebpf': {'available': True, 'issues': []},
        'ebpf_cgroup': {'available': True, 'issues': []},
        'tun': {'available': True, 'issues': []},
        'tproxy': {'available': True, 'issues': []},
        'redirect': {'available': True, 'issues': []}
    })
    assert no_runtime_evidence['ebpf']['available'] is True, no_runtime_evidence
    m.record_mode_runtime(runtime_details, True, 'started')
    verified = m.annotate_runtime_evidence(warning_mode)
    assert verified['ebpf']['runtime_verified'] is True, verified
    (root / 'sys/class/misc/tun').mkdir(parents=True, exist_ok=True)
    tun = m.tun_probe()
    assert tun['kernel_support'] and not tun['device_node'], tun
    def fake_tun_run(args, timeout=40, check=True, input_data=None, env=None):
        if args[0] == 'mknod':
            Path(args[1]).write_bytes(b'')
        return SimpleNamespace(returncode=0, stdout=b'', stderr=b'')
    m.run = fake_tun_run
    tun_repaired = m.ensure_tun_device()
    assert tun_repaired['ok'] and tun_repaired['created'], tun_repaired
    m.mode_capabilities_snapshot = lambda version=None, refresh=False: {
        'ebpf': {'available': True, 'reason': '', 'local_data_plane': 'socket_assign'},
        'ebpf_cgroup': {'available': True, 'reason': '', 'local_data_plane': 'cgroup'},
        'tun': {'available': True, 'reason': ''},
        'tproxy': {'available': True, 'reason': ''},
        'redirect': {'available': True, 'reason': ''}}
    tc_plan = json.loads(m.mode_plan(raw, 'ebpf'))
    tc_in = next(item for item in tc_plan['inbounds'] if item['type'] == 'ebpf')
    assert tc_in['local']['data_plane'] == 'socket_assign', tc_in
    cgroup_plan = json.loads(m.mode_plan(raw, 'ebpf_cgroup'))
    cgroup_in = next(item for item in cgroup_plan['inbounds'] if item['type'] == 'ebpf')
    assert cgroup_in['local']['data_plane'] == 'cgroup', cgroup_in
    m.mode_capabilities_snapshot = lambda version=None, refresh=False: {
        'ebpf': {'available': True, 'reason': '', 'local_data_plane': 'tc'},
        'ebpf_cgroup': {'available': True, 'reason': '', 'local_data_plane': 'cgroup'}}
    legacy_plan = json.loads(m.mode_plan(raw, 'ebpf'))
    legacy_in = next(item for item in legacy_plan['inbounds'] if item['type'] == 'ebpf')
    assert legacy_in['local']['data_plane'] == 'tc', legacy_in
    fallback_init = root / 'etc/init.d/singbox-dash-core'
    fallback_init.parent.mkdir(parents=True, exist_ok=True)
    fallback_init.write_text('#!/bin/sh\n', encoding='utf-8')
    m.core_init = root / 'etc/init.d/sing-box-missing'
    assert m.core_service_init() == fallback_init, m.core_service_init()
    provider_dir = root / 'etc/sing-box/providers'
    provider_dir.mkdir(parents=True, exist_ok=True)
    provider_file = provider_dir / 'Demo.yaml'
    provider_file.write_text(json.dumps({'outbounds': [
        {'type': 'vless', 'tag': 'Demo-A', 'server': 'a.example.com', 'server_port': 443, 'tls': {'enabled': True}},
        {'type': 'trojan', 'tag': 'Demo-B', 'server': 'b.example.com', 'server_port': 443}
    ]}), encoding='utf-8')
    active_file = root / 'etc/sing-box/config.yaml'
    active_file.write_text(json.dumps({
        'providers': [{'type': 'remote', 'tag': 'Demo', 'path': '/etc/sing-box/providers/Demo.yaml', 'url': 'https://example.com/sub'}],
        'outbounds': [
            {'type': 'selector', 'tag': 'Proxy', 'outbounds': ['Manual']},
            {'type': 'direct', 'tag': 'DIRECT'},
            {'type': 'vless', 'tag': 'Manual', 'server': 'manual.example.com', 'server_port': 8443}
        ]
    }), encoding='utf-8')
    m.active = lambda: active_file
    m.uci_get = lambda key, default='': '0'
    def fake_dashboard_clash(request, config=None):
        if request.get('path') == '/connections':
            return {
                'connections': [{'id': 'demo'}],
                'uploadTotal': 4096,
                'downloadTotal': 8192,
            }
        return {'providers': {'Demo': {
            'vehicleType': 'Remote', 'updatedAt': '2026-10-22T17:00:00+08:00',
            'subscriptionInfo': {'Upload': 100, 'Download': 200, 'Total': 1000, 'Expire': 1900000000}
        }}}
    m.clash_request = fake_dashboard_clash
    provider_status = m.provider_status()
    assert provider_status['counts']['providers'] == 1, provider_status
    assert provider_status['counts']['nodes'] == 3, provider_status
    assert provider_status['providers'][0]['node_count'] == 2, provider_status
    assert provider_status['providers'][0]['traffic']['used'] == 300, provider_status
    assert provider_status['providers'][0]['traffic']['percent'] == 30.0, provider_status
    assert len(provider_status['manual_nodes']) == 1, provider_status
    m.pids = lambda: [4321]
    overview = m.overview(rate_interval=0)
    assert overview['running'] and overview['providers']['counts']['providers'] == 1, overview
    assert overview['traffic']['connections'][0]['id'] == 'demo', overview
    assert overview['traffic']['uploadTotal'] == 4096, overview
    assert overview['traffic_rate']['upload'] == 0, overview
    print('eBPF variant, TUN layer, dashboard aggregation and fallback service tests OK')
finally:
    shutil.rmtree(root, ignore_errors=True)
