import importlib.util
import json
import tempfile
import time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
module_path = root / 'root/usr/bin/singbox-dash/manager.py'
spec = importlib.util.spec_from_file_location('sbd_manager_config_backups', module_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

with tempfile.TemporaryDirectory(prefix='sbd-config-backups-') as temp:
    manager = mod.Manager(temp)
    target = manager.conf / 'config-t09.yaml'
    target.write_text('outbounds:\n  - type: direct\n    tag: direct\n', encoding='utf-8')
    for _ in range(15):
        manager.backup_config(target.name)
        time.sleep(0.002)

    backups = manager.backup_list()
    assert len(backups) == mod.CONFIG_BACKUP_LIMIT == 10, backups
    files = [path for path in manager.backups.iterdir()
             if path.is_file() and manager.valid_backup(path.name)]
    assert len(files) == 10, files

    removed = backups[-1]['name']
    manager.delete_config_backup(removed)
    assert not (manager.backups / removed).exists()
    assert not (manager.backups / (removed + '.meta')).exists()
    assert len(manager.backup_list()) == 9

with tempfile.TemporaryDirectory(prefix='sbd-empty-config-') as temp:
    manager = mod.Manager(temp)
    target = manager.conf / 'config.yaml'
    candidate = json.dumps({
        'inbounds': [],
        'outbounds': [{'type': 'direct', 'tag': 'direct'}]
    }, indent=2).encode() + b'\n'
    job_id = 'c' * 32
    folder = manager.jobs / job_id
    folder.mkdir(parents=True)
    (folder / 'candidate').write_bytes(candidate)
    manager.active = lambda: target
    manager.pids = lambda: []
    manager.prepare_config_for_core = lambda data: (data, manager.parse(data), {'supported': True, 'removed': []})
    manager.validated_api_details = lambda config: {'endpoint': '', 'port': None, 'enabled': False}
    manager.validate = lambda data, executable=None: manager.parse(data)
    manager.mode_details = lambda data: {'mode': 'custom', 'port': None, 'udp_port': None, 'interface': ''}
    manager.api_details = lambda data: {'endpoint': '', 'port': None}
    job = {
        'id': job_id,
        'action': 'save',
        'target': 'config.yaml',
        'expected': mod.digest(b''),
        'mode': ''
    }
    status = manager._apply_config_job(job, folder)
    assert status['phase'] == 'done', status
    assert target.read_bytes() == candidate
    assert manager.backup_list() == []

print('config upload, backup retention and deletion tests OK')
