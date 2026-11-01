'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';

const MODES = [
    { id: 'tun', name: 'TUN', tag: 'L3 VIF', detail: '虚拟网卡全流量接管', icon: 'shield', color: 'blue' },
    { id: 'tproxy', name: 'TProxy', tag: 'NFTABLES', detail: '四层透明代理转发', icon: 'network', color: 'green' },
    { id: 'redirect', name: 'Redirect', tag: 'TCP NAT', detail: 'TCP 端口重定向', icon: 'route', color: 'purple' },
    { id: 'ebpf_cgroup', name: 'eBPF-Cgroup', tag: 'CGROUP V2', detail: 'cgroup v2 本机接管 + LAN packet_rewrite', icon: 'cpu', color: 'purple' },
    { id: 'ebpf', name: 'eBPF-TC', tag: 'SOCKET ASSIGN', detail: '版本自适应 TC 本机接管 + LAN packet_rewrite', icon: 'zap', color: 'orange' }
];

function shortVersion(value) {
    const line = String(value || '').split(/\r?\n/).find(item => /sing-box version/i.test(item)) || String(value || '');
    return line.replace(/^.*?sing-box version\s*/i, '').trim() || '—';
}

async function applyMode(mode, status, ctx) {
    ctx.setBusy(true);
    try {
        const job = await api.command('mode-apply', [status.active, mode.id]);
        if (job && job.id) await ctx.watchJob(job, '切换 ' + mode.name);
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
        return capabilities[id] || { available: false, reason: '尚未获取到该模式的能力检测结果' };
    }
    function modeTag(mode, capability) {
        if (mode.id !== 'ebpf') return mode.tag;
        return capability.local_data_plane === 'tc' ? 'TC' : 'SOCKET ASSIGN';
    }
    function modeDetail(mode, capability) {
        if (mode.id !== 'ebpf') return mode.detail;
        const plane = capability.local_data_plane || 'TC';
        return plane + ' 本机接管 + LAN packet_rewrite';
    }
    const options = MODES.map(mode => {
        const capability = capabilityFor(mode.id);
        const unavailable = capability.available !== true;
        const detailText = modeDetail(mode, capability);
        const button = ui.E('button', {
            type: 'button',
            'class': 'sbd-mode-option' + (unavailable ? ' disabled' : ''),
            title: unavailable ? (capability.reason || '当前系统不支持') : detailText,
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
                ui.E('div', { 'class': 'sbd-mode-option-desc' }, unavailable ? (capability.reason || '当前系统不支持') : detailText)
            ]),
            mode.id === active ? ui.badge('当前', 'green')
                : unavailable ? ui.badge('不可用', 'red')
                : ui.badge('可用', 'green'),
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
        ui.note('核心当前已停止，切换后只保存配置，下次启动时生效。', 'info'),
        unavailableCount
            ? ui.note('有 ' + unavailableCount + ' 种模式不适用于当前系统，原因已显示在对应选项中。', 'warn')
            : null,
        ui.E('div', { 'class': 'sbd-mode-option-list' }, options)
    ]);
    modal = ui.modal('切换接管模式', content, {
        subtitle: '选择下次启动使用的数据平面',
        cancelText: '取消', confirmText: '切换模式', width: '560px',
        onConfirm: async () => {
            const mode = MODES.find(item => item.id === selected);
            if (!mode || selected === active) {
                ui.notify('当前已经是 ' + (mode ? mode.name : '所选') + ' 模式', 'info');
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
    const note = ui.E('div', { 'class': 'sbd-dashboard-note' }, '正在读取实时流量');
    let previous = null;
    let pending = false;
    let snapshotPending = snapshotPromise || null;
    let snapshotRate = null;

    const card = ui.card('实时流量', [
        ui.E('div', { 'class': 'sbd-stat-grid sbd-stat-grid-5 sbd-dashboard-traffic-grid' }, [
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, '上传速率'), upRate,
                ui.E('div', { 'class': 'sbd-stat-sub' }, '实时')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, '下载速率'), downRate,
                ui.E('div', { 'class': 'sbd-stat-sub' }, '实时')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, '累计上传'), totalUp,
                ui.E('div', { 'class': 'sbd-stat-sub' }, '本次内核运行')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, '累计下载'), totalDown,
                ui.E('div', { 'class': 'sbd-stat-sub' }, '本次内核运行')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, '活动连接'), active,
                ui.E('div', { 'class': 'sbd-stat-sub' }, '当前快照')
            ])
        ]),
        note
    ], {
        className: 'sbd-span-12 sbd-dashboard-traffic',
        icon: 'activity', iconTone: 'blue',
        actions: [ui.btn('查看连接', {
            icon: 'link', small: true, onClick: () => ctx.navigate('connections')
        })]
    });

    async function load() {
        if (pending) return;
        if (!ctx.status || !ctx.status.running || !(ctx.status.api && ctx.status.api.port)) {
            previous = null;
            upRate.textContent = downRate.textContent = totalUp.textContent = totalDown.textContent = active.textContent = '—';
            note.textContent = '受管内核未运行，实时流量暂不可用。';
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
            note.textContent = '统计来自当前内核，重启后重新计数 · 每 3 秒刷新';
            if (firstSample) window.setTimeout(() => { if (!document.hidden) load(); }, 600);
        } catch (error) {
            note.textContent = '实时流量读取失败：' + api.errorText(error);
        } finally {
            pending = false;
        }
    }

    return { node: card, load };
}

function serviceCard(status, ctx) {
    const stateMeta = {
        stopped: { label: '已停止', code: 'INACTIVE', tone: 'red', dot: 'off' },
        starting: { label: '正在启动', code: 'STARTING', tone: 'orange', dot: 'starting' },
        running: { label: '运行中', code: 'ACTIVE', tone: 'green', dot: 'on' },
        stopping: { label: '正在停止', code: 'STOPPING', tone: 'orange', dot: 'stopping' },
        restarting: { label: '正在重启', code: 'RESTARTING', tone: 'orange', dot: 'starting' }
    };
    let current = status;
    let phase = current.running ? 'running' : 'stopped';
    let busy = false;
    const body = ui.E('div', { 'class': 'sbd-dashboard-service-body' });
    const card = ui.card('Sing-Box 内核服务', [body], {
        className: 'sbd-span-12 sbd-dashboard-service',
        icon: 'kernel', iconTone: 'blue'
    });

    function modeInfo() {
        const id = current.mode && (current.mode.variant || current.mode.mode);
        const mode = MODES.find(item => item.id === id);
        return {
            id,
            mode,
            name: (mode && mode.name) || id || '自定义',
            detail: (mode && mode.detail) || '自定义数据平面分流',
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
        const reviewButton = ui.btn('审阅与应用配置', {
            icon: 'config', disabled: transitioning,
            onClick: () => ctx.navigate('config')
        });
        let actions;
        if (transitioning) {
            actions = [reviewButton, transitionButton(meta)];
        } else if (running) {
            actions = [
                reviewButton,
                ui.btn('重启', { icon: 'restart', onClick: () => runAction('restart') }),
                ui.btn('停止', { icon: 'stop', variant: 'danger', onClick: () => runAction('stop') })
            ];
        } else {
            actions = [
                reviewButton,
                ui.btn('启动', { icon: 'play', variant: 'primary', onClick: () => runAction('start') })
            ];
        }

        const switchButton = phase === 'stopped' ? ui.btn('切换模式', {
            icon: 'sliders', small: true,
            onClick: () => openModeSelector(current, ctx)
        }) : null;

        const subtitle = running
            ? 'PID ' + (current.pid || '—') +
              (current.process && current.process.uptime ? ' · 在线 ' + api.formatUptime(current.process.uptime) : '')
            : phase === 'starting'
                ? '正在拉起 sing-box 进程并等待接口就绪'
                : phase === 'stopping'
                    ? '正在停止 sing-box 进程并释放接管资源'
                    : phase === 'restarting'
                        ? '正在重启 sing-box 进程并重新应用运行配置'
                        : (current.enabled ? '开机自启已启用，服务当前未运行' : '服务当前未启动');

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
            ? ui.note('检测到另有 ' + externalPids.length + ' 个非当前配置的 sing-box 进程：PID ' + externalPids.join(', '), 'warn')
            : null;
        if (externalNote) body.appendChild(externalNote);
        body.appendChild(ui.E('div', { 'class': 'sbd-dashboard-service-meta' }, [
            ui.E('div', { 'class': 'sbd-dashboard-fact sbd-dashboard-fact-version' }, [
                ui.E('span', { 'class': 'sbd-dashboard-fact-label' }, '版本'),
                ui.E('strong', { 'class': 'sbd-dashboard-fact-value' }, shortVersion(current.version_line))
            ]),
            ui.E('div', { 'class': 'sbd-dashboard-fact' }, [
                ui.E('span', { 'class': 'sbd-dashboard-fact-label' }, '进程'),
                ui.E('strong', { 'class': 'sbd-dashboard-fact-value' },
                    (running || stopping || phase === 'restarting') && current.pid ? '#' + current.pid : '—')
            ]),
            ui.E('div', { 'class': 'sbd-dashboard-fact' }, [
                ui.E('span', { 'class': 'sbd-dashboard-fact-label' }, '状态'),
                ui.E('strong', { 'class': 'sbd-dashboard-fact-value' }, meta.label)
            ]),
            ui.E('div', { 'class': 'sbd-dashboard-fact sbd-dashboard-fact-mode' }, [
                ui.E('span', { 'class': 'sbd-dashboard-fact-label' }, '运行模式'),
                ui.E('strong', { 'class': 'sbd-dashboard-fact-value sbd-dashboard-mode-value' }, mode.name)
            ]),
            switchButton
        ].filter(Boolean)));
    }

    async function runAction(action) {
        if (busy) return;
        if (action === 'stop') {
            const ok = await ui.confirm('停止 sing-box', '停止后透明代理和 Clash API 将中断。', '停止', true);
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
            ui.notify(action === 'stop' ? '服务已停止' : action === 'start' ? '服务已启动' : '服务已重启', 'success');
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
    return ui.card('运行预览', [
        ui.E('div', { 'class': 'sbd-stat-grid sbd-stat-grid-2 sbd-home-runtime-stats' }, [
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, '配置槽'),
                ui.E('div', { 'class': 'sbd-stat-value' }, String((status.slots || []).length || 1)),
                ui.E('div', { 'class': 'sbd-stat-sub' }, status.active || '默认配置')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, '核心内存'),
                ui.E('div', { 'class': 'sbd-stat-value' }, rss ? api.formatBytes(rss * 1024) : '—'),
                ui.E('div', { 'class': 'sbd-stat-sub' }, 'sing-box 进程')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, '订阅更新'),
                ui.E('div', { 'class': 'sbd-stat-value' }, interval ? interval + ' 分钟' : '已关闭'),
                ui.E('div', { 'class': 'sbd-stat-sub' }, '自动同步周期')
            ]),
            ui.E('div', { 'class': 'sbd-stat' }, [
                ui.E('div', { 'class': 'sbd-stat-label' }, '内核校验'),
                ui.E('div', { 'class': 'sbd-stat-value' }, status.process && status.process.exe_match ? '正常' : '待检查'),
                ui.E('div', { 'class': 'sbd-stat-sub' }, '可执行文件路径')
            ])
        ])
    ], { className: 'sbd-dashboard-summary sbd-home-runtime-tile', icon: 'overview', iconTone: 'green' });
}

function subscriptionTile(status, ctx, snapshotPromise) {
    const body = ui.E('div', { 'class': 'sbd-stack sbd-home-subscription-body' });
    const card = ui.card('订阅与节点', [body], {
        className: 'sbd-home-subscription-tile',
        icon: 'database', iconTone: 'blue',
        actions: [
            ui.btn('管理', { icon: 'sliders', small: true, onClick: () => ctx.navigate('subscriptions') }),
            ui.btn('', { icon: 'settings', iconOnly: true, small: true, title: '订阅设置', onClick: () => ctx.navigate('settings') })
        ]
    });
    async function load() {
        body.innerHTML = '';
        body.appendChild(ui.empty('正在读取订阅源…'));
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
                    ui.E('span', {}, '订阅源'), ui.E('strong', {}, String(counts.providers || 0))
                ]),
                ui.E('div', { 'class': 'sbd-home-sub-stat' }, [
                    ui.E('span', {}, '节点总数'), ui.E('strong', {}, String(counts.nodes || 0))
                ]),
                ui.E('div', { 'class': 'sbd-home-sub-stat' }, [
                    ui.E('span', {}, '自动更新'), ui.E('strong', {}, interval ? interval + ' 分' : '关闭')
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
                        ui.E('span', {}, '远程订阅流量'),
                        ui.E('strong', {}, api.formatBytes(used) + ' / ' + api.formatBytes(total))
                    ]),
                    ui.E('div', { 'class': 'sbd-sub-traffic-bar ' + tone }, [
                        ui.E('i', { style: 'width:' + percent.toFixed(1) + '%' })
                    ])
                ]));
            }
            const lastUpdate = data.latest_update ? api.formatDate(data.latest_update) : '尚未更新';
            body.appendChild(ui.E('div', { 'class': 'sbd-home-sub-foot' }, [
                ui.E('span', {}, '最近更新：' + lastUpdate),
                ui.badge(status.process && status.process.exe_match ? '进程正常' : '待校验',
                    status.process && status.process.exe_match ? 'green' : 'orange')
            ]));
        } catch (error) {
            body.innerHTML = '';
            body.appendChild(ui.note('订阅状态读取失败：' + api.errorText(error), 'bad'));
            body.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('重试', { icon: 'refresh', small: true, onClick: load })));
        }
    }
    load();
    return card;
}

async function render(host, ctx) {
    if (!ctx.status) {
        host.appendChild(ui.empty('无法读取运行状态'));
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




