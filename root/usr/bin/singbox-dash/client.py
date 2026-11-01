#!/usr/bin/python3
"""Small Unix-socket client for the persistent SingBox-Dash manager."""

import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

SOCKET_PATH = Path(os.environ.get('SBD_MANAGER_SOCKET', '/var/run/singbox-dash-manager.sock'))
SERVICE = Path('/etc/init.d/singbox-dash-manager')
MANAGER = Path('/usr/bin/singbox-dash/manager.py')


class RequestSentError(Exception):
    pass


def encode_request(args):
    lines = ['SBD1']
    for value in args:
        lines.append(base64.b64encode(str(value).encode('utf-8')).decode('ascii'))
    lines.append('END')
    return ('\n'.join(lines) + '\n').encode('utf-8')


def request(args, timeout=300):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(str(SOCKET_PATH))
        try:
            client.sendall(encode_request(args))
            client.shutdown(socket.SHUT_WR)
            chunks = []
            while True:
                chunk = client.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        except (OSError, socket.timeout) as exc:
            raise RequestSentError('Perintah telah dikirim, tetapi respons terputus. Muat ulang status untuk memastikan hasilnya.') from exc
    return b''.join(chunks).decode('utf-8').strip()


def start_service():
    if SERVICE.is_file():
        subprocess.run([str(SERVICE), 'start'], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=10, check=False)


def connect_with_start(args):
    try:
        return request(args)
    except (FileNotFoundError, ConnectionError, OSError, socket.timeout):
        start_service()
    last_error = None
    for _ in range(30):
        time.sleep(0.05)
        try:
            return request(args)
        except (FileNotFoundError, ConnectionError, OSError, socket.timeout) as exc:
            last_error = exc
    raise last_error or ConnectionError('manager daemon unavailable')


def fallback(args):
    if not MANAGER.is_file():
        return None
    return subprocess.run([sys.executable, str(MANAGER)] + list(args),
                          check=False).returncode


def main():
    args = sys.argv[1:]
    if not args or not str(args[0]).strip():
        sys.stdout.write(json.dumps({'ok': False, 'error': 'Perintah tindakan tidak ada'},
                                    ensure_ascii=False, separators=(',', ':')) + '\n')
        return 2
    try:
        output = connect_with_start(args)
    except RequestSentError as exc:
        output = json.dumps({'ok': False, 'error': str(exc)},
                            ensure_ascii=False, separators=(',', ':'))
    except Exception as exc:
        fallback_code = fallback(args)
        if fallback_code is not None:
            return fallback_code
        output = json.dumps({'ok': False, 'error': 'Layanan pengelolaan tidak tersedia: ' + str(exc)},
                            ensure_ascii=False, separators=(',', ':'))
    if not output:
        output = json.dumps({'ok': False, 'error': 'Layanan pengelolaan tidak memberikan hasil. Coba lagi.'},
                            ensure_ascii=False, separators=(',', ':'))
    sys.stdout.write(output + '\n')
    try:
        value = json.loads(output.splitlines()[-1])
    except Exception:
        return 0
    return 0 if value.get('ok') is not False else 2


if __name__ == '__main__':
    sys.exit(main())
