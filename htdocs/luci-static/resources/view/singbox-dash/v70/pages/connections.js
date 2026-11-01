'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';

const REFRESH_MS = 3000;
const PAGE_SIZE = 50;

function endpoint(host, port) {
    const value = String(host || '').trim();
    if (!value) return '—';
    const suffix = port ? ':' + String(port) : '';
    return value.includes(':') && !value.startsWith('[') ? '[' + value + ']' + suffix : value + suffix;
}

function connectionFrom(item) {
    const metadata = item && item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    const chains = Array.isArray(item && item.chains) ? item.chains.map(String).filter(Boolean) : [];
    return {
        id: String(item && item.id || ''),
        host: String(metadata.host || metadata.sniffHost || ''),
        destination: String(metadata.destinationIP || ''),
        destinationPort: String(metadata.destinationPort || ''),
        source: String(metadata.sourceIP || ''),
        sourcePort: String(metadata.sourcePort || ''),
        network: String(metadata.network || '').toLowerCase(),
        protocol: String(metadata.type || ''),
        process: String(metadata.processPath || '').replace(/\s+\(\d+\)$/, ''),
        chains: chains,
        rule: item && (item.rule || item.rulePayload)
            ? String(item.rule || '') + (item.rulePayload ? ' · ' + String(item.rulePayload) : '')
            : '',
        upload: Math.max(0, Number(item && item.upload) || 0),
        download: Math.max(0, Number(item && item.download) || 0),
        start: String(item && item.start || '')
    };
}

function rateText(value) {
    const number = Math.max(0, Number(value) || 0);
    return api.formatBytes(number) + '/s';
}

function durationText(value) {
    const started = Date.parse(String(value || ''));
    if (!Number.isFinite(started)) return '—';
    return api.formatUptime(Math.max(0, (Date.now() - started) / 1000));
}

function detailPair(label, value) {
    return [
        ui.E('dt', {}, label),
        ui.E('dd', {}, value == null || value === '' ? '—' : String(value))
    ];
}

async function render(host, ctx) {
    let snapshot = null;
    let previous = null;
    let rates = new Map();
    let totalRates = { upload: 0, download: 0 };
    let error = '';
    let loading = true;
    let paused = false;
    let closing = false;
    let request = 0;
    let page = 0;
    let filter = '';
    let sourceFilter = '';
    let networkFilter = '';
    let chainFilter = '';
    let sort = 'started';
    let timer = null;

    const root = ui.E('div', { 'class': 'sbd-stack sbd-connections-page' });
    host.appendChild(root);

    const activeValue = ui.E('div', { 'class': 'sbd-stat-value' }, '—');
    const activeSub = ui.E('div', { 'class': 'sbd-stat-sub' }, 'Snapshot saat ini');
    const upValue = ui.E('div', { 'class': 'sbd-stat-value' }, '—');
    const upSub = ui.E('div', { 'class': 'sbd-stat-sub' }, 'Total unggahan —');
    const downValue = ui.E('div', { 'class': 'sbd-stat-value' }, '—');
    const downSub = ui.E('div', { 'class': 'sbd-stat-sub' }, 'Total unduhan —');
    const memoryValue = ui.E('div', { 'class': 'sbd-stat-value' }, '—');
    const memorySub = ui.E('div', { 'class': 'sbd-stat-sub' }, 'Clash API');
    const sampleText = ui.E('div', { 'class': 'sbd-conn-sample' }, 'Menunggu sampel pertama');
    const summaryCard = ui.card('Ringkasan koneksi', [
        ui.E('div', { 'class': 'sbd-stat-grid sbd-stat-grid-4 sbd-conn-stats' }, [
            ui.E('div', { 'class': 'sbd-stat' }, [ui.E('div', { 'class': 'sbd-stat-label' }, 'Koneksi aktif'), activeValue, activeSub]),
            ui.E('div', { 'class': 'sbd-stat' }, [ui.E('div', { 'class': 'sbd-stat-label' }, 'Kecepatan unggah'), upValue, upSub]),
            ui.E('div', { 'class': 'sbd-stat' }, [ui.E('div', { 'class': 'sbd-stat-label' }, 'Kecepatan unduh'), downValue, downSub]),
            ui.E('div', { 'class': 'sbd-stat' }, [ui.E('div', { 'class': 'sbd-stat-label' }, 'Memori kernel'), memoryValue, memorySub])
        ]),
        sampleText
    ], { icon: 'activity', iconTone: 'blue', className: 'sbd-conn-summary' });

    const searchInput = ui.E('input', {
        type: 'search', 'class': 'sbd-input',
        placeholder: 'Cari target, sumber, rantai proxy, proses, atau aturan...',
        input: event => { filter = String(event.target.value || '').trim().toLowerCase(); page = 0; paint(); }
    });
    const sourceSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': 'Filter sumber', change: event => { sourceFilter = event.target.value; page = 0; paint(); } });
    const networkSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': 'Filter jenis jaringan', change: event => { networkFilter = event.target.value; page = 0; paint(); } });
    const chainSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': 'Filter rantai proxy', change: event => { chainFilter = event.target.value; page = 0; paint(); } });
    const sortSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': 'Urutkan koneksi', change: event => { sort = event.target.value; page = 0; paint(); } }, [
        ui.E('option', { value: 'started' }, 'Koneksi terbaru'),
        ui.E('option', { value: 'downloadRate' }, 'Kecepatan unduh'),
        ui.E('option', { value: 'uploadRate' }, 'Kecepatan unggah'),
        ui.E('option', { value: 'traffic' }, 'Total lalu lintas'),
        ui.E('option', { value: 'destination' }, 'Alamat tujuan')
    ]);

    const pauseButton = ui.btn('Jeda penyegaran', {
        icon: 'stop', small: true, onClick: () => {
            paused = !paused;
            const label = pauseButton.querySelector('span:not(.sbd-icon)');
            if (label) label.textContent = paused ? 'Lanjutkan penyegaran' : 'Jeda penyegaran';
            paint();
        }
    });
    const refreshButton = ui.btn('', { icon: 'refresh', iconOnly: true, title: 'Segarkan koneksi sekarang', onClick: () => load(false) });
    const closeFilteredButton = ui.btn('Tutup hasil filter', {
        icon: 'trash', small: true, variant: 'danger', onClick: () => closeVisible()
    });
    const closeAllButton = ui.btn('Tutup semua', {
        icon: 'trash', small: true, variant: 'danger', onClick: () => closeAll()
    });

    const toolbar = ui.E('div', { 'class': 'sbd-conn-toolbar' }, [
        ui.E('div', { 'class': 'sbd-rule-search sbd-conn-search' }, [ui.icon('search'), searchInput]),
        ui.E('div', { 'class': 'sbd-conn-filters' }, [sourceSelect, networkSelect, chainSelect, sortSelect]),
        ui.E('div', { 'class': 'sbd-btn-row sbd-conn-actions' }, [pauseButton, refreshButton, closeFilteredButton, closeAllButton])
    ]);

    const listHost = ui.E('div', { 'class': 'sbd-connection-list' });
    const pageLabel = ui.E('span', { 'class': 'sbd-conn-page-label' }, '0 koneksi');
    const prevButton = ui.btn('', { icon: 'chevronRight', iconOnly: true, title: 'Halaman sebelumnya', onClick: () => { page = Math.max(0, page - 1); paint(); } });
    const nextButton = ui.btn('', { icon: 'chevronRight', iconOnly: true, title: 'Halaman berikutnya', onClick: () => { page += 1; paint(); } });
    prevButton.querySelector('.sbd-icon').style.transform = 'rotate(180deg)';
    const pager = ui.E('div', { 'class': 'sbd-conn-pager' }, [pageLabel, ui.E('div', { 'class': 'sbd-btn-row' }, [prevButton, nextButton])]);
    const listCard = ui.card('Koneksi aktif', [toolbar, listHost, pager], {
        icon: 'link', iconTone: 'purple', flush: true,
        subtitle: 'Snapshot langsung · kecepatan dihitung dari dua sampel berurutan'
    });

    summaryCard.querySelector('.sbd-card-head').appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, [pauseButton, refreshButton]));
    root.appendChild(summaryCard);
    root.appendChild(listCard);

    function currentConnections() {
        return snapshot && Array.isArray(snapshot.connections) ? snapshot.connections : [];
    }

    function filteredConnections() {
        return currentConnections().filter(item => {
            if (sourceFilter && item.source !== sourceFilter) return false;
            if (networkFilter && item.network !== networkFilter) return false;
            if (chainFilter && item.chains.indexOf(chainFilter) < 0) return false;
            if (!filter) return true;
            return [item.host, item.destination, item.destinationPort, item.source,
                item.process, item.rule, item.protocol, item.chains.join(' ')]
                .some(value => String(value || '').toLowerCase().includes(filter));
        });
    }

    function sortConnections(items) {
        return items.slice().sort((left, right) => {
            let a, b;
            if (sort === 'downloadRate' || sort === 'uploadRate') {
                const rate = rates.get(left.id) || {};
                const peer = rates.get(right.id) || {};
                a = Number(rate[sort === 'uploadRate' ? 'upload' : 'download'] || 0);
                b = Number(peer[sort === 'uploadRate' ? 'upload' : 'download'] || 0);
            } else if (sort === 'traffic') {
                a = left.upload + left.download;
                b = right.upload + right.download;
            } else if (sort === 'destination') {
                return String(left.host || left.destination || '').localeCompare(
                    String(right.host || right.destination || ''), 'zh-CN', { numeric: true });
            } else {
                a = Date.parse(left.start) || 0;
                b = Date.parse(right.start) || 0;
            }
            return b - a || left.id.localeCompare(right.id);
        });
    }

    function setOptions(select, values, allLabel, current) {
        select.innerHTML = '';
        select.appendChild(ui.E('option', { value: '' }, allLabel));
        values.forEach(value => select.appendChild(ui.E('option', { value }, value)));
        select.value = values.indexOf(current) >= 0 ? current : '';
        return select.value;
    }

    function syncFilters() {
        const connections = currentConnections();
        const sources = Array.from(new Set(connections.map(item => item.source).filter(Boolean))).sort();
        const networks = Array.from(new Set(connections.map(item => item.network).filter(Boolean))).sort();
        const chains = Array.from(new Set(connections.flatMap(item => item.chains).filter(Boolean))).sort((a, b) =>
            String(a).localeCompare(String(b), 'zh-CN', { numeric: true }));
        sourceFilter = setOptions(sourceSelect, sources, 'Semua sumber', sourceFilter);
        networkFilter = setOptions(networkSelect, networks, 'Semua protokol', networkFilter);
        chainFilter = setOptions(chainSelect, chains, 'Semua rantai proxy', chainFilter);
    }

    function updateMetrics() {
        const connections = currentConnections();
        const upload = snapshot ? snapshot.uploadTotal : 0;
        const download = snapshot ? snapshot.downloadTotal : 0;
        activeValue.textContent = connections.length + ' koneksi';
        activeSub.textContent = paused ? 'Penyegaran dijeda' : 'Segarkan setiap 3 detik';
        upValue.textContent = rateText(totalRates.upload);
        upSub.textContent = 'Total unggahan ' + api.formatBytes(upload);
        downValue.textContent = rateText(totalRates.download);
        downSub.textContent = 'Total unduhan ' + api.formatBytes(download);
        memoryValue.textContent = snapshot ? api.formatBytes(snapshot.memory) : '—';
        memorySub.textContent = 'Clash API';
        if (snapshot) {
            const sample = new Date(snapshot.sampledAt).toLocaleTimeString('zh-CN', { hour12: false });
            sampleText.textContent = error
                ? 'Gagal membaca; menampilkan snapshot terakhir dari ' + sample
                : (paused ? 'Dijeda · ' : '') + 'Sampel terakhir ' + sample;
            sampleText.classList.toggle('bad', !!error);
        }
    }

    function infoButton(item) {
        return ui.btn('', {
            icon: 'info', iconOnly: true, small: true, title: 'Lihat detail koneksi',
            onClick: () => showDetails(item)
        });
    }

    function closeButton(item) {
        return ui.btn('', {
            icon: 'x', iconOnly: true, small: true, variant: 'danger', title: 'Tutup koneksi ini',
            disabled: closing,
            onClick: () => closeConnections([item], 'Tutup koneksi ini')
        });
    }

    function connectionRow(item) {
        const rate = rates.get(item.id) || { upload: 0, download: 0 };
        const destination = item.host || endpoint(item.destination, item.destinationPort);
        const sub = [
            item.host && item.destination ? endpoint(item.destination, item.destinationPort) : '',
            item.process, item.rule
        ].filter(Boolean).join(' · ');
        const primary = ui.E('div', { 'class': 'sbd-conn-primary' }, [
            ui.E('span', { 'class': 'sbd-conn-icon' }, ui.icon(item.network === 'udp' ? 'activity' : 'link')),
            ui.E('div', { 'class': 'sbd-conn-main' }, [
                ui.E('div', { 'class': 'sbd-conn-dest', title: destination }, destination),
                ui.E('div', { 'class': 'sbd-conn-sub', title: sub || item.id }, sub || 'Koneksi ' + item.id.slice(0, 8))
            ])
        ]);
        const source = ui.E('div', { 'class': 'sbd-conn-cell' }, [
            ui.E('span', { 'class': 'sbd-conn-label' }, 'Sumber'),
            ui.E('span', { 'class': 'sbd-conn-value' }, endpoint(item.source, item.sourcePort))
        ]);
        const chain = ui.E('div', { 'class': 'sbd-conn-cell sbd-conn-chain' }, [
            ui.E('span', { 'class': 'sbd-conn-label' }, 'Rantai proxy'),
            ui.E('span', { 'class': 'sbd-conn-value', title: item.chains.join(' → ') }, item.chains.length ? item.chains.join(' → ') : 'Langsung')
        ]);
        const traffic = ui.E('div', { 'class': 'sbd-conn-cell sbd-conn-traffic' }, [
            ui.E('span', { 'class': 'sbd-conn-label' }, 'Kecepatan / total'),
            ui.E('span', { 'class': 'sbd-conn-value' }, [
                ui.E('span', {}, '↑ ' + rateText(rate.upload) + ' · ' + api.formatBytes(item.upload)),
                ui.E('span', {}, '↓ ' + rateText(rate.download) + ' · ' + api.formatBytes(item.download))
            ])
        ]);
        return ui.E('article', { 'class': 'sbd-conn-row', 'data-id': item.id }, [
            primary, source, chain, traffic,
            ui.E('div', { 'class': 'sbd-conn-row-actions' }, [infoButton(item), closeButton(item)])
        ]);
    }

    function paint() {
        syncFilters();
        updateMetrics();
        const filtered = sorted();
        const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        page = Math.min(page, pageCount - 1);
        listHost.innerHTML = '';
        pageLabel.textContent = 'Cocok ' + filtered.length + ' / ' + currentConnections().length + ' · Halaman ' + (page + 1) + ' / ' + pageCount;
        prevButton.disabled = page <= 0;
        nextButton.disabled = page >= pageCount - 1;
        closeFilteredButton.disabled = closing || !filtered.length;
        closeAllButton.disabled = closing || !currentConnections().length;
        if (loading && !snapshot) {
            listHost.appendChild(ui.loading('Memuat koneksi aktif'));
            return;
        }
        if (error && !snapshot) {
            listHost.appendChild(ui.note('Gagal membaca koneksi: ' + error, 'bad'));
            listHost.appendChild(ui.E('div', { 'class': 'sbd-btn-row sbd-conn-retry' }, ui.btn('Coba lagi', {
                icon: 'refresh', onClick: () => load(false)
            })));
            return;
        }
        if (!filtered.length) {
            listHost.appendChild(ui.empty(currentConnections().length ? 'Tidak ada koneksi yang cocok dengan filter saat ini' : 'Tidak ada koneksi aktif saat ini'));
            return;
        }
        const start = page * PAGE_SIZE;
        filtered.slice(start, start + PAGE_SIZE).forEach(item => listHost.appendChild(connectionRow(item)));
    }

    function ingest(value) {
        const now = Date.now();
        const connections = Array.isArray(value && value.connections)
            ? value.connections.map(connectionFrom).filter(item => item.id) : [];
        if (previous && now > previous.at) {
            const seconds = (now - previous.at) / 1000;
            const old = previous.connections;
            const nextRates = new Map();
            connections.forEach(item => {
                const base = old.get(item.id);
                if (!base || item.upload < base.upload || item.download < base.download) return;
                nextRates.set(item.id, {
                    upload: (item.upload - base.upload) / seconds,
                    download: (item.download - base.download) / seconds
                });
            });
            rates = nextRates;
            const uploadTotal = Math.max(0, Number(value && value.uploadTotal) || 0);
            const downloadTotal = Math.max(0, Number(value && value.downloadTotal) || 0);
            totalRates = {
                upload: uploadTotal >= previous.uploadTotal ? (uploadTotal - previous.uploadTotal) / seconds : 0,
                download: downloadTotal >= previous.downloadTotal ? (downloadTotal - previous.downloadTotal) / seconds : 0
            };
        }
        const uploadTotal = Math.max(0, Number(value && value.uploadTotal) || 0);
        const downloadTotal = Math.max(0, Number(value && value.downloadTotal) || 0);
        snapshot = {
            connections,
            uploadTotal,
            downloadTotal,
            memory: Math.max(0, Number(value && value.memory) || 0),
            sampledAt: now
        };
        previous = {
            at: now,
            uploadTotal,
            downloadTotal,
            connections: new Map(connections.map(item => [item.id, item]))
        };
    }

    function sorted() {
        return sortConnections(filteredConnections());
    }

    function showDetails(item) {
        const rate = rates.get(item.id) || { upload: 0, download: 0 };
        ui.modal('Detail koneksi', [
            ui.E('dl', { 'class': 'sbd-conn-detail-grid' }, [
                ...detailPair('Domain tujuan', item.host),
                ...detailPair('Alamat tujuan', endpoint(item.destination, item.destinationPort)),
                ...detailPair('Sumber', endpoint(item.source, item.sourcePort)),
                ...detailPair('Jaringan', item.network ? item.network.toUpperCase() : ''),
                ...detailPair('Protokol', item.protocol),
                ...detailPair('Rantai proxy', item.chains.length ? item.chains.join(' → ') : 'Langsung'),
                ...detailPair('Proses', item.process),
                ...detailPair('Aturan yang cocok', item.rule),
                ...detailPair('Waktu mulai', item.start ? api.formatDate(item.start) : ''),
                ...detailPair('Durasi koneksi', durationText(item.start)),
                ...detailPair('Kecepatan langsung', '↑ ' + rateText(rate.upload) + ' / ↓ ' + rateText(rate.download)),
                ...detailPair('Total lalu lintas', '↑ ' + api.formatBytes(item.upload) + ' / ↓ ' + api.formatBytes(item.download)),
                ...detailPair('ID koneksi', item.id)
            ])
        ], { width: '680px' });
    }

    async function closeConnections(items, label) {
        const ids = Array.from(new Set(items.map(item => item.id).filter(Boolean)));
        if (!ids.length || closing) return;
        const ok = await ui.confirm(label || 'Tutup koneksi',
            ids.length + ' koneksi akan ditutup. Aplikasi mungkin tersambung kembali secara otomatis; koneksi baru setelah konfirmasi tidak akan ditutup.', 'Tutup', true);
        if (!ok) return;
        closing = true;
        paint();
        try {
            for (let index = 0; index < ids.length; index += 6) {
                await Promise.allSettled(ids.slice(index, index + 6).map(id =>
                    api.clash('DELETE', '/connections/' + encodeURIComponent(id))));
            }
            ui.notify('Permintaan menutup ' + ids.length + ' koneksi telah dikirim', 'success');
            await load(true);
        } catch (reason) {
            ui.notify('Gagal menutup koneksi: ' + api.errorText(reason), 'error', 7000);
        } finally {
            closing = false;
            paint();
        }
    }

    function closeVisible() {
        return closeConnections(sorted(), 'Tutup hasil filter');
    }

    function closeAll() {
        return closeConnections(currentConnections(), 'Tutup semua koneksi');
    }

    function clashReady() {
        const status = ctx.status || {};
        const apiInfo = status.api || {};
        return !!(status.running && apiInfo.port && apiInfo.valid !== false);
    }

    async function load(silent) {
        if (!clashReady()) {
            const status = ctx.status || {};
            const apiInfo = status.api || {};
            loading = false;
            error = !status.running ? 'sing-box tidak berjalan, koneksi tidak dapat dibaca'
                : (apiInfo.error || 'Clash API tidak diaktifkan dalam konfigurasi saat ini');
            paint();
            return;
        }
        if (loading && !silent) paint();
        const token = ++request;
        try {
            const value = await Promise.race([
                api.clashFresh('GET', '/connections'),
                new Promise((_, reject) => window.setTimeout(() => reject(new Error('Waktu baca koneksi habis')), 10000))
            ]);
            if (token !== request) return;
            ingest(value || {});
            error = '';
        } catch (reason) {
            if (token !== request) return;
            error = api.errorText(reason);
        } finally {
            if (token === request) {
                loading = false;
                paint();
            }
        }
    }

    paint();
    await load(false);
    timer = window.setInterval(() => {
        if (!paused && !document.hidden) load(true);
    }, REFRESH_MS);
    ctx.onCleanup(() => {
        if (timer) window.clearInterval(timer);
    });
}

return baseclass.extend({ render });


