'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';


function nameWithFlags(name, className) {
    return ui.nameWithFlags(name, className);
}

function ruleTypeName(value) {
    const raw = String(value || 'Rule');
    const names = {
        RuleSet: 'RULE-SET', DomainSuffix: 'DOMAIN-SUFFIX', DomainKeyword: 'DOMAIN-KEYWORD',
        DomainRegex: 'DOMAIN-REGEX', IPCIDR: 'IP-CIDR', IPIsPrivate: 'IP-IS-PRIVATE',
        DstPort: 'DST-PORT', ClashMode: 'CLASH-MODE', SrcIPCIDR: 'SRC-IP-CIDR',
        ProcessName: 'PROCESS-NAME', Match: 'MATCH'
    };
    return names[raw] || raw.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toUpperCase();
}

function hopIcon(hop) {
    if (hop.kind === 'direct') return ['link', 'green'];
    if (hop.kind === 'reject') return ['shield', 'red'];
    if (hop.kind === 'group') return ['sliders', 'orange'];
    return ['globe', 'blue'];
}

function hopKindName(hop) {
    if (hop.kind === 'group') return 'Grup kebijakan';
    if (hop.kind === 'node') return 'Node';
    if (hop.kind === 'direct') return 'Langsung';
    if (hop.kind === 'reject') return 'Blokir';
    return 'Outbound akhir';
}

function finalTone(name) {
    const value = String(name || '').toLowerCase();
    if (value === 'reject') return 'red';
    if (value === 'direct' || value === 'bypass') return 'green';
    return 'blue';
}

async function render(host, ctx) {
    const root = ui.E('div', { 'class': 'sbd-stack sbd-trace-page' });
    host.appendChild(root);

    const input = ui.E('input', {
        type: 'text', 'class': 'sbd-input sbd-trace-input',
        placeholder: 'Masukkan IP, domain, atau URL', autocomplete: 'off', spellcheck: 'false'
    });
    const submit = ui.btn('Telusuri rute', { icon: 'search', variant: 'primary', type: 'submit' });
    const form = ui.E('form', { 'class': 'sbd-trace-form' }, [input, submit]);
    const results = ui.E('div', { 'class': 'sbd-trace-results' });
    let busy = false;

    root.appendChild(ui.card('Penelusuran rute aturan', [
        form,
        ui.note('Simulasikan pencocokan aturan dengan TCP/443; sumber klien, kondisi proses, dan hasil resolusi DNS tidak disimulasikan.', 'info')
    ], { icon: 'link', iconTone: 'blue' }));
    root.appendChild(results);

    function renderEmpty(message) {
        results.innerHTML = '';
        results.appendChild(ui.empty(message || 'Masukkan IP atau domain untuk menelusuri outbound akhir'));
    }

    function chainCard(result) {
        const chain = Array.isArray(result.chain) ? result.chain : [];
        const hops = chain.map((hop, index) => {
            const [icon, tone] = hopIcon(hop);
            return ui.E('div', { 'class': 'sbd-trace-hop ' + hop.kind }, [
                ui.E('span', { 'class': 'sbd-trace-hop-index' }, String(index + 1)),
                ui.appIcon(icon, tone),
                ui.E('div', { 'class': 'sbd-trace-hop-copy' }, [
                    ui.E('strong', { 'class': 'sbd-trace-hop-name' }, nameWithFlags(hop.name)),
                    ui.E('span', { 'class': 'sbd-trace-hop-kind' }, hopKindName(hop) + ' · ' + hop.type)
                ]),
                index === chain.length - 1 ? ui.badge('Outbound', finalTone(hop.name)) : null
            ].filter(Boolean));
        });
        return ui.card('Rute outbound akhir', [
            ui.E('div', { 'class': 'sbd-trace-chain' }, hops),
            ui.E('div', { 'class': 'sbd-trace-final' }, [
                ui.E('span', {}, 'Outbound akhir'),
                ui.E('strong', {}, nameWithFlags(result.final || '—'))
            ])
        ], { icon: 'outbound', iconTone: 'green', className: 'sbd-trace-result-card' });
    }

    function ruleCard(result) {
        const matched = result.matched || {};
        const detail = String(matched.detail || '').replace(/^match rules\.\[\d+\]:\s*/, '');
        const meta = [];
        if (matched.index != null) meta.push('Aturan ke-' + (Number(matched.index) + 1));
        if (matched.proxy) meta.push('Target ' + matched.proxy);
        meta.push('Mode ' + ({ rule: 'Aturan', global: 'Global', direct: 'Langsung' }[result.mode] || result.mode || 'Aturan'));
        const notes = result.skipped
            ? result.skipped + ' aturan lain yang bergantung pada sumber atau kondisi proses tidak disertakan dalam pencocokan'
            : '';
        return ui.card('Aturan yang cocok', [
            ui.E('div', { 'class': 'sbd-trace-rule' }, [
                ui.E('div', { 'class': 'sbd-trace-rule-head' }, [
                    ui.badge(ruleTypeName(matched.type), 'blue'),
                    matched.payload ? ui.E('strong', { 'class': 'sbd-trace-rule-payload' }, matched.payload) : null
                ].filter(Boolean)),
                ui.E('div', { 'class': 'sbd-trace-rule-meta' }, ui.nameWithFlags(meta.join(' · '))),
                detail ? ui.E('div', { 'class': 'sbd-trace-rule-detail', title: detail }, detail) : null
            ].filter(Boolean)),
            notes ? ui.note(notes, 'info') : null
        ].filter(Boolean), { icon: 'rules', iconTone: 'purple', className: 'sbd-trace-result-card' });
    }

    async function run() {
        if (busy) return;
        const query = input.value.trim();
        if (!query) {
            input.focus();
            ui.notify('Masukkan IP atau domain', 'warning');
            return;
        }
        busy = true;
        submit.disabled = true;
        const label = submit.querySelector('span:not(.sbd-icon)');
        if (label) label.textContent = 'Menelusuri…';
        results.innerHTML = '';
        results.appendChild(ui.card('Mencocokkan rute', [ui.empty('Membaca aturan dan menguraikan grup proxy…')], {
            icon: 'link', iconTone: 'blue', className: 'sbd-trace-loading'
        }));
        try {
            const result = await api.traceTarget(query);
            results.innerHTML = '';
            results.appendChild(ruleCard(result));
            results.appendChild(chainCard(result));
        } catch (error) {
            results.innerHTML = '';
            results.appendChild(ui.card('Penelusuran rute gagal', [
                ui.note(api.errorText(error), 'bad'),
                ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('Coba lagi', { icon: 'refresh', onClick: run }))
            ], { icon: 'info', iconTone: 'red' }));
        } finally {
            busy = false;
            submit.disabled = false;
            if (label) label.textContent = 'Telusuri rute';
        }
    }

    form.addEventListener('submit', event => {
        event.preventDefault();
        run();
    });
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            run();
        }
    });
    renderEmpty();
}

return baseclass.extend({ render });



