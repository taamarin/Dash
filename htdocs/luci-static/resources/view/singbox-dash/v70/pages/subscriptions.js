'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';
'require view.singbox-dash.v70.lib.components as components';

const NODE_GROUPS = new Set(['selector', 'urltest', 'smart', 'smart-loadbalance', 'loadbalance', 'direct', 'block', 'dns']);

function slug(value) {
    const text = String(value || '').trim();
    let result = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 48);
    if (!result) {
        let hash = 2166136261;
        for (let index = 0; index < text.length; index++) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        result = 'provider-' + (hash >>> 0).toString(16);
    }
    return result || 'provider';
}

function providerPath(tag) {
    return '/etc/sing-box/providers/' + slug(tag) + '.yaml';
}

function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
}

function shortUrl(value) {
    const text = String(value || '');
    try {
        const parsed = new URL(text);
        const tail = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
        return parsed.host + tail.slice(0, 34) + (tail.length > 34 ? '…' : '');
    } catch (_) {
        return text.length > 64 ? text.slice(0, 61) + '…' : text;
    }
}

function endpoint(node) {
    const server = String(node.server || '');
    return server ? server + (node.port ? ':' + node.port : '') : '本地/内联';
}

function trafficTone(percent) {
    if (percent >= 90) return 'bad';
    if (percent >= 75) return 'warn';
    return 'good';
}

function expiryText(value) {
    const seconds = Number(value || 0);
    if (!seconds) return '到期时间未知';
    if (seconds > Date.now() / 1000 + 20 * 365 * 86400) return '长期有效';
    return api.formatDate(seconds, false) + ' 到期';
}

function trafficBlock(provider) {
    if (provider.kind === 'local') {
        return ui.E('div', { 'class': 'sbd-sub-traffic local' }, [
            ui.E('span', { 'class': 'sbd-sub-traffic-label' }, '本地节点'),
            ui.E('span', { 'class': 'sbd-sub-traffic-unknown' }, '无订阅流量信息')
        ]);
    }
    const traffic = provider.traffic;
    if (!traffic || !Number(traffic.total)) {
        return ui.E('div', { 'class': 'sbd-sub-traffic unknown' }, [
            ui.E('span', { 'class': 'sbd-sub-traffic-label' }, '订阅流量'),
            ui.E('span', { 'class': 'sbd-sub-traffic-unknown' }, '服务端未返回流量信息')
        ]);
    }
    const percent = Math.max(0, Math.min(100, Number(traffic.percent) || 0));
    return ui.E('div', { 'class': 'sbd-sub-traffic' }, [
        ui.E('div', { 'class': 'sbd-sub-traffic-head' }, [
            ui.E('span', { 'class': 'sbd-sub-traffic-label' }, '订阅流量'),
            ui.E('strong', {}, api.formatBytes(traffic.used) + ' / ' + api.formatBytes(traffic.total)),
            ui.E('span', { 'class': 'sbd-sub-traffic-percent ' + trafficTone(percent) }, percent.toFixed(1) + '%')
        ]),
        ui.E('div', { 'class': 'sbd-sub-traffic-bar ' + trafficTone(percent) }, [
            ui.E('i', { style: 'width:' + percent + '%' })
        ]),
        ui.E('div', { 'class': 'sbd-sub-traffic-meta' }, [
            ui.E('span', { title: '上传 ' + api.formatBytes(traffic.upload) + ' · 下载 ' + api.formatBytes(traffic.download) }, '剩余 ' + api.formatBytes(traffic.remaining)),
            ui.E('span', {}, expiryText(traffic.expire))
        ])
    ]);
}

async function render(host, ctx) {
    let data = null;
    let current = null;
    let busy = false;
    let tab = 'subscriptions';
    let search = '';
    const root = ui.E('div', { 'class': 'sbd-stack sbd-subscriptions-page' });
    const summary = ui.E('div', { 'class': 'sbd-sub-summary' });
    const toolbar = ui.E('div', { 'class': 'sbd-sub-toolbar' });
    const content = ui.E('div', { 'class': 'sbd-stack sbd-sub-content' });
    host.appendChild(root);
    root.appendChild(summary);
    root.appendChild(toolbar);
    root.appendChild(content);

    function setBusy(value) {
        busy = !!value;
        if (ctx.setBusy) ctx.setBusy(busy);
        components.setBusy(root, busy);
    }

    function providers() {
        return data && Array.isArray(data.providers) ? data.providers : [];
    }

    function allSources() {
        const list = providers().map(item => ({
            tag: item.tag,
            kind: item.kind,
            nodes: Array.isArray(item.nodes) ? item.nodes : [],
            error: item.error || ''
        }));
        if (data && Array.isArray(data.manual_nodes) && data.manual_nodes.length) {
            list.push({ tag: '手动节点', kind: 'manual', nodes: data.manual_nodes, error: '' });
        }
        return list;
    }

    function summaryTile(label, value, sub, tone) {
        return ui.E('div', { 'class': 'sbd-sub-summary-tile ' + (tone || '') }, [
            ui.E('span', { 'class': 'sbd-sub-summary-label' }, label),
            ui.E('strong', { 'class': 'sbd-sub-summary-value' }, value),
            ui.E('span', { 'class': 'sbd-sub-summary-sub' }, sub || '')
        ]);
    }

    function renderSummary() {
        summary.innerHTML = '';
        const counts = data && data.counts ? data.counts : {};
        const interval = data && data.subscription ? Number(data.subscription.interval || 0) : 0;
        summary.appendChild(summaryTile('订阅源', String(counts.providers || 0), (counts.remote || 0) + ' 远程 · ' + (counts.local || 0) + ' 本地', 'blue'));
        summary.appendChild(summaryTile('节点总数', String(counts.nodes || 0), '来自订阅与手动节点', 'green'));
        summary.appendChild(summaryTile('自动更新', interval ? interval + ' 分钟' : '已关闭', interval ? '定时拉取订阅源' : '可在设置中开启', interval ? 'orange' : ''));
        summary.appendChild(summaryTile('最近更新', data && data.latest_update ? api.formatDate(data.latest_update) : '—', 'Provider 文件时间', 'purple'));
    }

    function switchTab(next) {
        tab = next;
        render();
    }

    function renderToolbar() {
        toolbar.innerHTML = '';
        const tabs = ui.E('div', { 'class': 'sbd-sub-tabs' }, [
            ui.E('button', { type: 'button', 'class': 'sbd-sub-tab ' + (tab === 'subscriptions' ? 'active' : ''), click: () => switchTab('subscriptions') }, [
                ui.icon('database'), ui.E('span', {}, '订阅源'), ui.E('span', { 'class': 'sbd-sub-tab-count' }, String(providers().length))
            ]),
            ui.E('button', { type: 'button', 'class': 'sbd-sub-tab ' + (tab === 'nodes' ? 'active' : ''), click: () => switchTab('nodes') }, [
                ui.icon('globe'), ui.E('span', {}, '节点'), ui.E('span', { 'class': 'sbd-sub-tab-count' }, String((data && data.counts && data.counts.nodes) || 0))
            ])
        ]);
        const searchInput = ui.E('input', {
            type: 'search', 'class': 'sbd-input sbd-sub-search', placeholder: '搜索节点、协议或服务器',
            value: search, input: event => { search = event.target.value.trim().toLowerCase(); if (tab === 'nodes') renderContent(); }
        });
        const actions = ui.E('div', { 'class': 'sbd-sub-actions' }, [
            ui.btn('新增订阅', { icon: 'plus', variant: 'primary', onClick: () => openProviderEditor(null, 'remote') }),
            ui.btn('导入节点', { icon: 'upload', onClick: () => openProviderEditor(null, 'local') })
        ]);
        toolbar.appendChild(ui.E('div', { 'class': 'sbd-sub-toolbar-main' }, [tabs, tab === 'nodes' ? searchInput : null].filter(Boolean)));
        toolbar.appendChild(actions);
    }

    function providerCard(provider, index) {
        const remote = provider.kind === 'remote';
        const update = provider.updated ? api.formatDate(provider.updated) : '尚未更新';
        const source = remote ? provider.url : provider.path;
        return ui.E('section', { 'class': 'sbd-subscription-source-card' }, [
            ui.E('div', { 'class': 'sbd-sub-source-head' }, [
                ui.appIcon(remote ? 'link' : 'database', remote ? 'blue' : 'green'),
                ui.E('div', { 'class': 'sbd-sub-source-copy' }, [
                    ui.E('div', { 'class': 'sbd-sub-source-title' }, ui.nameWithFlags(provider.tag || '未命名订阅')),
                    ui.E('div', { 'class': 'sbd-sub-source-badges' }, [
                        ui.badge(remote ? '远程订阅' : '本地节点', remote ? 'blue' : 'green'),
                        ui.badge((provider.node_count || 0) + ' 节点', ''),
                        remote && provider.update_interval ? ui.badge('更新 ' + provider.update_interval, 'orange') : null,
                        !remote ? ui.badge('无订阅流量', '') : null,
                        provider.error ? ui.badge('读取异常', 'red') : null
                    ].filter(Boolean))
                ]),
                ui.E('div', { 'class': 'sbd-sub-source-actions' }, [
                    ui.btn('编辑', { icon: 'edit', small: true, onClick: () => openProviderEditor(index, remote ? 'remote' : 'local') }),
                    ui.btn('', { icon: 'trash', iconOnly: true, small: true, variant: 'danger', title: '删除订阅源', onClick: () => deleteProvider(index) })
                ])
            ]),
            ui.E('div', { 'class': 'sbd-sub-source-body' }, [
                ui.E('div', { 'class': 'sbd-sub-source-url', title: source || '' }, remote ? shortUrl(source) : (source || '未设置文件路径')),
                trafficBlock(provider),
                provider.error ? ui.note(provider.error, 'bad') : null,
                ui.E('div', { 'class': 'sbd-sub-source-meta' }, [
                    ui.E('span', {}, '更新：' + update),
                    ui.E('span', {}, provider.health_check && provider.health_check.enabled ? '健康检查已启用' : '健康检查关闭'),
                    provider.exclude ? ui.E('span', { title: provider.exclude }, '排除：' + provider.exclude.slice(0, 42) + (provider.exclude.length > 42 ? '…' : '')) : null
                ].filter(Boolean))
            ].filter(Boolean))
        ]);
    }

    function legacyCard() {
        const subscription = data && data.subscription ? data.subscription : {};
        if (!subscription.url) return null;
        return ui.E('section', { 'class': 'sbd-subscription-source-card legacy' }, [
            ui.E('div', { 'class': 'sbd-sub-source-head' }, [
                ui.appIcon('config', 'orange'),
                ui.E('div', { 'class': 'sbd-sub-source-copy' }, [
                    ui.E('div', { 'class': 'sbd-sub-source-title' }, '当前配置订阅'),
                    ui.E('div', { 'class': 'sbd-sub-source-badges' }, [
                        ui.badge('整份配置订阅', 'orange'),
                        ui.badge(subscription.interval ? '自动 ' + subscription.interval + ' 分钟' : '手动更新', subscription.interval ? 'green' : '')
                    ])
                ]),
                ui.E('div', { 'class': 'sbd-sub-source-actions' }, [
                    ui.btn('编辑地址', { icon: 'edit', small: true, onClick: openLegacyEditor }),
                    ui.btn('立即同步', { icon: 'refresh', small: true, onClick: updateLegacySubscription })
                ])
            ]),
            ui.E('div', { 'class': 'sbd-sub-source-body' }, [
                ui.E('div', { 'class': 'sbd-sub-source-url', title: subscription.url }, shortUrl(subscription.url))
            ])
        ]);
    }

    function renderSubscriptions() {
        content.innerHTML = '';
        const legacy = legacyCard();
        if (legacy) content.appendChild(legacy);
        const list = providers();
        if (!list.length) content.appendChild(ui.empty('暂无订阅源，可新增远程订阅或导入本地节点'));
        list.forEach((provider, index) => content.appendChild(providerCard(provider, index)));
    }

    function nodeCard(node) {
        const meta = [node.transport ? node.transport.toUpperCase() : '', node.tls ? 'TLS' : ''].filter(Boolean).join(' · ');
        return ui.E('div', { 'class': 'sbd-managed-node-card' }, [
            ui.appIcon(node.type && /direct|reject/i.test(node.type) ? 'link' : 'globe', node.tls ? 'green' : 'blue'),
            ui.E('div', { 'class': 'sbd-managed-node-copy' }, [
                ui.E('strong', { 'class': 'sbd-managed-node-name' }, ui.nameWithFlags(node.tag || '未命名节点')),
                ui.E('span', { 'class': 'sbd-managed-node-server' }, endpoint(node))
            ]),
            ui.E('div', { 'class': 'sbd-managed-node-meta' }, [
                ui.badge(node.type || 'Unknown', 'blue'),
                meta ? ui.E('span', {}, meta) : null
            ].filter(Boolean))
        ]);
    }

    function renderNodes() {
        content.innerHTML = '';
        const sources = allSources().map(source => ({
            ...source,
            nodes: source.nodes.filter(node => {
                if (!search) return true;
                return [node.tag, node.type, node.server, node.transport].join(' ').toLowerCase().includes(search);
            })
        })).filter(source => source.nodes.length || !search);
        if (!sources.length) {
            content.appendChild(ui.empty(search ? '未找到匹配节点' : '暂无可用节点'));
            return;
        }
        sources.forEach(source => {
            const section = ui.E('section', { 'class': 'sbd-node-source-section' }, [
                ui.E('div', { 'class': 'sbd-node-source-head' }, [
                    ui.E('div', { 'class': 'sbd-node-source-title' }, ui.nameWithFlags(source.tag)),
                    ui.badge(source.kind === 'remote' ? '远程' : source.kind === 'local' ? '本地' : '手动', source.kind === 'remote' ? 'blue' : 'green'),
                    ui.E('span', { 'class': 'sbd-node-source-count' }, source.nodes.length + ' 节点')
                ])
            ]);
            if (source.error) section.appendChild(ui.note(source.error, 'bad'));
            const grid = ui.E('div', { 'class': 'sbd-managed-node-grid' });
            source.nodes.forEach(node => grid.appendChild(nodeCard(node)));
            if (!source.nodes.length) grid.appendChild(ui.empty(search ? '该订阅没有匹配节点' : '该订阅暂无节点'));
            section.appendChild(grid);
            content.appendChild(section);
        });
    }

    function renderContent() {
        if (tab === 'nodes') renderNodes();
        else renderSubscriptions();
    }

    function render() {
        renderSummary();
        renderToolbar();
        renderContent();
    }

    async function load() {
        setBusy(true);
        try {
            const status = ctx.status || await api.status(true);
            const active = status && status.active ? status.active : '';
            const values = await Promise.all([api.providerStatus(), api.configGet(active)]);
            data = values[0];
            current = values[1];
            render();
        } catch (error) {
            content.innerHTML = '';
            content.appendChild(components.errorCard('节点与订阅加载失败', api.errorText(error), load, {
                icon: 'database'
            }));
        } finally {
            setBusy(false);
        }
    }

    async function applyProviders(nextProviders, message) {
        if (!current) throw new Error('当前配置尚未加载');
        const draft = clone(current.parsed);
        draft.providers = nextProviders;
        await api.validateConfigObject(draft);
        const job = await api.submitConfigObject({
            action: 'apply', target: current.name, expected: current.hash, data: draft
        });
        if (job) await ctx.watchJob(job, '应用节点与订阅');
        await ctx.refreshStatus().catch(() => {});
        await load();
        ui.notify(message || '节点与订阅已应用', 'success');
    }

    async function deleteProvider(index) {
        const provider = providers()[index];
        if (!provider) return;
        const ok = await ui.confirm('删除订阅源', '删除“' + provider.tag + '”会同时移除配置引用，并重启 sing-box。', '删除', true);
        if (!ok) return;
        try {
            setBusy(true);
            const next = providers().map(item => ({
                type: item.kind === 'local' ? 'local' : 'remote',
                tag: item.tag,
                path: item.path,
                url: item.url || undefined,
                update_interval: item.update_interval || undefined,
                include: item.include || undefined,
                exclude: item.exclude || undefined,
                http_client: item.http_client || undefined,
                health_check: item.health_check && Object.keys(item.health_check).length ? item.health_check : undefined
            }));
            next.splice(index, 1);
            await applyProviders(next, '订阅源已删除');
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally {
            setBusy(false);
        }
    }

    function openLegacyEditor() {
        const input = ui.E('input', { 'class': 'sbd-input', type: 'url', value: data.subscription.url || '', placeholder: 'https://example.com/config' });
        ui.modal('编辑配置订阅', [
            ui.field('订阅 URL', input, '用于整份配置更新，不会新增 provider。')
        ], {
            cancelText: '取消', confirmText: '保存地址', width: '680px',
            onConfirm: async () => {
                await api.setSubscription(input.value.trim());
                await load();
                ui.notify('配置订阅地址已保存', 'success');
            }
        });
    }

    async function updateLegacySubscription() {
        try {
            setBusy(true);
            const result = await api.command('subscription-update');
            if (result.job) await ctx.watchJob(result.job, '更新配置订阅');
            else ui.notify(result.message || '订阅内容没有变化', 'success');
            await ctx.refreshStatus().catch(() => {});
            await load();
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally {
            setBusy(false);
        }
    }

    function openProviderEditor(index, kind) {
        const existing = index === null || index === undefined ? null : providers()[index];
        const working = existing ? {
            tag: existing.tag || '', kind: existing.kind || kind,
            url: existing.url || '', path: existing.path || providerPath(existing.tag || ''),
            update_interval: existing.update_interval || '6h',
            include: existing.include || '', exclude: existing.exclude || '',
            http_client: existing.http_client || 'provider_direct',
            health: !!(existing.health_check && existing.health_check.enabled),
            sourceType: 'text', source: ''
        } : {
            tag: '', kind: kind || 'remote', url: kind === 'remote' ? '' : '',
            path: providerPath(''), update_interval: '6h', include: '', exclude: '',
            http_client: 'provider_direct', health: true, sourceType: 'text', source: ''
        };
        let imported = null;
        const body = ui.E('div', { 'class': 'sbd-stack sbd-sub-provider-form' });
        function input(value, placeholder, onInput, type) {
            const node = ui.E('input', { 'class': 'sbd-input', type: type || 'text', value: value || '', placeholder: placeholder || '' });
            node.addEventListener('input', () => onInput(node.value));
            return node;
        }
        function sourceEditor(hostNode) {
            const select = ui.E('select', { 'class': 'sbd-select' }, [
                ui.E('option', { value: 'text', selected: working.sourceType === 'text' ? '' : null }, '粘贴分享链接或 Base64'),
                ui.E('option', { value: 'url', selected: working.sourceType === 'url' ? '' : null }, '从解析链接下载')
            ]);
            select.addEventListener('change', () => { working.sourceType = select.value; working.source = ''; draw(); });
            const sourceNode = working.sourceType === 'url'
                ? input(working.source, 'https://example.com/subscribe', value => { working.source = value; }, 'url')
                : ui.E('textarea', { 'class': 'sbd-textarea', placeholder: 'vless://… / vmess://… / 整段 Base64 订阅内容' }, working.source);
            if (sourceNode.tagName === 'TEXTAREA') sourceNode.addEventListener('input', () => { working.source = sourceNode.value; });
            const importButton = ui.btn('解析并写入节点文件', {
                icon: 'download', onClick: async () => {
                    const tag = tagValue.value.trim();
                    if (!tag) return ui.notify('请先填写订阅名称', 'warn');
                    const path = existing && existing.tag === tag && existing.path ? existing.path : providerPath(tag);
                    importButton.disabled = true;
                    try {
                        imported = await api.importProvider({ tag, path, sourceType: working.sourceType, source: working.source });
                        working.path = imported.path;
                        ui.notify('已导入 ' + imported.count + ' 个节点', 'success');
                    } catch (error) {
                        ui.notify(api.errorText(error), 'error', 7000);
                    } finally {
                        importButton.disabled = false;
                    }
                }
            });
            hostNode.appendChild(ui.field('本地节点来源', select));
            hostNode.appendChild(ui.field(working.sourceType === 'url' ? '解析链接' : '节点内容', sourceNode,
                working.sourceType === 'url' ? '只用于本次下载，生成后不再依赖 URL。' : '支持一行一个分享链接或整段 Base64。'));
            hostNode.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, importButton));
        }
        const tagValue = input(working.tag, '例如 HIMEMY、备用机场', value => {
            working.tag = value;
            if (!existing) working.path = providerPath(value);
            pathText.textContent = working.path;
        });
        const pathText = ui.E('code', { 'class': 'sbd-sub-path' }, working.path);
        function draw() {
            body.innerHTML = '';
            body.appendChild(ui.field('订阅名称', tagValue, '用于生成 Provider 标签和文件名。'));
            if (working.kind === 'remote') {
                body.appendChild(ui.field('订阅 URL', input(working.url, 'https://example.com/subscribe', value => { working.url = value; }, 'url')));
                body.appendChild(ui.E('div', { 'class': 'sbd-sub-form-grid' }, [
                    ui.field('更新间隔', input(working.update_interval, '6h', value => { working.update_interval = value; })),
                    ui.field('HTTP 客户端', input(working.http_client, 'provider_direct', value => { working.http_client = value; }), '留空或填写已有 http_clients 标签。'),
                    ui.field('节点文件', pathText)
                ]));
                body.appendChild(ui.E('div', { 'class': 'sbd-sub-form-grid' }, [
                    ui.field('包含关键词', input(working.include, '例如 香港|日本', value => { working.include = value; }), '用 | 分隔。'),
                    ui.field('排除关键词', input(working.exclude, '例如 官网|到期|剩余', value => { working.exclude = value; }), '用 | 分隔。')
                ]));
            } else {
                sourceEditor(body);
                body.appendChild(ui.field('节点文件', pathText, '由分享链接解析后写入本地 provider。'));
            }
            const healthToggle = ui.E('select', { 'class': 'sbd-select' }, [
                ui.E('option', { value: '1', selected: working.health ? '' : null }, '启用'),
                ui.E('option', { value: '0', selected: working.health ? null : '' }, '关闭')
            ]);
            healthToggle.addEventListener('change', () => { working.health = healthToggle.value === '1'; });
            body.appendChild(ui.field('健康检查', healthToggle, '使用默认 204 检查地址，每 30 分钟检查一次。'));
        }
        tagValue.addEventListener('input', () => { working.tag = tagValue.value; working.path = existing && existing.tag === working.tag && existing.path ? existing.path : providerPath(working.tag); pathText.textContent = working.path; });
        draw();
        ui.modal(existing ? '编辑订阅源' : working.kind === 'remote' ? '新增远程订阅' : '导入本地节点', body, {
            subtitle: working.kind === 'remote' ? '保存后更新 providers 并重启 sing-box。' : '解析分享链接后生成本地节点 provider。',
            cancelText: '取消', confirmText: existing ? '保存并应用' : '添加并应用', width: '760px',
            onConfirm: async () => {
                const tag = working.tag.trim();
                if (!tag) throw new Error('订阅名称不能为空');
                if (providers().some((item, itemIndex) => item.tag === tag && itemIndex !== index)) throw new Error('订阅名称已存在');
                const path = providerPath(tag);
                if (working.kind === 'remote') {
                    if (!/^https?:\/\/\S+$/i.test(working.url.trim())) throw new Error('请输入有效的 HTTP/HTTPS 订阅 URL');
                } else if ((!existing || existing.kind !== 'local') && !(imported && imported.count)) {
                    throw new Error('请先解析并写入本地节点文件');
                }
                if (existing && existing.kind === 'local' && existing.path && existing.tag !== tag) {
                    throw new Error('本地订阅改名后需要重新解析节点文件');
                }
                const value = {
                    type: working.kind === 'local' ? 'local' : 'remote', tag, path,
                    health_check: working.health ? {
                        enabled: true, url: 'https://www.gstatic.com/generate_204', interval: '30m'
                    } : undefined
                };
                if (working.kind === 'remote') {
                    value.url = working.url.trim();
                    value.update_interval = working.update_interval.trim() || '6h';
                    if (working.include.trim()) value.include = working.include.trim();
                    if (working.exclude.trim()) value.exclude = working.exclude.trim();
                    if (working.http_client.trim()) value.http_client = working.http_client.trim();
                }
                const next = providers().map(item => ({
                    type: item.kind === 'local' ? 'local' : 'remote', tag: item.tag, path: item.path,
                    url: item.url || undefined, update_interval: item.update_interval || undefined,
                    include: item.include || undefined, exclude: item.exclude || undefined,
                    http_client: item.http_client || undefined,
                    health_check: item.health_check && Object.keys(item.health_check).length ? item.health_check : undefined
                }));
                if (existing) next[index] = value; else next.push(value);
                await applyProviders(next, existing ? '订阅源已更新' : '订阅源已添加');
            }
        });
    }

    render();
    await load();
}

return baseclass.extend({ render });



