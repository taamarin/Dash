from pathlib import Path
root = Path(__file__).resolve().parents[1]
base = root / 'htdocs/luci-static/resources/view/singbox-dash/v70'
lib = base / 'lib'
pages = base / 'pages'

required = [
    'schema-form.js', 'schema-model.js', 'schema-editor.js',
    'rule-editor.js', 'config-provider-editor.js'
]
for name in required:
    assert (lib / name).is_file(), name

sizes = {
    'schema-form.js': (lib / 'schema-form.js').stat().st_size,
    'schema-model.js': (lib / 'schema-model.js').stat().st_size,
    'schema-editor.js': (lib / 'schema-editor.js').stat().st_size,
    'config.js': (pages / 'config.js').stat().st_size,
    'rules.js': (pages / 'rules.js').stat().st_size,
}
assert sizes['schema-form.js'] < 2000, sizes
assert sizes['config.js'] < 30000, sizes
assert sizes['rules.js'] < 30000, sizes

schema_form = (lib / 'schema-form.js').read_text(encoding='utf-8')
assert 'schema-model' in schema_form and 'schema-editor' in schema_form
config = (pages / 'config.js').read_text(encoding='utf-8')
rules = (pages / 'rules.js').read_text(encoding='utf-8')
assert 'config-provider-editor' in config
assert 'function openProviderEditor' not in config
assert 'rule-editor' in rules
assert 'function targetOptions' not in rules
assert 'simpleRule, targetKey, targetLabel' in (lib / 'rule-editor.js').read_text(encoding='utf-8')
assert 'function openRouteSettings' in rules

print('module split tests OK:', ' '.join(f'{name}={size}' for name, size in sizes.items()))
