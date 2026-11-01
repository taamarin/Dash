/* Shared page primitives: busy state, recoverable errors, and save bars. */
'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';

function setBusy(scope, value, options) {
    const opt = options || {};
    if (!scope) return !!value;
    const excluded = new Set([].concat(opt.exclude || []));
    scope.querySelectorAll(opt.selector || 'button, input, textarea, select').forEach(node => {
        if (!excluded.has(node)) node.disabled = !!value;
    });
    return !!value;
}

function errorCard(title, error, retry, options) {
    const opt = options || {};
    const actions = [].concat(opt.actions || []);
    if (retry) actions.unshift(ui.btn(opt.retryText || 'Coba lagi', {
        icon: 'refresh', variant: opt.retryPrimary === false ? null : 'primary', onClick: retry
    }));
    const children = [ui.note(opt.errorText || String(error || 'Kesalahan tidak diketahui'), 'bad')];
    if (opt.hint) children.push(ui.note(opt.hint, 'info'));
    if (actions.length) children.push(ui.E('div', { 'class': 'sbd-btn-row' }, actions));
    return ui.card(title || 'Gagal memuat', children, {
        className: opt.className || '',
        icon: opt.icon || 'info',
        iconTone: 'red'
    });
}

function saveBar(buttons, options) {
    const opt = options || {};
    const dot = ui.E('span', { 'class': 'sbd-dot ' + (opt.dirty ? 'off' : 'on') });
    const stateText = ui.E('span', { 'class': 'sbd-config-state' }, opt.emptyText || 'Memuat konfigurasi');
    const node = ui.E('div', { 'class': 'sbd-config-savebar ' + (opt.className || '') }, [
        ui.E('div', { 'class': 'sbd-config-save-state' }, [dot, stateText]),
        ui.E('div', { 'class': 'sbd-config-save-actions' }, buttons || [])
    ]);

    function update(next) {
        const state = next || {};
        const available = state.available !== false;
        const busy = !!state.busy;
        const dirty = !!state.dirty;
        node.classList.toggle('unavailable', !available);
        node.classList.toggle('dirty', available && dirty);
        dot.className = 'sbd-dot ' + (dirty ? 'off' : 'on');
        stateText.textContent = !available ? (opt.emptyText || 'Memuat konfigurasi')
            : busy ? 'Memproses'
            : state.validationText || (dirty ? 'Ada perubahan yang belum disimpan' : (opt.idleText || 'Tersinkron'));
        (buttons || []).forEach(button => {
            button.disabled = busy || !dirty || !available;
        });
    }

    update({ available: opt.available !== false, dirty: !!opt.dirty,
             validationText: opt.validationText || '', busy: false });
    return { node, stateText, dot, update };
}

return baseclass.extend({ setBusy, errorCard, saveBar });
