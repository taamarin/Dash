import importlib.util
from pathlib import Path
import shutil
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
module_path = root / 'root/usr/bin/singbox-dash/manager.py'
spec = importlib.util.spec_from_file_location('sbd_manager_notice_test', module_path)
manager_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager_module)
Manager = manager_module.Manager
sys.path.insert(0, str(module_path.parent))
from sbdlib.releases import parse_upstream_version  # noqa: E402

assert parse_upstream_version('v1.15.0-alpha.12-xiaobaf14g')['key'] < parse_upstream_version('v1.15.0-alpha.13-reF1nd')['key']
assert parse_upstream_version('v1.14.3-reF1nd')['channel'] == 'stable'
assert parse_upstream_version('sing-box version 1.15.0-beta.2')['channel'] == 'preview'

work = Path(tempfile.mkdtemp(prefix='sbd-notice-test-'))
try:
    m = Manager(root=work)
    m.platform = lambda: {'core_arch': 'arm64', 'libc': 'musl'}
    m.core_version = lambda executable=None: 'sing-box version 1.15.0-alpha.12-xiaobaf14g-20261023\nEnvironment: linux/arm64'
    values = {'kernel_update_notice': '1', 'kernel_update_skip': ''}
    m.uci_get = lambda key, default='': values.get(key, default)
    calls = []
    def releases(channel='all', refresh=False, source=None):
        calls.append((channel, source))
        return [
            {'tag': 'v1.15.0-alpha.13-xiaobaf14g.1', 'name': 'alpha 13', 'published': '2026-10-25', 'channel': 'preview', 'assets': [
                {'name': 'sing-box-1.15.0-alpha.13-xiaobaf14g.1-linux-arm64-musl.tar.gz'}
            ]},
            {'tag': 'v1.15.0-alpha.14-xiaobaf14g.1', 'name': 'alpha 14 wrong arch', 'published': '2026-10-26', 'channel': 'preview', 'assets': [
                {'name': 'sing-box-1.15.0-alpha.14-xiaobaf14g.1-linux-mipsle-softfloat.tar.gz'}
            ]},
        ]
    m.releases = releases
    result = m.kernel_update_notice()
    assert result['available'] is True, result
    assert result['source'] == 'michongs', result
    assert result['latest_tag'] == 'v1.15.0-alpha.13-xiaobaf14g.1', result
    assert calls == [('preview', 'michongs')], calls

    values['kernel_update_skip'] = result['notice_key']
    skipped = m.kernel_update_notice()
    assert skipped['available'] is False and skipped['reason'] == 'skipped', skipped

    values['kernel_update_notice'] = '0'
    calls.clear()
    disabled = m.kernel_update_notice()
    assert disabled['available'] is False and disabled['reason'] == 'disabled', disabled
    assert not calls, calls

    m.core_version = lambda executable=None: 'sing-box version 1.14.3-reF1nd'
    values.update({'kernel_update_notice': '1', 'kernel_update_skip': ''})
    calls.clear()
    m.releases = lambda channel='all', refresh=False, source=None: (calls.append((channel, source)) or [])
    stable = m.kernel_update_notice()
    assert stable['reason'] == 'current', stable
    assert calls == [('stable', 'ref1nd')], calls
finally:
    shutil.rmtree(work, ignore_errors=True)

print('kernel update notice tests OK')