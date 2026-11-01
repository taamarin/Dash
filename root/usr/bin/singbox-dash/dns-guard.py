#!/usr/bin/python3
"""Keep dnsmasq resolving when sing-box DNS becomes unavailable."""

import json
import os
from pathlib import Path
import random
import shlex
import socket
import struct
import subprocess
import sys
import time

ROOT = Path(os.environ.get('SINGBOX_DASH_ROOT', '/'))
STATE_DIR = ROOT / 'etc/singbox-dash/.dash-state'
STATE_FILE = STATE_DIR / 'dns-guard.json'
LOG_FILE = STATE_DIR / 'dns-guard.log'
DNSMASQ_INIT = ROOT / 'etc/init.d/dnsmasq'
DNSMASQ_UCI = 'dhcp.@dnsmasq[0]'


def now():
    return int(time.time())


def run(args, timeout=20):
    try:
        return subprocess.run([str(item) for item in args], stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return subprocess.CompletedProcess(args, 124, b'', str(exc).encode())


def read_state():
    try:
        value = json.loads(STATE_FILE.read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(value):
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = STATE_FILE.with_name(STATE_FILE.name + '.tmp-' + str(os.getpid()))
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.chmod(temp, 0o600)
    os.replace(temp, STATE_FILE)


def log(message):
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    line = '%s %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), message)
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as stream:
            stream.write(line)
        if LOG_FILE.stat().st_size > 256 * 1024:
            lines = LOG_FILE.read_text(encoding='utf-8', errors='replace').splitlines()[-1000:]
            LOG_FILE.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    except OSError:
        pass
    run(['logger', '-t', 'singbox-dash-dns-guard', message], timeout=3)


def uci_get(key, default=''):
    value = os.environ.get('SBD_DNS_GUARD_' + key.replace('.', '_').upper(), '')
    if value:
        return value
    result = run(['uci', '-q', 'get', key], timeout=6)
    text = result.stdout.decode('utf-8', 'replace').strip()
    return text if result.returncode == 0 and text else default


def root_path(value):
    text = str(value or '')
    path = Path(text)
    if ROOT != Path('/') and text.startswith('/'):
        return ROOT / text.lstrip('/')
    return path


def read_singbox_config():
    try:
        import yaml
    except ImportError:
        yaml = None
    names = []
    configured = uci_get('sing-box.main.conffile', '')
    if configured:
        names.append(configured)
    names.extend(['/etc/sing-box/config.yaml', '/etc/sing-box/config.json'])
    seen = set()
    for name in names:
        path = root_path(name)
        key = str(path)
        if key in seen or not path.is_file():
            continue
        seen.add(key)
        try:
            text = path.read_text(encoding='utf-8')
            if path.suffix.lower() == '.json' or text.lstrip().startswith('{'):
                value = json.loads(text)
            elif yaml is not None:
                value = yaml.safe_load(text)
            else:
                continue
            if isinstance(value, dict):
                return value
        except (OSError, ValueError, yaml.YAMLError if yaml is not None else ValueError):
            continue
    return {}


def detect_singbox_dns_port():
    config = read_singbox_config()
    candidates = []
    for index, inbound in enumerate(config.get('inbounds') or []):
        if not isinstance(inbound, dict):
            continue
        raw_port = inbound.get('listen_port')
        try:
            port = int(raw_port)
        except (TypeError, ValueError):
            continue
        if port < 1 or port > 65535:
            continue
        tag = str(inbound.get('tag') or '').lower()
        kind = str(inbound.get('type') or '').lower()
        listen = str(inbound.get('listen') or '').lower()
        score = 0
        if 'dns' in tag:
            score += 100
        if kind == 'direct' and listen in ('127.0.0.1', '::1', 'localhost'):
            score += 30
        if kind == 'dns':
            score += 80
        if score:
            candidates.append((score, -index, port))
    return max(candidates)[2] if candidates else 0


def uci_servers():
    result = run(['uci', '-q', 'get', DNSMASQ_UCI + '.server'], timeout=6)
    if result.returncode:
        return []
    try:
        values = shlex.split(result.stdout.decode('utf-8', 'replace'))
    except ValueError:
        values = result.stdout.decode('utf-8', 'replace').split()
    return dedupe(values)


def dedupe(values):
    result = []
    seen = set()
    for value in values:
        item = str(value or '').strip()
        if not item or item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


def is_endpoint(value, port):
    text = str(value or '').strip().lower()
    return text in ('127.0.0.1#' + str(port), 'localhost#' + str(port))


def active_servers(servers, singbox_port):
    endpoint = '127.0.0.1#' + str(singbox_port)
    rest = [item for item in servers if not is_endpoint(item, singbox_port)]
    return dedupe([endpoint] + rest)


def fallback_servers(servers, singbox_port, backup_port, fallback_server=''):
    backup = '127.0.0.1#' + str(backup_port)
    fallback = str(fallback_server or '').strip()
    rest = [item for item in servers if not is_endpoint(item, singbox_port)]
    rest = [item for item in rest if item not in (backup, fallback)]
    return dedupe([backup] + ([fallback] if fallback else []) + rest)


def apply_servers(servers):
    servers = dedupe(servers)
    current = uci_servers()
    if current == servers:
        return False
    run(['uci', '-q', 'delete', DNSMASQ_UCI + '.server'], timeout=8)
    for server in servers:
        result = run(['uci', 'add_list', DNSMASQ_UCI + '.server=' + server], timeout=8)
        if result.returncode:
            raise RuntimeError('failed to set dnsmasq upstream ' + server)
    result = run(['uci', 'commit', 'dhcp'], timeout=8)
    if result.returncode:
        raise RuntimeError('failed to commit dnsmasq configuration')
    if os.environ.get('SBD_DNS_GUARD_NO_RELOAD') != '1' and DNSMASQ_INIT.is_file():
        result = run([DNSMASQ_INIT, 'reload'], timeout=30)
        if result.returncode:
            raise RuntimeError('dnsmasq reload failed')
        time.sleep(0.8)
    return True


def dns_probe(port, timeout=1.2):
    try:
        query_id = random.randint(0, 65535)
        packet = struct.pack('!HHHHHH', query_id, 0x0100, 1, 0, 0, 0)
        for label in ('www', 'baidu', 'com'):
            packet += bytes([len(label)]) + label.encode('ascii')
        packet += b'\x00' + struct.pack('!HH', 1, 1)
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(timeout)
        try:
            sock.sendto(packet, ('127.0.0.1', int(port)))
            data, _ = sock.recvfrom(4096)
            return len(data) >= 12 and struct.unpack('!H', data[:2])[0] == query_id
        finally:
            sock.close()
    except (OSError, ValueError, struct.error):
        return False


def probe_dnsmasq():
    return dns_probe(53, 1.5)


def config_values():
    enabled = uci_get('singbox-dash.main.dns_failover', '1') == '1'
    explicit = os.environ.get('SBD_DNS_SINGBOX_PORT', '').strip()
    manual = uci_get('singbox-dash.main.dns_singbox_port', '').strip()
    detected = 0 if explicit else detect_singbox_dns_port()
    try:
        singbox_port = int(explicit or detected or manual or 0)
    except (TypeError, ValueError):
        singbox_port = 0
    backup_text = (os.environ.get('SBD_DNS_BACKUP_PORT')
                   or os.environ.get('SBD_DNS_SMARTDNS_PORT')
                   or uci_get('singbox-dash.main.dns_backup_port', '')
                   or uci_get('singbox-dash.main.dns_smartdns_port', '1153'))
    try:
        backup_port = int(backup_text or 1153)
    except (TypeError, ValueError):
        backup_port = 1153
    fallback_server = (os.environ.get('SBD_DNS_FALLBACK_SERVER')
                       or uci_get('singbox-dash.main.dns_fallback_server', '223.5.5.5')).strip()
    try:
        interval = int(uci_get('singbox-dash.main.dns_guard_interval', '5') or 5)
    except (TypeError, ValueError):
        interval = 5
    return enabled, singbox_port, backup_port, fallback_server, max(2, min(interval, 60))


def snapshot(extra=None):
    enabled, singbox_port, backup_port, fallback_server, interval = config_values()
    value = {
        'enabled': enabled,
        'mode': read_state().get('mode', 'unknown'),
        'singbox_port': singbox_port or None,
        'singbox_port_detected': singbox_port or None,
        'backup_port': backup_port,
        'fallback_server': fallback_server,
        'interval': interval,
        'singbox_dns': bool(singbox_port) and dns_probe(singbox_port),
        'backup_dns': dns_probe(backup_port),
        'dnsmasq_dns': probe_dnsmasq(),
        'servers': uci_servers(),
        'state': read_state(),
    }
    if extra:
        value.update(extra)
    return value


def switch_to_backup(reason='manual'):
    enabled, singbox_port, backup_port, fallback_server, interval = config_values()
    current = uci_servers()
    state = read_state()
    original = state.get('original_servers')
    if not isinstance(original, list) or not original:
        original = active_servers(current, singbox_port)
    desired = fallback_servers(original, singbox_port, backup_port, fallback_server)
    apply_servers(desired)
    state.update({
        'mode': 'backup',
        'original_servers': active_servers(original, singbox_port),
        'failure_count': int(state.get('failure_count') or 0),
        'success_count': 0,
        'singbox_port': singbox_port or None,
        'backup_port': backup_port,
        'fallback_server': fallback_server,
        'interval': interval,
        'last_switch': now(),
        'last_probe': now(),
        'message': 'SingBox DNS unavailable; dnsmasq now uses the backup DNS service',
        'reason': reason,
        'servers': desired,
    })
    write_state(state)
    log('switched dnsmasq to backup DNS:%s%s (%s)' %
        (backup_port, (' via ' + fallback_server) if fallback_server else '', reason))
    return state


def switch_to_singbox(reason='manual'):
    enabled, singbox_port, backup_port, fallback_server, interval = config_values()
    state = read_state()
    current = uci_servers()
    original = state.get('original_servers')
    if not isinstance(original, list) or not original:
        original = active_servers(current, singbox_port)
    if not singbox_port:
        state.update({'mode': 'unknown', 'message': 'SingBox DNS port not detected; configure it manually',
                      'backup_port': backup_port, 'fallback_server': fallback_server,
                      'last_probe': now()})
        write_state(state)
        return state
    desired = active_servers(original, singbox_port)
    changed = apply_servers(desired)
    state.update({
        'mode': 'singbox',
        'original_servers': desired,
        'failure_count': 0,
        'success_count': 0,
        'singbox_port': singbox_port,
        'backup_port': backup_port,
        'fallback_server': fallback_server,
        'interval': interval,
        'last_switch': now() if changed else state.get('last_switch', 0),
        'last_probe': now(),
        'message': 'SingBox DNS healthy; dnsmasq restored to SingBox DNS',
        'reason': reason,
        'servers': desired,
    })
    write_state(state)
    log('restored dnsmasq to SingBox DNS:%s (%s)' % (singbox_port, reason))
    return state


def evaluate_once():
    enabled, singbox_port, backup_port, fallback_server, interval = config_values()
    state = read_state()
    mode = state.get('mode', 'unknown')
    backup_modes = ('backup', 'smartdns')
    if not enabled:
        if mode in backup_modes:
            return switch_to_singbox('failover disabled')
        state.update({'mode': 'singbox' if mode == 'unknown' else mode,
                      'message': 'DNS failover disabled', 'last_probe': now()})
        write_state(state)
        return state
    if not singbox_port:
        state.update({
            'mode': mode, 'failure_count': 0, 'success_count': 0,
            'singbox_port': None, 'backup_port': backup_port, 'fallback_server': fallback_server,
            'interval': interval, 'last_probe': now(), 'singbox_dns': False,
            'dnsmasq_dns': probe_dnsmasq(),
            'message': 'SingBox DNS port not detected; fill it manually in settings',
        })
        write_state(state)
        return state
    healthy = dns_probe(singbox_port)
    failures = 0 if healthy else int(state.get('failure_count') or 0) + 1
    successes = int(state.get('success_count') or 0) + 1 if healthy else 0
    state.update({
        'failure_count': failures,
        'success_count': successes,
        'singbox_port': singbox_port,
        'backup_port': backup_port,
        'fallback_server': fallback_server,
        'interval': interval,
        'last_probe': now(),
        'singbox_dns': healthy,
        'dnsmasq_dns': probe_dnsmasq(),
    })
    write_state(state)
    if healthy:
        if mode in backup_modes or mode == 'unknown':
            if successes >= 2:
                return switch_to_singbox('SingBox DNS recovered')
        state['message'] = 'SingBox DNS healthy'
        write_state(state)
        return state
    if mode not in backup_modes and failures >= 2:
        return switch_to_backup('SingBox DNS probe failed')
    state['message'] = 'SingBox DNS probe failed (%s/2)' % failures
    write_state(state)
    return state


def run_loop(stop_event=None):
    log('dns guard started')
    while True:
        try:
            state = evaluate_once()
            enabled, singbox_port, backup_port, fallback_server, interval = config_values()
        except Exception as exc:
            state = read_state()
            state.update({'message': 'guard error: ' + str(exc), 'last_error': now()})
            write_state(state)
            log('guard error: ' + str(exc))
            interval = 5
        delay = max(2, min(int(interval), 60))
        if stop_event is None:
            time.sleep(delay)
        elif stop_event.wait(delay):
            break


def command_status(_args):
    print(json.dumps(snapshot({'ok': True}), ensure_ascii=False, indent=2))
    return 0


def command_test(_args):
    print(json.dumps(snapshot({'ok': True}), ensure_ascii=False, indent=2))
    return 0


def command_failover(_args):
    state = switch_to_backup('manual test')
    print(json.dumps(snapshot({'ok': True, 'state': state}), ensure_ascii=False, indent=2))
    return 0


def command_recover(_args):
    state = switch_to_singbox('manual restore')
    print(json.dumps(snapshot({'ok': True, 'state': state}), ensure_ascii=False, indent=2))
    return 0


def command_once(_args):
    state = evaluate_once()
    print(json.dumps(snapshot({'ok': True, 'state': state}), ensure_ascii=False, indent=2))
    return 0


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name, func in (
        ('run', lambda _args: run_loop()),
        ('once', command_once),
        ('status', command_status),
        ('test', command_test),
        ('failover', command_failover),
        ('recover', command_recover),
    ):
        command = sub.add_parser(name)
        command.set_defaults(func=func)
    args = parser.parse_args()
    return args.func(args) or 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)



