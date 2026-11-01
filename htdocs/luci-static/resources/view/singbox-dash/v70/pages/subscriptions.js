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
    return server ? server + (node.port ? ':' + node.port : '') : 'Lokal/inline';
}

function trafficTone(percent) {
    if (percent >= 90) return 'bad';
    if (percent >= 75) return 'warn';
    return 'good';
}

function expiryText(value) {
    const seconds = Number(value || 0);
    if (!seconds) return 'Waktu kedaluwarsa tidak diketahui';
    if (seconds > Date.now() / 1000 + 20 * 365 * 86400) return 'Berlaku jangka panjang';
    return 'Kedaluwarsa ' + api.formatDate(seconds, false);
}

function trafficBlock(provider) {
    if (provider.kind === 'local') {
        return ui.E('div', { 'class': 'sbd-sub-traffic local' }, [
            ui.E('span', { 'class': 'sbd-sub-traffic-label' }, 'Node lokal'),
            ui.E('span', { 'class': 'sbd-sub-traffic-unknown' }, 'Tidak ada informasi lalu lintas langganan')
        ]);
    }
    const traffic = provider.traffic;
    if (!traffic || !Number(traffic.total)) {
        return ui.E('div', { 'class': 'sbd-sub-traffic unknown' }, [
            ui.E('span', { 'class': 'sbd-sub-traffic-label' }, 'Lalu lintas langganan'),
            ui.E('span', { 'class': 'sbd-sub-traffic-unknown' }, 'Server tidak mengembalikan informasi lalu lintas')
        ]);
    }
    const percent = Math.max(0, Math.min(100, Number(traffic.percent) || 0));
    return ui.E('div', { 'class': 'sbd-sub-traffic' }, [
        ui.E('div', { 'class': 'sbd-sub-traffic-head' }, [
            ui.E('span', { 'class': 'sbd-sub-traffic-label' }, 'Lalu lintas langganan'),
            ui.E('strong', {}, api.formatBytes(traffic.used) + ' / ' + api.formatBytes(traffic.total)),
            ui.E('span', { 'class': 'sbd-sub-traffic-percent ' + trafficTone(percent) }, percent.toFixed(1) + '%')
        ]),
        ui.E('div', { 'class': 'sbd-sub-traffic-bar ' + trafficTone(percent) }, [
            ui.E('i', { style: 'width:' + percent + '%' })
        ]),
        ui.E('div', { 'class': 'sbd-sub-traffic-meta' }, [
            ui.E('span', { title: 'Unggah ' + api.formatBytes(traffic.upload) + ' · Unduh ' + api.formatBytes(traffic.download) }, 'Tersisa ' + api.formatBytes(traffic.remaining)),
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
            list.push({ tag: 'Node manual', kind: 'manual', nodes: data.manual_nodes, error: '' });
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
        summary.appendChild(summaryTile('Sumber langganan', String(counts.providers || 0), (counts.remote || 0) + ' jarak jauh · ' + (counts.local || 0) + ' lokal', 'blue'));
        summary.appendChild(summaryTile('Total node', String(counts.nodes || 0), 'Dari langganan dan node manual', 'green'));
        summary.appendChild(summaryTile('Pembaruan otomatis', interval ? interval + ' menit' : 'Nonaktif', interval ? 'Mengambil sumber langganan secara berkala' : 'Dapat diaktifkan di pengaturan', interval ? 'orange' : ''));
        summary.appendChild(summaryTile('Pembaruan terakhir', data && data.latest_update ? api.formatDate(data.latest_update) : '—', 'Waktu file Provider', 'purple'));
    }

    function switchTab(next) {
        tab = next;
        render();
    }

    function renderToolbar() {
        toolbar.innerHTML = '';
        const tabs = ui.E('div', { 'class': 'sbd-sub-tabs' }, [
            ui.E('button', { type: 'button', 'class': 'sbd-sub-tab ' + (tab === 'subscriptions' ? 'active' : ''), click: () => switchTab('subscriptions') }, [
                ui.icon('database'), ui.E('span', {}, 'Sumber langganan'), ui.E('span', { 'class': 'sbd-sub-tab-count' }, String(providers().length))
            ]),
            ui.E('button', { type: 'button', 'class': 'sbd-sub-tab ' + (tab === 'nodes' ? 'active' : ''), click: () => switchTab('nodes') }, [
                ui.icon('globe'), ui.E('span', {}, 'Node'), ui.E('span', { 'class': 'sbd-sub-tab-count' }, String((data && data.counts && data.counts.nodes) || 0))
            ])
        ]);
        const searchInput = ui.E('input', {
            type: 'search', 'class': 'sbd-input sbd-sub-search', placeholder: 'Cari node, protokol, atau server',
            value: search, input: event => { search = event.target.value.trim().toLowerCase(); if (tab === 'nodes') renderContent(); }
        });
        const actions = ui.E('div', { 'class': 'sbd-sub-actions' }, [
            ui.btn('Tambah langganan', { icon: 'plus', variant: 'primary', onClick: () => openProviderEditor(null, 'remote') }),
            ui.btn('Impor node', { icon: 'upload', onClick: () => openProviderEditor(null, 'local') })
        ]);
        toolbar.appendChild(ui.E('div', { 'class': 'sbd-sub-toolbar-main' }, [tabs, tab === 'nodes' ? searchInput : null].filter(Boolean)));
        toolbar.appendChild(actions);
    }

    function providerCard(provider, index) {
        const remote = provider.kind === 'remote';
        const update = provider.updated ? api.formatDate(provider.updated) : 'Belum diperbarui';
        const source = remote ? provider.url : provider.path;
        return ui.E('section', { 'class': 'sbd-subscription-source-card' }, [
            ui.E('div', { 'class': 'sbd-sub-source-head' }, [
                ui.appIcon(remote ? 'link' : 'database', remote ? 'blue' : 'green'),
                ui.E('div', { 'class': 'sbd-sub-source-copy' }, [
                    ui.E('div', { 'class': 'sbd-sub-source-title' }, ui.nameWithFlags(provider.tag || 'Langganan tanpa nama')),
                    ui.E('div', { 'class': 'sbd-sub-source-badges' }, [
                        ui.badge(remote ? 'Langganan jarak jauh' : 'Node lokal', remote ? 'blue' : 'green'),
                        ui.badge((provider.node_count || 0) + ' node', ''),
                        remote && provider.update_interval ? ui.badge('Diperbarui ' + provider.update_interval, 'orange') : null,
                        !remote ? ui.badge('Tanpa lalu lintas langganan', '') : null,
                        provider.error ? ui.badge('Kesalahan pembacaan', 'red') : null
                    ].filter(Boolean))
                ]),
                ui.E('div', { 'class': 'sbd-sub-source-actions' }, [
                    ui.btn('Edit', { icon: 'edit', small: true, onClick: () => openProviderEditor(index, remote ? 'remote' : 'local') }),
                    ui.btn('', { icon: 'trash', iconOnly: true, small: true, variant: 'danger', title: 'Hapus sumber langganan', onClick: () => deleteProvider(index) })
                ])
            ]),
            ui.E('div', { 'class': 'sbd-sub-source-body' }, [
                ui.E('div', { 'class': 'sbd-sub-source-url', title: source || '' }, remote ? shortUrl(source) : (source || 'Path file belum diatur')),
                trafficBlock(provider),
                provider.error ? ui.note(provider.error, 'bad') : null,
                ui.E('div', { 'class': 'sbd-sub-source-meta' }, [
                    ui.E('span', {}, 'Diperbarui: ' + update),
                    ui.E('span', {}, provider.health_check && provider.health_check.enabled ? 'Pemeriksaan kesehatan aktif' : 'Pemeriksaan kesehatan nonaktif'),
                    provider.exclude ? ui.E('span', { title: provider.exclude }, 'Dikecualikan: ' + provider.exclude.slice(0, 42) + (provider.exclude.length > 42 ? '…' : '')) : null
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
                    ui.E('div', { 'class': 'sbd-sub-source-title' }, 'Langganan konfigurasi saat ini'),
                    ui.E('div', { 'class': 'sbd-sub-source-badges' }, [
                        ui.badge('Langganan seluruh konfigurasi', 'orange'),
                        ui.badge(subscription.interval ? 'Otomatis ' + subscription.interval + ' menit' : 'Pembaruan manual', subscription.interval ? 'green' : '')
                    ])
                ]),
                ui.E('div', { 'class': 'sbd-sub-source-actions' }, [
                    ui.btn('Edit alamat', { icon: 'edit', small: true, onClick: openLegacyEditor }),
                    ui.btn('Sinkronkan sekarang', { icon: 'refresh', small: true, onClick: updateLegacySubscription })
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
        if (!list.length) content.appendChild(ui.empty('Belum ada sumber langganan; tambahkan langganan jarak jauh atau impor node lokal'));
        list.forEach((provider, index) => content.appendChild(providerCard(provider, index)));
    }

    function nodeCard(node) {
        const meta = [node.transport ? node.transport.toUpperCase() : '', node.tls ? 'TLS' : ''].filter(Boolean).join(' · ');
        return ui.E('div', { 'class': 'sbd-managed-node-card' }, [
            ui.appIcon(node.type && /direct|reject/i.test(node.type) ? 'link' : 'globe', node.tls ? 'green' : 'blue'),
            ui.E('div', { 'class': 'sbd-managed-node-copy' }, [
                ui.E('strong', { 'class': 'sbd-managed-node-name' }, ui.nameWithFlags(node.tag || 'Node tanpa nama')),
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
            content.appendChild(ui.empty(search ? 'Tidak ditemukan node yang cocok' : 'Belum ada node yang tersedia'));
            return;
        }
        sources.forEach(source => {
            const section = ui.E('section', { 'class': 'sbd-node-source-section' }, [
                ui.E('div', { 'class': 'sbd-node-source-head' }, [
                    ui.E('div', { 'class': 'sbd-node-source-title' }, ui.nameWithFlags(source.tag)),
                    ui.badge(source.kind === 'remote' ? 'Jarak jauh' : source.kind === 'local' ? 'Lokal' : 'Manual', source.kind === 'remote' ? 'blue' : 'green'),
                    ui.E('span', { 'class': 'sbd-node-source-count' }, source.nodes.length + ' node')
                ])
            ]);
            if (source.error) section.appendChild(ui.note(source.error, 'bad'));
            const grid = ui.E('div', { 'class': 'sbd-managed-node-grid' });
            source.nodes.forEach(node => grid.appendChild(nodeCard(node)));
            if (!source.nodes.length) grid.appendChild(ui.empty(search ? 'Tidak ada node langganan yang cocok' : 'Langganan ini belum memiliki node'));
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
            content.appendChild(components.errorCard('Gagal memuat node dan langganan', api.errorText(error), load, {
                icon: 'database'
            }));
        } finally {
            setBusy(false);
        }
    }

    async function applyProviders(nextProviders, message) {
        if (!current) throw new Error('Konfigurasi saat ini belum dimuat');
        const draft = clone(current.parsed);
        draft.providers = nextProviders;
        await api.validateConfigObject(draft);
        const job = await api.submitConfigObject({
            action: 'apply', target: current.name, expected: current.hash, data: draft
        });
        if (job) await ctx.watchJob(job, 'Menerapkan node dan langganan');
        await ctx.refreshStatus().catch(() => {});
        await load();
        ui.notify(message || 'Node dan langganan diterapkan', 'success');
    }

    async function deleteProvider(index) {
        const provider = providers()[index];
        if (!provider) return;
        const ok = await ui.confirm('Hapus sumber langganan', 'Menghapus “' + provider.tag + '” juga akan menghapus referensinya dalam konfigurasi dan memulai ulang sing-box.', 'Hapus', true);
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
            await applyProviders(next, 'Sumber langganan dihapus');
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally {
            setBusy(false);
        }
    }

    function openLegacyEditor() {
        const input = ui.E('input', { 'class': 'sbd-input', type: 'url', value: data.subscription.url || '', placeholder: 'https://example.com/config' });
        ui.modal('Edit langganan konfigurasi', [
            ui.field('URL langganan', input, 'Digunakan untuk memperbarui seluruh konfigurasi; tidak menambahkan Provider.')
        ], {
            cancelText: 'Batal', confirmText: 'Simpan alamat', width: '680px',
            onConfirm: async () => {
                await api.setSubscription(input.value.trim());
                await load();
                ui.notify('Alamat langganan konfigurasi disimpan', 'success');
            }
        });
    }

    async function updateLegacySubscription() {
        try {
            setBusy(true);
            const result = await api.command('subscription-update');
            if (result.job) await ctx.watchJob(result.job, 'Memperbarui langganan konfigurasi');
            else ui.notify(result.message || 'Konten langganan tidak berubah', 'success');
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
                ui.E('option', { value: 'text', selected: working.sourceType === 'text' ? '' : null }, 'Tempel tautan berbagi atau Base64'),
                ui.E('option', { value: 'url', selected: working.sourceType === 'url' ? '' : null }, 'Unduh dari tautan penguraian')
            ]);
            select.addEventListener('change', () => { working.sourceType = select.value; working.source = ''; draw(); });
            const sourceNode = working.sourceType === 'url'
                ? input(working.source, 'https://example.com/subscribe', value => { working.source = value; }, 'url')
                : ui.E('textarea', { 'class': 'sbd-textarea', placeholder: 'vless://… / vmess://… / seluruh konten langganan Base64' }, working.source);
            if (sourceNode.tagName === 'TEXTAREA') sourceNode.addEventListener('input', () => { working.source = sourceNode.value; });
            const importButton = ui.btn('Uraikan dan tulis ke file node', {
                icon: 'download', onClick: async () => {
                    const tag = tagValue.value.trim();
                    if (!tag) return ui.notify('Masukkan nama langganan terlebih dahulu', 'warn');
                    const path = existing && existing.tag === tag && existing.path ? existing.path : providerPath(tag);
                    importButton.disabled = true;
                    try {
                        imported = await api.importProvider({ tag, path, sourceType: working.sourceType, source: working.source });
                        working.path = imported.path;
                        ui.notify(imported.count + ' node diimpor', 'success');
                    } catch (error) {
                        ui.notify(api.errorText(error), 'error', 7000);
                    } finally {
                        importButton.disabled = false;
                    }
                }
            });
            hostNode.appendChild(ui.field('Sumber node lokal', select));
            hostNode.appendChild(ui.field(working.sourceType === 'url' ? 'Tautan penguraian' : 'Konten node', sourceNode,
                working.sourceType === 'url' ? 'Hanya digunakan untuk unduhan kali ini; file yang dibuat tidak lagi bergantung pada URL.' : 'Mendukung satu tautan berbagi per baris atau seluruh konten Base64.'));
            hostNode.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, importButton));
        }
        const tagValue = input(working.tag, 'misalnya HIMEMY, penyedia cadangan', value => {
            working.tag = value;
            if (!existing) working.path = providerPath(value);
            pathText.textContent = working.path;
        });
        const pathText = ui.E('code', { 'class': 'sbd-sub-path' }, working.path);
        function draw() {
            body.innerHTML = '';
            body.appendChild(ui.field('Nama langganan', tagValue, 'Digunakan untuk membuat label Provider dan nama file.'));
            if (working.kind === 'remote') {
                body.appendChild(ui.field('URL langganan', input(working.url, 'https://example.com/subscribe', value => { working.url = value; }, 'url')));
                body.appendChild(ui.E('div', { 'class': 'sbd-sub-form-grid' }, [
                    ui.field('Interval pembaruan', input(working.update_interval, '6h', value => { working.update_interval = value; })),
                    ui.field('Klien HTTP', input(working.http_client, 'provider_direct', value => { working.http_client = value; }), 'Kosongkan atau masukkan label http_clients yang sudah ada.'),
                    ui.field('File node', pathText)
                ]));
                body.appendChild(ui.E('div', { 'class': 'sbd-sub-form-grid' }, [
                    ui.field('Kata kunci penyertaan', input(working.include, 'misalnya Hong Kong|Jepang', value => { working.include = value; }), 'Pisahkan dengan |.'),
                    ui.field('Kata kunci pengecualian', input(working.exclude, 'misalnya situs resmi|kedaluwarsa|tersisa', value => { working.exclude = value; }), 'Pisahkan dengan |.')
                ]));
            } else {
                sourceEditor(body);
                body.appendChild(ui.field('File node', pathText, 'Ditulis ke Provider lokal setelah tautan berbagi diuraikan.'));
            }
            const healthToggle = ui.E('select', { 'class': 'sbd-select' }, [
                ui.E('option', { value: '1', selected: working.health ? '' : null }, 'Aktifkan'),
                ui.E('option', { value: '0', selected: working.health ? null : '' }, 'Nonaktifkan')
            ]);
            healthToggle.addEventListener('change', () => { working.health = healthToggle.value === '1'; });
            body.appendChild(ui.field('Pemeriksaan kesehatan', healthToggle, 'Gunakan alamat pemeriksaan 204 default dan periksa setiap 30 menit.'));
        }
        tagValue.addEventListener('input', () => { working.tag = tagValue.value; working.path = existing && existing.tag === working.tag && existing.path ? existing.path : providerPath(working.tag); pathText.textContent = working.path; });
        draw();
        ui.modal(existing ? 'Edit sumber langganan' : working.kind === 'remote' ? 'Tambah langganan jarak jauh' : 'Impor node lokal', body, {
            subtitle: working.kind === 'remote' ? 'Provider akan diperbarui dan sing-box dimulai ulang setelah disimpan.' : 'Uraikan tautan berbagi untuk membuat Provider node lokal.',
            cancelText: 'Batal', confirmText: existing ? 'Simpan dan terapkan' : 'Tambah dan terapkan', width: '760px',
            onConfirm: async () => {
                const tag = working.tag.trim();
                if (!tag) throw new Error('Nama langganan tidak boleh kosong');
                if (providers().some((item, itemIndex) => item.tag === tag && itemIndex !== index)) throw new Error('Nama langganan sudah digunakan');
                const path = providerPath(tag);
                if (working.kind === 'remote') {
                    if (!/^https?:\/\/\S+$/i.test(working.url.trim())) throw new Error('Masukkan URL langganan HTTP/HTTPS yang valid');
                } else if ((!existing || existing.kind !== 'local') && !(imported && imported.count)) {
                    throw new Error('Uraikan node dan tulis ke file lokal terlebih dahulu');
                }
                if (existing && existing.kind === 'local' && existing.path && existing.tag !== tag) {
                    throw new Error('Setelah nama langganan lokal diubah, file node harus diuraikan kembali');
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
                await applyProviders(next, existing ? 'Sumber langganan diperbarui' : 'Sumber langganan ditambahkan');
            }
        });
    }

    render();
    await load();
}

return baseclass.extend({ render });

