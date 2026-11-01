'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.schema-model as schemaModel';

const {
    FIELD_LABELS, TOP_LEVEL_TITLES, PRIORITY_KEYS, clone, humanize, isPlainObject,
    resolveSchema, mergeSchema, expandVariants, schemaKind, objectVariants,
    variantType, variantLabel, chooseVariant, KIND_LABELS, variantLabelText,
    uniqueVariants, variantMatches, defaultVariantValue, getPath, setPath,
    deletePath, tagPool, defaultObject, controlValue, fieldLabel, fieldDescription, objectInfo
} = schemaModel;

function renderMixedUnion(schema, value, path, options) {
    const root = options.root;
    const variants = uniqueVariants(root, schema);
    if (!variants.length) return renderTextInput(schema, value, path, options, false);
    let selected = variants.findIndex(item => variantMatches(root, item, value));
    if (selected < 0) selected = 0;
    const select = ui.E('select', { 'class': 'sbd-select sbd-union-mode' },
        variants.map((item, index) => ui.E('option', { value: String(index), selected: index === selected ? '' : null },
            variantLabelText(root, item))));
    const host = ui.E('div', { 'class': 'sbd-union-value' });
    const wrap = ui.E('div', { 'class': 'sbd-mixed-union' }, [
        ui.E('div', { 'class': 'sbd-union-head' }, [
            ui.E('span', { 'class': 'sbd-field-label' }, 'Jenis data'), select
        ]),
        host
    ]);

    function draw() {
        host.innerHTML = '';
        const variant = variants[selected];
        if (!variant) return;
        const kind = schemaKind(root, variant);
        const current = getPath(options.draft, path);
        if (kind === 'object') {
            renderObjectFields(host, variant, isPlainObject(current) ? current : {}, path,
                Object.assign({}, options, { omitType: true, required: (variant.required || []) }));
        } else if (kind === 'array') {
            host.appendChild(renderArrayEditor(variant, current, path, options));
        } else if (kind === 'boolean') {
            host.appendChild(renderSwitch(variant, current, path, options));
        } else if ((kind === 'integer' || kind === 'number') && variant.enum) {
            host.appendChild(renderEnum(variant, current, path, options));
        } else if (kind === 'integer' || kind === 'number') {
            host.appendChild(renderNumber(variant, current, path, options));
        } else if (variant.enum) {
            host.appendChild(renderEnum(variant, current, path, options));
        } else {
            const multi = /(pem|certificate|private key|证书|私钥)/i.test(variant.description || '')
                || variant.format === 'multiline';
            host.appendChild(renderTextInput(variant, current, path, options, multi));
        }
    }

    select.addEventListener('change', () => {
        selected = Number(select.value) || 0;
        const next = defaultVariantValue(root, variants[selected], options);
        if (next === undefined) deletePath(options.draft, path);
        else setPath(options.draft, path, next);
        markChange(options);
        draw();
    });
    draw();
    return wrap;
}

function renderJsonEditor(schema, value, path, options) {
    const input = ui.E('textarea', { 'class': 'sbd-textarea sbd-schema-code' });
    input.value = value === undefined ? '' : JSON.stringify(value, null, 2);
    const commit = () => {
        const raw = String(input.value || '').trim();
        if (!raw) deletePath(options.draft, path);
        else {
            try { setPath(options.draft, path, JSON.parse(raw)); }
            catch (_) { ui.notify('Format JSON tidak valid', 'error'); return; }
        }
        markChange(options);
    };
    input.addEventListener('change', commit);
    return input;
}

function renderMixedArray(schema, value, path, options, itemVariants) {
    const items = Array.isArray(value) ? value.slice() : [];
    const wrap = ui.E('div', { 'class': 'sbd-object-list sbd-mixed-array' });
    const rows = ui.E('div', { 'class': 'sbd-object-rows' });
    function commit() {
        if (!items.length) deletePath(options.draft, path);
        else setPath(options.draft, path, items);
        markChange(options);
    }
    function itemInfo(item) {
        const variant = itemVariants.find(entry => variantMatches(options.root, entry, item)) || itemVariants[0];
        let preview = '';
        try { preview = typeof item === 'string' ? item : JSON.stringify(item); }
        catch (_) { preview = String(item); }
        if (preview && preview.length > 120) preview = preview.slice(0, 120) + '…';
        return { title: variant ? variantLabelText(options.root, variant) : 'Nilai', preview };
    }
    function open(item, index) {
        let selected = itemVariants.findIndex(entry => variantMatches(options.root, entry, item));
        if (selected < 0) selected = 0;
        const local = { value: item === undefined ? defaultVariantValue(options.root, itemVariants[selected], options) : clone(item) };
        const typeSelect = itemVariants.length > 1
            ? ui.E('select', { 'class': 'sbd-select' }, itemVariants.map((entry, idx) =>
                ui.E('option', { value: String(idx), selected: idx === selected ? '' : null }, variantLabelText(options.root, entry))))
            : null;
        const editorHost = ui.E('div', { 'class': 'sbd-stack' });
        function draw() {
            editorHost.innerHTML = '';
            const variant = itemVariants[selected];
            if (!variant) return;
            const localOptions = Object.assign({}, options, {
                draft: local, required: ['value'], onChange: () => {}, rerender: draw
            });
            editorHost.appendChild(renderField('Nilai', variant, local.value, ['value'], localOptions));
        }
        if (typeSelect) {
            typeSelect.addEventListener('change', () => {
                selected = Number(typeSelect.value) || 0;
                local.value = defaultVariantValue(options.root, itemVariants[selected], options);
                draw();
            });
        }
        draw();
        ui.modal(index === undefined ? 'Tambah item daftar' : 'Edit item daftar', ui.E('div', { 'class': 'sbd-stack' }, [
            typeSelect ? ui.field('Jenis', typeSelect) : null,
            editorHost
        ].filter(Boolean)), {
            subtitle: index === undefined ? '' : itemInfo(item).title,
            cancelText: 'Batal', confirmText: index === undefined ? 'Tambah' : 'Simpan', width: '620px',
            onConfirm: () => {
                if (index === undefined) items.push(clone(local.value));
                else items[index] = clone(local.value);
                commit();
                options.rerender();
            }
        });
    }
    function draw() {
        rows.innerHTML = '';
        if (!items.length) rows.appendChild(ui.E('div', { 'class': 'sbd-schema-empty' }, 'Belum ada item'));
        items.forEach((item, index) => {
            const info = itemInfo(item);
            const up = ui.btn('', { icon: 'chevron', iconOnly: true, variant: 'ghost', title: 'Pindahkan ke atas', disabled: index === 0, onClick: () => {
                [items[index - 1], items[index]] = [items[index], items[index - 1]];
                commit(); draw();
            } });
            up.classList.add('sbd-rotate-up');
            rows.appendChild(ui.E('div', { 'class': 'sbd-object-row' }, [
                ui.E('div', { 'class': 'sbd-object-main' }, [
                    ui.E('div', { 'class': 'sbd-object-title' }, info.title),
                    info.preview ? ui.E('div', { 'class': 'sbd-object-sub' }, info.preview) : null
                ].filter(Boolean)),
                ui.E('div', { 'class': 'sbd-object-actions' }, [
                    up,
                    ui.btn('Edit', { icon: 'edit', small: true, onClick: () => open(clone(item), index) }),
                    ui.btn('', { icon: 'trash', iconOnly: true, variant: 'ghost', title: 'Hapus', onClick: () => {
                        items.splice(index, 1); commit(); draw();
                    } })
                ])
            ]));
        });
        rows.appendChild(ui.E('div', { 'class': 'sbd-schema-add' }, ui.btn('Tambah item', {
            icon: 'plus', variant: 'primary', small: true, disabled: !itemVariants.length,
            onClick: () => open(undefined, undefined)
        })));
    }
    draw();
    wrap.appendChild(rows);
    return wrap;
}

function renderArrayEditor(schema, value, path, options) {
    const itemSchema = resolveSchema(options.root, schema.items || {});
    const itemVariants = uniqueVariants(options.root, itemSchema);
    const kinds = Array.from(new Set(itemVariants.map(item => schemaKind(options.root, item))));
    if (!itemVariants.length) return renderJsonEditor(schema, value, path, options);
    if (kinds.length === 1 && kinds[0] === 'object')
        return renderObjectArray(schema, value, path, options);
    if (kinds.length === 1 && ['string', 'integer', 'number'].includes(kinds[0]))
        return renderPrimitiveArray(schema, value, path, options, kinds[0] === 'integer' || kinds[0] === 'number');
    return renderMixedArray(schema, value, path, options, itemVariants);
}

function markChange(options) {
    if (options && typeof options.onChange === 'function') options.onChange();
}
function renderSwitch(schema, value, path, options) {
    const required = (options.required || []).includes(path[path.length - 1]);
    const absent = value === undefined || value === null;
    if (!required) {
        const select = ui.E('select', { 'class': 'sbd-select' }, [
            ui.E('option', { value: '' }, 'Default'),
            ui.E('option', { value: 'true' }, 'Aktif'),
            ui.E('option', { value: 'false' }, 'Nonaktif')
        ]);
        select.value = absent ? '' : String(!!value);
        select.addEventListener('change', () => {
            if (select.value === '') deletePath(options.draft, path);
            else setPath(options.draft, path, select.value === 'true');
            markChange(options);
        });
        return select;
    }
    const input = ui.E('input', { type: 'checkbox' });
    input.checked = !!value;
    input.addEventListener('change', () => { setPath(options.draft, path, input.checked); markChange(options); });
    return ui.E('label', { 'class': 'sbd-switch' }, [input, ui.E('span')]);
}

function renderEnum(schema, value, path, options) {
    const select = ui.E('select', { 'class': 'sbd-select' });
    if (!(options.required || []).includes(path[path.length - 1])) {
        select.appendChild(ui.E('option', { value: '' }, 'Default'));
    }
    (schema.enum || []).forEach(item => select.appendChild(ui.E('option', { value: String(item) }, String(item))));
    select.value = value === undefined || value === null ? '' : String(value);
    select.addEventListener('change', () => {
        if (select.value === '') deletePath(options.draft, path);
        else setPath(options.draft, path, schema.type === 'integer' || schema.type === 'number'
            ? Number(select.value) : select.value);
        markChange(options);
    });
    return select;
}

function renderTextInput(schema, value, path, options, multi) {
    const reference = schema['x-tag-reference'] || '';
    if (reference && !multi) {
        const input = ui.E('input', {
            'class': 'sbd-input', type: 'text', placeholder: reference + ' tag',
            value: controlValue(schema, value)
        });
        const list = ui.E('datalist', { id: 'sbd-ref-' + (++controlId) });
        tagPool(options, reference).forEach(tag => list.appendChild(ui.E('option', { value: tag })));
        input.setAttribute('list', list.id);
        input.addEventListener('change', () => {
            const next = input.value.trim();
            if (!next) deletePath(options.draft, path); else setPath(options.draft, path, next);
            markChange(options);
        });
        return ui.E('div', { 'class': 'sbd-schema-datalist' }, [input, list]);
    }
    const attrs = {
        'class': multi ? 'sbd-textarea sbd-schema-code' : 'sbd-input',
        value: controlValue(schema, value), spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off'
    };
    if (schema.format === 'password') attrs.type = 'password';
    const input = ui.E(multi ? 'textarea' : 'input', attrs);
    const commit = () => {
        const next = String(input.value || '');
        if (!next.trim()) deletePath(options.draft, path); else setPath(options.draft, path, next);
        markChange(options);
    };
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    return input;
}

function renderNumber(schema, value, path, options) {
    const input = ui.E('input', {
        'class': 'sbd-input', type: 'number',
        value: value === undefined || value === null ? '' : String(value),
        min: schema.minimum !== undefined ? String(schema.minimum) : null,
        max: schema.maximum !== undefined ? String(schema.maximum) : null,
        step: schema.type === 'integer' ? '1' : 'any'
    });
    input.addEventListener('change', () => {
        if (input.value === '') deletePath(options.draft, path);
        else setPath(options.draft, path, Number(input.value));
        markChange(options);
    });
    return input;
}

function renderPrimitiveArray(schema, value, path, options, numeric) {
    const items = Array.isArray(value) ? value.slice() : [];
    const wrap = ui.E('div', { 'class': 'sbd-chip-editor' });
    const chips = ui.E('div', { 'class': 'sbd-chips' });
    const input = ui.E('input', {
        'class': 'sbd-input', type: numeric ? 'number' : 'text',
        placeholder: numeric ? 'Masukkan angka lalu tekan Enter atau klik tambah' : 'Masukkan nilai lalu tekan Enter atau klik tambah'
    });
    const itemSchema = resolveSchema(options.root, schema.items || {});
    const reference = itemSchema['x-tag-reference'] || '';
    let list = null;
    if (reference) {
        list = ui.E('datalist', { id: 'sbd-array-ref-' + (++controlId) });
        tagPool(options, reference).forEach(tag => list.appendChild(ui.E('option', { value: tag })));
        input.setAttribute('list', list.id);
    }
    function commit() {
        if (!items.length) deletePath(options.draft, path);
        else setPath(options.draft, path, items);
        markChange(options);
    }
    function redraw() {
        chips.innerHTML = '';
        items.forEach((item, index) => {
            const remove = ui.E('button', { type: 'button', 'class': 'sbd-chip-x', title: 'Hapus' }, '×');
            remove.addEventListener('click', () => { items.splice(index, 1); commit(); redraw(); });
            chips.appendChild(ui.E('span', { 'class': 'sbd-chip' }, [ui.E('span', {}, String(item)), remove]));
        });
        if (!items.length) chips.appendChild(ui.E('span', { 'class': 'sbd-chip-empty' }, 'Belum diatur'));
    }
    function add() {
        const raw = String(input.value || '').trim();
        if (!raw) return;
        const next = numeric ? Number(raw) : raw;
        if (!items.includes(next)) items.push(next);
        input.value = '';
        commit();
        redraw();
    }
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
    wrap.appendChild(chips);
    wrap.appendChild(ui.E('div', { 'class': 'sbd-chip-add' }, [
        input, list, ui.btn('Tambah', { icon: 'plus', small: true, onClick: add })
    ].filter(Boolean)));
    redraw();
    return wrap;
}

function renderFieldRow(label, description, control, options) {
    const vertical = control && control.matches && control.matches('textarea, .sbd-object-list, .sbd-map-editor, .sbd-mixed-union');
    const copy = ui.E('div', { 'class': 'sbd-schema-field-copy' }, [
        ui.E('div', { 'class': 'sbd-schema-field-label' }, [
            ui.E('span', {}, label),
            options && options.required ? ui.E('span', { 'class': 'sbd-required' }, '*') : null
        ].filter(Boolean)),
        description ? ui.E('div', { 'class': 'sbd-schema-field-desc' }, description) : null
    ].filter(Boolean));
    return ui.E('div', { 'class': 'sbd-schema-field' + (vertical ? ' vertical' : '') }, [copy, control]);
}

function renderMapEditor(schema, value, path, options) {
    const object = isPlainObject(value) ? clone(value) : {};
    const wrap = ui.E('div', { 'class': 'sbd-map-editor' });
    const rows = ui.E('div', { 'class': 'sbd-map-rows' });
    const valueSchema = schema.additionalProperties && typeof schema.additionalProperties === 'object'
        ? resolveSchema(options.root, schema.additionalProperties) : null;
    const keySchema = schema.propertyNames ? resolveSchema(options.root, schema.propertyNames) : null;
    const keyEnum = keySchema && Array.isArray(keySchema.enum) ? keySchema.enum.map(String) : [];
    const keyPattern = keySchema && keySchema.pattern ? keySchema.pattern : '';
    function commit() {
        if (!Object.keys(object).length) deletePath(options.draft, path);
        else setPath(options.draft, path, object);
        markChange(options);
    }
    function edit(key) {
        const keyInput = ui.E('input', { 'class': 'sbd-input', type: 'text', placeholder: 'Nama kunci', value: key || '' });
        let keyList = null;
        if (keyEnum.length) {
            keyList = ui.E('datalist', { id: 'sbd-map-key-' + (++controlId) });
            keyEnum.forEach(item => keyList.appendChild(ui.E('option', { value: item })));
            keyInput.setAttribute('list', keyList.id);
        }
        const local = { value: key ? clone(object[key]) : undefined };
        const valueHost = ui.E('div', { 'class': 'sbd-stack' });
        const freeValue = ui.E('textarea', { 'class': 'sbd-textarea sbd-schema-code', placeholder: 'Nilai JSON atau teks' });
        if (!valueSchema) {
            const current = local.value;
            freeValue.value = current === undefined ? '' : (typeof current === 'string' ? current : JSON.stringify(current, null, 2));
        }
        function drawValue() {
            valueHost.innerHTML = '';
            if (valueSchema) {
                valueHost.appendChild(renderField('Nilai', valueSchema, local.value, ['value'],
                    Object.assign({}, options, { draft: local, onChange: () => {}, rerender: drawValue })));
            } else {
                valueHost.appendChild(ui.field('Nilai', freeValue));
            }
        }
        drawValue();
        const hint = keyEnum.length ? 'Kunci yang dapat dipilih: ' + keyEnum.join(' / ')
            : keyPattern ? 'Format kunci: ' + keyPattern : '';
        ui.modal(key ? 'Edit pasangan kunci-nilai' : 'Tambah pasangan kunci-nilai', ui.E('div', { 'class': 'sbd-stack' }, [
            ui.field('Kunci', keyInput, hint),
            keyList,
            valueHost
        ].filter(Boolean)), {
            cancelText: 'Batal', confirmText: 'Simpan', width: '560px',
            onConfirm: () => {
                const nextKey = keyInput.value.trim();
                if (!nextKey) throw new Error('Nama kunci tidak boleh kosong');
                if (keyEnum.length && !keyEnum.includes(nextKey))
                    throw new Error('Kunci harus berupa salah satu dari: ' + keyEnum.join(' / '));
                if (keyPattern) {
                    try {
                        if (!new RegExp(keyPattern).test(nextKey)) throw new Error();
                    } catch (_) { throw new Error('Format kunci tidak sesuai'); }
                }
                if (nextKey !== key && Object.prototype.hasOwnProperty.call(object, nextKey))
                    throw new Error('Nama kunci sudah ada');
                if (nextKey !== key) delete object[key];
                if (!valueSchema) {
                    const raw = freeValue.value.trim();
                    if (!raw) delete object[nextKey];
                    else {
                        try { object[nextKey] = JSON.parse(raw); }
                        catch (_) { object[nextKey] = raw; }
                    }
                } else if (local.value === undefined) {
                    delete object[nextKey];
                } else {
                    object[nextKey] = clone(local.value);
                }
                commit();
                options.rerender();
            }
        });
    }
    function draw() {
        rows.innerHTML = '';
        const entries = Object.entries(object);
        if (!entries.length) rows.appendChild(ui.E('div', { 'class': 'sbd-schema-empty' }, 'Belum ada item'));
        entries.forEach(([key, item]) => {
            rows.appendChild(ui.E('div', { 'class': 'sbd-map-row' }, [
                ui.E('div', { 'class': 'sbd-map-key' }, key),
                ui.E('div', { 'class': 'sbd-map-value' }, typeof item === 'string' ? item : JSON.stringify(item)),
                ui.E('div', { 'class': 'sbd-map-actions' }, [
                    ui.btn('Edit', { icon: 'edit', small: true, onClick: () => edit(key) }),
                    ui.btn('', { icon: 'trash', iconOnly: true, variant: 'ghost', title: 'Hapus', onClick: () => {
                        delete object[key]; commit(); draw();
                    } })
                ])
            ]));
        });
        rows.appendChild(ui.E('div', { 'class': 'sbd-schema-add' }, ui.btn('Tambah item', { icon: 'plus', small: true, onClick: () => edit('') })));
    }
    draw();
    wrap.appendChild(rows);
    return wrap;
}

function renderObjectField(label, schema, value, path, options) {
    const hasValue = isPlainObject(value);
    const details = ui.E('details', { 'class': 'sbd-schema-object' }, ui.E('summary', {
        'class': 'sbd-schema-object-head'
    }, [
        ui.E('span', { 'class': 'sbd-schema-object-title' }, label),
        ui.E('span', { 'class': 'sbd-schema-object-hint' }, hasValue ? Object.keys(value).length + ' item' : 'Belum dikonfigurasi')
    ]));
    const body = ui.E('div', { 'class': 'sbd-schema-object-body' });
    details.appendChild(body);
    if (!hasValue) {
        details.appendChild(ui.E('div', { 'class': 'sbd-schema-add' }, ui.btn('Aktifkan konfigurasi', {
            icon: 'plus', small: true, onClick: () => { setPath(options.draft, path, {}); markChange(options); options.rerender(); }
        })));
    } else {
        renderObjectFields(body, schema, value, path, options);
    }
    return details;
}

function renderObjectFields(host, schema, value, path, options) {
    const info = objectInfo(options.root, schema);
    const required = info.required || [];
    const main = [];
    const advanced = [];
    Object.entries(info.properties).forEach(([key, property]) => {
        if (key === 'type' && options.omitType) return;
        const resolvedProperty = resolveSchema(options.root, property);
        if (resolvedProperty && resolvedProperty['x-sbd-unsupported']) return;
        const missingTags = (options.root && options.root['x-sbd-missing-tags']) || [];
        const fieldTags = { v2ray_api: 'with_v2ray_api', clash_api: 'with_clash_api', utls: 'with_utls' };
        if (fieldTags[key] && missingTags.includes(fieldTags[key])) return;
        const propertyVariants = uniqueVariants(options.root, property);
        const complex = propertyVariants.some(item => ['object', 'array'].includes(schemaKind(options.root, item)));
        const priority = PRIORITY_KEYS.has(key) || required.includes(key);
        const childOptions = Object.assign({}, options, { required });
        const node = renderField(key, property, getPath(options.draft, path.concat(key)), path.concat(key), childOptions);
        if (complex || priority) main.push(node); else advanced.push(node);
    });
    if (!main.length && !advanced.length) host.appendChild(ui.E('div', { 'class': 'sbd-schema-empty' }, 'Tidak ada kolom yang dapat diedit'));
    main.forEach(node => host.appendChild(node));
    if (advanced.length) {
        const details = ui.E('details', { 'class': 'sbd-schema-advanced' }, [
            ui.E('summary', {}, 'Opsi lainnya (' + advanced.length + ')')
        ]);
        advanced.forEach(node => details.appendChild(node));
        host.appendChild(details);
    }
}

function renderVariantObject(schema, value, path, options) {
    const variants = objectVariants(options.root, schema);
    const draft = isPlainObject(value) ? clone(value) : {};
    const variant = chooseVariant(options.root, variants, draft);
    const wrap = ui.E('div', { 'class': 'sbd-variant-editor' });
    if (variants.length > 1) {
        const select = ui.E('select', { 'class': 'sbd-select' }, variants.map(item =>
            ui.E('option', { value: variantLabel(options.root, item), selected: item === variant ? '' : null }, variantLabel(options.root, item))
        ));
        select.addEventListener('change', () => {
            const chosen = variants[select.selectedIndex] || variants[0];
            const next = defaultObject(options.root, chosen, options);
            setPath(options.draft, path, next);
            markChange(options);
            options.rerender();
        });
        wrap.appendChild(ui.field('Jenis', select));
    }
    const body = ui.E('div', {});
    renderObjectFields(body, variant || schema, draft, path, Object.assign({}, options, {
        omitType: true, required: (variant && variant.required) || []
    }));
    wrap.appendChild(body);
    return wrap;
}

function renderObjectArray(schema, value, path, options) {
    const items = Array.isArray(value) ? value.slice() : [];
    const variants = objectVariants(options.root, schema.items || schema);
    const wrap = ui.E('div', { 'class': 'sbd-object-list' });
    const rows = ui.E('div', { 'class': 'sbd-object-rows' });
    function commit() {
        if (!items.length) deletePath(options.draft, path);
        else setPath(options.draft, path, items);
        markChange(options);
    }
    const isRuleList = path[path.length - 1] === 'rules';
    function itemTitle(item, index) {
        if (isRuleList) {
            const target = item && (item.action || item.outbound || item.rule_set || item.domain
                || item.domain_suffix || item.ip_cidr || item.protocol || item.type);
            return 'Aturan #' + (index + 1) + (target ? ' · ' + String(target) : '');
        }
        const variant = chooseVariant(options.root, variants, item || {});
        const type = item && item.type || variantType(options.root, variant) || 'Item';
        return type + (item && item.tag ? ' · ' + item.tag : '');
    }
    function itemSubtitle(item) {
        if (!isPlainObject(item)) return '';
        if (isRuleList) {
            const parts = [];
            ['inbound', 'protocol', 'domain', 'domain_suffix', 'domain_keyword', 'ip_cidr', 'port', 'port_range'].forEach(key => {
                if (item[key] === undefined || item[key] === null || item[key] === '') return;
                parts.push(Array.isArray(item[key]) ? item[key].join(', ') : String(item[key]));
            });
            return parts.join(' · ');
        }
        return [item.listen_port ? 'Port ' + item.listen_port : '', item.server || '', item.path || ''].filter(Boolean).join(' · ');
    }
    function open(item, index) {
        const working = clone(item || defaultObject(options.root, variants[0], options));
        const host = ui.E('div', { 'class': 'sbd-schema-modal-body' });
        const editorHost = ui.E('div', {});
        const typeSelect = variants.length > 1 ? ui.E('select', { 'class': 'sbd-select' }, variants.map((variant, idx) =>
            ui.E('option', { value: String(idx), selected: variant === chooseVariant(options.root, variants, working) ? '' : null }, variantLabel(options.root, variant))
        )) : null;
        function draw() {
            editorHost.innerHTML = '';
            const variant = typeSelect ? variants[Number(typeSelect.value)] : variants[0];
            renderObjectFields(editorHost, variant || schema, working, [], Object.assign({}, options, {
                draft: working, omitType: true, required: (variant && variant.required) || [],
                rerender: draw, onChange: () => {}
            }));
        }
        if (typeSelect) {
            typeSelect.addEventListener('change', () => {
                const variant = variants[Number(typeSelect.value)];
                const next = defaultObject(options.root, variant, options);
                Object.keys(working).forEach(key => delete working[key]);
                Object.assign(working, next);
                draw();
            });
            host.appendChild(ui.field('Jenis', typeSelect));
        }
        host.appendChild(editorHost);
        draw();
        ui.modal(index === undefined ? 'Tambah item' : 'Edit item', host, {
            subtitle: index === undefined ? '' : itemTitle(working, index),
            cancelText: 'Batal',
            confirmText: index === undefined ? 'Tambah' : 'Simpan',
            width: '660px',
            onConfirm: () => {
                if (index === undefined) items.push(working); else items[index] = working;
                commit();
                options.rerender();
            }
        });
    }
    function draw() {
        rows.innerHTML = '';
        if (!items.length) rows.appendChild(ui.E('div', { 'class': 'sbd-schema-empty' }, 'Belum ada item'));
        items.forEach((item, index) => {
            const up = ui.btn('', { icon: 'chevron', iconOnly: true, variant: 'ghost', title: 'Pindahkan ke atas', disabled: index === 0, onClick: () => {
                [items[index - 1], items[index]] = [items[index], items[index - 1]]; commit(); draw();
            } });
            up.classList.add('sbd-rotate-up');
            rows.appendChild(ui.E('div', { 'class': 'sbd-object-row' }, [
                ui.E('div', { 'class': 'sbd-object-main' }, [
                    ui.E('div', { 'class': 'sbd-object-title' }, itemTitle(item, index)),
                    itemSubtitle(item) ? ui.E('div', { 'class': 'sbd-object-sub' }, itemSubtitle(item)) : null
                ].filter(Boolean)),
                ui.E('div', { 'class': 'sbd-object-actions' }, [
                    up,
                    ui.btn('Edit', { icon: 'edit', small: true, onClick: () => open(clone(item), index) }),
                    ui.btn('', { icon: 'trash', iconOnly: true, variant: 'ghost', title: 'Hapus', onClick: () => {
                        items.splice(index, 1); commit(); draw();
                    } })
                ])
            ]));
        });
        rows.appendChild(ui.E('div', { 'class': 'sbd-schema-add' }, ui.btn('Tambah item', {
            icon: 'plus', variant: 'primary', small: true, disabled: !variants.length, onClick: () => open(undefined, undefined)
        })));
    }
    draw();
    wrap.appendChild(rows);
    return wrap;
}

function renderField(key, property, value, path, options) {
    const root = options.root;
    const schema = resolveSchema(root, property);
    const label = fieldLabel(key, schema);
    const description = fieldDescription(schema);
    const required = (options.required || []).includes(key);
    const variants = uniqueVariants(root, schema);
    const kinds = Array.from(new Set(variants.map(item => schemaKind(root, item, value))));
    const kind = kinds[0] || schemaKind(root, schema, value);
    const objectChoices = variants.filter(item => schemaKind(root, item) === 'object');

    if (kinds.length > 1) {
        return renderFieldRow(label, description, renderMixedUnion(schema, value, path, options), { required });
    }
    if (kind === 'object' && objectChoices.length > 1) {
        return renderFieldRow(label, description, renderVariantObject(schema, value, path, options), { required });
    }
    if (kind === 'object' && objectChoices.length === 1) {
        const info = objectInfo(root, objectChoices[0]);
        if (!Object.keys(info.properties).length && info.schema.additionalProperties) {
            return renderFieldRow(label, description, renderMapEditor(info.schema, value, path, options), { required });
        }
        return renderObjectField(label, objectChoices[0], value, path, options);
    }
    if (kind === 'array') {
        return renderFieldRow(label, description, renderArrayEditor(schema, value, path, options), { required });
    }
    if (schema.enum) return renderFieldRow(label, description, renderEnum(schema, value, path, options), { required });
    if (schema.const !== undefined) {
        return renderFieldRow(label, description, ui.E('div', { 'class': 'sbd-schema-const' }, String(schema.const)), { required });
    }
    if (kind === 'boolean') return renderFieldRow(label, description, renderSwitch(schema, value, path, options), { required });
    if (kind === 'integer' || kind === 'number') {
        return renderFieldRow(label, description, renderNumber(schema, value, path, options), { required });
    }
    const multi = /(pem|certificate|private key|证书|私钥)/i.test(description)
        || schema.format === 'multiline';
    return renderFieldRow(label, description, renderTextInput(schema, value, path, options, multi), { required });
}

function renderTopLevel(host, key, options) {
    const property = resolveSchema(options.root, (options.root.properties || {})[key]);
    const label = TOP_LEVEL_TITLES[key] || fieldLabel(key, property);
    const kind = schemaKind(options.root, property, getPath(options.draft, [key]));
    const body = ui.E('div', { 'class': 'sbd-schema-card-body' });
    const card = ui.card(label, [body], { className: 'sbd-span-12 sbd-schema-section' });
    const path = [key];
    if (kind === 'object') {
        const has = isPlainObject(getPath(options.draft, path));
        if (!has) {
            body.appendChild(ui.E('div', { 'class': 'sbd-schema-unset' }, [
                ui.E('span', {}, 'Opsi konfigurasi ini belum aktif'),
                ui.btn('Aktifkan konfigurasi', { icon: 'plus', small: true, onClick: () => {
                    setPath(options.draft, path, {});
                    markChange(options);
                    options.rerender();
                } })
            ]));
        } else {
            const choices = objectVariants(options.root, property);
            if (choices.length === 1) {
                const info = objectInfo(options.root, choices[0]);
                if (!Object.keys(info.properties).length && info.schema.additionalProperties) {
                    body.appendChild(renderMapEditor(info.schema, getPath(options.draft, path), path, options));
                } else {
                    renderObjectFields(body, choices[0], getPath(options.draft, path), path,
                        Object.assign({}, options, { required: [] }));
                }
            } else {
                body.appendChild(renderField(key, property, getPath(options.draft, path), path,
                    Object.assign({}, options, { required: [] })));
            }
        }
    } else if (kind === 'array') {
        const itemSchema = resolveSchema(options.root, property.items || {});
        if (objectVariants(options.root, itemSchema).length) {
            body.appendChild(renderObjectArray(property, getPath(options.draft, path), path, options));
        } else {
            body.appendChild(renderField(key, property, getPath(options.draft, path), path,
                Object.assign({}, options, { required: [] })));
        }
    } else {
        body.appendChild(renderField(key, property, getPath(options.draft, path), path,
            Object.assign({}, options, { required: [] })));
    }
    host.appendChild(card);
    return card;
}

return baseclass.extend({
    renderMixedUnion,
    renderJsonEditor,
    renderMixedArray,
    renderArrayEditor,
    renderSwitch,
    renderEnum,
    renderTextInput,
    renderNumber,
    renderPrimitiveArray,
    renderFieldRow,
    renderMapEditor,
    renderObjectField,
    renderObjectFields,
    renderVariantObject,
    renderObjectArray,
    renderField,
    renderTopLevel
});
