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
        select.appendChild(ui.E('option', { value: '__direct', selected: selected === '__direct' ? '' : null }, 'Langsung (direct)'));
        select.appendChild(ui.E('option', { value: '__reject', selected: selected === '__reject' ? '' : null }, 'Blokir (reject)'));
        const group = ui.E('optgroup', { label: 'Proxy dan outbound khusus' });
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
            group.appendChild(ui.E('option', { value: selected, selected: '' }, selected.slice(7) + ' · outbound tidak ditemukan'));
        }
        if (group.childNodes.length) select.appendChild(group);
    }

    function finalOptions(select, selected) {
        select.appendChild(ui.E('option', { value: '', selected: !selected ? '' : null }, 'Belum diatur'));
        const group = ui.E('optgroup', { label: 'Label outbound' });
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
            group.appendChild(ui.E('option', { value: selected, selected: '' }, selected + ' · outbound tidak ditemukan'));
        }
        if (group.childNodes.length) select.appendChild(group);
    }

    function fieldOptions(select, selected) {
        const groups = Object.create(null);
        MATCH_FIELDS.forEach(field => {
            if (!groups[field.group]) groups[field.group] = ui.E('optgroup', { label: field.group });
            groups[field.group].appendChild(ui.E('option', { value: field.key, selected: selected === field.key ? '' : null }, field.label + (field.common ? ' · Disarankan' : '')));
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
                placeholder: meta.placeholder || 'Masukkan nilai pencocokan'
            })
            : ui.E('textarea', {
                'class': 'sbd-textarea sbd-rule-values', spellcheck: 'false',
                placeholder: meta.placeholder || 'Masukkan satu nilai pencocokan per baris'
            });
        if (!single) control.value = text || '';
        control.addEventListener('input', () => onChange(control.value));

        const guideRow = (label, value, code) => ui.E('div', { 'class': 'sbd-rule-guide-row' }, [
            ui.E('strong', {}, label),
            code ? ui.E('code', { 'class': 'sbd-rule-guide-code' }, value) : ui.E('span', {}, value)
        ]);
        host.appendChild(control);
        host.appendChild(ui.E('div', { 'class': 'sbd-rule-guide' }, [
            guideRow('Fungsi', meta.summary || meta.hint, false),
            meta.example ? guideRow('Contoh', meta.example, true) : null,
            meta.note ? guideRow('Catatan', meta.note, false) : null
        ].filter(Boolean)));
        if (suggestions.length) {
            const chips = ui.E('div', { 'class': 'sbd-rule-suggestions' }, [
                ui.E('span', { 'class': 'sbd-rule-suggestions-label' }, 'Nilai tersedia (' + suggestions.length + ')')
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
                }, 'Lainnya +' + hidden.length);
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
            existing ? ui.E('option', { value: 'keep', selected: '' }, 'Pertahankan posisi saat ini') : null,
            ui.E('option', { value: 'safe', selected: existing ? null : '' }, 'Sebelum aturan fallback (disarankan)'),
            ui.E('option', { value: 'top' }, 'Awal daftar (prioritas tertinggi)'),
            ui.E('option', { value: 'end' }, 'Akhir daftar')
        ].filter(Boolean));
        const preview = ui.E('div', { 'class': 'sbd-rule-preview' });
        function refreshPreview() {
            const values = splitValues(working.text);
            const field = FIELD_BY_KEY[working.field];
            const target = working.target === '__direct' ? 'Langsung' : working.target === '__reject' ? 'Blokir'
                : working.target.indexOf('route::') === 0 ? working.target.slice(7) : 'Outbound belum dipilih';
            preview.textContent = values.length
                ? 'Jika cocok dengan “' + field.label + '”: ' + values.slice(0, 3).join(', ') + (values.length > 3 ? ' dan ' + (values.length - 3) + ' lainnya' : '') + ' → ' + target
                : 'Hasil perutean akhir akan ditampilkan setelah nilai pencocokan diisi';
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
            ui.note('Satu aturan visual hanya mencocokkan satu kondisi. Untuk kombinasi seperti “domain + port”, gunakan aturan lanjutan.', 'info'),
            ui.field('Metode pencocokan', fieldSelect, 'Pencocokan umum ditampilkan lebih dahulu; kumpulan aturan, domain, dan IP adalah tiga metode yang paling umum.'),
            ui.field('Nilai pencocokan', valuesHost),
            preview,
            ui.field('Tindakan / outbound', targetSelect, 'Pilih koneksi langsung, blokir, atau teruskan lalu lintas yang cocok ke proxy outbound tertentu.'),
            ui.field('Posisi penyisipan', positionSelect, existing ? 'Pertahankan posisi saat ini atau pindahkan aturan ke prioritas baru.' : 'Aturan baru ditempatkan sebelum aturan fallback secara default agar tidak tertangkap lebih dahulu oleh kondisi fallback.')
        ]);
        ui.modal(existing ? 'Edit aturan' : 'Tambah aturan', content, {
            subtitle: existing ? '#' + (index + 1) + ' · ' + matchLabel(existing) : 'Aturan visual dengan satu kondisi',
            cancelText: 'Batal', confirmText: existing ? 'Simpan perubahan' : 'Tambah aturan', width: '680px',
            onConfirm: () => {
                const values = validateValues(working.field, working.text);
                if (working.field === 'rule_set') {
                    const known = new Set(ruleSetTags());
                    const missing = values.filter(value => !known.has(value));
                    if (missing.length) throw new Error('Kumpulan aturan ini tidak ada dalam konfigurasi saat ini: ' + missing.join(', '));
                }
                if (working.field === 'inbound') {
                    const known = new Set((getDraft().inbounds || []).map(item => item && item.tag).filter(Boolean).map(String));
                    const missing = values.filter(value => !known.has(value));
                    if (missing.length) throw new Error('Tag inbound ini tidak ada dalam konfigurasi saat ini: ' + missing.join(', '));
                }
                const rule = buildRule(working.target, working.field, values);
                const position = existing
                    ? updateRuleAt(index, rule, positionSelect.value)
                    : insertRule(rule, null, positionSelect.value);
                markDirty(existing ? 'Perubahan aturan ditambahkan ke daftar simpan' : 'Aturan baru ditambahkan, belum disimpan');
                ui.notify(existing ? 'Aturan disimpan ke #' + (position + 1) : 'Aturan baru ditambahkan ke #' + (position + 1), 'success');
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
        const formatButton = ui.btn('Format', { icon: 'sliders', onClick: () => {
            try { editor.value = JSON.stringify(JSON.parse(editor.value), null, 2); }
            catch (error) { ui.notify('Format JSON tidak valid: ' + error.message, 'error'); }
        } });
        const content = ui.E('div', { 'class': 'sbd-stack' }, [
            ui.note('Semua kolom aturan lanjutan akan dipertahankan. Validasi kernel sing-box tetap dijalankan sebelum penyimpanan; konfigurasi tidak akan ditulis jika validasi gagal.', 'info'),
            editor
        ]);
        ui.modal(existing ? 'Edit aturan lanjutan' : 'Tambah aturan lanjutan', content, {
            subtitle: existing ? '#' + (index + 1) + ' · JSON mentah' : 'Kondisi majemuk, aturan logika, atau kolom kernel baru',
            cancelText: 'Batal', confirmText: existing ? 'Simpan perubahan' : 'Tambah aturan', width: '760px',
            extraActions: [formatButton],
            onConfirm: () => {
                let rule;
                try { rule = JSON.parse(editor.value); }
                catch (error) { throw new Error('Format JSON tidak valid: ' + error.message); }
                if (!isObject(rule)) throw new Error('Aturan harus berupa objek JSON');
                const position = insertRule(rule, existing ? index : null);
                markDirty('Aturan lanjutan diubah, belum disimpan');
                ui.notify(existing ? 'Aturan lanjutan diperbarui' : 'Aturan lanjutan ditambahkan ke #' + (position + 1), 'success');
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
        const formatButton = ui.btn('Format JSON', { icon: 'sliders', onClick: () => {
            try {
                ruleSetEditor.value = JSON.stringify(JSON.parse(ruleSetEditor.value || '[]'), null, 2);
                extrasEditor.value = JSON.stringify(JSON.parse(extrasEditor.value || '{}'), null, 2);
            } catch (error) {
                ui.notify('Format JSON tidak valid: ' + error.message, 'error');
            }
        } });
        const content = ui.E('div', { 'class': 'sbd-stack sbd-route-settings' }, [
            ui.field('Outbound akhir', finalSelect, 'Digunakan jika tidak ada aturan yang cocok. Hanya label outbound dalam konfigurasi saat ini yang ditampilkan.'),
            ui.field('JSON kumpulan aturan', ruleSetEditor, 'Kelola route.rule_set; semua kolom kumpulan aturan local / remote yang didukung kernel tersedia.'),
            ui.field('JSON opsi perutean lainnya', extrasEditor, 'Misalnya default_domain_resolver, auto_detect_interface; gunakan kontrol khusus di atas untuk rules, final, dan rule_set.'),
            ui.note('Validasi konfigurasi lengkap dan kernel akan dijalankan sebelum penyimpanan; konfigurasi tidak akan ditulis jika validasi gagal.', 'info')
        ]);
        ui.modal('Pengaturan perutean', content, {
            subtitle: 'Kelola kumpulan aturan, outbound akhir, dan kolom perutean lanjutan di sini',
            cancelText: 'Batal', confirmText: 'Terapkan pengaturan', width: '760px',
            extraActions: [formatButton],
            onConfirm: () => {
                let sets;
                let extra;
                try { sets = JSON.parse(ruleSetEditor.value || '[]'); }
                catch (error) { throw new Error('Format JSON kumpulan aturan tidak valid: ' + error.message); }
                try { extra = JSON.parse(extrasEditor.value || '{}'); }
                catch (error) { throw new Error('Format JSON opsi perutean lainnya tidak valid: ' + error.message); }
                if (!Array.isArray(sets)) throw new Error('Kumpulan aturan harus berupa array JSON');
                if (!isObject(extra)) throw new Error('Opsi perutean lainnya harus berupa objek JSON');
                const reserved = ['rules', 'final', 'rule_set'].filter(key => Object.prototype.hasOwnProperty.call(extra, key));
                if (reserved.length) throw new Error('Opsi perutean lainnya tidak boleh berisi: ' + reserved.join(', '));
                const next = Object.assign({}, extra, {
                    rules: Array.isArray(route.rules) ? route.rules : []
                });
                if (finalSelect.value) next.final = finalSelect.value;
                if (sets.length) next.rule_set = sets;
                getDraft().route = next;
                markDirty('Pengaturan perutean diubah, belum disimpan');
                ui.notify('Pengaturan perutean ditambahkan ke daftar simpan', 'success');
            }
        });
    }

    return { openEditor, openAdvanced, openRouteSettings };
}

return baseclass.extend({ create });
