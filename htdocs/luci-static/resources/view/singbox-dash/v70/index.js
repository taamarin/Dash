'use strict';
'require view';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';
const pageModule = id => 'view.singbox-dash.v70.pages.' + id;
const ASSET_VERSION = 'db3288810c6a';
const PAGES = [
    { id: 'overview', label: 'Beranda', icon: 'overview', module: pageModule('overview') },
    { id: 'proxies', label: 'Proxy', icon: 'proxies', module: pageModule('proxies') },
    { id: 'subscriptions', label: 'Langganan', icon: 'database', module: pageModule('subscriptions') },
    { id: 'connections', label: 'Koneksi', icon: 'activity', module: pageModule('connections') },
    { id: 'trace', label: 'Penelusuran', icon: 'link', module: pageModule('trace') },
    { id: 'rules', label: 'Aturan', icon: 'rules', module: pageModule('rules') },
    { id: 'config', label: 'Konfigurasi', icon: 'config', module: pageModule('config') },
    { id: 'kernel', label: 'Kernel', icon: 'kernel', module: pageModule('kernel') },
    { id: 'tools', label: 'Diagnostik & Log', icon: 'tools', module: pageModule('tools') },
    { id: 'settings', label: 'Pengaturan', icon: 'settings', module: pageModule('settings'), hidden: true }
];
const NAV_GROUPS = [
    { id: 'overview', label: 'Beranda', icon: 'overview', items: ['overview'] },
    { id: 'network', label: 'Jaringan', icon: 'network', items: ['proxies', 'subscriptions', 'connections', 'trace'] },
    { id: 'rules', label: 'Aturan', icon: 'rules', items: ['rules'] },
    { id: 'config', label: 'Konfigurasi', icon: 'config', items: ['config'] },
    { id: 'system', label: 'Sistem', icon: 'settings', items: ['kernel', 'tools', 'settings'] },
    { id: 'panel', label: 'Panel', icon: 'globe', external: true }
];
const PAGE_LABELS = Object.fromEntries(PAGES.map(page => [page.id, page.label]));
const PAGE_TITLES = {
    overview: 'Dasbor',
    proxies: 'Proxy',
    subscriptions: 'Node dan langganan',
    connections: 'Koneksi',
    trace: 'Penelusuran',
    rules: 'Aturan',
    config: 'Konfigurasi',
    kernel: 'Pengelolaan kernel',
    tools: 'Diagnostik & log',
    settings: 'Pengaturan panel'
};
const PAGE_SUBTITLES = {
    overview: 'Lalu lintas langsung · Kontrol layanan · Ringkasan operasi',
    proxies: 'Grup proxy dan node',
    subscriptions: 'Sumber langganan, node, dan impor',
    connections: 'Koneksi aktif dan lalu lintas langsung',
    trace: 'Pencocokan aturan dan rute outbound akhir',
    rules: 'Aturan perutean dan kumpulan aturan',
    config: 'Global · DNS · Inbound · Outbound',
    kernel: 'Unduh dan alih kernel',
    tools: 'Diagnostik lingkungan · Log langsung · Kontrol layanan',
    settings: 'Pengaturan antarmuka dan pembaruan'
};

function panelUrl(status) {
    const api = status && status.api;
    const port = api && api.port ? Number(api.port) : 0;
    if (!status || !status.running || !Number.isInteger(port) || port < 1 || port > 65535)
        return '';
    if (api.valid === false) return '';
    let host = String(window.location.hostname || '').trim();
    if (!host) return '';
    if (host.includes(':')) host = '[' + host + ']';
    const scheme = api.scheme === 'https' ? 'https' : 'http';
    return scheme + '://' + host + ':' + port + '/ui/';
}
const TERMINAL = ['done', 'failed', 'rolled_back', 'rollback_failed'];
const PHASES = {
    queued: ['Dalam antrean', 5], preparing: ['Menyiapkan', 12], downloading: ['Mengunduh kernel', 24],
    installing: ['Memasang kernel', 42], writing: ['Menulis konfigurasi', 58], network: ['Menerapkan aturan jaringan', 68],
    restarting: ['Memulai ulang layanan', 80], verifying: ['Memeriksa operasi', 92], rolling_back: ['Melakukan rollback', 94],
    done: ['Selesai', 100], failed: ['Gagal', 100], rolled_back: ['Rollback selesai', 100],
    rollback_failed: ['Rollback gagal', 100]
};


function enhanceDocumentLandmarks(header, main) {
    if (!document.querySelector('main, [role="main"]')) {
        main.setAttribute('role', 'main');
        main.setAttribute('aria-label', 'Konten utama SingBox-Dash');
    }
    if (!document.querySelector('header, [role="banner"]')) {
        header.setAttribute('role', 'banner');
        header.setAttribute('aria-label', 'SingBox-Dash');
    } else {
        header.setAttribute('role', 'region');
        header.setAttribute('aria-label', 'Bilah alat SingBox-Dash');
    }
    const themeNav = document.querySelector('#mainmenu.main-left, .sidenav');
    if (themeNav && !themeNav.matches('nav, [role="navigation"]')) {
        themeNav.setAttribute('role', 'navigation');
        themeNav.setAttribute('aria-label', 'Navigasi utama LuCI');
    }
}

async function ensureStylesheet() {
    const base = '/luci-static/resources/view/singbox-dash/v70/style.css';
    const href = base + '?v=' + ASSET_VERSION;
    const existing = document.querySelector('link[data-singbox-dash-style],style[data-singbox-dash-style]');
    if (existing) return;
    if (window.DecompressionStream) {
        try {
            const packed = await new Promise((resolve, reject) => {
                const request = new window.XMLHttpRequest();
                request.open('GET', base + '.gz?v=' + ASSET_VERSION, true);
                request.responseType = 'arraybuffer';
                request.onload = () => {
                    if (request.status >= 200 && request.status < 300) resolve(request.response);
                    else reject(new Error('gzip CSS unavailable'));
                };
                request.onerror = () => reject(new Error('gzip CSS request failed'));
                request.send();
            });
            const css = await new window.Response(
                new window.Blob([packed]).stream().pipeThrough(new window.DecompressionStream('gzip'))
            ).text();
            const style = document.createElement('style');
            style.setAttribute('data-singbox-dash-style', '1');
            style.textContent = css;
            document.head.appendChild(style);
            return;
        } catch (_) {}
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-singbox-dash-style', '1');
    document.head.appendChild(link);
    await new Promise(resolve => {
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', resolve, { once: true });
        window.setTimeout(resolve, 3000);
    });
}

function scrollToTop() {
    try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch (_) {}
    ['.main-right', '#maincontent', '.main'].forEach(selector => {
        const node = document.querySelector(selector);
        if (node && node.scrollTop) node.scrollTop = 0;
    });
}

function initialPage(settings) {
    const hash = String(window.location.hash || '').replace(/^#/, '');
    if (PAGES.some(page => page.id === hash)) return hash;
    const configured = settings && settings.default_page;
    return PAGES.some(page => page.id === configured) ? configured : 'overview';
}

function jobError(job) {
    return (job && (job.error || job.rollback_error || job.message)) || 'Eksekusi tugas gagal';
}

return view.extend({
    handleSave: null,
    handleSaveApply: null,
    handleReset: null,

    render: async function() {
        await ensureStylesheet();
        document.title = 'SingBox-Dash';

        let settings = null;
        let status = null;
        let loadError = '';
        let bootFromCache = false;
        let initialOverview = null;
        const cachedBoot = api.bootstrapCached();
        if (cachedBoot) {
            settings = cachedBoot.settings || null;
            status = cachedBoot.status || null;
            bootFromCache = true;
        } else {
            try {
                const hashPage = String(window.location.hash || '').replace(/^#/, '');
                const includeOverview = !hashPage || hashPage === 'overview';
                const boot = await api.bootstrap(true, includeOverview);
                settings = boot.settings || null;
                status = boot.status || null;
                initialOverview = boot.overview || null;
            } catch (error) {
                loadError = api.errorText(error);
                const results = await Promise.allSettled([api.settings(true), api.status(true)]);
                if (results[0].status === 'fulfilled') settings = results[0].value;
                else loadError = api.errorText(results[0].reason) || loadError;
                if (results[1].status === 'fulfilled') status = results[1].value;
                else loadError = api.errorText(results[1].reason) || loadError;
            }
        }

        const state = {
            page: initialPage(settings),
            settings,
            status,
            busy: false,
            cleanups: []
        };
        let statusTime = status ? Date.now() : 0;
        let statusPending = null;

        const statusDot = ui.E('span', { 'class': 'sbd-dot ' + (status && status.running ? 'on' : 'off') });
        const statusText = ui.E('span', { 'aria-live': 'polite', 'aria-atomic': 'true' }, status ? (status.running ? 'Berjalan' : 'Berhenti') : 'Tidak terhubung');
        const pageTitle = ui.E('h1', { 'class': 'sbd-page-title' }, PAGE_TITLES[state.page]);
        const pageSubtitle = ui.E('div', { 'class': 'sbd-page-subtitle' }, PAGE_SUBTITLES[state.page] || '');
        const pageHost = ui.E('div', { 'class': 'sbd-page-host' });
        const app = ui.E('div', { 'class': 'sbd-app' });
        const kernelUpdateNotice = ui.E('div', {
            'class': 'sbd-kernel-update-notice',
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': 'true'
        });
        kernelUpdateNotice.hidden = true;

        const refreshButton = ui.btn('', {
            icon: 'refresh', iconOnly: true, title: 'Muat ulang halaman',
            onClick: () => requestPageReload()
        });
        refreshButton.classList.add('sbd-header-settings');

        const settingsButton = ui.btn('', {
            icon: 'settings', iconOnly: true, title: 'Pengaturan panel',
            onClick: () => navigate('settings')
        });
        settingsButton.classList.add('sbd-header-settings');

        const header = ui.E('div', { 'class': 'sbd-header' }, [
            ui.E('div', { 'class': 'sbd-header-inner' }, [
                ui.E('div', { 'class': 'sbd-brand' }, [
                    ui.E('div', { 'class': 'sbd-logo' },
                        ui.E('img', {
                            src: '/luci-static/resources/view/singbox-dash/v70/logo.png?v=' + ASSET_VERSION,
                            alt: '', 'aria-hidden': 'true', draggable: 'false'
                        })),
                    ui.E('div', { 'class': 'sbd-brand-title' }, 'SingBox-Dash')
                ]),
                ui.E('div', { 'class': 'sbd-header-grow' }),
                ui.E('div', { 'class': 'sbd-header-status', title: 'Status layanan sing-box' }, [statusDot, statusText]),
                refreshButton,
                settingsButton
            ])
        ]);

        const desktopTabs = ui.E('nav', { 'class': 'sbd-tabs', 'aria-label': 'Navigasi utama' });
        const subTabs = ui.E('nav', { 'class': 'sbd-filter-pills sbd-subtabs', 'aria-label': 'Kategori fitur' });
        const bottomTabs = ui.E('nav', { 'class': 'sbd-bottom', 'aria-label': 'Navigasi seluler' });
        let lastGroupPage = Object.create(null);
        try { lastGroupPage = JSON.parse(window.localStorage.getItem('singbox-dash-nav-groups') || '{}') || {}; } catch (_) {}

        function activeGroup() {
            return NAV_GROUPS.find(group => !group.external && group.items.includes(state.page));
        }

        function groupTarget(group) {
            if (!group || !group.items.length) return 'overview';
            if (group.items.includes(state.page)) return state.page;
            const remembered = lastGroupPage[group.id];
            return group.items.includes(remembered) ? remembered : group.items[0];
        }

        function buildNavigation() {
            desktopTabs.innerHTML = '';
            bottomTabs.innerHTML = '';
            subTabs.innerHTML = '';
            settingsButton.classList.toggle('active', state.page === 'settings');
            const currentGroup = activeGroup();
            if (currentGroup) {
                lastGroupPage[currentGroup.id] = state.page;
                try { window.localStorage.setItem('singbox-dash-nav-groups', JSON.stringify(lastGroupPage)); } catch (_) {}
            }

            function groupIcon(group) {
                return ui.icon(group.icon);
            }

            function navItem(group, mobile) {
                const isExternal = !!group.external;
                const externalUrl = isExternal ? panelUrl(state.status) : '';
                const active = !isExternal && !!currentGroup && currentGroup.id === group.id;
                const target = isExternal ? null : groupTarget(group);
                return ui.E(isExternal ? 'a' : 'button', {
                    type: isExternal ? null : 'button',
                    'class': (mobile ? 'sbd-mobile-tab' : 'sbd-tab')
                        + (active ? ' active' : '') + (isExternal && !externalUrl ? ' disabled' : ''),
                    href: isExternal ? (externalUrl || null) : null,
                    target: isExternal && externalUrl ? '_blank' : null,
                    rel: isExternal && externalUrl ? 'noopener noreferrer' : null,
                    title: isExternal ? (externalUrl ? 'Buka panel' : 'Clash API tidak diaktifkan dalam konfigurasi atau kernel tidak berjalan') : group.label,
                    'aria-current': !isExternal && target === state.page ? 'page' : null,
                    'aria-disabled': isExternal && !externalUrl ? 'true' : null,
                    click: isExternal ? event => {
                        const url = panelUrl(state.status);
                        if (!url) {
                            event.preventDefault();
                            ui.notify('Clash API tidak diaktifkan dalam konfigurasi atau kernel tidak berjalan', 'warn');
                            return;
                        }
                        event.preventDefault();
                        window.open(url, '_blank', 'noopener,noreferrer');
                    } : () => navigate(target)
                }, [groupIcon(group), ui.E('span', {}, group.label)]);
            }

            NAV_GROUPS.forEach(group => {
                desktopTabs.appendChild(navItem(group, false));
                bottomTabs.appendChild(navItem(group, true));
            });
            bottomTabs.style.gridTemplateColumns = 'repeat(' + NAV_GROUPS.length + ', minmax(0, 1fr))';

            app.classList.toggle('sbd-has-subtabs', !!(currentGroup && currentGroup.items.length > 1));
            if (currentGroup && currentGroup.items.length > 1) {
                currentGroup.items.forEach(pageId => {
                    const active = pageId === state.page;
                    subTabs.appendChild(ui.E('button', {
                        type: 'button',
                        'class': 'sbd-filter-pill' + (active ? ' active' : ''),
                        'aria-current': active ? 'page' : null,
                        click: () => navigate(pageId)
                    }, PAGE_LABELS[pageId] || pageId));
                });
                subTabs.hidden = false;
            } else {
                subTabs.hidden = true;
            }
        }

        const main = ui.E('div', { 'class': 'sbd-main' }, [
            ui.E('div', { 'class': 'sbd-page-head' }, [pageTitle, pageSubtitle]),
            pageHost
        ]);
        app.appendChild(header);
        app.appendChild(desktopTabs);
        app.appendChild(subTabs);
        app.appendChild(kernelUpdateNotice);
        app.appendChild(main);
        app.appendChild(bottomTabs);

        function updateHeader(currentStatus) {
            if (currentStatus) state.status = currentStatus;
            const running = !!(state.status && state.status.running);
            statusDot.className = 'sbd-dot ' + (running ? 'on' : 'off');
            statusText.textContent = state.status ? (running ? 'Berjalan' : 'Berhenti') : 'Tidak terhubung';
            const jobs = state.status && state.status.job;
            if (jobs && !TERMINAL.includes(jobs.phase)) {
                statusText.textContent = (PHASES[jobs.phase] || [jobs.phase || 'Sedang memproses tugas'])[0];
                statusDot.className = 'sbd-dot ' + (jobs.phase === 'failed' ? 'off' : '');
            }
        }


        let kernelNoticeCheckStarted = false;
        let kernelNoticeHideTimer = null;

        function hideKernelUpdateNotice() {
            kernelUpdateNotice.classList.remove('show');
            if (kernelNoticeHideTimer) window.clearTimeout(kernelNoticeHideTimer);
            kernelNoticeHideTimer = window.setTimeout(() => {
                kernelUpdateNotice.hidden = true;
                kernelUpdateNotice.innerHTML = '';
                kernelNoticeHideTimer = null;
            }, 180);
        }

        function showKernelUpdateNotice(info) {
            const sourceLabel = info.source_label || 'Saat ini';
            const currentVersion = info.current_version || 'Versi tidak diketahui';
            const latestVersion = info.latest_version || info.latest_tag || 'Versi baru';
            const actionButtons = [];
            const setActionsBusy = busy => actionButtons.forEach(button => { button.disabled = !!busy; });
            async function persist(action) {
                setActionsBusy(true);
                try {
                    await api.setKernelUpdateNotice(action, info.source || '', info.latest_tag || '');
                    hideKernelUpdateNotice();
                } catch (error) {
                    ui.notify('Gagal menyimpan pengaturan pemberitahuan pembaruan: ' + api.errorText(error), 'error', 6000);
                    setActionsBusy(false);
                }
            }
            const viewButton = ui.btn('Lihat pembaruan', {
                icon: 'kernel', variant: 'primary', small: true,
                onClick: () => {
                    hideKernelUpdateNotice();
                    navigate('kernel');
                }
            });
            const skipButton = ui.btn('Lewati kali ini', {
                variant: 'ghost', small: true,
                onClick: () => persist('skip')
            });
            const disableButton = ui.btn('Jangan ingatkan lagi', {
                variant: 'ghost', small: true,
                onClick: () => persist('disable')
            });
            actionButtons.push(viewButton, skipButton, disableButton);
            kernelUpdateNotice.innerHTML = '';
            kernelUpdateNotice.appendChild(ui.E('div', { 'class': 'sbd-kernel-update-surface' }, [
                ui.E('div', { 'class': 'sbd-kernel-update-icon', 'aria-hidden': 'true' }, ui.icon('bell')),
                ui.E('div', { 'class': 'sbd-kernel-update-copy' }, [
                    ui.E('div', { 'class': 'sbd-kernel-update-title' }, 'Pembaruan kernel tersedia untuk ' + sourceLabel),
                    ui.E('div', { 'class': 'sbd-kernel-update-meta' },
                        currentVersion + ' → ' + latestVersion + (info.latest_tag && info.latest_tag !== latestVersion ? ' · ' + info.latest_tag : '')),
                    ui.E('div', { 'class': 'sbd-kernel-update-hint' }, 'Pemeriksaan hanya dilakukan saat panel dibuka dan tidak memengaruhi operasi saat ini')
                ]),
                ui.E('div', { 'class': 'sbd-kernel-update-actions' }, actionButtons)
            ]));
            kernelUpdateNotice.hidden = false;
            window.requestAnimationFrame(() => kernelUpdateNotice.classList.add('show'));
        }

        function runKernelUpdateCheck() {
            if (kernelNoticeCheckStarted) return;
            kernelNoticeCheckStarted = true;
            api.kernelUpdateNotice().then(result => {
                if (result && result.available) showKernelUpdateNotice(result);
            }).catch(() => {});
        }

        function scheduleKernelUpdateCheck() {
            const run = () => {
                if (!document.hidden) {
                    runKernelUpdateCheck();
                    return;
                }
                document.addEventListener('visibilitychange', function onVisible() {
                    if (document.hidden) return;
                    document.removeEventListener('visibilitychange', onVisible);
                    runKernelUpdateCheck();
                });
            };
            if (window.requestIdleCallback)
                window.requestIdleCallback(run, { timeout: 1500 });
            else
                window.setTimeout(run, 700);
        }

        async function refreshStatus(force) {
            if (statusPending) return statusPending;
            if (!force && state.status && Date.now() - statusTime < 3000) return state.status;
            statusPending = api.status(!!force).then(value => {
                state.status = value;
                statusTime = Date.now();
                updateHeader();
                buildNavigation();
                return value;
            }, error => {
                statusText.textContent = 'Koneksi gagal';
                statusDot.className = 'sbd-dot off';
                throw error;
            }).finally(() => {
                statusPending = null;
            });
            return statusPending;
        }

        function setBusy(value) {
            state.busy = !!value;
            app.classList.toggle('sbd-busy', state.busy);
        }

        async function watchJob(job, title) {
            if (!job || !job.id) throw new Error('Tugas latar belakang tidak dibuat');
            const statusLine = ui.E('div', { 'class': 'sbd-job-status' }, 'Tugas dibuat');
            const detail = ui.E('div', { 'class': 'sbd-modal-text' }, '');
            const bar = ui.E('div', { 'class': 'sbd-progress' }, ui.E('i'));
            const ref = ui.modal(title || 'Menjalankan tugas', [statusLine, detail, bar], {
                dismissable: false,
                width: '480px'
            });
            let latest = job;
            let transientErrors = 0;
            for (;;) {
                try {
                    latest = await api.job(job.id) || latest;
                    transientErrors = 0;
                } catch (error) {
                    transientErrors++;
                    if (transientErrors >= 4) {
                        ref.close();
                        throw error;
                    }
                    await ui.sleep(700);
                    continue;
                }
                const meta = PHASES[latest.phase] || [latest.phase || 'Sedang berjalan', 50];
                statusLine.textContent = meta[0];
                detail.textContent = [latest.message, latest.target, latest.reason].filter(Boolean).join(' · ');
                bar.firstChild.style.width = meta[1] + '%';
                bar.className = 'sbd-progress ' + (latest.phase === 'failed' || latest.phase === 'rollback_failed' ? 'bad' : latest.phase === 'done' ? 'good' : '');
                updateHeader();
                if (latest.phase === 'done') {
                    await ui.sleep(650);
                    ref.close();
                    await refreshStatus(true);
                    return latest;
                }
                if (TERMINAL.includes(latest.phase)) {
                    ref.close();
                    await refreshStatus().catch(() => {});
                    throw new Error(jobError(latest));
                }
                await ui.sleep(850);
            }
        }

        const ctx = {
            get status() { return state.status; },
            set status(value) { state.status = value; updateHeader(value); },
            get settings() { return state.settings; },
            set settings(value) { state.settings = value; },
            navigate,
            refreshStatus,
            refreshPage: () => requestPageReload(),
            setBusy,
            watchJob,
            onCleanup(fn) { if (typeof fn === 'function') state.cleanups.push(fn); },
            consumeInitialOverview() {
                const value = initialOverview;
                initialOverview = null;
                return value;
            },
            leaveGuard: null
        };

        async function refreshBootstrapSnapshot() {
            try {
                const boot = await api.bootstrap(true);
                if (boot && boot.settings) state.settings = boot.settings;
                if (boot && boot.status) {
                    state.status = boot.status;
                    statusTime = Date.now();
                    updateHeader();
                    buildNavigation();
                }
            } catch (_) {}
        }

        async function requestPageReload() {
            if (ctx.leaveGuard) {
                try {
                    if (!await ctx.leaveGuard()) return;
                } catch (_) { return; }
                ctx.leaveGuard = null;
            }
            await renderCurrent(true);
        }

        async function renderCurrent(force) {
            if (!force && state.page !== 'settings'
                    && !PAGES.some(page => page.id === state.page)) state.page = 'overview';
            state.cleanups.splice(0).forEach(fn => {
                try { fn(); } catch (_) {}
            });
            scrollToTop();
            buildNavigation();
            pageTitle.textContent = PAGE_TITLES[state.page] || 'SingBox-Dash';
            pageSubtitle.textContent = PAGE_SUBTITLES[state.page] || '';
            pageHost.innerHTML = '';
            try {
                if (!state.status)
                    await refreshStatus(true).catch(() => {});
                const definition = PAGES.find(page => page.id === state.page);
                if (!definition) throw new Error('Halaman tidak ditemukan');
                const page = await L.require(definition.module);
                pageHost.innerHTML = '';
                await page.render(pageHost, ctx);
            } catch (error) {
                pageHost.innerHTML = '';
                pageHost.appendChild(ui.card('Gagal memuat', [
                    ui.note(api.errorText(error), 'bad'),
                    ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('Coba lagi', { icon: 'refresh', onClick: () => renderCurrent(true) }))
                ]));
            }
        }

        function navigate(page) {
            if (page !== 'settings' && !PAGES.some(item => item.id === page)) page = 'overview';
            if (state.page === page && pageHost.childNodes.length) return;
            const go = () => {
                state.page = page;
                const group = NAV_GROUPS.find(item => !item.external && item.items.includes(page));
                if (group) {
                    lastGroupPage[group.id] = page;
                    try { window.localStorage.setItem('singbox-dash-nav-groups', JSON.stringify(lastGroupPage)); } catch (_) {}
                }
                try { window.history.replaceState(null, '', '#' + page); } catch (_) {}
                scrollToTop();
                renderCurrent();
                scheduleStatusPoll(statusPollDelay());
            };
            if (ctx.leaveGuard) {
                Promise.resolve().then(() => ctx.leaveGuard()).then(ok => {
                    if (!ok) return;
                    ctx.leaveGuard = null;
                    go();
                }).catch(() => {});
                return;
            }
            go();
        }

        if (loadError && !status) {
            pageHost.appendChild(ui.note('Layanan pengelolaan tidak tersedia: ' + loadError, 'bad'));
        }
        buildNavigation();
        updateHeader();
        setTimeout(() => {
            enhanceDocumentLandmarks(header, main);
            renderCurrent();
        }, 0);
        if (bootFromCache) setTimeout(() => refreshBootstrapSnapshot(), 60);
        scheduleKernelUpdateCheck();

        let pollStopped = false;
        let pollTimer = null;
        function statusPollDelay() {
            return state.page === 'overview' ? 5000 : 15000;
        }
        function scheduleStatusPoll(delay) {
            if (pollStopped) return;
            if (pollTimer) window.clearTimeout(pollTimer);
            pollTimer = window.setTimeout(pollStatus, delay);
        }
        async function pollStatus() {
            pollTimer = null;
            if (pollStopped) return;
            if (!document.hidden && !state.busy && !statusPending) {
                const previousRunning = state.status ? !!state.status.running : null;
                await refreshStatus(true).catch(() => {});
                const currentRunning = state.status ? !!state.status.running : null;
                if (previousRunning !== null && currentRunning !== null && previousRunning !== currentRunning)
                    await renderCurrent(false).catch(() => {});
            }
            scheduleStatusPoll(statusPollDelay());
        }
        async function resumeStatus() {
            if (document.hidden || pollStopped) return;
            scheduleStatusPoll(50);
        }
        document.addEventListener('visibilitychange', resumeStatus);
        scheduleStatusPoll(statusPollDelay());
        state.cleanups.push(() => {
            pollStopped = true;
            if (pollTimer) window.clearTimeout(pollTimer);
            document.removeEventListener('visibilitychange', resumeStatus);
        });
        return app;
    }
});



