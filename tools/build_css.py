#!/usr/bin/env python3
"""Assemble, minify and precompress the runtime stylesheet."""

import argparse
import gzip
import hashlib
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src/styles'
ASSET_DIR = ROOT / 'htdocs/luci-static/resources/view/singbox-dash/v70'
TARGET = ASSET_DIR / 'style.css'
TARGET_GZIP = ASSET_DIR / 'style.css.gz'
INDEX = ASSET_DIR / 'index.js'
PARTS = tuple(sorted(SOURCE.glob('*.css')))
VERSION_PATTERN = re.compile(r"const ASSET_VERSION = '[0-9a-f]{12}';")


def strip_comments(text):
    result = []
    index = 0
    quote = ''
    while index < len(text):
        character = text[index]
        if quote:
            result.append(character)
            if character == '\\' and index + 1 < len(text):
                index += 1
                result.append(text[index])
            elif character == quote:
                quote = ''
            index += 1
            continue
        if character in ('"', "'"):
            quote = character
            result.append(character)
            index += 1
            continue
        if text.startswith('/*', index):
            end = text.find('*/', index + 2)
            index = len(text) if end < 0 else end + 2
            continue
        result.append(character)
        index += 1
    return ''.join(result)


def minify_code(segment):
    segment = re.sub(r'\s+', ' ', segment)
    segment = re.sub(r'\s*([{};,>~])\s*', r'\1', segment)
    segment = re.sub(r':\s+', ':', segment)
    return segment.replace(';}', '}')


def minify(text):
    text = strip_comments(text)
    result = []
    code = []
    index = 0
    quote = ''

    def flush():
        if code:
            result.append(minify_code(''.join(code)))
            code.clear()

    while index < len(text):
        character = text[index]
        if character in ('"', "'"):
            flush()
            quote = character
            value = [character]
            index += 1
            while index < len(text):
                value.append(text[index])
                if text[index] == '\\' and index + 1 < len(text):
                    index += 1
                    value.append(text[index])
                elif text[index] == quote:
                    index += 1
                    break
                index += 1
            result.append(''.join(value))
            quote = ''
            continue
        code.append(character)
        index += 1
    flush()
    return ''.join(result).strip() + '\n'


def build():
    if not PARTS:
        raise SystemExit('no CSS modules found')
    source = ''.join(path.read_text(encoding='utf-8') for path in PARTS)
    return minify(source).encode('utf-8')


def build_gzip(data):
    return gzip.compress(data, compresslevel=9, mtime=0)


def asset_version(data):
    return hashlib.sha256(data).hexdigest()[:12]


def update_index(version):
    text = INDEX.read_text(encoding='utf-8')
    if not VERSION_PATTERN.search(text):
        raise SystemExit('ASSET_VERSION placeholder missing from index.js')
    updated = VERSION_PATTERN.sub("const ASSET_VERSION = '" + version + "';", text, count=1)
    if updated != text:
        INDEX.write_text(updated, encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='verify generated assets are current')
    args = parser.parse_args()
    data = build()
    compressed = build_gzip(data)
    version = asset_version(data)
    if args.check:
        if not TARGET.is_file() or TARGET.read_bytes() != data:
            raise SystemExit('style.css is stale; run tools/build_css.py')
        if not TARGET_GZIP.is_file() or TARGET_GZIP.read_bytes() != compressed:
            raise SystemExit('style.css.gz is stale; run tools/build_css.py')
        if "const ASSET_VERSION = '" + version + "';" not in INDEX.read_text(encoding='utf-8'):
            raise SystemExit('ASSET_VERSION is stale; run tools/build_css.py')
        print('CSS modules, minified stylesheet, gzip asset and hash are in sync')
        return
    temporary = TARGET.with_name('.' + TARGET.name + '.tmp')
    temporary.write_bytes(data)
    temporary.replace(TARGET)
    temporary_gzip = TARGET_GZIP.with_name('.' + TARGET_GZIP.name + '.tmp')
    temporary_gzip.write_bytes(compressed)
    temporary_gzip.replace(TARGET_GZIP)
    update_index(version)
    print('%s (%d bytes, gzip %d bytes, asset %s)' % (
        TARGET, len(data), len(compressed), version))


if __name__ == '__main__':
    main()
