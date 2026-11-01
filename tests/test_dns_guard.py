from pathlib import Path
import importlib.util
import shutil
import tempfile

module_path = Path(__file__).resolve().parents[1] / 'root/usr/bin/singbox-dash/dns-guard.py'
spec = importlib.util.spec_from_file_location('dns_guard', module_path)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

original = ['127.0.0.1#5335', '127.0.0.1#1153', '223.5.5.5', '119.29.29.29']
assert guard.active_servers(original, 5335) == original
fallback = guard.fallback_servers(original, 5335, 1153)
assert fallback[0] == '127.0.0.1#1153'
assert '127.0.0.1#5335' not in fallback
assert '223.5.5.5' in fallback and '119.29.29.29' in fallback
restored = guard.active_servers(original, 5335)
assert restored[0] == '127.0.0.1#5335'
assert guard.dedupe(['a', 'a', 'b']) == ['a', 'b']

# Restoring to SingBox DNS must distinguish an unchanged dnsmasq state from a
# real switch; this path previously raised NameError before writing state.
saved_functions = {name: getattr(guard, name) for name in ('config_values', 'uci_servers', 'read_state', 'apply_servers', 'write_state', 'log')}
guard.config_values = lambda: (True, 5335, 1153, '223.5.5.5', 5)
guard.uci_servers = lambda: list(original)
guard.read_state = lambda: {'mode': 'backup', 'original_servers': original, 'last_switch': 123}
guard.apply_servers = lambda servers: False
guard.write_state = lambda state: None
guard.log = lambda message: None
restored_state = guard.switch_to_singbox('test')
assert restored_state['mode'] == 'singbox'
assert restored_state['last_switch'] == 123
for name, function in saved_functions.items():
    setattr(guard, name, function)

root = Path(tempfile.mkdtemp(prefix='dns-guard-test-'))
try:
    guard.STATE_DIR = root / 'state'
    guard.STATE_FILE = guard.STATE_DIR / 'dns-guard.json'
    guard.LOG_FILE = guard.STATE_DIR / 'dns-guard.log'
    guard.write_state({'mode': 'smartdns', 'original_servers': original})
    state = guard.read_state()
    assert state['mode'] == 'smartdns'
    assert state['original_servers'] == original
finally:
    shutil.rmtree(root, ignore_errors=True)
print('dns guard tests OK')
