import base64
import importlib.util
import io
from pathlib import Path

root = Path(__file__).resolve().parents[1]
module_path = root / 'root/usr/bin/singbox-dash/daemon.py'
spec = importlib.util.spec_from_file_location('sbd_daemon_test', module_path)
daemon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daemon)

args = ['config-bundle', 'config.yaml', 'no-schema']
payload = b'SBD1\n' + b''.join(
    base64.b64encode(item.encode('utf-8')) + b'\n' for item in args
) + b'END\n'
client_spec = importlib.util.spec_from_file_location('sbd_client_test', module_path.with_name('client.py'))
client = importlib.util.module_from_spec(client_spec)
client_spec.loader.exec_module(client)
assert client.encode_request(args).startswith(b'SBD1\n')
assert client.encode_request(args).endswith(b'END\n')
assert daemon.decode_request(io.BytesIO(client.encode_request(args))) == args
assert daemon.execute(['version']) == {'ok': True, 'app': 'singbox-dash', 'version': '1.0.4'}
empty_command = daemon.execute([])
assert empty_command['ok'] is False and 'Perintah tindakan tidak ada' in empty_command['error']
unknown = daemon.execute(['not-a-command'])
assert unknown['ok'] is False and 'Perintah tidak diketahui' in unknown['error']

assert daemon.decode_request(io.BytesIO(b'')) is None
for invalid in (b'BAD\nEND\n', b'SBD1\n%%%\nEND\n', b'SBD1\n' + base64.b64encode(b'x') + b'\n'):
    try:
        daemon.decode_request(io.BytesIO(invalid))
        raise AssertionError('invalid request accepted: %r' % invalid)
    except (ValueError, AssertionError) as exc:
        assert not isinstance(exc, AssertionError), invalid


wrapper = (root / 'root/usr/bin/singbox-dash/singbox-dash').read_text(encoding='utf-8')
assert 'socat -t 5 -,shut-none' in wrapper
assert 'version|bootstrap|status|overview|job|settings-get|subscription-info' in wrapper
assert 'command -v base64' in wrapper
assert 'exec /usr/bin/python3 /usr/bin/singbox-dash/client.py' in wrapper
assert 'Perintah tindakan tidak ada' in module_path.with_name('client.py').read_text(encoding='utf-8')
init_script = (root / 'root/etc/init.d/singbox-dash-manager').read_text(encoding='utf-8')
assert '/usr/bin/singbox-dash/daemon.py' in init_script

print('manager daemon protocol tests OK')
