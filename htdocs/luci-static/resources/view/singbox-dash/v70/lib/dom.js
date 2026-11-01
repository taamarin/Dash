/* deslop-ignore-file 24: these are a deliberate standard line-icon set, not generated mascot art. */
'use strict';
'require baseclass';
'require dom';

const REGIONAL_INDICATOR_START = 0x1F1E6;
const REGIONAL_INDICATOR_END = 0x1F1FF;

const SVG = {
    overview: '<path d="M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z"/>',
    proxies: '<path d="M21 3 3 10.5l7.5 3L13.5 21 21 3Z"/>',
    config: '<path d="M5 3h10l4 4v14H5V3Zm9 2v3h3M8 12h8M8 16h8"/>',
    kernel: '<path d="M9 3h6v3h3v3h3v6h-3v3h-3v3H9v-3H6v-3H3V9h3V6h3V3Z"/><path d="M9 9h6v6H9z"/>',
    tools: '<path d="M14.7 5.3a4 4 0 0 0-5 5L4 16l4 4 5.7-5.7a4 4 0 0 0 5-5l-2.3 2.3-3-3 2.3-2.3Z"/>',
    settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m19 13 2-1-2-1v-2l-2-.7-.8-1.8.3-2.1-2-1.2-1.7 1.2h-2L9.1 3.2l-2 1.2.3 2.1-.8 1.8L4.6 9v2L3 12l1.6 1v2l2 .7.8 1.8-.3 2.1 2 1.2 1.7-1.2h2l1.7 1.2 2-1.2-.3-2.1.8-1.8L19 15v-2Z"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    stop: '<path d="M6 6h12v12H6z"/>',
    restart: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8A7 7 0 0 1 18.7 9.5M17.9 16A7 7 0 0 1 5.3 14.5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 6M20 4v7h-7"/>',
    save: '<path d="M5 3h12l2 2v16H5V3Zm3 0v6h8V3M8 21v-7h8v7"/>',
    upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5M5 16v4h14v-4"/>',
    download: '<path d="M12 4v12m0 0 5-5m-5 5-5-5M5 20h14"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 14h8l1-14M10 11v6M14 11v6"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6l-8-3Z"/><path d="m8.5 12 2.3 2.3 4.7-5"/>',
    activity: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
    cpu: '<path d="M7 7h10v10H7zM9 1v3m6-3v3M9 20v3m6-3v3M1 9h3m-3 6h3M20 9h3m-3 6h3"/>',
    network: '<path d="M12 3a6 6 0 0 1 6 6c0 4.2-6 9-6 9S6 13.2 6 9a6 6 0 0 1 6-6Zm-2 17h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
    terminal: '<path d="m5 7 5 5-5 5m7 0h7"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/>',
    edit: '<path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20ZM13.5 7l3.5 3.5"/>',
    backup: '<path d="M4 7h16v13H4V7Zm4-3h8v3M8 12h8m-4-3v6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-9h.01"/>',
    chevron: '<path d="m8 10 4 4 4-4"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrowUp: '<path d="m6 15 6-6 6 6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a14.5 14.5 0 0 0 0 18 14.5 14.5 0 0 0 0-18Z"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.2 9.5 4.5 4.5 0 0 0 7 18Z"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
    grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    gitBranch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 7h5a5 5 0 0 1 5 5"/>',
    message: '<path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9h8M8 12h5"/>',
    wallet: '<path d="M3 7h15a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2V7Z"/><path d="M3 7V5h13v2M15 12h5v3h-5a1.5 1.5 0 0 1 0-3Z"/>',
    music: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
    gamepad: '<path d="M8 8h8a5 5 0 0 1 4.8 6.4l-.8 2.7a2.5 2.5 0 0 1-4.3 1l-1.8-2.1H9.9l-1.8 2.1a2.5 2.5 0 0 1-4.3-1l-.8-2.7A5 5 0 0 1 8 8Z"/><path d="M7 11v4M5 13h4M16 12h.01M18 14h.01"/>',
    leaf: '<path d="M5 19c8 0 13-5 14-14-9 0-14 4-14 11v3Z"/><path d="M5 19c3-5 7-8 12-10"/>',
    route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18h4a3.5 3.5 0 0 0 0-7h-1a3.5 3.5 0 0 1 0-7h4"/>',
    inbound: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    outbound: '<path d="M7 17 17 7m0 0H9m8 0v8"/>',
    sliders: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
    sparkle: '<path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z"/>',
    rules: '<path d="M5 6h14M5 12h14M5 18h14"/><circle cx="8" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    arrowDown: '<path d="m6 9 6 6 6-6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'
};

function E(tag, attrs, children) {
    return dom.create(tag, attrs || {}, children == null ? [] : (Array.isArray(children) ? children : [children]));
}

function nameWithFlags(name, className) {
    const text = String(name == null ? '' : name);
    const chars = Array.from(text);
    const children = [];
    let buffer = '';
    const flush = () => {
        if (!buffer) return;
        children.push(buffer);
        buffer = '';
    };
    for (let index = 0; index < chars.length; index++) {
        const code = chars[index].codePointAt(0);
        if (code < REGIONAL_INDICATOR_START || code > REGIONAL_INDICATOR_END) {
            buffer += chars[index];
            continue;
        }
        const next = index + 1 < chars.length ? chars[index + 1].codePointAt(0) : 0;
        flush();
        if (next >= REGIONAL_INDICATOR_START && next <= REGIONAL_INDICATOR_END) {
            children.push(E('span', { 'class': 'sbd-name-emoji' }, chars[index] + chars[index + 1]));
            index++;
        } else {
            children.push(E('span', { 'class': 'sbd-name-letter' }, String.fromCharCode(65 + code - REGIONAL_INDICATOR_START)));
        }
    }
    flush();
    return E('span', { 'class': className || '' }, children.length ? children : text);
}

function icon(name, extraClass) {
    const svg = dom.parse('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + (SVG[name] || SVG.info) + '</svg>');
    return E('span', { 'class': 'sbd-icon ' + (extraClass || ''), 'aria-hidden': 'true' }, svg);
}

function appIcon(name, color) {
    return E('div', { 'class': 'sbd-app-icon ' + (color || 'blue') }, icon(name));
}

function btn(label, options) {
    const opt = options || {};
    const children = [];
    if (opt.icon) children.push(icon(opt.icon));
    if (label) children.push(E('span', {}, String(label)));
    const node = E('button', {
        type: opt.type || 'button',
        'class': 'sbd-btn ' + (opt.variant || '') + (opt.small ? ' small' : '') + (opt.iconOnly ? ' icon-only' : ''),
        title: opt.title || label || '',
        'aria-label': opt.iconOnly ? (opt.title || label || null) : null,
        disabled: opt.disabled ? '' : null,
        click: opt.onClick || null
    }, children);
    if (opt.disabled) node.disabled = true;
    return node;
}

function badge(text, tone) {
    return E('span', { 'class': 'sbd-badge ' + (tone || '') }, String(text));
}

function card(title, body, options) {
    const opt = options || {};
    const node = E('section', { 'class': 'sbd-card ' + (opt.className || '') });
    if (title || opt.subtitle || opt.actions) {
        const titleWrap = E('div', { 'class': 'sbd-card-head-main' }, [
            opt.icon ? E('div', { 'class': 'sbd-card-head-icon ' + (opt.iconTone || '') }, icon(opt.icon)) : null,
            E('div', {}, [
                E('h2', { 'class': 'sbd-card-title' }, String(title || '')),
                opt.subtitle ? E('div', { 'class': 'sbd-card-sub' }, String(opt.subtitle)) : null
            ].filter(Boolean))
        ].filter(Boolean));
        const head = E('div', { 'class': 'sbd-card-head' }, [
            titleWrap,
            opt.actions ? E('div', { 'class': 'sbd-btn-row' }, opt.actions) : null
        ].filter(Boolean));
        node.appendChild(head);
    }
    if (body) node.appendChild(E('div', { 'class': opt.flush ? 'sbd-card-body sbd-card-body-flush' : 'sbd-card-body' }, body));
    if (opt.footer) node.appendChild(E('div', { 'class': 'sbd-card-foot' }, opt.footer));
    return node;
}

function field(label, control, hint) {
    return E('label', { 'class': 'sbd-field' }, [
        E('span', { 'class': 'sbd-field-label' }, String(label)),
        control,
        hint ? E('span', { 'class': 'sbd-field-hint' }, String(hint)) : null
    ].filter(Boolean));
}

function row(title, sub, action, options) {
    const opt = options || {};
    const main = E('div', { 'class': 'sbd-row-main' }, [
        E('div', { 'class': 'sbd-row-title' }, String(title || '')),
        sub ? E('div', { 'class': 'sbd-row-sub' }, sub) : null
    ].filter(Boolean));
    const left = opt.icon
        ? E('div', { 'class': 'sbd-row-left' }, [appIcon(opt.icon, opt.color), main])
        : main;
    return E('div', { 'class': 'sbd-row' }, [
        left,
        action ? E('div', { 'class': 'sbd-row-action' }, action) : null
    ].filter(Boolean));
}

function loading(text) {
    return E('div', { 'class': 'sbd-loading', 'role': 'status', 'aria-live': 'polite' }, [
        E('div', { 'class': 'sbd-spinner' }),
        E('span', {}, text || 'Memuat...')
    ]);
}

function empty(text) {
    return E('div', { 'class': 'sbd-empty' }, String(text || 'Tidak ada data'));
}

function note(text, tone) {
    return E('div', { 'class': 'sbd-note ' + (tone || '') }, typeof text === 'string' ? String(text) : text);
}

let activeModals = [];

function modal(title, content, options) {
    const opt = options || {};
    let closed = false;
    const overlay = E('div', { 'class': 'sbd-modal-backdrop', role: 'presentation' });
    overlay.style.zIndex = String(1000 + activeModals.length * 10);

    const close = () => {
        if (closed) return;
        closed = true;
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        activeModals = activeModals.filter(item => item !== overlay);
        if (!activeModals.length) document.body.classList.remove('sbd-modal-open');
        if (opt.onClose) opt.onClose();
    };

    const body = E('div', { 'class': 'sbd-modal-content' }, content || []);
    const footNodes = [].concat(opt.extraActions || [], [
        opt.cancelText ? btn(opt.cancelText, { onClick: close }) : null,
        opt.confirmText ? btn(opt.confirmText, {
            variant: opt.danger ? 'danger' : 'primary',
            onClick: async () => {
                if (opt.onConfirm) {
                    try { await opt.onConfirm(); } catch (error) { notify(error.message || String(error), 'error'); return; }
                }
                if (opt.closeOnConfirm !== false) close();
            }
        }) : null
    ]).filter(Boolean);
    const footer = E('div', { 'class': 'sbd-modal-foot' }, footNodes);
    const dialog = E('div', {
        'class': 'sbd-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': String(title || 'Dialog'),
        style: opt.width ? 'width:min(' + opt.width + ', 100%)' : null
    }, [
        E('div', { 'class': 'sbd-modal-head' }, [
            E('div', {}, [
                E('div', { 'class': 'sbd-modal-title' }, String(title || '')),
                opt.subtitle ? E('div', { 'class': 'sbd-modal-sub' }, String(opt.subtitle)) : null
            ].filter(Boolean)),
            opt.dismissable === false ? null : btn('', { icon: 'x', iconOnly: true, variant: 'ghost', title: 'Tutup', onClick: close })
        ].filter(Boolean)),
        body,
        footer.childNodes.length ? footer : null
    ].filter(Boolean));
    overlay.appendChild(dialog);
    overlay.addEventListener('click', event => {
        if (event.target === overlay && opt.dismissable !== false) close();
    });
    const onKey = event => {
        if (event.key === 'Escape' && opt.dismissable !== false && activeModals[activeModals.length - 1] === overlay) {
            close();
        }
    };
    activeModals.push(overlay);
    document.body.classList.add('sbd-modal-open');
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    return { overlay, dialog, body, close };
}

function confirm(title, text, confirmText, danger) {
    return new Promise(resolve => {
        let answer = false;
        const ref = modal(title, E('div', { 'class': 'sbd-modal-text' }, text || ''), {
            cancelText: 'Batal',
            confirmText: confirmText || 'Konfirmasi',
            danger: !!danger,
            onConfirm: () => { answer = true; },
            onClose: () => resolve(answer)
        });
        ref.overlay.addEventListener('keydown', event => {
            if (event.key === 'Enter') { answer = true; ref.close(); }
        });
    });
}

let toastHost = null;
function notify(message, tone, timeout) {
    if (!toastHost) {
        toastHost = E('div', { 'class': 'sbd-toasts', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
        document.body.appendChild(toastHost);
    }
    const item = E('div', { 'class': 'sbd-toast ' + (tone || '') }, [
        icon(tone === 'error' ? 'x' : tone === 'success' ? 'check' : 'info'),
        E('span', {}, String(message || ''))
    ]);
    toastHost.appendChild(item);
    window.setTimeout(() => item.classList.add('out'), timeout || 3200);
    window.setTimeout(() => item.remove(), (timeout || 3200) + 220);
}

function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

return baseclass.extend({ E, icon, appIcon, btn, badge, card, field, row, loading, empty, note, modal, confirm, notify, sleep, nameWithFlags });
