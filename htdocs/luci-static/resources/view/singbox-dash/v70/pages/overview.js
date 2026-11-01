'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';

const MODES = [
    { id: 'tun', name: 'TUN', tag: 'L3 VIF', detail: 'Pengambilalihan seluruh lalu lintas melalui kartu jaringan virtual', icon: 'shield', color: 'blue' },
    { id: 'tproxy', name: 'TProxy', tag: 'NFTABLES', detail: 'Penerusan proxy transparan lapisan 4', icon: 'network', color: 'green' },
    { id: 'redirect', name: 'Redirect', tag: 'TCP NAT', detail: 'Pengalihan port TCP', icon: 'route', color: 'purple' },
    { id: 'ebpf_cgroup', name: 'eBPF-Cgroup', tag: 'CGROUP V2', detail: 'Pengambilalihan lokal cgroup v2 + LAN packet_rewrite', icon: 'cpu', color: 'purple' },
    { id: 'ebpf', name: 'eBPF-TC', tag: 'SOCKET ASSIGN', detail: 'Pengambilalihan lokal TC adaptif versi + LAN packet_rewrite', icon: 'zap', color: 'orange' }
];

function shortVersion(value) {
    const line = String(value || '').split(/\r?\n/).find(item => /sing-box version/i.test(item)) || String(value || '');
    return line.replace(/^.*?sing-box version\s*/i, '').trim() || '—';
}

async function applyMode(mode, status, ctx) {
    ctx.setBusy(true);
    try {
        const job = await api.command('mode-apply', [status.active, mode.id]);
        if (job && job.id) await ctx.watchJob(job, 'Beralih ke ' + mode.name);
        await ctx.refreshStatus();
        ctx.refreshPage();
    } catch (error) {
        ui.notify(api.errorText(error), 'error', 7000);
    } finally {
        ctx.setBusy(false);
    }
}

function openModeSelector(status, ctx) {
    const active = status.mode && (status.mode.variant || status.mode.mode);
    const capabilities = status.mode_capabilities || {};
    let selected = active;
    let modal = null;
    const buttons = [];

    function capabilityFor(id) {
        return capabilities[id] || { available: false, reason: 'Hasil pemeriksaan kemampuan untuk mode ini belum diperoleh' };
    }
    function modeTag(mode, capability) {
        if (mode.id !== 'ebpf') return mode.tag;
        return capability.local_data_plane === 'tc' ? 'TC' : 'SOCKET ASSIGN';
    }
    function modeDetail(mode, capability) {
        if (mode.id !== 'ebpf') return mode.detail;
        const plane = capability.local_data_plane || 'TC';
        return plane + ' pengambilalihan lokal + LAN packet_rewrite';
    }
    const options = MODES.map(mode => {
        const capability = capabilityFor(mode.id);
        const unavailable = capability.available !== true;
        const detailText = modeDetail(mode, capability);
        const button = ui.E('button', {
            type: 'button',
            'class': 'sbd-mode-option' + (unavailable ? ' disabled' : ''),
            title: unavailable ? (capability.reason || 'Tidak didukung oleh sistem saat ini') : detailText,
            disabled: unavailable ? '' : null,
            click: () => {
                selected = mode.id;
                buttons.forEach(item => {
                    const current = item.mode.id === selected;
                    item.button.classList.toggle('active', current);
                    item.button.setAttribute('aria-pressed', current ? 'true' : 'false');
                });
            }
        }, [
            ui.appIcon(mode.icon, mode.color),
            ui.E('div', { 'class': 'sbd-mode-option-main' }, [
                ui.E('div', { 'class': 'sbd-mode-option-title' }, mode.name),
                ui.E('div', { 'class': 'sbd-mode-option-desc' }, unavailable ? (capability.reason || 'Tidak didukung oleh sistem saat ini') : detailText)
            ]),
            mode.id === active ? ui.badge('Aktif', 'green')
                : unavailable ? ui.badge('Tidak tersedia', 'red')
                : ui.badge('Tersedia', 'green'),
            ui.E('span', { 'class': 'sbd-mode-option-check' }, ui.icon('check'))
        ]);
        if (mode.id === active) button.classList.add('active');
        button.setAttribute('aria-pressed', mode.id === active ? 'true' : 'false');
        buttons.push({ mode, button });
        return button;
    });

    const unavailableCount = options.filter((item, index) =>
        capabilityFor(MODES[index].id).available !== true).length;
    const content = ui.E('div', { 'class': 'sbd-mode-options' }, [
        ui.note('Inti saat ini berhenti; setelah beralih, konfigurasi hanya disimpan dan berlaku saat mulai berikutnya.', 'info'),
        unavailableCount
            ? ui.note(unavailableCount + ' mode tidak berlaku untuk sistem saat ini; alasannya ditampilkan pada opsi terkait.', 'warn')
            : null,
        ui.E('div', { 'class': 'sbd-mode-option-list' }, options)
    ]);
    modal = ui.modal('Alih mode pengambilalihan', content, {
        subtitle: 'Pilih data plane yang digunakan pada mulai berikutnya',
        cancelText: 'Batal', confirmText: 'Alih mode', width: '560px',
        onConfirm: async () => {
            const mode = MODES.find(item => item.id === selected);
            if (!mode || selected === active) {
                ui.notify('Mode ' + (mode ? mode.name : 'yang dipilih') + ' sudah aktif', 'info');
                return;
            }
            modal.close();
            await applyMode(mode, status, ctx);
        }
    });
}

function trafficCard(ctx, snapshotPromise) {
    const upRate = ui.E('div', { 'class': 'sbd-stat-value' }, '—');
    const downRate = ui.E('div', { 'class': 'sbd-stat-value' }, '—');
    const totalUp = ui.E('div', { 'class': 'sbd-stat-value' }, '—');
    const totalDown = ui.E('div', { 'class': 'sbd-stat-value' }, '—');
    const active = ui.E('div', { 'class': 'sbd-stat-value' }, '—');
    const note = ui.E('div', { 'class': 'sbd-dashboard-note' }, 'Memuat lalu lintas langsung');
    let previous = null;
    let pending = false;
    let snapshotPending = snapshotPromise || null;
    let snapshotRate = null;

    const card = ui.card('Lalu lintas langsung', [
        ui.E('div', { 'class': 'sbd-stat-grid sbd-stat-grid-5 sbd-dashboard-traffic-grid' }, [
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, 'Kecepatan unggah'), upRate,
                ui.E('div', { 'class': 'sbd-stat-sub' }, 'Langsung')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, 'Kecepatan unduh'), downRate,
                ui.E('div', { 'class': 'sbd-stat-sub' }, 'Langsung')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, 'Total unggahan'), totalUp,
                ui.E('div', { 'class': 'sbd-stat-sub' }, 'Operasi kernel saat ini')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, 'Total unduhan'), totalDown,
                ui.E('div', { 'class': 'sbd-stat-sub' }, 'Operasi kernel saat ini')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, 'Koneksi aktif'), active,
                ui.E('div', { 'class': 'sbd-stat-sub' }, 'Snapshot saat ini')
            ])
        ]),
        note
    ], {
        className: 'sbd-span-12 sbd-dashboard-traffic',
        icon: 'activity', iconTone: 'blue',
        actions: [ui.btn('Lihat koneksi', {
            icon: 'link', small: true, onClick: () => ctx.navigate('connections')
        })]
    });

    async function load() {
        if (pending) return;
        if (!ctx.status || !ctx.status.running || !(ctx.status.api && ctx.status.api.port)) {
            previous = null;
            upRate.textContent = downRate.textContent = totalUp.textContent = totalDown.textContent = active.textContent = '—';
            note.textContent = 'Kernel terkelola tidak berjalan; lalu lintas langsung untuk sementara tidak tersedia.';
            return;
        }
        pending = true;
        try {
            let value;
            if (snapshotPending) {
                const snapshot = await snapshotPending;
                snapshotPending = null;
                if (snapshot.error) throw snapshot.error;
                if (!snapshot.data || !snapshot.data.traffic)
                    throw new Error((snapshot.data && snapshot.data.traffic_error) || 'traffic unavailable');
                value = snapshot.data.traffic;
                snapshotRate = snapshot.data.traffic_rate || null;
            } else {
                value = await api.clashFresh('GET', '/connections');
            }
            const now = Date.now();
            const connections = Array.isArray(value && value.connections) ? value.connections : [];
            const uploadTotal = Math.max(0, Number(value && value.uploadTotal) || 0);
            const downloadTotal = Math.max(0, Number(value && value.downloadTotal) || 0);
            totalUp.textContent = api.formatBytes(uploadTotal);
            totalDown.textContent = api.formatBytes(downloadTotal);
            active.textContent = String(connections.length);
            const sampledRate = snapshotRate;
            snapshotRate = null;
            if (sampledRate) {
                upRate.textContent = api.formatBytes(sampledRate.upload) + '/s';
                downRate.textContent = api.formatBytes(sampledRate.download) + '/s';
            } else if (previous && now > previous.at) {
                const seconds = (now - previous.at) / 1000;
                upRate.textContent = api.formatBytes(Math.max(0, uploadTotal - previous.uploadTotal) / seconds) + '/s';
                downRate.textContent = api.formatBytes(Math.max(0, downloadTotal - previous.downloadTotal) / seconds) + '/s';
            } else {
                upRate.textContent = '—';
                downRate.textContent = '—';
            }
            const firstSample = !previous && !sampledRate;
            previous = { at: now, uploadTotal, downloadTotal };
            note.textContent = 'Statistik berasal dari kernel saat ini, dihitung ulang setelah mulai ulang · diperbarui setiap 3 detik';
            if (firstSample) window.setTimeout(() => { if (!document.hidden) load(); }, 600);
        } catch (error) {
            note.textContent = 'Gagal membaca lalu lintas langsung: ' + api.errorText(error);
        } finally {
            pending = false;
        }
    }

    return { node: card, load };
}

function serviceCard(status, ctx) {
    const stateMeta = {
        stopped: { label: 'Berhenti', code: 'INACTIVE', tone: 'red', dot: 'off' },
        starting: { label: 'Memulai', code: 'STARTING', tone: 'orange', dot: 'starting' },
        running: { label: 'Berjalan', code: 'ACTIVE', tone: 'green', dot: 'on' },
        stopping: { label: 'Menghentikan', code: 'STOPPING', tone: 'orange', dot: 'stopping' },
        restarting: { label: 'Memulai ulang', code: 'RESTARTING', tone: 'orange', dot: 'starting' }
    };
    let current = status;
    let phase = current.running ? 'running' : 'stopped';
    let busy = false;
    const body = ui.E('div', { 'class': 'sbd-dashboard-service-body' });
    const card = ui.card('Layanan inti Sing-Box', [body], {
        className: 'sbd-span-12 sbd-dashboard-service',
        icon: 'kernel', iconTone: 'blue'
    });

    function modeInfo() {
        const id = current.mode && (current.mode.variant || current.mode.mode);
        const mode = MODES.find(item => item.id === id);
        return {
            id,
            mode,
            name: (mode && mode.name) || id || 'Kustom',
            detail: (mode && mode.detail) || 'Perutean data plane kustom',
            tag: (mode && mode.tag) || 'CUSTOM'
        };
    }

    function transitionButton(meta) {
        const button = ui.btn(meta.label, { icon: 'refresh', disabled: true });
        button.classList.add('sbd-service-busy-btn');
        return button;
    }

    function render() {
        const meta = stateMeta[phase];
        const running = phase === 'running';
        const stopping = phase === 'stopping';
        const transitioning = phase === 'starting' || phase === 'stopping' || phase === 'restarting';
        const mode = modeInfo();
        const reviewButton = ui.btn('Tinjau dan terapkan konfigurasi', {
            icon: 'config', disabled: transitioning,
            onClick: () => ctx.navigate('config')
        });
        let actions;
        if (transitioning) {
            actions = [reviewButton, transitionButton(meta)];
        } else if (running) {
            actions = [
                reviewButton,
                ui.btn('Mulai ulang', { icon: 'restart', onClick: () => runAction('restart') }),
                ui.btn('Berhenti', { icon: 'stop', variant: 'danger', onClick: () => runAction('stop') })
            ];
        } else {
            actions = [
                reviewButton,
                ui.btn('Mulai', { icon: 'play', variant: 'primary', onClick: () => runAction('start') })
            ];
        }

        const switchButton = phase === 'stopped' ? ui.btn('Alih mode', {
            icon: 'sliders', small: true,
            onClick: () => openModeSelector(current, ctx)
        }) : null;

        const subtitle = running
            ? 'PID ' + (current.pid || '—') +
              (current.process && current.process.uptime ? ' · Online ' + api.formatUptime(current.process.uptime) : '')
            : phase === 'starting'
                ? 'Memulai proses sing-box dan menunggu antarmuka siap'
                : phase === 'stopping'
                    ? 'Menghentikan proses sing-box dan melepaskan sumber daya pengambilalihan'
                    : phase === 'restarting'
                        ? 'Memulai ulang proses sing-box dan menerapkan kembali konfigurasi runtime'
                        : (current.enabled ? 'Mulai otomatis saat boot aktif, tetapi layanan tidak berjalan' : 'Layanan belum dimulai');

        body.innerHTML = '';
        body.appendChild(ui.E('div', { 'class': 'sbd-dashboard-service-main' }, [
            ui.E('div', { 'class': 'sbd-dashboard-service-copy' }, [
                ui.E('div', { 'class': 'sbd-dashboard-service-state' }, [
                    ui.E('span', { 'class': 'sbd-dot ' + meta.dot }),
                    ui.E('strong', {}, meta.label),
                    ui.badge(meta.code, meta.tone),
                    transitioning ? ui.E('span', { 'class': 'sbd-service-state-spinner', 'aria-hidden': 'true' }) : null
                ].filter(Boolean)),
                ui.E('div', { 'class': 'sbd-dashboard-service-sub' }, subtitle)
            ]),
            ui.E('div', { 'class': 'sbd-btn-row' }, actions)
        ]));
        const externalPids = Array.isArray(current.external_pids) ? current.external_pids : [];
        const externalNote = externalPids.length
            ? ui.note('Terdeteksi ' + externalPids.length + ' proses sing-box lain yang tidak menggunakan konfigurasi saat ini: PID ' + externalPids.join(', '), 'warn')
            : null;
        if (externalNote) body.appendChild(externalNote);
        body.appendChild(ui.E('div', { 'class': 'sbd-dashboard-service-meta' }, [
            ui.E('div', { 'class': 'sbd-dashboard-fact sbd-dashboard-fact-version' }, [
                ui.E('span', { 'class': 'sbd-dashboard-fact-label' }, 'Versi'),
                ui.E('strong', { 'class': 'sbd-dashboard-fact-value' }, shortVersion(current.version_line))
            ]),
            ui.E('div', { 'class': 'sbd-dashboard-fact' }, [
                ui.E('span', { 'class': 'sbd-dashboard-fact-label' }, 'Proses'),
                ui.E('strong', { 'class': 'sbd-dashboard-fact-value' },
                    (running || stopping || phase === 'restarting') && current.pid ? '#' + current.pid : '—')
            ]),
            ui.E('div', { 'class': 'sbd-dashboard-fact' }, [
                ui.E('span', { 'class': 'sbd-dashboard-fact-label' }, 'Status'),
                ui.E('strong', { 'class': 'sbd-dashboard-fact-value' }, meta.label)
            ]),
            ui.E('div', { 'class': 'sbd-dashboard-fact sbd-dashboard-fact-mode' }, [
                ui.E('span', { 'class': 'sbd-dashboard-fact-label' }, 'Mode operasi'),
                ui.E('strong', { 'class': 'sbd-dashboard-fact-value sbd-dashboard-mode-value' }, mode.name)
            ]),
            switchButton
        ].filter(Boolean)));
    }

    async function runAction(action) {
        if (busy) return;
        if (action === 'stop') {
            const ok = await ui.confirm('Hentikan sing-box', 'Proxy transparan dan Clash API akan terputus setelah dihentikan.', 'Berhenti', true);
            if (!ok) return;
        }
        const previous = phase;
        busy = true;
        phase = action === 'stop' ? 'stopping' : action === 'restart' ? 'restarting' : 'starting';
        render();
        await ui.sleep(90);
        try {
            ctx.setBusy(true);
            const started = Date.now();
            await api.command('service', [action]);
            const minimum = action === 'restart' ? 900 : 650;
            if (Date.now() - started < minimum) await ui.sleep(minimum - (Date.now() - started));
            await ctx.refreshStatus();
            ui.notify(action === 'stop' ? 'Layanan dihentikan' : action === 'start' ? 'Layanan dimulai' : 'Layanan dimulai ulang', 'success');
            ctx.refreshPage();
        } catch (error) {
            phase = previous;
            render();
            ui.notify(api.errorText(error), 'error', 7000);
        } finally {
            busy = false;
            ctx.setBusy(false);
        }
    }

    render();
    return { node: card, runAction };
}

function summaryCard(status, ctx) {
    const rss = status.process && status.process.rss_kb;
    const interval = ctx.settings ? Number(ctx.settings.update_interval) || 0 : 0;
    return ui.card('Pratinjau operasi', [
        ui.E('div', { 'class': 'sbd-stat-grid sbd-stat-grid-2 sbd-home-runtime-stats' }, [
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, 'Slot konfigurasi'),
                ui.E('div', { 'class': 'sbd-stat-value' }, String((status.slots || []).length || 1)),
                ui.E('div', { 'class': 'sbd-stat-sub' }, status.active || 'Konfigurasi default')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, 'Memori inti'),
                ui.E('div', { 'class': 'sbd-stat-value' }, rss ? api.formatBytes(rss * 1024) : '—'),
                ui.E('div', { 'class': 'sbd-stat-sub' }, 'Proses sing-box')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, 'Pembaruan langganan'),
                ui.E('div', { 'class': 'sbd-stat-value' }, interval ? interval + ' menit' : 'Nonaktif'),
                ui.E('div', { 'class': 'sbd-stat-sub' }, 'Interval sinkronisasi otomatis')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, 'Verifikasi kernel'),
                ui.E('div', { 'class': 'sbd-stat-value' }, status.process && status.process.exe_match ? 'Normal' : 'Perlu diperiksa'),
                ui.E('div', { 'class': 'sbd-stat-sub' }, 'Path file executable')
            ])
        ])
    ], { className: 'sbd-dashboard-summary sbd-home-runtime-tile', icon: 'overview', iconTone: 'green' });
}

function subscriptionTile(status, ctx, snapshotPromise) {
    const body = ui.E('div', { 'class': 'sbd-stack sbd-home-subscription-body' });
    const card = ui.card('Langganan dan node', [body], {
        className: 'sbd-home-subscription-tile',
        icon: 'database', iconTone: 'blue',
        actions: [
            ui.btn('Kelola', { icon: 'sliders', small: true, onClick: () => ctx.navigate('subscriptions') }),
            ui.btn('', { icon: 'settings', iconOnly: true, small: true, title: 'Pengaturan langganan', onClick: () => ctx.navigate('settings') })
        ]
    });
    async function load() {
        body.innerHTML = '';
        body.appendChild(ui.empty('Memuat sumber langganan…'));
        try {
            const snapshot = await snapshotPromise;
            if (snapshot.error) throw snapshot.error;
            const data = snapshot.data && snapshot.data.providers;
            if (!data)
                throw new Error((snapshot.data && snapshot.data.provider_error) || 'provider status unavailable');
            const counts = data.counts || {};
            const interval = Number((data.subscription && data.subscription.interval) || (ctx.settings && ctx.settings.update_interval) || 0);
            body.innerHTML = '';
            body.appendChild(ui.E('div', { 'class': 'sbd-home-sub-stats' }, [
                ui.E('div', { 'class': 'sbd-home-sub-stat' }, [
                    ui.E('span', {}, 'Sumber langganan'), ui.E('strong', {}, String(counts.providers || 0))
                ]),
                ui.E('div', { 'class': 'sbd-home-sub-stat' }, [
                    ui.E('span', {}, 'Total node'), ui.E('strong', {}, String(counts.nodes || 0))
                ]),
                ui.E('div', { 'class': 'sbd-home-sub-stat' }, [
                    ui.E('span', {}, 'Pembaruan otomatis'), ui.E('strong', {}, interval ? interval + ' mnt' : 'Nonaktif')
                ])
            ]));
            const trafficProviders = (data.providers || []).filter(provider => provider.traffic && Number(provider.traffic.total) > 0);
            if (trafficProviders.length) {
                const used = trafficProviders.reduce((sum, provider) => sum + Number(provider.traffic.used || 0), 0);
                const total = trafficProviders.reduce((sum, provider) => sum + Number(provider.traffic.total || 0), 0);
                const percent = total ? Math.min(100, used * 100 / total) : 0;
                const tone = percent >= 90 ? 'bad' : percent >= 75 ? 'warn' : 'good';
                body.appendChild(ui.E('div', { 'class': 'sbd-home-sub-traffic' }, [
                    ui.E('div', { 'class': 'sbd-home-sub-traffic-head' }, [
                        ui.E('span', {}, 'Lalu lintas langganan jarak jauh'),
                        ui.E('strong', {}, api.formatBytes(used) + ' / ' + api.formatBytes(total))
                    ]),
                    ui.E('div', { 'class': 'sbd-sub-traffic-bar ' + tone }, [
                        ui.E('i', { style: 'width:' + percent.toFixed(1) + '%' })
                    ])
                ]));
            }
            const lastUpdate = data.latest_update ? api.formatDate(data.latest_update) : 'Belum diperbarui';
            body.appendChild(ui.E('div', { 'class': 'sbd-home-sub-foot' }, [
                ui.E('span', {}, 'Pembaruan terakhir: ' + lastUpdate),
                ui.badge(status.process && status.process.exe_match ? 'Proses normal' : 'Perlu divalidasi',
                    status.process && status.process.exe_match ? 'green' : 'orange')
            ]));
        } catch (error) {
            body.innerHTML = '';
            body.appendChild(ui.note('Gagal membaca status langganan: ' + api.errorText(error), 'bad'));
            body.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('Coba lagi', { icon: 'refresh', small: true, onClick: load })));
        }
    }
    load();
    return card;
}

async function render(host, ctx) {
    if (!ctx.status) {
        host.appendChild(ui.empty('Tidak dapat membaca status operasi'));
        return;
    }
    const initialOverview = ctx.consumeInitialOverview ? ctx.consumeInitialOverview() : null;
    const overviewPromise = initialOverview
        ? Promise.resolve({ data: initialOverview, error: null })
        : api.overview(true).then(
            data => ({ data, error: null }),
            error => ({ data: null, error })
        );
    const traffic = trafficCard(ctx, overviewPromise);
    const service = serviceCard(ctx.status, ctx);
    const dashboardPair = ui.E('div', { 'class': 'sbd-span-12 sbd-dashboard-pair' }, [
        summaryCard(ctx.status, ctx),
        subscriptionTile(ctx.status, ctx, overviewPromise)
    ]);
    const root = ui.E('div', { 'class': 'sbd-grid sbd-dashboard' }, [
        traffic.node,
        service.node,
        dashboardPair
    ]);
    host.appendChild(root);
    await traffic.load();
    const ratePrime = window.setTimeout(() => {
        if (!document.hidden) traffic.load();
    }, 1000);
    const trafficTimer = window.setInterval(() => {
        if (!document.hidden) traffic.load();
    }, 3000);
    ctx.onCleanup(() => {
        window.clearTimeout(ratePrime);
        window.clearInterval(trafficTimer);
    });
}

return baseclass.extend({ render });



