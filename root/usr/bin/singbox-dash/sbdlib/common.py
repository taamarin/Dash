"""Shared filesystem, error, and serialization primitives."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid


MAX_CONFIG = 10 * 1024 * 1024


class Failure(Exception):
    pass

def digest(data):
    return hashlib.sha256(data).hexdigest()

def file_digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def clean_error(text):
    text = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', str(text))
    text = re.sub(r'(?i)(secret|token|password)\s*[:=]\s*\S+', r'\1=[hidden]', text)
    text = re.sub(r'https?://[^\s\"\']+', '[URL hidden]', text)
    return text.strip()[-2400:]

def atomic(path, data, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    try:
        with open(tmp, 'xb') as stream:
            os.chmod(tmp, mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        try:
            fd = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError:
            pass
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass

def write_json(path, obj):
    atomic(path, json.dumps(obj, ensure_ascii=False, indent=2).encode(), 0o600)

def read_json(path, fallback=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (FileNotFoundError, ValueError, OSError):
        return fallback

def run_quiet(args, timeout=10, env=None):
    try:
        return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=timeout, env=env)
    except (OSError, subprocess.TimeoutExpired):
        return None

def append_error_log(action, message):
    """Persist sanitized command errors for the diagnostics log view."""
    root = Path(os.environ.get('SINGBOX_DASH_ROOT', '/'))
    path = root / 'etc/sing-box/.dash-state/errors.log'
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        stamp = time.strftime('%Y-%m-%d %H:%M:%S')
        line = '[%s] %s: %s\n' % (stamp, action or 'unknown', clean_error(message))
        with open(path, 'a', encoding='utf-8') as stream:
            stream.write(line)
        if path.stat().st_size > 512 * 1024:
            lines = path.read_text(encoding='utf-8', errors='replace').splitlines()[-2000:]
            atomic(path, ('\n'.join(lines) + '\n').encode('utf-8'), 0o600)
    except OSError:
        pass

def natural_key(value):
    return [int(p) if p.isdigit() else p.lower()
            for p in re.split(r'(\d+)', str(value or ''))]

