/* Rule editor modals separated from rule page lifecycle. */
'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.rule-model as ruleModel';

const {
    MATCH_FIELDS, FIELD_BY_KEY, SINGLE_FIELDS, ACTION_LABELS,
    clone, isObject, simpleRule, targetKey, targetLabel, matchLabel, ruleTitle,
    splitValues, validateValues, buildRule, suggestionValues, safeJson
} = ruleModel;

function create(env) {
    const {
        isAvailable, getDraft, rules, ruleSetTags, markDirty, insertRule, updateRuleAt
    } = env;

    function targetOptions(select, selected) {
        select.appendChild(ui.E('option', { value: '__direct', selected: selected === '__direct' ? '' : null }, '直连（direct）'));
        select.appendChild(ui.E('option', { value: '__reject', selected: selected === '__reject' ? '' : null }, '拦截（reject）'));
        const group = ui.E('optgroup', { label: '代理与自定义出站' });
        const seen = new Set();
        ((getDraft().outbounds) || []).forEach(item => {
            if (!item || !item.tag) return;
            const tag = String(item.tag);
            if (seen.has(tag)) return;
            seen.add(tag);
            group.appendChild(ui.E('option', { value: 'route::' + tag, selected: selected === 'route::' + tag ? '' : null },
                tag + (item.type ? ' · ' + item.type : '')));
        });
        if (selected && selected.indexOf('route::') === 0 && !seen.has(selected.slice(7))) {
            group.appendChild(ui.E('option', { value: selected, selected: '' }, selected.slice(7) + ' · 未找到出站'));
        }
        if (group.childNodes.length) select.appendChild(group);
    }

    function finalOptions(select, selected) {
        select.appendChild(ui.E('option', { value: '', selected: !selected ? '' : null }, '未设置'));
        const group = ui.E('optgroup', { label: '出站标签' });
        const seen = new Set();
        ((getDraft().outbounds) || []).forEach(item => {
            if (!item || !item.tag) return;
            const tag = String(item.tag);
            if (seen.has(tag)) return;
            seen.add(tag);
            group.appendChild(ui.E('option', { value: tag, selected: selected === tag ? '' : null },
                tag + (item.type ? ' · ' + item.type : '')));
        });
        if (selected && !seen.has(selected)) {
            group.appendChild(ui.E('option', { value: selected, selected: '' }, selected + ' · 未找到出站'));
        }
        if (group.childNodes.length) select.appendChild(group);
    }

    function fieldOptions(select, selected) {
        const groups = Object.create(null);
        MATCH_FIELDS.forEach(field => {
            if (!groups[field.group]) groups[field.group] = ui.E('optgroup', { label: field.group });
            groups[field.group].appendChild(ui.E('option', { value: field.key, selected: selected === field.key ? '' : null }, field.label + (field.common ? ' · 推荐' : '')));
        });
        Object.keys(groups).forEach(name => select.appendChild(groups[name]));
    }

    function defaultTarget() {
        const final = getDraft().route && getDraft().route.final;
        if (final && ((getDraft().outbounds || []).some(item => item && item.tag === final))) return 'route::' + final;
        const outbound = (getDraft().outbounds || []).find(item => item && item.tag && /selector|urltest|smart/i.test(String(item.type || '')))
            || (getDraft().outbounds || []).find(item => item && item.tag);
        return outbound ? 'route::' + outbound.tag : '__direct';
    }

    function valueControl(host, field, text, onChange) {
        host.innerHTML = '';
        const meta = FIELD_BY_KEY[field];
        const suggestions = suggestionValues(field, getDraft());
        const single = SINGLE_FIELDS.has(field);
        const control = single
            ? ui.E('input', {
                'class': 'sbd-input', type: 'text', value: text || '',
                placeholder: meta.placeholder || '填写一个匹配值'
            })
            : ui.E('textarea', {
                'class': 'sbd-textarea sbd-rule-values', spellcheck: 'false',
                placeholder: meta.placeholder || '每行填写一个匹配值'
            });
        if (!single) control.value = text || '';
        control.addEventListener('input', () => onChange(control.value));

        const guideRow = (label, value, code) => ui.E('div', { 'class': 'sbd-rule-guide-row' }, [
            ui.E('strong', {}, label),
            code ? ui.E('code', { 'class': 'sbd-rule-guide-code' }, value) : ui.E('span', {}, value)
        ]);
        host.appendChild(control);
        host.appendChild(ui.E('div', { 'class': 'sbd-rule-guide' }, [
            guideRow('作用', meta.summary || meta.hint, false),
            meta.example ? guideRow('示例', meta.example, true) : null,
            meta.note ? guideRow('注意', meta.note, false) : null
        ].filter(Boolean)));
        if (suggestions.length) {
            const chips = ui.E('div', { 'class': 'sbd-rule-suggestions' }, [
                ui.E('span', { 'class': 'sbd-rule-suggestions-label' }, '可用值（' + suggestions.length + '）')
            ]);
            const addSuggestion = value => {
                if (single) {
                    control.value = value;
                } else {
                    const current = splitValues(control.value);
                    if (!current.includes(value)) current.push(value);
                    control.value = current.join('\n');
                }
                control.dispatchEvent(new Event('input', { bubbles: true }));
                control.focus();
            };
            suggestions.slice(0, 12).forEach(value => {
                chips.appendChild(ui.E('button', {
                    type: 'button', 'class': 'sbd-rule-suggestion', click: () => addSuggestion(value)
                }, value));
            });
            const hidden = suggestions.slice(12);
            if (hidden.length) {
                const more = ui.E('button', {
                    type: 'button', 'class': 'sbd-rule-suggestion more',
                    click: () => {
                        hidden.forEach(value => chips.insertBefore(ui.E('button', {
                            type: 'button', 'class': 'sbd-rule-suggestion', click: () => addSuggestion(value)
                        }, value), more));
                        more.remove();
                    }
                }, '更多 +' + hidden.length);
                chips.appendChild(more);
            }
            host.appendChild(chips);
        }
        host.appendChild(ui.E('div', { 'class': 'sbd-rule-field-hint' }, meta.hint || ''));
    }

    function openEditor(index) {
        if (!isAvailable()) return;
        const existing = index === null || index === undefined ? null : rules()[index];
        const simple = existing ? simpleRule(existing) : null;
        if (existing && !simple) { openAdvanced(index); return; }
        const defaultField = ruleSetTags().length ? 'rule_set' : 'domain_suffix';
        const working = {
            target: existing ? targetKey(existing) : defaultTarget(),
            field: simple ? simple.field : defaultField,
            text: simple ? simple.values.join('\n') : ''
        };
        const fieldSelect = ui.E('select', { 'class': 'sbd-select' });
        fieldOptions(fieldSelect, working.field);
        const valuesHost = ui.E('div', { 'class': 'sbd-stack' });
        const targetSelect = ui.E('select', { 'class': 'sbd-select' });
        targetOptions(targetSelect, working.target);
        const positionSelect = ui.E('select', { 'class': 'sbd-select' }, [
            existing ? ui.E('option', { value: 'keep', selected: '' }, '保持当前位置') : null,
            ui.E('option', { value: 'safe', selected: existing ? null : '' }, '兜底规则之前（推荐）'),
            ui.E('option', { value: 'top' }, '列表顶部（最高优先）'),
            ui.E('option', { value: 'end' }, '列表末尾')
        ].filter(Boolean));
        const preview = ui.E('div', { 'class': 'sbd-rule-preview' });
        function refreshPreview() {
            const values = splitValues(working.text);
            const field = FIELD_BY_KEY[working.field];
            const target = working.target === '__direct' ? '直连' : working.target === '__reject' ? '拦截'
                : working.target.indexOf('route::') === 0 ? working.target.slice(7) : '未选择出站';
            preview.textContent = values.length
                ? '命中“' + field.label + '”中的 ' + values.slice(0, 3).join('、') + (values.length > 3 ? ' 等 ' + values.length + ' 项' : '') + ' → ' + target
                : '填写匹配值后显示最终分流结果';
        }
        valueControl(valuesHost, working.field, working.text, value => { working.text = value; refreshPreview(); });
        fieldSelect.addEventListener('change', () => {
            if (fieldSelect.value === working.field) return;
            working.field = fieldSelect.value;
            working.text = '';
            valueControl(valuesHost, working.field, working.text, value => { working.text = value; refreshPreview(); });
            refreshPreview();
        });
        targetSelect.addEventListener('change', () => { working.target = targetSelect.value; refreshPreview(); });
        refreshPreview();
        const content = ui.E('div', { 'class': 'sbd-stack sbd-rule-editor' }, [
            ui.note('一条可视化规则只匹配一个条件。需要“域名 + 端口”或多条件组合时，请使用高级规则。', 'info'),
            ui.field('匹配方式', fieldSelect, '常用匹配排在前面；规则集、域名和 IP 是最常用的三种方式。'),
            ui.field('匹配值', valuesHost),
            preview,
            ui.field('动作 / 出站', targetSelect, '选择直连、拦截，或将命中流量交给指定代理出站。'),
            ui.field('插入位置', positionSelect, existing ? '可保持当前位置，或把规则移动到新的优先级。' : '新规则默认放在兜底规则之前，避免被兜底条件提前截获。')
        ]);
        ui.modal(existing ? '编辑规则' : '新增规则', content, {
            subtitle: existing ? '#' + (index + 1) + ' · ' + matchLabel(existing) : '单条件可视化规则',
            cancelText: '取消', confirmText: existing ? '保存修改' : '添加规则', width: '680px',
            onConfirm: () => {
                const values = validateValues(working.field, working.text);
                if (working.field === 'rule_set') {
                    const known = new Set(ruleSetTags());
                    const missing = values.filter(value => !known.has(value));
                    if (missing.length) throw new Error('当前配置中不存在规则集：' + missing.join('、'));
                }
                if (working.field === 'inbound') {
                    const known = new Set((getDraft().inbounds || []).map(item => item && item.tag).filter(Boolean).map(String));
                    const missing = values.filter(value => !known.has(value));
                    if (missing.length) throw new Error('当前配置中不存在入站标签：' + missing.join('、'));
                }
                const rule = buildRule(working.target, working.field, values);
                const position = existing
                    ? updateRuleAt(index, rule, positionSelect.value)
                    : insertRule(rule, null, positionSelect.value);
                markDirty(existing ? '规则修改已加入待保存列表' : '新规则已添加，尚未保存');
                ui.notify(existing ? '规则已保存到 #' + (position + 1) : '新规则已加入 #' + (position + 1), 'success');
            }
        });
    }

    function openAdvanced(index) {
        if (!isAvailable()) return;
        const existing = index === null || index === undefined ? null : rules()[index];
        const defaultRoute = defaultTarget();
        const template = defaultRoute.indexOf('route::') === 0
            ? { action: 'route', outbound: defaultRoute.slice(7), domain_suffix: ['example.com'] }
            : defaultRoute === '__reject'
                ? { action: 'reject', domain_suffix: ['example.com'] }
                : { action: 'direct', domain_suffix: ['example.com'] };
        const initial = existing ? JSON.stringify(existing, null, 2) : JSON.stringify(template, null, 2);
        const editor = ui.E('textarea', { 'class': 'sbd-textarea sbd-schema-code sbd-rule-json', spellcheck: 'false' });
        editor.value = initial;
        const formatButton = ui.btn('格式化', { icon: 'sliders', onClick: () => {
            try { editor.value = JSON.stringify(JSON.parse(editor.value), null, 2); }
            catch (error) { ui.notify('JSON 格式错误：' + error.message, 'error'); }
        } });
        const content = ui.E('div', { 'class': 'sbd-stack' }, [
            ui.note('高级规则会保留全部字段。保存前仍会执行 sing-box 内核校验，失败不会写入。', 'info'),
            editor
        ]);
        ui.modal(existing ? '编辑高级规则' : '新增高级规则', content, {
            subtitle: existing ? '#' + (index + 1) + ' · 原始 JSON' : '多条件、逻辑规则或内核新字段',
            cancelText: '取消', confirmText: existing ? '保存修改' : '添加规则', width: '760px',
            extraActions: [formatButton],
            onConfirm: () => {
                let rule;
                try { rule = JSON.parse(editor.value); }
                catch (error) { throw new Error('JSON 格式错误：' + error.message); }
                if (!isObject(rule)) throw new Error('规则必须是一个 JSON 对象');
                const position = insertRule(rule, existing ? index : null);
                markDirty('高级规则已修改，尚未保存');
                ui.notify(existing ? '高级规则已更新' : '高级规则已加入 #' + (position + 1), 'success');
            }
        });
    }

    function openRouteSettings() {
        if (!isAvailable()) return;
        const route = isObject(getDraft().route) ? getDraft().route : {};
        const finalSelect = ui.E('select', { 'class': 'sbd-select' });
        finalOptions(finalSelect, String(route.final || ''));
        const ruleSetEditor = ui.E('textarea', {
            'class': 'sbd-textarea sbd-schema-code sbd-rule-json sbd-route-set-json',
            spellcheck: 'false'
        });
        ruleSetEditor.value = JSON.stringify(route.rule_set || [], null, 2);
        const extras = {};
        Object.keys(route).forEach(key => {
            if (!['rules', 'final', 'rule_set'].includes(key)) extras[key] = route[key];
        });
        const extrasEditor = ui.E('textarea', {
            'class': 'sbd-textarea sbd-schema-code sbd-route-options-json',
            spellcheck: 'false'
        });
        extrasEditor.value = JSON.stringify(extras, null, 2);
        const formatButton = ui.btn('格式化 JSON', { icon: 'sliders', onClick: () => {
            try {
                ruleSetEditor.value = JSON.stringify(JSON.parse(ruleSetEditor.value || '[]'), null, 2);
                extrasEditor.value = JSON.stringify(JSON.parse(extrasEditor.value || '{}'), null, 2);
            } catch (error) {
                ui.notify('JSON 格式错误：' + error.message, 'error');
            }
        } });
        const content = ui.E('div', { 'class': 'sbd-stack sbd-route-settings' }, [
            ui.field('最终出站', finalSelect, '所有规则都未命中时使用。只列出当前配置中的 outbound 标签。'),
            ui.field('规则集 JSON', ruleSetEditor, '维护 route.rule_set；支持内核的 local / remote 规则集完整字段。'),
            ui.field('其他路由选项 JSON', extrasEditor, '例如 default_domain_resolver、auto_detect_interface；rules、final、rule_set 请使用上方专用控件。'),
            ui.note('保存前会执行完整配置与内核校验，失败不会写入。', 'info')
        ]);
        ui.modal('路由设置', content, {
            subtitle: '规则集、最终出站与高级路由字段统一在此维护',
            cancelText: '取消', confirmText: '应用设置', width: '760px',
            extraActions: [formatButton],
            onConfirm: () => {
                let sets;
                let extra;
                try { sets = JSON.parse(ruleSetEditor.value || '[]'); }
                catch (error) { throw new Error('规则集 JSON 格式错误：' + error.message); }
                try { extra = JSON.parse(extrasEditor.value || '{}'); }
                catch (error) { throw new Error('其他路由选项 JSON 格式错误：' + error.message); }
                if (!Array.isArray(sets)) throw new Error('规则集必须是 JSON 数组');
                if (!isObject(extra)) throw new Error('其他路由选项必须是 JSON 对象');
                const reserved = ['rules', 'final', 'rule_set'].filter(key => Object.prototype.hasOwnProperty.call(extra, key));
                if (reserved.length) throw new Error('其他路由选项中不能包含：' + reserved.join(', '));
                const next = Object.assign({}, extra, {
                    rules: Array.isArray(route.rules) ? route.rules : []
                });
                if (finalSelect.value) next.final = finalSelect.value;
                if (sets.length) next.rule_set = sets;
                getDraft().route = next;
                markDirty('路由设置已修改，尚未保存');
                ui.notify('路由设置已加入待保存列表', 'success');
            }
        });
    }

    return { openEditor, openAdvanced, openRouteSettings };
}

return baseclass.extend({ create });
