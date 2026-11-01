'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';
'require view.singbox-dash.v70.lib.components as components';
'require view.singbox-dash.v70.lib.rule-model as ruleModel';
'require view.singbox-dash.v70.lib.rule-editor as ruleEditor';

const {
    MATCH_FIELDS, FIELD_BY_KEY, SINGLE_FIELDS, CATEGORY_DEFS, ACTION_LABELS,
    clone, isObject, simpleRule, outboundMap, categoryOf, targetKey,
    targetLabel, matchLabel, ruleTitle, isCatchAll, splitValues,
    validateValues, buildRule, suggestionValues, safeJson
} = ruleModel;

async function render(host, ctx) {
    let status = ctx.status || null;
    let current = null;
    let draft = {};
    let outbounds = Object.create(null);
    let dirty = false;
    let busy = false;
    let validationText = '';
    let filter = 'all';
    let search = '';
    let loaded = false;

    const root = ui.E('div', { 'class': 'sbd-rules-page' });
    const toolbarHost = ui.E('div', { 'class': 'sbd-rules-toolbar-host' });
    const statsHost = ui.E('div', { 'class': 'sbd-rule-stats' });
    const pillsHost = ui.E('div', { 'class': 'sbd-filter-pills sbd-rule-pills' });
    const listHost = ui.E('div', { 'class': 'sbd-rule-list' });
    const slotSelect = ui.E('select', { 'class': 'sbd-select sbd-config-slot' });
    const activeBadge = ui.E('span', { 'class': 'sbd-inline' });
    const searchInput = ui.E('input', {
        type: 'search', 'class': 'sbd-input', placeholder: '搜索域名、IP、规则集或出站...',
        input: event => { search = String(event.target.value || '').trim().toLowerCase(); paint(); }
    });
    const addButton = ui.btn('新增规则', { icon: 'plus', variant: 'primary', onClick: () => openEditor(null) });
    const advancedButton = ui.btn('高级规则', { icon: 'terminal', onClick: () => openAdvanced(null) });
    const routeSettingsButton = ui.btn('路由设置', { icon: 'sliders', onClick: () => openRouteSettings() });
    const refreshButton = ui.btn('刷新', { icon: 'refresh', onClick: reloadCurrent });
    const validateButton = ui.btn('校验', { icon: 'shield', onClick: () => validateDraft() });
    const revertButton = ui.btn('放弃修改', { icon: 'refresh', onClick: reloadCurrent });
    const saveButton = ui.btn('保存', { icon: 'save', onClick: () => saveDraft('save') });
    const applyButton = ui.btn('保存并应用', { icon: 'check', variant: 'primary', onClick: () => saveDraft('apply') });
    const savebar = components.saveBar([validateButton, revertButton, saveButton, applyButton], {
        className: 'sbd-rule-savebar', emptyText: '加载规则', idleText: '规则已同步'
    });
    const controls = ui.E('div', { 'class': 'sbd-rules-controls' }, [
        ui.E('div', { 'class': 'sbd-rule-search' }, [ui.icon('search'), searchInput]),
        pillsHost
    ]);

    host.appendChild(root);
    root.appendChild(toolbarHost);
    root.appendChild(statsHost);
    root.appendChild(controls);
    root.appendChild(listHost);
    root.appendChild(savebar.node);

    const beforeUnload = event => {
        if (!dirty) return;
        event.preventDefault();
        event.returnValue = '';
        return '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    const leaveGuard = async () => {
        if (!dirty) return true;
        return ui.confirm('离开规则中心', '当前规则修改尚未保存，离开后会丢失。', '离开');
    };
    ctx.leaveGuard = leaveGuard;
    ctx.onCleanup(() => {
        window.removeEventListener('beforeunload', beforeUnload);
        if (ctx.leaveGuard === leaveGuard) ctx.leaveGuard = null;
    });

    function rules() {
        if (!isObject(draft.route)) draft.route = {};
        if (!Array.isArray(draft.route.rules)) draft.route.rules = [];
        return draft.route.rules;
    }

    function ruleSetTags() {
        const tags = [];
        (((draft.route || {}).rule_set) || []).forEach(item => {
            [].concat((item && item.tag) || []).forEach(tag => { if (tag) tags.push(String(tag)); });
        });
        return Array.from(new Set(tags));
    }

    function renderToolbar() {
        toolbarHost.innerHTML = '';
        activeBadge.innerHTML = '';
        if (current) {
            const active = current.active !== undefined ? current.active : !!(status && status.active === current.name);
            activeBadge.appendChild(ui.badge(active ? '当前' : '待用', active ? 'green' : ''));
            activeBadge.appendChild(ui.badge(rules().length + ' 条规则', ''));
            activeBadge.appendChild(ui.badge(ruleSetTags().length + ' 个规则集', ''));
            if (draft.route && draft.route.final) activeBadge.appendChild(ui.E('span', { 'class': 'sbd-badge orange' }, ui.nameWithFlags('最终出站：' + draft.route.final)));
        }
        toolbarHost.appendChild(ui.E('div', { 'class': 'sbd-config-toolbar sbd-rule-toolbar' }, [
            ui.E('div', { 'class': 'sbd-config-toolbar-main' }, [
                ui.E('label', { 'class': 'sbd-inline sbd-config-slot-wrap' }, [
                    ui.E('span', { 'class': 'sbd-field-label' }, '配置槽'), slotSelect
                ]),
                activeBadge
            ]),
            ui.E('div', { 'class': 'sbd-config-toolbar-actions' }, [addButton, advancedButton, routeSettingsButton, refreshButton])
        ]));
        addButton.disabled = busy || !current;
        advancedButton.disabled = busy || !current;
        routeSettingsButton.disabled = busy || !current;
        slotSelect.disabled = busy || !current;
    }

    function setBusy(value) {
        busy = !!value;
        components.setBusy(root, busy);
        if (ctx && typeof ctx.setBusy === 'function') ctx.setBusy(busy);
        renderToolbar();
        updateSavebar();
    }

    function updateSavebar() {
        savebar.update({ busy, dirty, validationText, available: !!current });
    }

    function markDirty(message) {
        dirty = true;
        validationText = message || '';
        updateSavebar();
        paint();
    }

    function counts() {
        const result = { all: 0, proxy: 0, direct: 0, block: 0, advanced: 0 };
        rules().forEach(rule => { result.all++; result[categoryOf(rule, outbounds)]++; });
        return result;
    }

    function renderStats() {
        const total = counts();
        statsHost.innerHTML = '';
        CATEGORY_DEFS.forEach(category => {
            statsHost.appendChild(ui.E('div', { 'class': 'sbd-rule-stat ' + category.id }, [
                ui.E('div', { 'class': 'sbd-rule-stat-icon ' + (category.tone || '') }, ui.icon(category.icon)),
                ui.E('div', {}, [
                    ui.E('div', { 'class': 'sbd-rule-stat-value' }, String(total[category.id])),
                    ui.E('div', { 'class': 'sbd-rule-stat-label' }, category.label)
                ])
            ]));
        });
    }

    function renderPills() {
        const total = counts();
        pillsHost.innerHTML = '';
        CATEGORY_DEFS.forEach(category => {
            pillsHost.appendChild(ui.E('button', {
                type: 'button', 'class': 'sbd-filter-pill ' + (filter === category.id ? 'active' : ''),
                click: () => { filter = category.id; paint(); }
            }, [ui.E('span', {}, category.label), ui.E('span', { 'class': 'sbd-rule-pill-count' }, String(total[category.id]))]));
        });
    }

    function matchesSearch(rule, index) {
        if (!search) return true;
        const simple = simpleRule(rule);
        const haystack = [
            String(index + 1), ruleTitle(rule, simple, index), targetLabel(rule, outbounds),
            matchLabel(rule), simple ? simple.values.join(' ') : '', safeJson(rule)
        ].join(' ').toLowerCase();
        return haystack.includes(search);
    }

    function categoryIcon(category) {
        return category === 'proxy' ? 'route' : category === 'direct' ? 'link'
            : category === 'block' ? 'shield' : 'sliders';
    }

    function chipNode(value) {
        const text = String(value);
        return ui.E('span', { 'class': 'sbd-rule-chip', title: text }, text.length > 62 ? text.slice(0, 60) + '…' : text);
    }

    function editRule(index) {
        const rule = rules()[index];
        if (simpleRule(rule)) openEditor(index);
        else openAdvanced(index);
    }

    function ruleRow(rule, index) {
        const simple = simpleRule(rule);
        const category = categoryOf(rule, outbounds);
        const categoryDef = CATEGORY_DEFS.find(item => item.id === category);
        const title = ruleTitle(rule, simple, index);
        const meta = matchLabel(rule) + ' · ' + targetLabel(rule, outbounds);
        const main = ui.E('div', { 'class': 'sbd-rule-main', role: 'button', tabindex: '0' }, [
            ui.E('div', { 'class': 'sbd-rule-title-line' }, [
                ui.E('span', { 'class': 'sbd-rule-title', title }, ui.nameWithFlags(title)),
                ui.badge(categoryDef.label, category === 'proxy' ? 'blue' : category === 'direct' ? 'green' : category === 'block' ? 'red' : 'purple'),
                simple && simple.values.length > 1 ? ui.badge('+' + (simple.values.length - 1)) : null
            ].filter(Boolean)),
            ui.E('div', { 'class': 'sbd-rule-meta' }, ui.nameWithFlags(meta)),
            ui.E('div', { 'class': 'sbd-rule-chips' }, simple
                ? simple.values.slice(0, 3).map(chipNode).concat(simple.values.length > 3 ? [ui.E('span', { 'class': 'sbd-rule-chip more' }, '还有 ' + (simple.values.length - 3) + ' 项')] : [])
                : [ui.E('span', { 'class': 'sbd-rule-chip advanced' }, matchLabel(rule)), ui.E('span', { 'class': 'sbd-rule-chip advanced' }, ACTION_LABELS[rule.action] || rule.action || '原始规则')])
        ]);
        main.addEventListener('click', () => editRule(index));
        main.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); editRule(index); }
        });
        const actions = ui.E('div', { 'class': 'sbd-rule-actions' }, [
            ui.btn('', { icon: 'arrowUp', iconOnly: true, small: true, variant: 'ghost', title: '上移', disabled: index === 0,
                onClick: () => moveRule(index, -1) }),
            ui.btn('', { icon: 'arrowDown', iconOnly: true, small: true, variant: 'ghost', title: '下移', disabled: index === rules().length - 1,
                onClick: () => moveRule(index, 1) }),
            ui.btn('', { icon: 'copy', iconOnly: true, small: true, variant: 'ghost', title: '复制规则',
                onClick: () => duplicateRule(index) }),
            ui.btn('', { icon: 'edit', iconOnly: true, small: true, variant: 'ghost', title: '编辑规则',
                onClick: () => editRule(index) }),
            ui.btn('', { icon: 'trash', iconOnly: true, small: true, variant: 'ghost', title: '删除规则',
                onClick: () => deleteRule(index) })
        ]);
        return ui.E('article', { 'class': 'sbd-rule-row ' + category }, [
            ui.E('div', { 'class': 'sbd-rule-order' }, '#' + (index + 1)),
            ui.E('div', { 'class': 'sbd-rule-icon ' + category }, ui.icon(categoryIcon(category))),
            main,
            actions
        ]);
    }

    function paint() {
        if (!loaded) return;
        renderToolbar();
        renderStats();
        renderPills();
        listHost.innerHTML = '';
        const allRules = rules();
        const visible = [];
        allRules.forEach((rule, index) => {
            if (filter !== 'all' && categoryOf(rule, outbounds) !== filter) return;
            if (!matchesSearch(rule, index)) return;
            visible.push([rule, index]);
        });
        if (!visible.length) {
            listHost.appendChild(ui.card('没有匹配的规则', [
                ui.empty(allRules.length ? '调整筛选条件或搜索关键词后重试' : '当前配置还没有路由规则')
            ], { icon: 'rules', iconTone: 'blue' }));
            updateSavebar();
            return;
        }
        visible.forEach(item => listHost.appendChild(ruleRow(item[0], item[1])));
        updateSavebar();
    }

    function moveRule(index, delta) {
        const target = index + delta;
        if (target < 0 || target >= rules().length) return;
        const list = rules();
        [list[index], list[target]] = [list[target], list[index]];
        markDirty('规则顺序已修改，尚未保存');
        ui.notify('已' + (delta < 0 ? '上移' : '下移') + '规则', 'success');
    }

    function catchAllPosition(list) {
        const catchAll = list.findIndex(isCatchAll);
        return catchAll >= 0 ? catchAll : list.length;
    }

    function insertRule(rule, index, placement) {
        const list = rules();
        if (index !== null && index !== undefined) {
            list[index] = rule;
            return index;
        }
        const position = placement === 'top' ? 0
            : placement === 'end' ? list.length
            : catchAllPosition(list);
        list.splice(position, 0, rule);
        return position;
    }

    function updateRuleAt(index, rule, placement) {
        const list = rules();
        if (!placement || placement === 'keep') {
            list[index] = rule;
            return index;
        }
        list.splice(index, 1);
        const position = placement === 'top' ? 0
            : placement === 'end' ? list.length
            : catchAllPosition(list);
        list.splice(position, 0, rule);
        return position;
    }

    function duplicateRule(index) {
        const list = rules();
        const copy = clone(list[index]);
        list.splice(index + 1, 0, copy);
        markDirty('规则已复制，尚未保存');
        ui.notify('已复制为第 #' + (index + 2) + ' 条规则', 'success');
    }

    async function deleteRule(index) {
        const rule = rules()[index];
        const simple = simpleRule(rule);
        const ok = await ui.confirm('删除规则', '删除 #' + (index + 1) + ' ' + ruleTitle(rule, simple, index) + '？此操作会在保存后生效。', '删除', true);
        if (!ok) return;
        rules().splice(index, 1);
        markDirty('已删除规则，尚未保存');
        ui.notify('规则已删除，保存后生效', 'success');
    }

    const editor = ruleEditor.create({
        isAvailable: () => !!current,
        getDraft: () => draft,
        rules,
        ruleSetTags,
        markDirty,
        insertRule,
        updateRuleAt
    });

    function openEditor(index) { return editor.openEditor(index); }
    function openAdvanced(index) { return editor.openAdvanced(index); }
    function openRouteSettings() { return editor.openRouteSettings(); }

    async function validateDraft() {
        if (!current || !dirty) return;
        setBusy(true);
        try {
            const result = await api.validateConfigObject(draft);
            validationText = '校验通过 · ' + (result.rules || rules().length) + ' 条规则';
            ui.notify('规则与配置校验通过', 'success');
        } catch (error) {
            validationText = '校验失败';
            ui.notify(api.errorText(error), 'error', 8000);
        } finally {
            setBusy(false);
        }
    }

    async function saveDraft(action) {
        if (!current || !dirty) return;
        if (action === 'apply') {
            const ok = await ui.confirm('保存并应用规则', '写入 ' + current.name + '，校验通过后重启 sing-box 使规则生效。', '应用');
            if (!ok) return;
        }
        const targetName = current.name;
        setBusy(true);
        try {
            const job = await api.submitConfigObject({ action, target: targetName, expected: current.hash, data: draft });
            if (job && job.id) await ctx.watchJob(job, action === 'apply' ? '应用路由规则' : '保存路由规则');
            await loadConfig(targetName);
            ui.notify(action === 'apply' ? '规则已保存并应用' : '规则已保存', 'success');
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 9000);
        } finally {
            setBusy(false);
        }
    }

    async function reloadCurrent() {
        if (!current) return;
        if (dirty) {
            const ok = await ui.confirm('放弃修改', '当前未保存的规则修改将丢失。', '重新载入');
            if (!ok) return;
        }
        try {
            await loadConfig(current.name);
            ui.notify('规则已重新载入', 'success');
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        }
    }

    async function loadConfig(name) {
        if (!name) throw new Error('没有可用的配置槽');
        setBusy(true);
        try {
            const config = await api.configGet(name);
            current = config;
            draft = clone(config.parsed || {});
            outbounds = outboundMap(draft);
            slotSelect.value = config.name;
            dirty = false;
            validationText = '';
            loaded = true;
            paint();
        } finally {
            setBusy(false);
        }
    }

    async function switchSlot() {
        if (!slotSelect.value || (current && slotSelect.value === current.name)) return;
        if (dirty) {
            const ok = await ui.confirm('切换配置槽', '当前修改尚未保存，切换后会丢失。', '切换');
            if (!ok) { slotSelect.value = current ? current.name : ''; return; }
        }
        try { await loadConfig(slotSelect.value); }
        catch (error) {
            slotSelect.value = current ? current.name : '';
            ui.notify(api.errorText(error), 'error', 7000);
        }
    }

    async function loadInitial() {
        listHost.innerHTML = '';
        listHost.appendChild(ui.loading('读取路由规则'));
        setBusy(true);
        try {
            status = ctx.status || await api.status(true);
            ctx.status = status;
            const requested = status.active || (status.slots && status.slots[0] && status.slots[0].name);
            if (!requested) throw new Error('没有可用的配置槽');
            const bundle = await api.configBundle(requested, status.kernel_key);
            const slots = bundle.slots || status.slots || [];
            slotSelect.innerHTML = '';
            slots.forEach(slot => slotSelect.appendChild(ui.E('option', {
                value: slot.name, selected: slot.active ? '' : null
            }, slot.name + (slot.active ? '（当前）' : ''))));
            current = bundle.config;
            draft = clone(current.parsed || {});
            outbounds = outboundMap(draft);
            slotSelect.value = current.name;
            dirty = false;
            validationText = '';
            loaded = true;
            paint();
        } catch (error) {
            loaded = false;
            listHost.innerHTML = '';
            listHost.appendChild(components.errorCard('规则中心加载失败', api.errorText(error), loadInitial, {
                icon: 'rules'
            }));
        } finally {
            setBusy(false);
        }
    }

    slotSelect.addEventListener('change', switchSlot);
    await loadInitial();
}

return baseclass.extend({ render });



