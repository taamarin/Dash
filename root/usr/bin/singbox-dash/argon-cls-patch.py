#!/usr/bin/python3
"""Prevent Argon's first-paint sidebar layout shift with a reversible patch."""

import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

HEADER = Path(os.environ.get(
    'SBD_ARGON_HEADER',
    '/usr/share/ucode/luci/template/themes/argon/header.ut'))
BACKUP = Path(os.environ.get(
    'SBD_ARGON_HEADER_BACKUP',
    '/etc/singbox-dash/argon-header.ut.orig'))
ORIGINAL = '<div class="main-left" id="mainmenu" style="display:none">'
FIXED = '<div class="main-left" id="mainmenu">'


def write_atomic(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile('wb', dir=path.parent, delete=False) as stream:
        stream.write(data)
        temporary = Path(stream.name)
    try:
        os.chmod(temporary, mode)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def patch():
    if not HEADER.is_file():
        return {'ok': True, 'status': 'argon-missing'}
    text = HEADER.read_text(encoding='utf-8')
    if ORIGINAL not in text:
        return {'ok': True, 'status': 'already-patched' if FIXED in text else 'not-applicable'}
    BACKUP.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copy2(HEADER, BACKUP)
    os.chmod(BACKUP, 0o600)
    updated = text.replace(ORIGINAL, FIXED, 1)
    write_atomic(HEADER, updated.encode('utf-8'), HEADER.stat().st_mode & 0o777)
    return {'ok': True, 'status': 'patched'}


def restore():
    if not BACKUP.is_file():
        return {'ok': True, 'status': 'no-backup'}
    header_mode = HEADER.stat().st_mode & 0o777 if HEADER.is_file() else 0o644
    write_atomic(HEADER, BACKUP.read_bytes(), header_mode)
    BACKUP.unlink(missing_ok=True)
    return {'ok': True, 'status': 'restored'}


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'patch'
    try:
        result = restore() if action == 'restore' else patch()
    except Exception as exc:
        result = {'ok': False, 'error': str(exc)}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
