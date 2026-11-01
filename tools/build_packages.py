#!/usr/bin/env python3
"""Build the LuCI package payloads without compiling OpenWrt dependencies."""

import argparse
import gzip
import os
from pathlib import Path
import re
import shutil
import tarfile

ROOT = Path(__file__).resolve().parents[1]
EXECUTABLES = {
    'etc/init.d/singbox-dash-core',
    'etc/init.d/singbox-dash-dns-guard',
    'etc/init.d/singbox-dash-job',
    'etc/init.d/singbox-dash-manager',
    'etc/init.d/singbox-dash-update',
    'etc/uci-defaults/90_luci-app-singbox-dash',
    'usr/bin/singbox-dash-network-guard',
    'usr/bin/singbox-dash/argon-cls-patch.py',
    'usr/bin/singbox-dash/client.py',
    'usr/bin/singbox-dash/core.sh',
    'usr/bin/singbox-dash/daemon.py',
    'usr/bin/singbox-dash/dns-guard.py',
    'usr/bin/singbox-dash/mode.sh',
    'usr/bin/singbox-dash/singbox-dash',
    'usr/bin/singbox-dash/update-loop.sh',
}
PRIVATE_FILES = {
    'etc/config/singbox-dash': 0o600,
    'usr/bin/singbox-dash/manager.py': 0o700,
}

POSTINST = '''#!/bin/sh
[ "${IPKG_NO_SCRIPT:-0}" = "1" ] && exit 0
ROOT="${IPKG_INSTROOT:-}"
if [ -n "$ROOT" ] && [ "$ROOT" != "/" ]; then
    exit 0
fi
for version_dir in /www/luci-static/resources/view/singbox-dash/v*; do
    [ -d "$version_dir" ] || continue
    [ "${version_dir##*/}" = "v70" ] || rm -rf "$version_dir"
done
rm -f /www/luci-static/resources/view/singbox-dash/index.js /www/luci-static/resources/view/singbox-dash/style.css /www/luci-static/resources/view/singbox-dash/style.css.gz
rm -rf /tmp/luci-modulecache /tmp/luci-indexcache /tmp/luci-indexcache.*
/usr/bin/python3 /usr/bin/singbox-dash/argon-cls-patch.py patch >/dev/null 2>&1 || true
for service in singbox-dash-manager singbox-dash-dns-guard singbox-dash-update; do
    [ -x "/etc/init.d/$service" ] && "/etc/init.d/$service" enable >/dev/null 2>&1 || true
done
[ -x /etc/init.d/singbox-dash-manager ] && /etc/init.d/singbox-dash-manager restart >/dev/null 2>&1 || true
[ -x /etc/init.d/singbox-dash-dns-guard ] && /etc/init.d/singbox-dash-dns-guard restart >/dev/null 2>&1 || true
[ -x /etc/init.d/singbox-dash-update ] && /etc/init.d/singbox-dash-update restart >/dev/null 2>&1 || true
/etc/init.d/rpcd reload >/dev/null 2>&1 || true
exit 0
'''

PRERM = '''#!/bin/sh
ROOT="${IPKG_INSTROOT:-}"
[ -n "$ROOT" ] && exit 0
/usr/bin/python3 /usr/bin/singbox-dash/argon-cls-patch.py restore >/dev/null 2>&1 || true
for service in singbox-dash-manager singbox-dash-dns-guard singbox-dash-update singbox-dash-job; do
    [ -x "/etc/init.d/$service" ] && "/etc/init.d/$service" stop >/dev/null 2>&1 || true
done
exit 0
'''

POSTRM = '''#!/bin/sh
ROOT="${IPKG_INSTROOT:-}"
[ -n "$ROOT" ] && exit 0
rm -rf /tmp/luci-indexcache /tmp/luci-indexcache.* /tmp/luci-modulecache
/etc/init.d/rpcd reload >/dev/null 2>&1 || true
exit 0
'''


def package_version():
    makefile = (ROOT / 'Makefile').read_text(encoding='utf-8')
    version = re.search(r'^PKG_VERSION:=(\S+)', makefile, re.MULTILINE)
    release = re.search(r'^PKG_RELEASE:=(\S+)', makefile, re.MULTILINE)
    if not version or not release:
        raise SystemExit('PKG_VERSION or PKG_RELEASE missing from Makefile')
    return version.group(1), release.group(1)


def package_mode(path, data_root):
    relative = path.relative_to(data_root).as_posix()
    if relative in PRIVATE_FILES:
        return PRIVATE_FILES[relative]
    if relative in EXECUTABLES:
        return 0o755
    return 0o755 if path.is_dir() else 0o644


def add_tree(archive, root, names=None):
    paths = sorted(root.rglob('*'), key=lambda item: item.as_posix()) if names is None else [root / name for name in names]
    for path in paths:
        relative = path.relative_to(root).as_posix()
        info = archive.gettarinfo(str(path), arcname='./' + relative)
        info.mode = 0o755 if root.name == 'control' and relative in {'postinst', 'prerm', 'postrm'} else package_mode(path, root)
        info.uid = 0
        info.gid = 0
        info.uname = 'root'
        info.gname = 'root'
        info.mtime = 1700000000
        if path.is_file():
            with path.open('rb') as stream:
                archive.addfile(info, stream)
        else:
            archive.addfile(info)


def write_tar_gz(path, root, names=None):
    with path.open('wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.GNU_FORMAT) as archive:
                add_tree(archive, root, names)


def write_scripts(control):
    for name, content in (('postinst', POSTINST), ('prerm', PRERM), ('postrm', POSTRM)):
        path = control / name
        path.write_text(content, encoding='utf-8', newline='\n')
        os.chmod(path, 0o755)


def build_ipk(output, data, control, version, release):
    stage = output / '.ipk-stage'
    stage.mkdir(parents=True, exist_ok=True)
    write_tar_gz(stage / 'data.tar.gz', data)
    write_tar_gz(stage / 'control.tar.gz', control, ['control', 'conffiles', 'postinst', 'prerm', 'postrm'])
    (stage / 'debian-binary').write_bytes(b'2.0\n')

    target = output / f'luci-app-singbox-dash_{version}-r{release}_all.ipk'
    with target.open('wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.GNU_FORMAT) as archive:
                for name in ('debian-binary', 'data.tar.gz', 'control.tar.gz'):
                    path = stage / name
                    info = archive.gettarinfo(str(path), arcname='./' + name)
                    info.mode = 0o644
                    info.uid = 0
                    info.gid = 0
                    info.uname = 'root'
                    info.gname = 'root'
                    info.mtime = 1700000000
                    with path.open('rb') as stream:
                        archive.addfile(info, stream)
    shutil.rmtree(stage)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='release-assets', help='output directory inside the repository')
    args = parser.parse_args()

    output = (ROOT / args.output).resolve()
    if ROOT not in output.parents:
        raise SystemExit('output directory must stay inside the repository')
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    version, release = package_version()
    stage = output / '.stage'
    data = stage / 'data'
    control = stage / 'control'
    data.mkdir(parents=True)
    control.mkdir(parents=True)

    shutil.copytree(ROOT / 'root', data, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    shutil.copytree(ROOT / 'htdocs', data / 'www', dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    for path in list(data.rglob('__pycache__')):
        shutil.rmtree(path)
    for path in data.rglob('*.pyc'):
        path.unlink(missing_ok=True)

    for path in data.rglob('*'):
        os.chmod(path, package_mode(path, data))

    write_scripts(control)
    installed_size = sum(path.stat().st_size for path in data.rglob('*') if path.is_file())
    (control / 'control').write_text(
        '\n'.join((
            'Package: luci-app-singbox-dash',
            f'Version: {version}-r{release}',
            'Depends: python3, python3-yaml, luci-base, nftables, ip-full, cgi-io, socat',
            'Source: luci-app-singbox-dash',
            'SourceName: luci-app-singbox-dash',
            'License: MIT',
            'Section: luci',
            'Maintainer: singbox-dash',
            'Architecture: all',
            f'Installed-Size: {max(1, (installed_size + 1023) // 1024)}',
            'Description: OpenWrt LuCI 的 Sing-box 运行、配置、规则、订阅与内核管理面板。',
            '',
        )),
        encoding='utf-8',
        newline='\n',
    )
    (control / 'conffiles').write_text('/etc/config/singbox-dash\n', encoding='utf-8')

    ipk = build_ipk(output, data, control, version, release)

    apk_input = output / 'apk-input'
    apk_root = apk_input / 'root'
    shutil.copytree(data, apk_root)
    protected = apk_root / 'etc/apk/protected_paths.d'
    protected.mkdir(parents=True, exist_ok=True)
    (protected / 'luci-app-singbox-dash.list').write_text('+etc/config/singbox-dash\n', encoding='utf-8')
    for name, content in (('postinst', POSTINST), ('prerm', PRERM), ('postrm', POSTRM)):
        (apk_input / name).write_text(content, encoding='utf-8', newline='\n')
    shutil.rmtree(stage)
    (output / 'version.txt').write_text(f'{version}-r{release}\n', encoding='utf-8')

    print(f'version={version}-r{release}')
    print(f'ipk={ipk.name}')
    print(f'apk_input={apk_input}')


if __name__ == '__main__':
    main()