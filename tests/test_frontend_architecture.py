import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
base = root / 'htdocs/luci-static/resources/view/singbox-dash/v70'
files = sorted(base.rglob('*.js'))
prefix = 'view.singbox-dash.v70.'


def resolve(name):
    if not name.startswith(prefix):
        return None
    relative = name[len(prefix):].replace('.', '/') + '.js'
    path = base / relative
    return path.relative_to(base).as_posix() if path.is_file() else None


graph = {}
for path in files:
    text = path.read_text(encoding='utf-8')
    dependencies = []
    for match in re.finditer(r"^'require\s+([^']+?)(?:\s+as\s+\w+)?';", text, re.M):
        dependency = resolve(match.group(1).strip())
        if dependency:
            dependencies.append(dependency)
    graph[path.relative_to(base).as_posix()] = sorted(set(dependencies))

reachable = {'index.js'}
queue = ['index.js']
while queue:
    current = queue.pop(0)
    for dependency in graph.get(current, []):
        if dependency not in reachable:
            reachable.add(dependency)
            queue.append(dependency)

assert graph['index.js'] == ['lib/api.js', 'lib/dom.js'], graph['index.js']
assert len(reachable) == 4, reachable
assert graph['lib/api.js'] == ['lib/api-transport.js'], graph['lib/api.js']
assert 'lib/api-upload.js' not in reachable
assert not any(module.startswith('pages/') for module in graph['index.js'])
index_source = (base / 'index.js').read_text(encoding='utf-8')
assert 'L.require(definition.module)' in index_source
assert 'warmPageData' not in index_source
assert "return state.page === 'overview' ? 5000 : 15000;" in index_source
overview_source = (base / 'pages/overview.js').read_text(encoding='utf-8')
assert 'statusTimer' not in overview_source
assert 'api.overview(true)' in overview_source
assert 'api.bootstrap(true, includeOverview)' in index_source
assert 'consumeInitialOverview' in index_source
assert "ui.E('div', { 'class': 'sbd-header' }" in index_source
assert "ui.E('div', { 'class': 'sbd-main' }" in index_source
assert 'function enhanceDocumentLandmarks' in index_source
assert 'enhanceDocumentLandmarks(header, main)' in index_source
assert '#mainmenu.main-left' in index_source
assert "'role': 'status'" in (base / 'lib/dom.js').read_text(encoding='utf-8')
assert "'aria-label': 'Filter sumber'" in (base / 'pages/connections.js').read_text(encoding='utf-8')
assert "'aria-label': 'Sumber kernel'" in (base / 'pages/kernel.js').read_text(encoding='utf-8')
assert "role: 'log', tabindex: '0'" in (base / 'pages/tools.js').read_text(encoding='utf-8')
assert "'aria-label': 'Mulai otomatis saat boot'" in (base / 'pages/settings.js').read_text(encoding='utf-8')
config_source = (base / 'pages/config.js').read_text(encoding='utf-8')
assert "|| 'config.yaml'" in config_source
assert 'Impor file konfigurasi' in config_source
assert 'createConfigFromFile(file, text)' in config_source
assert 'snapshotPending' in overview_source
print('frontend architecture tests OK: 4 startup modules, lazy pages/upload, one status poller')
