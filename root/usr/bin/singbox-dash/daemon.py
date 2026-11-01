#!/usr/bin/python3
"""Persistent local transport for the SingBox-Dash manager."""

import base64
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import sys

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import manager as manager_module  # noqa: E402

SOCKET_PATH = Path(os.environ.get('SBD_MANAGER_SOCKET', '/var/run/singbox-dash-manager.sock'))
MAX_ARGS = 32
MAX_LINE = 64 * 1024


def decode_request(stream):
    header = stream.readline(16)
    if not header:
        return None
    if header.strip() != b'SBD1':
        raise ValueError('invalid request header')
    args = []
    while True:
        line = stream.readline(MAX_LINE)
        if not line:
            raise ValueError('incomplete request')
        if not line.endswith(b'\n'):
            raise ValueError('request line too long')
        value = line.strip()
        if value == b'END':
            break
        if len(args) >= MAX_ARGS:
            raise ValueError('too many arguments')
        try:
            decoded = base64.b64decode(value, validate=True).decode('utf-8')
        except Exception as exc:
            raise ValueError('invalid argument encoding') from exc
        if len(decoded) > MAX_LINE:
            raise ValueError('argument too long')
        args.append(decoded)
    return args


def execute(args):
    action = str(args[0]).strip() if args else ''
    if not action:
        return {'ok': False, 'error': '缺少操作命令'}
    try:
        return manager_module.command_result(args)
    except manager_module.Failure as exc:
        message = manager_module.clean_error(exc)
        manager_module.append_error_log(action, message)
        return {'ok': False, 'error': message}
    except Exception as exc:
        message = '内部错误：' + manager_module.clean_error(exc)
        manager_module.append_error_log(action, message)
        return {'ok': False, 'error': message}


class Handler(socketserver.StreamRequestHandler):
    timeout = 300

    def handle(self):
        try:
            args = decode_request(self.rfile)
            if args is None:
                return
            result = execute(args)
            payload = json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n'
            self.wfile.write(payload.encode('utf-8'))
            self.wfile.flush()
        except Exception as exc:
            manager_module.append_error_log('daemon-protocol', exc)
            payload = json.dumps({'ok': False, 'error': '管理器请求格式错误'},
                                 ensure_ascii=False, separators=(',', ':')) + '\n'
            try:
                self.wfile.write(payload.encode('utf-8'))
                self.wfile.flush()
            except OSError:
                pass


if hasattr(socketserver, 'UnixStreamServer'):
    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True
        request_queue_size = 32
else:
    class Server:
        pass


def socket_is_live(path):
    if not path.exists():
        return False
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(0.5)
            client.connect(str(path))
        return True
    except OSError:
        return False


def main():
    os.umask(0o077)
    if socket_is_live(SOCKET_PATH):
        return 0
    try:
        SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        manager_module.append_error_log('daemon-socket', exc)
        return 1
    server = Server(str(SOCKET_PATH), Handler)
    os.chmod(SOCKET_PATH, 0o600)

    def stop(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        try:
            SOCKET_PATH.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
