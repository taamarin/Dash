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
    const activeSub = ui.E('div', { 'class': 'sbd-stat-sub' }, '当前快照');
    const upValue = ui.E('div', { 'class': 'sbd-stat-value' }, '—');
    const upSub = ui.E('div', { 'class': 'sbd-stat-sub' }, '累计上传 —');
    const downValue = ui.E('div', { 'class': 'sbd-stat-value' }, '—');
    const downSub = ui.E('div', { 'class': 'sbd-stat-sub' }, '累计下载 —');
    const memoryValue = ui.E('div', { 'class': 'sbd-stat-value' }, '—');
    const memorySub = ui.E('div', { 'class': 'sbd-stat-sub' }, 'Clash API');
    const sampleText = ui.E('div', { 'class': 'sbd-conn-sample' }, '等待第一次采样');

    const summaryCard = ui.card('连接概览', [
        ui.E('div', { 'class': 'sbd-stat-grid sbd-stat-grid-4 sbd-conn-stats' }, [
            ui.E('div', { 'class': 'sbd-stat' }, [ui.E('div', { 'class': 'sbd-stat-label' }, '活动连接'), activeValue, activeSub]),
            ui.E('div', { 'class': 'sbd-stat' }, [ui.E('div', { 'class': 'sbd-stat-label' }, '上传速率'), upValue, upSub]),
            ui.E('div', { 'class': 'sbd-stat' }, [ui.E('div', { 'class': 'sbd-stat-label' }, '下载速率'), downValue, downSub]),
            ui.E('div', { 'class': 'sbd-stat' }, [ui.E('div', { 'class': 'sbd-stat-label' }, '内核内存'), memoryValue, memorySub])
        ]),
        sampleText
    ], { icon: 'activity', iconTone: 'blue', className: 'sbd-conn-summary' });

    const searchInput = ui.E('input', {
        type: 'search', 'class': 'sbd-input',
        placeholder: '搜索目标、来源、代理链、进程或规则...',
        input: event => { filter = String(event.target.value || '').trim().toLowerCase(); page = 0; paint(); }
    });
    const sourceSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': '来源筛选', change: event => { sourceFilter = event.target.value; page = 0; paint(); } });
    const networkSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': '网络类型筛选', change: event => { networkFilter = event.target.value; page = 0; paint(); } });
    const chainSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': '代理链筛选', change: event => { chainFilter = event.target.value; page = 0; paint(); } });
    const sortSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': '连接排序', change: event => { sort = event.target.value; page = 0; paint(); } }, [
        ui.E('option', { value: 'started' }, '最新连接'),
        ui.E('option', { value: 'downloadRate' }, '下载速率'),
        ui.E('option', { value: 'uploadRate' }, '上传速率'),
        ui.E('option', { value: 'traffic' }, '累计流量'),
        ui.E('option', { value: 'destination' }, '目标地址')
    ]);

    const pauseButton = ui.btn('暂停刷新', {
        icon: 'stop', small: true, onClick: () => {
            paused = !paused;
            const label = pauseButton.querySelector('span:not(.sbd-icon)');
            if (label) label.textContent = paused ? '继续刷新' : '暂停刷新';
            paint();
        }
    });
    const refreshButton = ui.btn('', { icon: 'refresh', iconOnly: true, title: '立即刷新连接', onClick: () => load(false) });
    const closeFilteredButton = ui.btn('关闭筛选结果', {
        icon: 'trash', small: true, variant: 'danger', onClick: () => closeVisible()
    });
    const closeAllButton = ui.btn('关闭全部', {
        icon: 'trash', small: true, variant: 'danger', onClick: () => closeAll()
    });

    const toolbar = ui.E('div', { 'class': 'sbd-conn-toolbar' }, [
        ui.E('div', { 'class': 'sbd-rule-search sbd-conn-search' }, [ui.icon('search'), searchInput]),
        ui.E('div', { 'class': 'sbd-conn-filters' }, [sourceSelect, networkSelect, chainSelect, sortSelect]),
        ui.E('div', { 'class': 'sbd-btn-row sbd-conn-actions' }, [pauseButton, refreshButton, closeFilteredButton, closeAllButton])
    ]);

    const listHost = ui.E('div', { 'class': 'sbd-connection-list' });
    const pageLabel = ui.E('span', { 'class': 'sbd-conn-page-label' }, '0 条');
    const prevButton = ui.btn('', { icon: 'chevronRight', iconOnly: true, title: '上一页', onClick: () => { page = Math.max(0, page - 1); paint(); } });
    const nextButton = ui.btn('', { icon: 'chevronRight', iconOnly: true, title: '下一页', onClick: () => { page += 1; paint(); } });
    prevButton.querySelector('.sbd-icon').style.transform = 'rotate(180deg)';
    const pager = ui.E('div', { 'class': 'sbd-conn-pager' }, [pageLabel, ui.E('div', { 'class': 'sbd-btn-row' }, [prevButton, nextButton])]);
    const listCard = ui.card('活动连接', [toolbar, listHost, pager], {
        icon: 'link', iconTone: 'purple', flush: true,
        subtitle: '实时快照 · 速率来自连续两次采样'
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
        sourceFilter = setOptions(sourceSelect, sources, '全部来源', sourceFilter);
        networkFilter = setOptions(networkSelect, networks, '全部协议', networkFilter);
        chainFilter = setOptions(chainSelect, chains, '全部代理链', chainFilter);
    }

    function updateMetrics() {
        const connections = currentConnections();
        const upload = snapshot ? snapshot.uploadTotal : 0;
        const download = snapshot ? snapshot.downloadTotal : 0;
        activeValue.textContent = connections.length + ' 条';
        activeSub.textContent = paused ? '刷新已暂停' : '每 3 秒刷新';
        upValue.textContent = rateText(totalRates.upload);
        upSub.textContent = '累计上传 ' + api.formatBytes(upload);
        downValue.textContent = rateText(totalRates.download);
        downSub.textContent = '累计下载 ' + api.formatBytes(download);
        memoryValue.textContent = snapshot ? api.formatBytes(snapshot.memory) : '—';
        memorySub.textContent = 'Clash API';
        if (snapshot) {
            const sample = new Date(snapshot.sampledAt).toLocaleTimeString('zh-CN', { hour12: false });
            sampleText.textContent = error
                ? '读取失败，显示 ' + sample + ' 的上次快照'
                : (paused ? '已暂停 · ' : '') + '最后采样 ' + sample;
            sampleText.classList.toggle('bad', !!error);
        }
    }

    function infoButton(item) {
        return ui.btn('', {
            icon: 'info', iconOnly: true, small: true, title: '查看连接详情',
            onClick: () => showDetails(item)
        });
    }

    function closeButton(item) {
        return ui.btn('', {
            icon: 'x', iconOnly: true, small: true, variant: 'danger', title: '关闭此连接',
            disabled: closing,
            onClick: () => closeConnections([item], '关闭此连接')
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
                ui.E('div', { 'class': 'sbd-conn-sub', title: sub || item.id }, sub || '连接 ' + item.id.slice(0, 8))
            ])
        ]);
        const source = ui.E('div', { 'class': 'sbd-conn-cell' }, [
            ui.E('span', { 'class': 'sbd-conn-label' }, '来源'),
            ui.E('span', { 'class': 'sbd-conn-value' }, endpoint(item.source, item.sourcePort))
        ]);
        const chain = ui.E('div', { 'class': 'sbd-conn-cell sbd-conn-chain' }, [
            ui.E('span', { 'class': 'sbd-conn-label' }, '代理链'),
            ui.E('span', { 'class': 'sbd-conn-value', title: item.chains.join(' → ') }, item.chains.length ? item.chains.join(' → ') : '直连')
        ]);
        const traffic = ui.E('div', { 'class': 'sbd-conn-cell sbd-conn-traffic' }, [
            ui.E('span', { 'class': 'sbd-conn-label' }, '速率 / 累计'),
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
        pageLabel.textContent = '匹配 ' + filtered.length + ' / ' + currentConnections().length + ' 条 · 第 ' + (page + 1) + ' / ' + pageCount + ' 页';
        prevButton.disabled = page <= 0;
        nextButton.disabled = page >= pageCount - 1;
        closeFilteredButton.disabled = closing || !filtered.length;
        closeAllButton.disabled = closing || !currentConnections().length;
        if (loading && !snapshot) {
            listHost.appendChild(ui.loading('读取活动连接'));
            return;
        }
        if (error && !snapshot) {
            listHost.appendChild(ui.note('连接读取失败：' + error, 'bad'));
            listHost.appendChild(ui.E('div', { 'class': 'sbd-btn-row sbd-conn-retry' }, ui.btn('重试', {
                icon: 'refresh', onClick: () => load(false)
            })));
            return;
        }
        if (!filtered.length) {
            listHost.appendChild(ui.empty(currentConnections().length ? '没有匹配当前筛选条件的连接' : '当前没有活动连接'));
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
        ui.modal('连接详情', [
            ui.E('dl', { 'class': 'sbd-conn-detail-grid' }, [
                ...detailPair('目标域名', item.host),
                ...detailPair('目标地址', endpoint(item.destination, item.destinationPort)),
                ...detailPair('来源', endpoint(item.source, item.sourcePort)),
                ...detailPair('网络', item.network ? item.network.toUpperCase() : ''),
                ...detailPair('协议', item.protocol),
                ...detailPair('代理链', item.chains.length ? item.chains.join(' → ') : '直连'),
                ...detailPair('进程', item.process),
                ...detailPair('规则命中', item.rule),
                ...detailPair('开始时间', item.start ? api.formatDate(item.start) : ''),
                ...detailPair('连接时长', durationText(item.start)),
                ...detailPair('实时速率', '↑ ' + rateText(rate.upload) + ' / ↓ ' + rateText(rate.download)),
                ...detailPair('累计流量', '↑ ' + api.formatBytes(item.upload) + ' / ↓ ' + api.formatBytes(item.download)),
                ...detailPair('连接 ID', item.id)
            ])
        ], { width: '680px' });
    }

    async function closeConnections(items, label) {
        const ids = Array.from(new Set(items.map(item => item.id).filter(Boolean)));
        if (!ids.length || closing) return;
        const ok = await ui.confirm(label || '关闭连接',
            '将关闭 ' + ids.length + ' 条连接。应用可能自动重连，确认后新建的连接不会被关闭。', '关闭', true);
        if (!ok) return;
        closing = true;
        paint();
        try {
            for (let index = 0; index < ids.length; index += 6) {
                await Promise.allSettled(ids.slice(index, index + 6).map(id =>
                    api.clash('DELETE', '/connections/' + encodeURIComponent(id))));
            }
            ui.notify('已请求关闭 ' + ids.length + ' 条连接', 'success');
            await load(true);
        } catch (reason) {
            ui.notify('关闭连接失败：' + api.errorText(reason), 'error', 7000);
        } finally {
            closing = false;
            paint();
        }
    }

    function closeVisible() {
        return closeConnections(sorted(), '关闭筛选结果');
    }

    function closeAll() {
        return closeConnections(currentConnections(), '关闭全部连接');
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
            error = !status.running ? 'sing-box 未运行，无法读取连接'
                : (apiInfo.error || '当前配置中未启用 Clash API');
            paint();
            return;
        }
        if (loading && !silent) paint();
        const token = ++request;
        try {
            const value = await Promise.race([
                api.clashFresh('GET', '/connections'),
                new Promise((_, reject) => window.setTimeout(() => reject(new Error('读取连接超时')), 10000))
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



