/* Node-provider manager modal separated from config page lifecycle. */
'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';

function create(env) {
    const { providers, markDirty } = env;

    function providerSlug(tag) {
        const value = String(tag || '').trim();
        let slug = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 48);
        if (!slug) {
            let hash = 2166136261;
            for (let index = 0; index < value.length; index++) {
                hash ^= value.charCodeAt(index);
                hash = Math.imul(hash, 16777619);
            }
            slug = 'provider-' + (hash >>> 0).toString(16);
        }
        return slug || 'provider';
    }

    function providerPath(tag) {
        return '/etc/sing-box/providers/' + providerSlug(tag) + '.yaml';
    }

    function openProviders() {
        let manager = null;
        const body = ui.E('div', { 'class': 'sbd-stack sbd-provider-manager' });
        function refresh() {
            body.innerHTML = '';
            body.appendChild(ui.note('远程 Provider 会按更新周期从 URL 拉取；本地 Provider 不会联网更新，由粘贴内容或解析链接生成静态节点文件。', 'info'));
            const list = ui.E('div', { 'class': 'sbd-provider-list' });
            providers().forEach((provider, index) => {
                const type = provider && provider.type === 'local' ? 'local' : 'remote';
                const source = type === 'local' ? provider.path || '未设置路径' : provider.url || '未设置 URL';
                list.appendChild(ui.row(provider.tag || '未命名 Provider', [
                    ui.E('div', { 'class': 'sbd-provider-meta' }, [
                        ui.badge(type === 'local' ? '本地静态' : '远程订阅', type === 'local' ? 'green' : 'blue'),
                        ui.E('span', { 'class': 'sbd-provider-source' }, source),
                        type === 'remote' ? ui.E('span', { 'class': 'sbd-provider-path' }, provider.path || '') : null
                    ].filter(Boolean))
                ], [
                    ui.btn('编辑', { icon: 'edit', small: true, onClick: () => openProviderEditor(index, refresh) }),
                    ui.btn('', { icon: 'trash', iconOnly: true, small: true, variant: 'danger',
                        title: '删除 Provider', onClick: () => deleteProvider(index, refresh) })
                ], { icon: type === 'local' ? 'database' : 'link', color: type === 'local' ? 'green' : 'blue' }));
            });
            if (!providers().length) list.appendChild(ui.empty('暂无节点提供者'));
            body.appendChild(list);
            body.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('新增提供者', {
                icon: 'plus', variant: 'primary', onClick: () => openProviderEditor(null, refresh)
            })));
        }
        refresh();
        manager = ui.modal('节点提供者', body, {
            subtitle: '远程订阅与本机静态节点分开管理',
            confirmText: '完成', width: '780px'
        });
        return manager;
    }

    async function deleteProvider(index, refresh) {
        const provider = providers()[index] || {};
        const ok = await ui.confirm('删除节点提供者',
            '删除 ' + (provider.tag || '该 Provider') + ' 后，引用它的策略组可能在保存时才报错。确定删除？',
            '删除', true);
        if (!ok) return;
        providers().splice(index, 1);
        markDirty();
        refresh();
        ui.notify('Provider 已从待保存配置中删除', 'success');
    }

    function openProviderEditor(index, refreshParent) {
        const existing = index === null || index === undefined ? null : providers()[index];
        const provider = existing || {};
        const working = {
            type: provider.type === 'local' ? 'local' : 'remote',
            tag: provider.tag || '',
            url: provider.url || '',
            path: provider.path || '',
            update_interval: provider.update_interval || '6h',
            exclude: provider.exclude || '',
            include: provider.include || '',
            http_client: provider.http_client || '',
            healthEnabled: !provider.health_check || provider.health_check.enabled !== false,
            healthUrl: (provider.health_check && provider.health_check.url) || 'https://www.gstatic.com/generate_200',
            healthInterval: (provider.health_check && provider.health_check.interval) || '30m',
            sourceType: 'text',
            source: ''
        };
        if (working.healthUrl === 'https://www.gstatic.com/generate_200')
            working.healthUrl = 'https://www.gstatic.com/generate_204';
        let autoPath = !existing;
        if (!working.path) working.path = providerPath(working.tag);
        let imported = existing && provider.type === 'local' ? { path: existing.path, count: 0, tags: [] } : null;
        const formHost = ui.E('div', { 'class': 'sbd-stack sbd-provider-form' });
        const statusHost = ui.E('div', { 'class': 'sbd-provider-import-status' });
        let editor = null;
        function input(value, placeholder, onInput, type) {
            const node = ui.E('input', { 'class': 'sbd-input', type: type || 'text', value: value || '', placeholder: placeholder || '' });
            node.addEventListener('input', () => onInput(node.value));
            return node;
        }
        function textarea(value, placeholder) {
            const node = ui.E('textarea', { 'class': 'sbd-textarea sbd-provider-textarea', spellcheck: 'false', placeholder });
            node.value = value || '';
            node.addEventListener('input', () => { working.source = node.value; });
            return node;
        }
        function renderStatus() {
            statusHost.innerHTML = '';
            if (!imported) return;
            statusHost.appendChild(ui.note(imported.count
                ? '已写入本地 Provider：' + imported.count + ' 个节点 · ' + imported.path
                : '当前使用已有本地文件：' + imported.path, 'success'));
            if (imported.tags && imported.tags.length) {
                statusHost.appendChild(ui.E('div', { 'class': 'sbd-provider-tags' },
                    imported.tags.slice(0, 12).map(tag => ui.badge(tag, 'green'))));
            }
        }
        async function importLocal(button) {
            try {
                if (!working.tag.trim()) throw new Error('请先填写 Provider 标签');
                if (!/^\/etc\/sing-box\/providers\/[^/]+$/.test(working.path)) throw new Error('本地文件必须位于 /etc/sing-box/providers/');
                if (!working.source.trim()) throw new Error(working.sourceType === 'url' ? '请填写解析链接' : '请粘贴节点链接或 Base64 内容');
                button.disabled = true;
                button.textContent = '正在解析并写入...';
                const result = await api.importProvider({
                    tag: working.tag.trim(), path: working.path,
                    sourceType: working.sourceType, source: working.source
                });
                imported = { path: result.path, count: result.count, tags: result.tags || [] };
                renderStatus();
                ui.notify('已生成 ' + result.count + ' 个本地节点', 'success');
                if (result.skipped && result.skipped.length)
                    ui.notify('有 ' + result.skipped.length + ' 行节点未识别，可在日志或重新粘贴后检查', 'warn', 6000);
            } catch (error) {
                ui.notify(api.errorText(error), 'error', 8000);
            } finally {
                button.disabled = false;
                button.textContent = '解析并写入本地文件';
            }
        }
        function renderEditor() {
            formHost.innerHTML = '';
            const typeSelect = ui.E('select', { 'class': 'sbd-select' }, [
                ui.E('option', { value: 'remote', selected: working.type === 'remote' ? '' : null }, '远程订阅 Provider'),
                ui.E('option', { value: 'local', selected: working.type === 'local' ? '' : null }, '本地静态 Provider')
            ]);
            typeSelect.addEventListener('change', () => { working.type = typeSelect.value; renderEditor(); });
            let pathInput = null;
            const tagInput = input(working.tag, '例如 HIMEMY', value => {
                working.tag = value;
                if (autoPath) {
                    working.path = providerPath(value);
                    if (pathInput) pathInput.value = working.path;
                }
            });
            pathInput = ui.E('input', { 'class': 'sbd-input', value: working.path || '' });
            pathInput.addEventListener('input', () => {
                autoPath = false;
                working.path = pathInput.value;
                imported = null;
                renderStatus();
            });
            formHost.appendChild(ui.E('div', { 'class': 'sbd-provider-type-row' }, [
                ui.field('类型', typeSelect, '远程订阅会定时更新；本地静态不会请求订阅 URL。'),
                ui.field('Provider 标签', tagInput, '同时也是策略组筛选名称，建议使用稳定名称。')
            ]));
            formHost.appendChild(ui.field('节点文件', pathInput, '本地 Provider 文件固定存放在 /etc/sing-box/providers/。'));
            if (working.type === 'remote') {
                formHost.appendChild(ui.field('远程链接', input(working.url, 'https://example.com/subscribe', value => { working.url = value; }, 'url'),
                    '填写机场订阅 URL。节点由 sing-box 按 update_interval 自动更新。'));
                formHost.appendChild(ui.E('div', { 'class': 'sbd-provider-form-grid' }, [
                    ui.field('更新周期', input(working.update_interval, '6h', value => { working.update_interval = value; }), '例如 30m、6h、24h。'),
                    ui.field('HTTP 客户端', input(working.http_client, '例如 provider_direct', value => { working.http_client = value; }), '可选，必须是配置中已有的 HTTP Client tag。')
                ]));
                formHost.appendChild(ui.E('div', { 'class': 'sbd-provider-form-grid' }, [
                    ui.field('包含正则', input(working.include, '可选，例如 香港|日本|US', value => { working.include = value; }), '仅保留名称匹配的节点。'),
                    ui.field('排除正则', input(working.exclude, '官网|到期|流量|剩余', value => { working.exclude = value; }), '过滤套餐信息或不可用节点。')
                ]));
            } else {
                const sourceSelect = ui.E('select', { 'class': 'sbd-select' }, [
                    ui.E('option', { value: 'text', selected: working.sourceType === 'text' ? '' : null }, '粘贴节点或 Base64 内容'),
                    ui.E('option', { value: 'url', selected: working.sourceType === 'url' ? '' : null }, '填写远程解析链接')
                ]);
                sourceSelect.addEventListener('change', () => {
                    working.sourceType = sourceSelect.value;
                    working.source = '';
                    renderEditor();
                });
                formHost.appendChild(ui.field('本地节点来源', sourceSelect,
                    '解析链接只用于本次下载，生成后不再依赖该 URL。'));
                if (working.sourceType === 'url') {
                    formHost.appendChild(ui.field('解析链接', input(working.source, 'https://example.com/subscribe', value => { working.source = value; }, 'url'),
                        '后端会下载 Base64/分享链接订阅并转换成静态 outbounds。'));
                } else {
                    formHost.appendChild(ui.field('节点内容', textarea(working.source,
                        '粘贴 vless://、vmess://、trojan://、ss:// 分享链接，或整段 Base64 订阅内容'),
                        '支持一行一个分享链接，也支持机场返回的整段 Base64。'));
                }
                const importButton = ui.btn('解析并写入本地文件', { icon: 'download', variant: 'primary',
                    onClick: () => importLocal(importButton) });
                formHost.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, importButton));
            }
            const healthToggle = ui.E('select', { 'class': 'sbd-select' }, [
                ui.E('option', { value: '1', selected: working.healthEnabled ? '' : null }, '启用'),
                ui.E('option', { value: '0', selected: working.healthEnabled ? null : '' }, '关闭')
            ]);
            healthToggle.addEventListener('change', () => { working.healthEnabled = healthToggle.value === '1'; renderEditor(); });
            formHost.appendChild(ui.E('div', { 'class': 'sbd-provider-form-grid' }, [
                ui.field('健康检查', healthToggle),
                ui.field('检查地址', input(working.healthUrl, 'https://www.gstatic.com/generate_204', value => { working.healthUrl = value; }), '仅在启用时写入。'),
                ui.field('检查间隔', input(working.healthInterval, '30m', value => { working.healthInterval = value; }), '例如 5m、30m。')
            ]));
            formHost.appendChild(statusHost);
            renderStatus();
            if (editor) {
                const subtitle = editor.dialog.querySelector('.sbd-modal-sub');
                if (subtitle) subtitle.textContent = working.type === 'local'
                    ? '生成并维护本地静态节点文件' : '远程订阅 URL 与更新参数';
            }
        }
        renderEditor();
        editor = ui.modal(existing ? '编辑节点提供者' : '新增节点提供者', formHost, {
            subtitle: working.type === 'local' ? '生成并维护本地静态节点文件' : '远程订阅 URL 与更新参数',
            cancelText: '取消', confirmText: existing ? '保存 Provider' : '添加 Provider', width: '780px',
            onConfirm: () => {
                const tag = working.tag.trim();
                const path = working.path.trim();
                if (!tag) throw new Error('Provider 标签不能为空');
                if (providers().some((item, itemIndex) => item && item.tag === tag && itemIndex !== index))
                    throw new Error('Provider 标签已存在');
                if (!/^\/etc\/sing-box\/providers\/[^/]+$/.test(path)) throw new Error('节点文件必须位于 /etc/sing-box/providers/');
                if (working.type === 'remote') {
                    const url = working.url.trim();
                    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('远程链接必须是 HTTP/HTTPS URL');
                } else if (!existing || existing.type !== 'local') {
                    if (!imported || !imported.count) throw new Error('请先解析节点并写入本地文件');
                    if (imported.path !== path) throw new Error('节点文件路径已改变，请重新解析');
                } else if (imported && imported.path !== path) {
                    throw new Error('节点文件路径已改变，请重新解析');
                }
                const value = { type: working.type, tag, path };
                if (working.healthEnabled) value.health_check = {
                    enabled: true,
                    url: working.healthUrl.trim() || 'https://www.gstatic.com/generate_204',
                    interval: working.healthInterval.trim() || '30m'
                };
                if (working.type === 'remote') {
                    value.url = working.url.trim();
                    value.update_interval = working.update_interval.trim() || '6h';
                    if (working.exclude.trim()) value.exclude = working.exclude.trim();
                    if (working.include.trim()) value.include = working.include.trim();
                    if (working.http_client.trim()) value.http_client = working.http_client.trim();
                }
                if (existing) providers()[index] = value;
                else providers().push(value);
                markDirty();
                refreshParent();
                ui.notify(existing ? 'Provider 修改已加入待保存列表' : 'Provider 已加入待保存列表', 'success');
            }
        });
        return editor;
    }

    return { openProviders };
}

return baseclass.extend({ create });
