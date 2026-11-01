import gzip
import hashlib
import importlib.util
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / 'src/styles'
asset = root / 'htdocs/luci-static/resources/view/singbox-dash/v70'
target = asset / 'style.css'
parts = sorted(source.glob('*.css'))

spec = importlib.util.spec_from_file_location('sbd_build_css', root / 'tools/build_css.py')
build_css = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_css)

assert parts, 'CSS source modules are missing'
assert [path.name for path in parts] == [
    '00-tokens.css', '10-base.css', '20-pages.css', '30-rules-workspace.css',
    '40-dashboard.css', '50-theme-vantage.css', '60-feature-pages.css',
    '70-theme-argon.css', '80-responsive.css'
]
expected = build_css.build()
assert target.read_bytes() == expected, 'style.css is stale; run tools/build_css.py'
compressed = (asset / 'style.css.gz').read_bytes()
assert gzip.decompress(compressed) == expected, 'style.css.gz is stale; run tools/build_css.py'
version = hashlib.sha256(expected).hexdigest()[:12]
index_text = (asset / 'index.js').read_text(encoding='utf-8')
assert "const ASSET_VERSION = '%s';" % version in index_text
assert '.gz?v=' in index_text
assert 'await ensureStylesheet();' in index_text

text = expected.decode('utf-8')
assert 'html[data-argon-mode="dark"]' in text
without_comments = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
without_strings = re.sub(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'', '', without_comments)
balance = 0
for character in without_strings:
    if character == '{':
        balance += 1
    elif character == '}':
        balance -= 1
        assert balance >= 0, 'extra closing brace in CSS'
assert balance == 0, 'unclosed CSS block'
print('CSS minification, gzip and content hash tests OK')
