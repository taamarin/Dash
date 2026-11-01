'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';
'require view.singbox-dash.v70.lib.components as components';
'require view.singbox-dash.v70.lib.schema-form as schemaForm';
'require view.singbox-dash.v70.lib.config-model as configModel';
'require view.singbox-dash.v70.lib.config-hub as configHub';
'require view.singbox-dash.v70.lib.config-provider-editor as configProviderEditor';

const EMPTY_CONFIG_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const { GROUPS, HUB_SECTIONS, TILE_SPAN, groupBadges } = configModel;

async function render(host, ctx) {
    let status = ctx.status || null;
    let current = null;
    let schema = null;
    let draft = {};
    let backups = [];
    let subscription = { url: '', interval: 0, enabled: false };
    let dirty = false;
    let busy = false;
    let view = 'hub';
    let validationText = '';

    const root = ui.E('div', { 'class': 'sbd-config-page' });
    host.appendChild(root);
    const toolbarHost = ui.E('div', { 'class': 'sbd-config-toolbar-host' });
    const viewHost = ui.E('div', { 'class': 'sbd-config-view' });
    const statusBadge = ui.E('span', { 'class': 'sbd-inline' }, '');
    const slotSelect = ui.E('select', { 'class': 'sbd-select sbd-config-slot' });
    const importInput = ui.E('input', {
        type: 'file', accept: '.yaml,.yml,.json,application/json,text/yaml', style: 'display:none',
        change: async event => {
            const file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (!file) return;
            try {
                const text = await file.text();
                if (!current) {
                    await createConfigFromFile(file, text);
                    return;
                }
                view = 'advanced';
                dirty = false;
                renderView();
                rawEditor.value = text;
                dirty = true;
                updateSavebar();
                ui.notify('已载入高级编辑器', 'success');
            } catch (error) { ui.notify('读取失败：' + error.message, 'error'); }
        }
    });
    const rawEditor = ui.E('textarea', {
        'class': 'sbd-textarea sbd-editor', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
        placeholder: '直接编辑 YAML / JSON 配置文本'
    });
    const validateButton = ui.btn('校验', { icon: 'shield', onClick: () => validateDraft() });
    const revertButton = ui.btn('放弃修改', { icon: 'refresh', onClick: () => reloadCurrent() });
    const saveButton = ui.btn('保存', { icon: 'save', onClick: () => saveDraft('save') });
    const applyButton = ui.btn('保存并应用', { icon: 'check', variant: 'primary', onClick: () => saveDraft('apply') });
    const savebar = components.saveBar([validateButton, revertButton, saveButton, applyButton], {
        className: 'sbd-config-savebar', emptyText: '加载配置', idleText: '配置已同步'
    });
    root.appendChild(toolbarHost);
    root.appendChild(viewHost);
    root.appendChild(savebar.node);
    root.appendChild(importInput);

    function setBusy(value) {
        busy = !!value;
        components.setBusy(root, busy, { exclude: importInput });
        if (ctx && typeof ctx.setBusy === 'function') ctx.setBusy(busy);
        updateSavebar();
    }
    function markDirty() {
        dirty = true;
        validationText = '';
        updateSavebar();
        if (view === 'hub') refreshTileSummaries();
    }
    function updateSavebar() {
        savebar.update({ busy, dirty, validationText, available: !!current });
    }
    function renderToolbar() {
        toolbarHost.innerHTML = '';
        const left = ui.E('div', { 'class': 'sbd-config-toolbar-main' });
        if (view !== 'hub') left.appendChild(ui.btn('返回分类', {
            icon: 'chevron', onClick: leaveView
        }));
        left.appendChild(ui.E('label', { 'class': 'sbd-inline sbd-config-slot-wrap' }, [
            ui.E('span', { 'class': 'sbd-field-label' }, '配置槽'), slotSelect
        ]));
        left.appendChild(statusBadge);
        toolbarHost.appendChild(ui.E('div', { 'class': 'sbd-config-toolbar' }, [
            left,
            ui.E('div', { 'class': 'sbd-config-toolbar-actions' }, [
                ui.btn('导入', { icon: 'upload', onClick: () => importInput.click() }),
                ui.btn('源码编辑', { icon: 'terminal', onClick: openAdvanced }),
                ui.btn('', { icon: 'refresh', iconOnly: true, title: '重新载入', onClick: () => reloadCurrent() })
            ])
        ]));
        statusBadge.innerHTML = '';
        if (current) {
            const active = current.active !== undefined ? current.active : !!(status && status.active === current.name);
            statusBadge.appendChild(ui.badge(active ? '当前' : '待用', active ? 'green' : ''));
            statusBadge.appendChild(ui.badge('字段集：' + ((status && status.core_family_label) || '未知'), 'green'));
            statusBadge.appendChild(ui.badge('模式：' + (current.mode && current.mode.mode !== 'unknown' ? current.mode.mode : 'custom'), ''));
        }
    }
    function renderView() {
        renderToolbar();
        viewHost.innerHTML = '';
        if (view === 'hub') renderHub();
        else renderAdvanced();
        updateSavebar();
    }

    function refreshTileSummaries() {
        configHub.refreshTileSummaries(viewHost, draft);
    }

    function renderHub() {
        configHub.render({
            host: viewHost,
            config: draft,
            busy,
            onGroup: openGroup,
            onAdvanced: openAdvanced,
            subscriptionCard,
            backupCard
        });
    }

    function formOptions(customRerender) {
        return {
            root: schema,
            draft,
            config: draft,
            onChange: markDirty,
            rerender: customRerender || renderView
        };
    }

    function providers() {
        if (!Array.isArray(draft.providers)) draft.providers = [];
        return draft.providers;
    }

    const providerEditor = configProviderEditor.create({ providers, markDirty });

    function openGroup(id) {
        if (id === 'providers') { providerEditor.openProviders(); return; }
        const group = GROUPS[id];
        if (!group) return;
        const modalBody = ui.E('div', { 'class': 'sbd-schema-modal-body sbd-stack' });
        function drawModalGroup() {
            modalBody.innerHTML = '';
            const options = formOptions(() => {
                drawModalGroup();
                refreshTileSummaries();
                updateSavebar();
            });
            group.keys.forEach(key => {
                if (!(schema.properties || {})[key]) return;
                schemaForm.renderTopLevel(modalBody, key, options);
            });
            refreshTileSummaries();
            updateSavebar();
        }
        drawModalGroup();
        ui.modal(group.title, modalBody, {
            subtitle: group.desc,
            confirmText: '完成',
            width: '760px',
            onClose: () => {
                    refreshTileSummaries();
                updateSavebar();
            }
        });
    }

    function openAdvanced() {
        if (dirty) {
            ui.confirm('切换到源码编辑', '可视化修改尚未保存，切换后会丢失。', '继续').then(ok => {
                if (!ok) return;
                dirty = false;
                view = 'advanced';
                renderView();
            });
            return;
        }
        view = 'advanced';
        renderView();
    }

    function renderAdvanced() {
        viewHost.innerHTML = '';
        rawEditor.value = current ? current.data : '';
        dirty = false;
        rawEditor.oninput = () => { dirty = true; validationText = ''; updateSavebar(); };
        const card = ui.card('源码编辑', [
            ui.note('源码编辑会保留完整配置字段；保存前自动执行内核校验，失败时不会写入。', 'info'),
            rawEditor,
            ui.E('div', { 'class': 'sbd-editor-foot' }, [
                ui.E('span', {}, 'UTF-8 · YAML / JSON · 保存时自动执行内核校验与失败回滚'),
                ui.E('span', {}, current ? current.name : '')
            ])
        ], { className: 'sbd-span-12', icon: 'terminal', iconTone: 'green' });
        viewHost.appendChild(ui.E('div', { 'class': 'sbd-grid' }, card));
    }

    async function loadConfig(name) {
        if (!name) throw new Error('没有可用的配置槽');
        setBusy(true);
        try {
            current = await api.configGet(name);
            draft = schemaForm.clone(current.parsed || {});
            slotSelect.value = current.name;
            dirty = false;
            validationText = '';
            view = 'hub';
                renderView();
        } finally { setBusy(false); }
    }

    async function createConfigFromFile(file, text) {
        if (!text.trim()) return ui.notify('配置文件为空', 'error');
        const targetName = (status && status.active) || 'config.yaml';
        const expected = (status && status.active_hash) || EMPTY_CONFIG_SHA;
        ctx.setBusy(true);
        try {
            const job = await api.submitConfig({
                action: 'save', target: targetName, expected, data: text
            });
            const compatibility = job && job.compatibility || {};
            await ctx.watchJob(job, '导入配置文件');
            await loadInitial();
            const apiInfo = (job && job.api) || (current && current.api) || null;
            const apiSummary = apiInfo && apiInfo.port
                ? '，Clash API 端口 ' + apiInfo.port
                : (apiInfo && apiInfo.endpoint ? '' : '，未启用 Clash API');
            const removed = Array.isArray(compatibility.removed) ? compatibility.removed.length : 0;
            const compatibilitySummary = removed
                ? '，已适配当前内核并去除 ' + removed + ' 个不兼容字段'
                : compatibility.converted ? '，已转换为当前内核支持的配置格式' : '';
            ui.notify('配置 ' + targetName + ' 已校验并导入' + apiSummary + compatibilitySummary,
                'success', 8000);
        } catch (error) {
            ui.notify('配置导入失败：' + api.errorText(error), 'error', 9000);
        } finally {
            ctx.setBusy(false);
        }
    }

    async function loadInitial() {
        viewHost.innerHTML = '';
        viewHost.appendChild(ui.loading('读取配置与 Schema'));
        try {
            status = ctx.status || await api.status(true);
            ctx.status = status;
            const requestedName = status.active || (status.slots[0] && status.slots[0].name);
            if (!requestedName) throw new Error('没有可用的配置槽');
            const cachedSchema = api.schemaCached(status.kernel_key);
            const schemaPromise = cachedSchema
                ? Promise.resolve(cachedSchema)
                : api.schema(status.kernel_key);
            const [bundle, initialSchema] = await Promise.all([
                api.configBundle(requestedName, status.kernel_key),
                schemaPromise
            ]);
            const schemaKey = bundle.kernel_key || status.kernel_key;
            schema = api.schemaCached(schemaKey) || initialSchema
                || await api.schema(schemaKey, true);
            const slots = bundle.slots || status.slots || [];
            slotSelect.innerHTML = '';
            slots.forEach(slot => slotSelect.appendChild(ui.E('option', {
                value: slot.name, selected: slot.active ? '' : null
            }, slot.name + (slot.active ? '（当前）' : ''))));
            current = bundle.config;
            draft = schemaForm.clone(current.parsed || {});
            slotSelect.value = current.name;
            backups = bundle.backups || [];
            subscription = bundle.subscription || { url: '', interval: 0, enabled: false };
            dirty = false;
            validationText = '';
            view = 'hub';
                renderView();
        } catch (error) {
            current = null;
            draft = {};
            dirty = false;
            slotSelect.innerHTML = '';
            toolbarHost.innerHTML = '';
            viewHost.innerHTML = '';
            viewHost.appendChild(components.errorCard('配置加载失败', api.errorText(error), loadInitial, {
                className: 'sbd-span-12', icon: 'config',
                hint: '可以选择已有的 YAML / JSON 配置文件导入，校验通过后会创建新的配置槽。',
                retryPrimary: false,
                actions: [ui.btn('导入配置文件', { icon: 'upload', variant: 'primary', onClick: () => importInput.click() })]
            }));
            updateSavebar();
        }
    }

    async function switchSlot() {
        if (!slotSelect.value || (current && slotSelect.value === current.name)) return;
        if (dirty) {
            const ok = await ui.confirm('切换配置槽', '当前修改尚未保存，切换后会丢失。', '切换');
            if (!ok) { slotSelect.value = current ? current.name : ''; return; }
        }
        try { await loadConfig(slotSelect.value); }
        catch (error) { ui.notify(api.errorText(error), 'error', 7000); }
    }

    async function reloadCurrent() {
        if (dirty) {
            const ok = await ui.confirm('放弃修改', '未保存的修改将丢失。', '重新载入');
            if (!ok) return;
        }
        try {
            await loadConfig(current ? current.name : slotSelect.value);
            ui.notify('配置已重新载入', 'success');
        } catch (error) { ui.notify(api.errorText(error), 'error', 7000); }
    }

    async function validateDraft() {
        if (view === 'advanced') {
            if (!rawEditor.value.trim()) return ui.notify('配置为空', 'error');
            setBusy(true);
            try {
                const result = await api.validateConfig(rawEditor.value, 'config');
                const removed = result && result.compatibility && Array.isArray(result.compatibility.removed)
                    ? result.compatibility.removed.length : 0;
                validationText = '校验通过 · ' + (result.outbounds || 0) + ' 出站 · '
                    + (result.rules || 0) + ' 规则' + (removed ? ' · 已适配 ' + removed + ' 个字段' : '');
                ui.notify('配置校验通过', 'success');
            } catch (error) {
                validationText = '校验失败';
                ui.notify(api.errorText(error), 'error', 7000);
            } finally { setBusy(false); }
            return;
        }
        setBusy(true);
        try {
            const result = await api.validateConfigObject(draft);
            validationText = '校验通过 · ' + (result.outbounds || 0) + ' 出站 · ' + (result.rules || 0) + ' 规则';
            ui.notify('配置校验通过', 'success');
        } catch (error) {
            validationText = '校验失败';
            ui.notify(api.errorText(error), 'error', 7000);
        } finally { setBusy(false); }
    }

    async function saveDraft(action) {
        if (!current || !dirty) return ui.notify('没有需要保存的修改', 'info');
        if (action === 'apply') {
            const ok = await ui.confirm('保存并应用', '将写入 ' + current.name + '，校验通过后重启 sing-box。', '应用');
            if (!ok) return;
        }
        setBusy(true);
        try {
            let job;
            if (view === 'advanced') {
                job = await api.submitConfig({
                    action, target: current.name, expected: current.hash,
                    data: rawEditor.value
                });
            } else {
                job = await api.submitConfigObject({
                    action, target: current.name, expected: current.hash, data: draft
                });
            }
            await ctx.watchJob(job, action === 'apply' ? '应用配置' : '保存配置');
            const name = current.name;
            await loadConfig(name);
            await loadBackups();
            if (action === 'apply') await ctx.refreshStatus().catch(() => {});
            ui.notify(action === 'apply' ? '配置已应用' : '配置已保存', 'success');
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 8000);
        } finally { setBusy(false); }
    }

    function leaveView() {
        if (dirty) {
            ui.confirm('返回配置中心', '未保存的修改将丢失。', '返回').then(ok => {
                if (!ok) return;
                dirty = false;
                view = 'hub';
                renderView();
            });
            return;
        }
        view = 'hub';
        renderView();
    }

    function subscriptionCard() {
        const input = ui.E('input', {
            'class': 'sbd-input', type: 'url', placeholder: 'https://example.com/subscribe',
            value: subscription.url || ''
        });
        const info = ui.E('div', { 'class': 'sbd-inline' }, [
            ui.E('span', { 'class': 'sbd-check-circle ' + (subscription.url ? 'checked' : '') }, ui.icon('check')),
            ui.badge(subscription.url ? '已配置订阅' : '未配置订阅', subscription.url ? 'blue' : ''),
            ui.badge(subscription.interval ? '自动更新：' + subscription.interval + ' 分钟' : '手动更新', subscription.interval ? 'green' : '')
        ]);
        async function saveAddress() {
            setBusy(true);
            try {
                subscription = await api.setSubscription(input.value.trim());
                ui.notify('订阅地址已保存', 'success');
                if (view === 'hub') renderHub();
            } catch (error) { ui.notify(api.errorText(error), 'error', 6000); }
            finally { setBusy(false); }
        }
        async function updateNow() {
            if (dirty) return ui.notify('请先保存当前修改', 'warn');
            setBusy(true);
            try {
                const result = await api.command('subscription-update');
                if (result.job) await ctx.watchJob(result.job, '更新订阅');
                else ui.notify(result.message || '订阅内容无变化', 'success');
                await loadConfig(current ? current.name : slotSelect.value);
                await loadBackups();
            } catch (error) { ui.notify(api.errorText(error), 'error', 7000); }
            finally { setBusy(false); }
        }
        return ui.card('远程订阅源', [
            ui.E('div', { 'class': 'sbd-stack' }, [
                info,
                ui.field('订阅 URL', input),
                ui.E('div', { 'class': 'sbd-btn-row' }, [
                    ui.btn('保存地址', { icon: 'save', onClick: saveAddress }),
                    ui.btn('立即同步', { icon: 'refresh', variant: 'primary', onClick: updateNow })
                ])
            ])
        ], { className: 'sbd-span-6', icon: 'link', iconTone: 'orange' });
    }

    function backupCard() {
        const body = ui.E('div', { 'class': 'sbd-backup-list' });
        if (!backups.length) body.appendChild(ui.empty('暂无配置备份'));
        backups.slice(0, 10).forEach(item => {
            body.appendChild(ui.row(item.slot || '配置快照', [
                api.formatDate(item.time), ' · ', api.formatBytes(item.size)
            ], [
                ui.btn('恢复', { icon: 'backup', small: true, onClick: () => restoreBackup(item) }),
                ui.btn('', {
                    icon: 'trash', iconOnly: true, small: true, variant: 'danger',
                    title: '删除此备份', onClick: () => deleteBackup(item)
                })
            ], { icon: 'backup', color: 'purple' }));
        });
        return ui.card('历史快照备份', [body], {
            className: 'sbd-span-6',
            icon: 'backup',
            iconTone: 'purple',
            subtitle: '最多保留 10 份，超出后自动删除最旧的快照',
            actions: [ui.btn('', { icon: 'refresh', iconOnly: true, title: '刷新备份', onClick: loadBackups })]
        });
    }

    async function loadBackups() {
        try { backups = (await api.command('backups')).backups || []; }
        catch (_) { backups = []; }
        if (view === 'hub') renderHub();
    }

    async function loadSubscription() {
        try { subscription = await api.subscriptionInfo(); }
        catch (_) { subscription = { url: '', interval: 0, enabled: false }; }
        if (view === 'hub') renderHub();
    }

    async function deleteBackup(item) {
        const ok = await ui.confirm('删除配置快照',
            '将永久删除 ' + api.formatDate(item.time) + ' 的 ' + (item.slot || '配置') +
            ' 快照。此操作不会影响当前活动配置。', '删除', true);
        if (!ok) return;
        setBusy(true);
        try {
            await api.deleteConfigBackup(item.name);
            ui.notify('配置快照已删除', 'success');
            await loadBackups();
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally { setBusy(false); }
    }

    async function restoreBackup(item) {
        setBusy(true);
        try {
            const target = await api.configGet(item.slot);
            const ok = await ui.confirm('恢复历史备份',
                '将 ' + item.slot + ' 恢复至 ' + api.formatDate(item.time) + ' 的备份版本。', '恢复');
            if (!ok) return;
            const job = await api.sendJson('submit', {
                action: 'restore', target: item.slot, expected: target.hash, backup: item.name
            }, 'restore-config');
            await ctx.watchJob(job, '恢复配置');
            await loadConfig(current && current.name === item.slot ? item.slot : current.name);
            await loadBackups();
        } catch (error) { ui.notify(api.errorText(error), 'error', 7000); }
        finally { setBusy(false); }
    }

    slotSelect.addEventListener('change', switchSlot);
    await loadInitial();
}

return baseclass.extend({ render });



