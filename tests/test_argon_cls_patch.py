import importlib.util
from pathlib import Path
import tempfile
from unittest import mock

root = Path(__file__).resolve().parents[1]
module_path = root / 'root/usr/bin/singbox-dash/argon-cls-patch.py'
spec = importlib.util.spec_from_file_location('argon_cls_patch', module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory(prefix='argon-cls-') as temp:
    header = Path(temp) / 'header.ut'
    backup = Path(temp) / 'header.ut.orig'
    original = '<div class="main-left" id="mainmenu" style="display:none">\n'
    header.write_text(original, encoding='utf-8')
    with mock.patch.object(module, 'HEADER', header), mock.patch.object(module, 'BACKUP', backup):
        assert module.patch()['status'] == 'patched'
        assert 'style="display:none"' not in header.read_text(encoding='utf-8')
        assert backup.is_file()
        assert module.patch()['status'] == 'already-patched'
        assert module.restore()['status'] == 'restored'
        assert header.read_text(encoding='utf-8') == original
        assert not backup.exists()
        assert module.restore()['status'] == 'no-backup'

print('Argon CLS patch tests OK')
