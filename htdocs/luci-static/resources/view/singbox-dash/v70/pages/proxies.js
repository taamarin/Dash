'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';

const TYPE_NAMES = {
    Selector: '手动选择', URLTest: '自动测速', Fallback: '故障转移',
    LoadBalance: '负载均衡', Smart: '智能选择', Relay: '链式代理',
    Direct: '直连', Reject: '阻断'
};
const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Smart', 'Relay']);
const GROUP_COLORS = ['orange', 'blue', 'green', 'purple', 'red'];
const TEST_URL = 'http://www.gstatic.com/generate_204';
const TEST_TIMEOUT = 4000;
const MODE_OPTIONS = [['rule', '规则'], ['global', '全局'], ['direct', '直连']];
const FOLDER_LABELS = {
    folder_all: '全部',
    folder_uncategorized: '未分类',
    folder_builtin_strategy: '策略组',
    folder_builtin_nodes: '节点组'
};
const VIRTUAL_UNCAT = '__uncat__';
let sharedData = null;
let sharedMode = 'rule';
let sharedFolderState = null;
let sharedFolderSource = 'automatic';
const sharedDelays = Object.create(null);

function delayText(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '超时';
    return number + ' ms';
}

function delayClass(value) {
    const base = 'sbd-node-test sbd-node-delay';
    if (value == null) return base;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return base + ' bad';
    if (number >= 350) return base + ' warn';
    return base;
}

function nameNode(name, className) {
    return ui.nameWithFlags(name, className);
}

function nameBadge(name, tone) {
    return ui.E('span', { 'class': 'sbd-badge ' + (tone || '') }, nameNode(name, ''));
}

function historyDelay(node) {
    const history = node && Array.isArray(node.history) ? node.history : [];
    const latest = history[history.length - 1];
    const value = latest && Number(latest.delay);
    return Number.isFinite(value) ? value : null;
}

function modeName(value) {
    const mode = String(value || 'rule').toLowerCase();
    if (mode === 'global') return '全局';
    if (mode === 'direct') return '直连';
    return '规则';
}

function groupIcon(name, type) {
    const text = String(name || '').toLowerCase();
    if (/direct|直连|国内/.test(text)) return ['link', 'green'];
    if (/reject|ad|广告|拦截/.test(text)) return ['shield', 'red'];
    if (/(^|\s)all($|\s)|全部/.test(text)) return ['folder', 'blue'];
    if (/cloudflare|cf优|cf隧|cloud|(^|\W)cf($|\W)/.test(text)) return ['cloud', 'orange'];
    if (/update|更新|升级/.test(text)) return ['refresh', 'blue'];
    if (/googlefcm|fcm|push|通知/.test(text)) return ['bell', 'blue'];
    if (/paypal|crypto|wallet|payment|pay(?!pal)|bank|支付|金融/.test(text)) return ['wallet', 'green'];
    if (/youtube|netflix|disney|emby|plex|bilibili|douyin|tiktok|video|stream|影视|媒体/.test(text)) return ['play', 'red'];
    if (/spotify|music|网易云|音乐/.test(text)) return ['music', 'green'];
    if (/github|gitlab/.test(text)) return ['gitBranch', 'purple'];
    if (/discord/.test(text)) return ['message', 'blue'];
    if (/telegram|电报|(^|\W)tg($|\W)/.test(text)) return ['proxies', 'blue'];
    if (/microsoft|onedrive|xbox|office/.test(text)) return ['grid', 'blue'];
    if (/google|gmail|搜索/.test(text)) return ['search', 'blue'];
    if (/apple|icloud|苹果/.test(text)) return ['leaf', 'green'];
    if (/ai|openai|claude|gemini|gpt/.test(text)) return ['sparkle', 'purple'];
    if (/game|steam|ubisoft|blizzard|游戏/.test(text)) return ['gamepad', 'orange'];
    if (/twitter|instagram|facebook|social|社交/.test(text)) return ['message', 'purple'];
    if (/tracker|tracking|统计/.test(text)) return ['activity', 'orange'];
    if (type === 'URLTest' || type === 'Smart' || /auto|urltest|自动/.test(text)) return ['zap', 'orange'];
    return ['folder', 'blue'];
}

async function render(host, ctx) {
    let data = sharedData;
    let mode = sharedMode;
    let modeChanging = false;
    let syncing = false;
    let error = null;
    let filter = '';
    let activeCategory = 'ALL';
    const delays = sharedDelays;
    const testingGroups = new Set();
    const testedGroups = new Set();
    const openGroups = new Set();
    let folderState = sharedFolderState;
    let folderReadPromise = null;
    let folderSource = sharedFolderSource;
    const root = ui.E('div', { 'class': 'sbd-stack' });
    host.appendChild(root);

    const pillsHost = ui.E('div', { 'class': 'sbd-filter-pills' });
    const modeSwitch = ui.E('div', {
        'class': 'sbd-mode-switch', role: 'group', 'aria-label': '运行模式'
    });
    const modeButtons = Object.create(null);
    MODE_OPTIONS.forEach(item => {
        const button = ui.E('button', {
            type: 'button', 'data-mode': item[0], title: '切换到' + item[1] + '模式',
            click: () => setMode(item[0])
        }, item[1]);
        modeButtons[item[0]] = button;
        modeSwitch.appendChild(button);
    });
    const testAllButton = ui.btn('全部测速', {
        icon: 'zap', small: true, title: '自动测试全部策略组', onClick: () => testAllGroups()
    });
    const testAllLabel = testAllButton.querySelector('span:not(.sbd-icon)');
    const refreshButton = ui.btn('', {
        icon: 'refresh', iconOnly: true, title: '刷新策略组', onClick: () => load()
    });
    const filterBar = ui.E('div', { 'class': 'sbd-filter-bar' }, [
        pillsHost,
        ui.E('div', { 'class': 'sbd-toolbar-meta' }, [
            modeSwitch, testAllButton, refreshButton
        ])
    ]);
    root.appendChild(filterBar);

    const list = ui.E('div', { 'class': 'sbd-stack sbd-proxy-group-grid' });

    const searchInput = ui.E('input', {
        type: 'search',
        'class': 'sbd-input',
        placeholder: '搜索策略组或节点名称...',
        input: event => { filter = event.target.value.trim().toLowerCase(); paint(); }
    });
    root.appendChild(ui.E('div', { 'class': 'sbd-glass-search-bar' }, [
        ui.icon('search'),
        searchInput
    ]));
    root.appendChild(list);

    function updateModeSwitch() {
        Object.keys(modeButtons).forEach(key => {
            const active = key === mode;
            modeButtons[key].classList.toggle('active', active);
            modeButtons[key].setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    async function setMode(next) {
        next = String(next || '').toLowerCase();
        if (modeChanging || !['rule', 'global', 'direct'].includes(next) || next === mode) return;
        modeChanging = true;
        Object.values(modeButtons).forEach(button => { button.disabled = true; });
        try {
            await api.clash('PATCH', '/configs', { mode: next });
            mode = next;
            updateModeSwitch();
            if (data) paint();
            await load({ silent: true });
            ui.notify('已切换到' + modeName(mode) + '模式，zashboard 已同步', 'success');
        } catch (error) {
            updateModeSwitch();
            ui.notify('模式切换失败：' + api.errorText(error), 'error', 7000);
        } finally {
            modeChanging = false;
            Object.values(modeButtons).forEach(button => { button.disabled = false; });
        }
    }

    function groupsFrom(payload) {
        const proxies = payload && payload.proxies ? payload.proxies : {};
        return Object.keys(proxies).map(name => proxies[name]).filter(item =>
            item && Array.isArray(item.all) && item.all.length &&
            GROUP_TYPES.has(String(item.type || ''))
        );
    }

    function zashboardOrigin() {
        const status = ctx.status || {};
        const api = status.api || {};
        const port = Number(api.port);
        if (!status.running || api.valid === false || !Number.isInteger(port)
                || port < 1 || port > 65535) return '';
        let host = String(window.location.hostname || '').trim();
        if (!host) return '';
        if (host.includes(':')) host = '[' + host + ']';
        return (api.scheme === 'https' ? 'https' : 'http') + '://' + host + ':' + port;
    }

    function readZashboardFolderState() {
        const origin = zashboardOrigin();
        if (!origin) return Promise.resolve(null);
        return new Promise(resolve => {
            let frame = null;
            let finished = false;
            let timer = null;
            const finish = value => {
                if (finished) return;
                finished = true;
                if (timer) window.clearTimeout(timer);
                window.removeEventListener('message', onMessage);
                if (frame) frame.remove();
                resolve(value);
            };
            const onMessage = event => {
                if (event.origin !== origin) return;
                const message = event.data;
                if (!message || message.type !== 'singbox-dash:zashboard-folders') return;
                let state = null;
                if (message.raw) {
                    try { state = JSON.parse(message.raw); }
                    catch (_) { state = null; }
                }
                finish(state && Array.isArray(state.folders) ? state : null);
            };
            window.addEventListener('message', onMessage);
            timer = window.setTimeout(() => finish(null), 2500);
            frame = document.createElement('iframe');
            frame.style.display = 'none';
            frame.setAttribute('aria-hidden', 'true');
            frame.src = origin + '/ui/zashboard-bridge.html?ts=' + Date.now();
            document.body.appendChild(frame);
        });
    }

    function defaultFolderState() {
        return {
            activeId: 'ALL',
            seeded: true,
            folders: [
                {
                    id: 'builtin-strategy', name: 'folder_builtin_strategy', order: 0,
                    rules: [{ type: 'auto', value: 'hasGroup' }], manualIncludes: []
                },
                {
                    id: 'builtin-nodes', name: 'folder_builtin_nodes', order: 1,
                    rules: [{ type: 'auto', value: 'nodeOnly' }], manualIncludes: []
                }
            ]
        };
    }

    function ensureFolderState(force) {
        if (force) folderReadPromise = null;
        if (folderReadPromise) return folderReadPromise;
        folderReadPromise = readZashboardFolderState().then(state => {
            if (state) {
                folderState = state;
                folderSource = 'zashboard';
            } else {
                folderState = folderState || defaultFolderState();
                folderSource = folderSource === 'zashboard' ? 'zashboard' : 'automatic';
            }
            sharedFolderState = folderState;
            sharedFolderSource = folderSource;
            return folderState;
        }).catch(() => {
            folderState = folderState || defaultFolderState();
            folderSource = folderSource === 'zashboard' ? 'zashboard' : 'automatic';
            sharedFolderState = folderState;
            sharedFolderSource = folderSource;
            return folderState;
        });
        return folderReadPromise;
    }

    function folderLabel(name) {
        return FOLDER_LABELS[name] || name || '分类';
    }

    function isNodeOnly(name, proxies, groupNames) {
        const group = proxies[name];
        if (!group || !Array.isArray(group.all) || !group.all.length) return false;
        return !group.all.some(member => groupNames.has(member));
    }

    function matchesFolderRule(name, rule, proxies, groupNames) {
        if (!rule || !rule.type) return false;
        if (rule.type === 'auto') {
            const nodeOnly = isNodeOnly(name, proxies, groupNames);
            return rule.value === 'nodeOnly' ? nodeOnly : !nodeOnly;
        }
        if (rule.type === 'regex' || rule.type === 'excludeRegex') {
            if (!rule.pattern) return false;
            try { return new RegExp(rule.pattern).test(name); }
            catch (_) { return false; }
        }
        return false;
    }

    function folderMatches(name, folder, proxies, groupNames) {
        if ((folder.manualIncludes || []).includes(name)) return true;
        const rules = Array.isArray(folder.rules) ? folder.rules : [];
        const includes = rules.filter(rule => rule.type === 'auto' || rule.type === 'regex');
        const excludes = rules.filter(rule => rule.type === 'excludeRegex');
        if (!includes.some(rule => matchesFolderRule(name, rule, proxies, groupNames))) return false;
        return !excludes.some(rule => matchesFolderRule(name, rule, proxies, groupNames));
    }

    function computeFolderView(groups, proxies) {
        const state = folderState || defaultFolderState();
        const folders = [...(state.folders || [])].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
        const groupNames = new Set(
            Object.values(proxies || {})
                .filter(item => item && Array.isArray(item.all) && item.all.length)
                .map(item => item.name)
        );
        const sets = new Map();
        folders.forEach(folder => sets.set(folder.id, new Set()));
        const uncategorized = new Set();
        groups.forEach(group => {
            let matched = false;
            folders.forEach(folder => {
                if (!folderMatches(group.name, folder, proxies, groupNames)) return;
                matched = true;
                sets.get(folder.id).add(group.name);
            });
            if (!matched) uncategorized.add(group.name);
        });
        const items = [{ id: 'ALL', label: '全部', count: groups.length, icon: 'rules' }]
            .concat(folders.map(folder => ({
                id: folder.id, label: folderLabel(folder.name),
                count: sets.get(folder.id).size, icon: 'folder'
            })));
        if (uncategorized.size) {
            sets.set(VIRTUAL_UNCAT, uncategorized);
            items.push({ id: VIRTUAL_UNCAT, label: folderLabel('folder_uncategorized'), count: uncategorized.size, icon: 'sliders' });
        }
        return { items, sets };
    }

    function renderFilterPills(folderView) {
        pillsHost.innerHTML = '';
        const sourceTip = folderSource === 'zashboard' ? '分类来自 zashboard 配置' : '分类按代理关系自动生成';
        folderView.items.forEach(item => {
            const button = ui.E('button', {
                type: 'button',
                title: sourceTip,
                'class': 'sbd-filter-pill sbd-folder-pill ' + (activeCategory === item.id ? 'active' : ''),
                click: () => { activeCategory = item.id; paint(); }
            }, [
                ui.icon(item.icon || 'folder'),
                ui.E('span', {}, item.label),
                ui.E('span', { 'class': 'sbd-filter-count' }, String(item.count))
            ]);
            pillsHost.appendChild(button);
        });
    }

    function groupNode(proxies, group, index, open) {
        const nodes = group.all.map(name => proxies[name] || { name, type: 'Unknown' });
        const visible = nodes.filter(node => !filter || String(node.name).toLowerCase().includes(filter));
        if (filter && !visible.length) return null;

        const block = ui.E('details', { 'class': 'sbd-card sbd-proxy-group' });
        if (open || filter || openGroups.has(group.name)) block.open = true;
        block.setAttribute('data-group-name', group.name);
        block.addEventListener('toggle', () => {
            if (block.open) {
                openGroups.add(group.name);
                testGroup(group, false);
            } else {
                openGroups.delete(group.name);
            }
        });

        const [iconName, defaultColor] = groupIcon(group.name, group.type);
        const iconColor = GROUP_COLORS[index % GROUP_COLORS.length] || defaultColor;
        const typeText = TYPE_NAMES[group.type] || group.type;
        const nowText = ui.E('div', { 'class': 'sbd-proxy-now' });
        function updateNow(selected) {
            group.now = selected;
            nowText.innerHTML = '';
            nowText.appendChild(nameBadge(selected || '未选择', /direct|直连/i.test(selected || '') ? 'green' : 'orange'));
            nowText.appendChild(ui.badge(typeText, 'blue'));
            nowText.appendChild(ui.E('span', {}, visible.length + ' 节点'));
        }
        updateNow(group.now);

        const summary = ui.E('summary', {}, [
            ui.E('div', { 'class': 'sbd-proxy-head' }, [
                ui.appIcon(iconName, iconColor),
                ui.E('div', { 'class': 'sbd-proxy-head-main' }, [
                    nameNode(group.name, 'sbd-proxy-name'),
                    nowText
                ]),
                ui.E('span', { 'class': 'sbd-chevron' }, ui.icon('chevron'))
            ])
        ]);
        block.appendChild(summary);

        const nodeList = ui.E('div', { 'class': 'sbd-proxy-nodes' });
        visible.forEach(node => {
            const active = node.name === group.now;
            const delay = delays[node.name];
            const check = ui.E('span', { 'class': 'sbd-check-circle ' + (active ? 'checked' : '') }, ui.icon('check'));
            const test = ui.E('button', {
                type: 'button',
                'class': delayClass(delay),
                'data-delay-node': node.name,
                title: '点击测试节点延迟',
                'aria-label': '测试 ' + node.name + ' 的延迟',
                click: async event => {
                    event.preventDefault();
                    event.stopPropagation();
                    test.disabled = true;
                    test.classList.add('testing');
                    test.textContent = '…';
                    let value = 0;
                    try {
                        const result = await api.clash('GET', '/proxies/' + encodeURIComponent(node.name) +
                            '/delay?url=' + encodeURIComponent(TEST_URL) + '&timeout=5000');
                        value = Number(result && result.delay || 0);
                    } catch (_) {
                        value = 0;
                    }
                    applyDelay(node.name, value);
                    test.disabled = false;
                }
            }, delay == null ? '—' : delayText(delay));
            const protocol = node.udp === false ? 'TCP' : 'UDP';
            const typeLabel = node.type && node.type !== 'Unknown' ? node.type : 'Proxy';
            const item = ui.E('div', {
                role: 'button',
                tabindex: '0',
                'class': 'sbd-node ' + (active ? 'active' : ''),
                'data-node': node.name,
                click: async () => {
                    if (group.now === node.name) return;
                    try {
                        await api.clash('PUT', '/proxies/' + encodeURIComponent(group.name), { name: node.name });
                        ui.notify('已切换至 ' + node.name, 'success');
                        updateNow(node.name);
                        nodeList.querySelectorAll('.sbd-node').forEach(row => {
                            const selected = row.getAttribute('data-node') === node.name;
                            row.classList.toggle('active', selected);
                            const circle = row.querySelector('.sbd-check-circle');
                            if (circle) circle.classList.toggle('checked', selected);
                        });
                    } catch (err) {
                        ui.notify(api.errorText(err), 'error', 5000);
                    }
                }
            }, [
                check,
                nameNode(node.name, 'sbd-node-name'),
                ui.E('span', { 'class': 'sbd-node-protocol' }, protocol),
                ui.E('span', { 'class': 'sbd-node-type' }, typeLabel),
                test
            ]);
            item.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    item.click();
                }
            });
            nodeList.appendChild(item);
        });
        block.appendChild(nodeList);
        return block;
    }

    function applyDelay(name, value) {
        delays[name] = value;
        list.querySelectorAll('[data-delay-node]').forEach(node => {
            if (node.getAttribute('data-delay-node') !== name) return;
            node.className = delayClass(value);
            node.textContent = delayText(value);
        });
    }

    function seedDelays(proxies) {
        Object.values(proxies || {}).forEach(node => {
            if (!node || !node.name) return;
            const value = historyDelay(node);
            if (value !== null) delays[node.name] = value;
        });
    }

    function markGroupTesting(group) {
        const members = new Set(group.all || []);
        list.querySelectorAll('[data-delay-node]').forEach(node => {
            const name = node.getAttribute('data-delay-node');
            if (!members.has(name)) return;
            node.classList.add('testing');
            if (delays[name] === undefined) node.textContent = '…';
        });
    }

    async function testGroup(group, manual) {
        if (!group || !Array.isArray(group.all)) return;
        if (testingGroups.has(group.name)) return;
        if (!manual && testedGroups.has(group.name)) return;
        testedGroups.add(group.name);
        testingGroups.add(group.name);
        markGroupTesting(group);
        try {
            const result = await api.clash('GET', '/group/' + encodeURIComponent(group.name) +
                '/delay?url=' + encodeURIComponent(TEST_URL) + '&timeout=' + TEST_TIMEOUT);
            const values = result && typeof result === 'object' ? result : {};
            (group.all || []).forEach(name => {
                const value = Object.prototype.hasOwnProperty.call(values, name) ? Number(values[name]) : 0;
                applyDelay(name, Number.isFinite(value) ? value : 0);
            });
        } catch (error) {
            if (manual) ui.notify('策略组测速失败：' + api.errorText(error), 'error', 6000);
            (group.all || []).forEach(name => {
                if (delays[name] === undefined) {
                    list.querySelectorAll('[data-delay-node]').forEach(node => {
                        if (node.getAttribute('data-delay-node') === name) {
                            node.className = delayClass(null);
                            node.textContent = '—';
                        }
                    });
                }
            });
        } finally {
            testingGroups.delete(group.name);
        }
    }

    async function runPool(items, limit, worker) {
        let cursor = 0;
        async function run() {
            while (cursor < items.length) {
                const item = items[cursor++];
                await worker(item);
            }
        }
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    }

    async function testAllGroups() {
        if (!data || testAllButton.disabled) return;
        const groups = groupsFrom(data).filter(group => group.name !== 'GLOBAL');
        if (!groups.length) return;
        testAllButton.disabled = true;
        if (testAllLabel) testAllLabel.textContent = '测速中…';
        let finished = 0;
        try {
            await runPool(groups, 4, async group => {
                await testGroup(group, true);
                finished++;
            });
            ui.notify('已完成 ' + finished + ' 个策略组测速', 'success');
        } finally {
            testAllButton.disabled = false;
            if (testAllLabel) testAllLabel.textContent = '全部测速';
        }
    }

    function paint() {
        if (!list) return;
        const scrollState = [];
        ['.main-right', '#maincontent', '.main'].forEach(selector => {
            const node = document.querySelector(selector);
            if (node) scrollState.push([node, node.scrollTop]);
        });
        list.innerHTML = '';
        if (error) {
            list.appendChild(ui.card('无法读取策略分流', [
                ui.note(error, 'bad'),
                ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('重试', { icon: 'refresh', onClick: load }))
            ], { className: 'sbd-proxy-grid-full' }));
            return;
        }
        if (!data) return;
        const proxies = data.proxies || {};
        let groups = groupsFrom(data);
        if (mode !== 'global') groups = groups.filter(group => group.name !== 'GLOBAL');
        const folderView = computeFolderView(groups, proxies);
        if (!folderView.items.some(item => item.id === activeCategory)) activeCategory = 'ALL';
        renderFilterPills(folderView);
        if (!groups.length) {
            list.appendChild(ui.empty('当前配置无可管理的策略组'));
            return;
        }
        const selectedNames = activeCategory === 'ALL' ? null : (folderView.sets.get(activeCategory) || new Set());
        const filtered = selectedNames ? groups.filter(group => selectedNames.has(group.name)) : groups;
        filtered.forEach(group => {
            const node = groupNode(proxies, group, groups.indexOf(group), false);
            if (node) list.appendChild(node);
        });
        if (!list.childNodes.length) list.appendChild(ui.empty('未找到匹配的节点'));
        window.requestAnimationFrame(() => scrollState.forEach(item => { item[0].scrollTop = item[1]; }));
    }

    function showLoadingState() {
        list.innerHTML = '';
        const skeleton = ui.E('div', { 'class': 'sbd-proxy-skeleton' }, Array.from({ length: 4 }, () =>
            ui.E('div', { 'class': 'sbd-proxy-skeleton-row' }, [
                ui.E('span', { 'class': 'sbd-proxy-skeleton-icon' }),
                ui.E('span', { 'class': 'sbd-proxy-skeleton-copy' }, [
                    ui.E('i'), ui.E('i')
                ]),
                ui.E('span', { 'class': 'sbd-proxy-skeleton-action' })
            ])));
        list.appendChild(ui.card('正在读取策略组', [
            skeleton,
            ui.note('正在连接 Clash API，通常需要几秒钟。', 'info')
        ], { icon: 'proxies', iconTone: 'blue', className: 'sbd-proxy-grid-full' }));
    }

    async function load(options) {
        if (syncing) return;
        const status = ctx.status || {};
        const apiInfo = status.api || {};
        if (!status.running) {
            error = 'sing-box 未运行，无法读取策略组';
            data = null;
            paint();
            return;
        }
        if (apiInfo.valid === false || !apiInfo.port) {
            error = apiInfo.error || '当前配置中未启用 Clash API';
            data = null;
            paint();
            return;
        }
        const silent = !!(options && options.silent);
        syncing = true;
        if (!silent) {
            error = null;
            showLoadingState();
        }
        try {
            if (!silent) folderReadPromise = null;
            folderState = folderState || defaultFolderState();
            const folderPromise = ensureFolderState();
            folderPromise.then(() => { if (data) paint(); }).catch(() => {});
            const configPromise = api.clash('GET', '/configs').then(result => {
                const nextMode = String(result && result.mode || 'rule').toLowerCase();
                if (['rule', 'global', 'direct'].includes(nextMode)) mode = nextMode;
                updateModeSwitch();
            }).catch(() => {});
            let proxyResult;
            try {
                proxyResult = await Promise.race([
                    api.clash('GET', '/proxies'),
                    new Promise((_, reject) => window.setTimeout(
                        () => reject(new Error('读取策略组超时，请重试')), 8000))
                ]);
            } catch (reason) {
                proxyResult = null;
                if (!silent) {
                    error = api.errorText(reason);
                    data = null;
                }
            }
            if (proxyResult) {
                data = proxyResult;
                sharedData = data;
                seedDelays(data.proxies || {});
                if (!silent) testedGroups.clear();
            }
            if (!error || data) paint();
            configPromise.catch(() => {});
            testAllButton.disabled = !data || groupsFrom(data).length === 0;
            if (data) requestAnimationFrame(() => {
                Array.from(list.querySelectorAll('.sbd-proxy-group')).forEach(block => {
                    if (!block.open) return;
                    const name = block.getAttribute('data-group-name');
                    const group = groupsFrom(data).find(item => item.name === name);
                    if (group) testGroup(group, false);
                });
            });
        } finally {
            syncing = false;
        }
    }

    updateModeSwitch();
    if (data) {
        paint();
        testAllButton.disabled = !groupsFrom(data).length;
        load({ silent: true }).catch(() => {});
    } else {
        await load();
    }
    const pollTimer = window.setInterval(() => {
        if (!document.hidden) load({ silent: true }).catch(() => {});
    }, 10000);
    const folderTimer = window.setInterval(async () => {
        if (document.hidden || !data) return;
        await ensureFolderState(true);
        paint();
    }, 60000);
    ctx.onCleanup(() => {
        window.clearInterval(pollTimer);
        window.clearInterval(folderTimer);
    });
}

return baseclass.extend({ render });



