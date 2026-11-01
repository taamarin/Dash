'use strict';
'require baseclass';
'require rpc';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';
'require view.singbox-dash.v70.lib.components as components';

const MODE_DIAGNOSTICS = [
    { id: 'ebpf', name: 'eBPF · TC', icon: 'zap', color: 'orange', detail: '版本自适应 TC 本机接管' },
    { id: 'ebpf_cgroup', name: 'eBPF · Cgroup', icon: 'cpu', color: 'purple', detail: 'cgroup v2 本机接管' },
    { id: 'tun', name: 'TUN', icon: 'shield', color: 'blue', detail: '虚拟网卡全流量接管' },
    { id: 'tproxy', name: 'TProxy', icon: 'network', color: 'green', detail: 'TCP / UDP 透明代理' },
    { id: 'redirect', name: 'Redirect', icon: 'route', color: 'purple', detail: 'TCP NAT + UDP TProxy' }
];

async function render(host, ctx) {
    let diag = null;
    let busy = false;
    const root = ui.E('div', { 'class': 'sbd-grid' });
    host.appendChild(root);

    const serviceHost = ui.E('div', { 'class': 'sbd-span-12' });
    const checkHost = ui.E('div', { 'class': 'sbd-span-12' });
    const logHost = ui.E('div', { 'class': 'sbd-span-12' });
    root.appendChild(serviceHost);
    root.appendChild(checkHost);
    root.appendChild(logHost);

    function setBusy(value) {
        busy = value;
        components.setBusy(root, value, { selector: 'button' });
    }

    function memoryText() {
        const memory = diag && diag.memory_kb || {};
        if (!memory.MemTotal) return '—';
        const used = Math.max(0, memory.MemTotal - (memory.MemAvailable || 0));
        return api.formatBytes(used * 1024) + ' / ' + api.formatBytes(memory.MemTotal * 1024);
    }

    function diskText() {
        const text = String(diag && diag.disk || '');
        const line = text.split(/\r?\n/).find(item => /\/overlay/.test(item));
        if (!line) return '—';
        const fields = line.trim().split(/\s+/);
        return fields.length >= 4 ? api.formatBytes(Number(fields[3]) * 1024) + ' 可用' : line;
    }

    function renderService() {
        serviceHost.innerHTML = '';
        const status = diag && diag.status || ctx.status || {};
        serviceHost.appendChild(ui.card('服务控制', [
            ui.E('div', { 'class': 'sbd-service-state' }, [
                ui.E('span', { 'class': 'sbd-dot ' + (status.running ? 'on' : 'off') }),
                ui.E('span', {}, status.running ? '运行中 · PID ' + status.pid : '已停止')
            ]),
            ui.E('div', { 'class': 'sbd-btn-stack sbd-service-actions' }, [
                ui.btn(status.running ? '停止内核' : '启动内核', {
                    icon: status.running ? 'stop' : 'play',
                    variant: status.running ? 'danger' : 'primary',
                    onClick: () => service(status.running ? 'stop' : 'start')
                }),
                ui.btn('重启内核', { icon: 'restart', onClick: () => service('restart') }),
                ui.btn('更新订阅', { icon: 'refresh', onClick: updateSubscription }),
                ui.btn('重新检测', { icon: 'activity', onClick: () => loadDiagnostics(true) })
            ])
        ], { icon: 'tools', iconTone: 'orange' }));
    }

    function modeCard(meta, mode) {
        const data = mode || {};
        const available = !!data.available;
        const active = !!data.active;
        const state = !available ? ['不可用', 'red']
            : active && data.running ? ['运行中', 'green']
            : ['可用', 'green'];
        const checks = Array.isArray(data.checks) ? data.checks : [];
        const issues = Array.isArray(data.issues) ? data.issues.slice(0, 12) : [];
        const blocking = issues.filter(item => ['fail', 'unknown'].includes(String(item.severity || '').toLowerCase()));
        const warnings = issues.filter(item => String(item.severity || '').toLowerCase() === 'warn');
        function technicalDetails(items) {
            if (!items.length) return null;
            return ui.E('details', { 'class': 'sbd-mode-tech' }, [
                ui.E('summary', {}, '查看技术详情'),
                ui.E('div', { 'class': 'sbd-mode-tech-list' }, items.map(item => ui.E('div', { 'class': 'sbd-mode-tech-item' }, [
                    ui.E('strong', {}, [item.scope, item.name].filter(Boolean).join(' · ')),
                    item.detail ? ui.E('span', {}, item.detail) : null
                ].filter(Boolean))))
            ]);
        }
        const blockingNodes = blocking.map(item => {
            const severity = String(item.severity || 'fail').toLowerCase();
            return ui.E('div', { 'class': 'sbd-mode-issue ' + severity }, [
                ui.badge('需处理', severity === 'unknown' ? 'purple' : 'red'),
                ui.E('div', { 'class': 'sbd-mode-issue-copy' }, [
                    ui.E('strong', {}, item.title || item.name || '必需能力未通过'),
                    item.advice ? ui.E('span', {}, item.advice) : null
                ].filter(Boolean))
            ]);
        });
        function repairTun(button) {
            button.disabled = true;
            api.repairTun().then(async result => {
                if (result && result.ok) {
                    ui.notify(result.created ? 'TUN 设备节点已创建' : 'TUN 设备已就绪', 'success');
                    await loadDiagnostics(true);
                } else {
                    ui.notify((result && result.reason) || 'TUN 修复失败', 'error', 8000);
                }
            }).catch(error => {
                ui.notify(api.errorText(error), 'error', 8000);
            }).finally(() => {
                button.disabled = false;
            });
        }
        const repairAction = data.repair_available
            ? ui.E('div', { 'class': 'sbd-mode-repair' }, ui.btn(
                data.kernel_support ? '创建 TUN 设备节点' : '尝试加载 TUN 模块',
                { icon: 'tools', small: true, onClick: () => repairTun(repairAction.firstChild) }))
            : null;
        const warningHint = available && warnings.length
            ? ui.E('div', { 'class': 'sbd-mode-hint' }, [
                ui.icon('info'),
                ui.E('div', { 'class': 'sbd-mode-hint-copy' }, [
                    ui.E('strong', {}, '可用，有运行注意项'),
                    ui.E('span', {}, warnings.map(item => item.title || item.name).filter(Boolean).slice(0, 3).join('；'))
                ]),
                technicalDetails(warnings)
            ].filter(Boolean))
            : null;
        const summaryText = !available && blocking.length
            ? (blocking.length + ' 项必需能力未通过，请查看原因')
            : (data.summary || meta.detail);
        return ui.E('div', { 'class': 'sbd-mode-diag' + (active ? ' active' : '') + (available ? '' : ' unavailable') }, [
            ui.E('div', { 'class': 'sbd-mode-diag-head' }, [
                ui.E('div', { 'class': 'sbd-row-left' }, [
                    ui.appIcon(meta.icon, meta.color),
                    ui.E('div', { 'class': 'sbd-row-main' }, [
                        ui.E('div', { 'class': 'sbd-row-title' }, meta.name),
                        ui.E('div', { 'class': 'sbd-row-sub' }, summaryText)
                    ])
                ]),
                ui.badge(state[0], state[1])
            ]),
            data.exact_object_load === false || data.probe_result && data.probe_result !== 'preflight_passed'
                ? ui.E('div', { 'class': 'sbd-mode-issue fail' }, [ui.badge('需处理', 'red'),
                    ui.E('div', { 'class': 'sbd-mode-issue-copy' }, ui.E('span', {},
                        data.probe_result && data.probe_result !== 'preflight_passed'
                            ? '结构化预检未通过：' + data.probe_result
                            : '未能加载实际 eBPF 程序对象，不能标记为可用。'))])
                : null,
            ui.E('div', { 'class': 'sbd-mode-diag-checks' }, checks.map(item => ui.E('div', {
                'class': 'sbd-mode-diag-check ' + (item.ready === true ? 'good' : item.ready === false ? 'bad' : 'pending')
            }, [
                ui.E('span', { 'class': 'sbd-mode-diag-check-name' }, item.name),
                ui.E('strong', { 'class': 'sbd-mode-diag-check-value' }, item.value == null || item.value === '' ? '—' : String(item.value))
            ]))),
            blockingNodes.length ? ui.E('div', { 'class': 'sbd-mode-issues' }, blockingNodes) : null,
            !available && blocking.length ? technicalDetails(issues) : null,
            warningHint,
            repairAction,
            !available && !issues.length && data.reason
                ? ui.E('div', { 'class': 'sbd-mode-issue fail' }, [ui.badge('需处理', 'red'),
                    ui.E('div', { 'class': 'sbd-mode-issue-copy' }, ui.E('span', {}, data.reason))])
                : null
        ].filter(Boolean));
    }

    function renderChecks() {
        checkHost.innerHTML = '';
        const checks = diag && diag.checks || {};
        const names = { nft: 'nftables', tun: 'TUN 设备节点', tun_kernel: 'TUN 内核', cgroup2: 'cgroup v2', bpffs: 'bpffs', ebpf: 'eBPF 内核' };
        const checkNodes = Object.keys(names).map(key => ui.E('div', { 'class': 'sbd-check' }, [
            ui.E('div', { 'class': 'sbd-check-name' }, names[key]),
            ui.E('div', { 'class': 'sbd-check-value ' + (checks[key] ? 'good' : 'bad') }, checks[key] ? '正常' : '缺失')
        ]));
        checkHost.appendChild(ui.card('系统环境检查', [
            ui.E('div', { 'class': 'sbd-stat-grid sbd-stat-grid-3' }, [
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, '系统内存'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, memoryText())
                ]),
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, 'Overlay 空间'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, diskText())
                ]),
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, '检测时间'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, diag ? api.formatDate(diag.time) : '—')
                ])
            ]),
            ui.E('div', { 'class': 'sbd-checks' }, checkNodes),
            diag && diag.status && diag.status.api && diag.status.api.port
                ? ui.row('Clash API', diag.status.api.endpoint, ui.badge('在线', 'green'), { icon: 'globe', color: 'green' })
                : ui.note('Clash API 当前未启用。', 'warn')
        ], { icon: 'shield', iconTone: 'green' }));

        const modes = diag && diag.modes || {};
        checkHost.appendChild(ui.card('接管模式诊断', [
            ui.E('div', { 'class': 'sbd-mode-diag-grid' },
                MODE_DIAGNOSTICS.map(meta => modeCard(meta, modes[meta.id])))
        ], {
            icon: 'network',
            iconTone: 'orange',
            subtitle: '依赖、预检与当前运行状态',
            actions: [ui.btn('', { icon: 'refresh', iconOnly: true, title: '重新检测', onClick: () => loadDiagnostics(true) })]
        }));
    }

    let logsPaused = false;
    let logTimer = null;
    let rawLogs = '';
    let logSource = 'all';
    let logLevel = 'all';
    let logSearch = '';
    let logFollow = true;
    const logPre = ui.E('pre', { 'class': 'sbd-pre sbd-log', role: 'log', tabindex: '0', 'aria-label': '运行日志' }, '加载中...');
    const logMeta = ui.E('div', { 'class': 'sbd-log-meta' }, '读取日志...');
    const logSourceSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': '日志来源', change: event => {
        logSource = event.target.value; renderLogText();
    } });
    const logLevelSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': '日志级别', change: event => {
        logLevel = event.target.value; renderLogText();
    } }, [
        ui.E('option', { value: 'all' }, '全部级别'),
        ui.E('option', { value: 'error' }, '错误'),
        ui.E('option', { value: 'warn' }, '警告'),
        ui.E('option', { value: 'info' }, '信息'),
        ui.E('option', { value: 'debug' }, '调试')
    ]);
    const logSearchInput = ui.E('input', {
        type: 'search', 'class': 'sbd-input', 'aria-label': '过滤日志关键词', placeholder: '过滤日志关键词...',
        input: event => { logSearch = String(event.target.value || '').trim().toLowerCase(); renderLogText(); }
    });
    const logFollowInput = ui.E('input', { type: 'checkbox', checked: '' });
    logFollowInput.checked = true;
    logFollowInput.addEventListener('change', () => {
        logFollow = logFollowInput.checked;
        if (logFollow) renderLogText();
    });
    const pauseLogButton = ui.btn('暂停', { small: true, onClick: () => {
        logsPaused = !logsPaused;
        const label = pauseLogButton.querySelector('span');
        if (label) label.textContent = logsPaused ? '继续' : '暂停';
        ui.notify(logsPaused ? '日志自动刷新已暂停' : '日志自动刷新已继续', 'info');
        renderLogText();
    } });
    const copyLogButton = ui.btn('复制', { small: true, onClick: async () => {
        try {
            await navigator.clipboard.writeText(filteredLogText());
            ui.notify('当前日志已复制', 'success');
        } catch (_) {
            ui.notify('浏览器不允许自动复制，请手动选择日志文本', 'warn');
        }
    } });
    const exportLogButton = ui.btn('导出', { small: true, icon: 'download', onClick: () => exportLogs() });
    const clearLogButton = ui.btn('清空显示', { small: true, onClick: () => {
        rawLogs = '';
        renderLogText();
    } });

    function sourceLabel(source) {
        const value = String(source || '').trim();
        if (/sing-box 运行日志/.test(value)) return '内核运行';
        if (/sing-box 系统日志/.test(value)) return '系统日志';
        if (/配置错误/.test(value)) return '配置错误';
        return value || '其他';
    }

    function logLevelOf(line) {
        const text = String(line || '').toUpperCase();
        if (/\b(FATAL|PANIC)\b/.test(text)) return 'error';
        if (/\bERROR\b/.test(text)) return 'error';
        if (/\bWARN(?:ING)?\b/.test(text)) return 'warn';
        if (/\bDEBUG\b/.test(text)) return 'debug';
        if (/\bTRACE\b/.test(text)) return 'debug';
        if (/\bINFO\b/.test(text)) return 'info';
        return 'other';
    }

    function parseLogLines(text) {
        const normalized = String(text || '').replace(/\r/g, '');
        const entries = [];
        normalized.split(/\n\n(?=\[)/).forEach(section => {
            const header = section.match(/^\[([^\]]+)\]\s*\n?/);
            const source = header ? header[1] : '';
            const body = header ? section.slice(header[0].length) : section;
            body.split('\n').forEach(line => {
                if (!line.trim()) return;
                entries.push({ source, label: sourceLabel(source), level: logLevelOf(line), line });
            });
        });
        return entries;
    }

    function filteredLogEntries() {
        return parseLogLines(rawLogs).filter(entry => {
            if (logSource !== 'all' && entry.label !== logSource) return false;
            if (logLevel !== 'all' && entry.level !== logLevel) return false;
            if (logSearch && !(entry.label + ' ' + entry.line).toLowerCase().includes(logSearch)) return false;
            return true;
        });
    }

    function filteredLogText() {
        const entries = filteredLogEntries();
        if (!entries.length) return rawLogs || '';
        return entries.map(entry => (entry.source ? '[' + entry.label + '] ' : '') + entry.line).join('\n');
    }

    function syncLogSources() {
        const entries = parseLogLines(rawLogs);
        const values = Array.from(new Set(entries.map(entry => entry.label))).filter(Boolean);
        if (logSource !== 'all' && values.indexOf(logSource) < 0) logSource = 'all';
        const current = logSource;
        logSourceSelect.innerHTML = '';
        logSourceSelect.appendChild(ui.E('option', { value: 'all' }, '全部来源'));
        values.forEach(value => logSourceSelect.appendChild(ui.E('option', { value }, value)));
        logSourceSelect.value = current;
    }

    function renderLogText() {
        syncLogSources();
        const entries = filteredLogEntries();
        const all = parseLogLines(rawLogs);
        if (!rawLogs) {
            logPre.textContent = '日志显示已清空，下次刷新会重新读取。';
        } else if (!entries.length) {
            logPre.textContent = '没有匹配当前筛选条件的日志。';
        } else {
            logPre.textContent = entries.map(entry => (entry.source ? '[' + entry.label + '] ' : '') + entry.line).join('\n');
        }
        logMeta.textContent = '显示 ' + entries.length + ' / ' + all.length + ' 行 · ' +
            (logsPaused ? '自动刷新已暂停' : '每 5 秒自动刷新');
        if (logFollow) window.requestAnimationFrame(() => { logPre.scrollTop = logPre.scrollHeight; });
    }

    function submitLogDownload(path, filename) {
        const form = document.createElement('form');
        form.method = 'post';
        form.action = (L.env.cgi_base || '/cgi-bin') + '/cgi-download';
        form.style.display = 'none';
        [['sessionid', rpc.getSessionID()], ['path', path], ['filename', filename]].forEach(item => {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = item[0];
            input.value = item[1];
            form.appendChild(input);
        });
        document.body.appendChild(form);
        form.submit();
        form.remove();
    }

    async function exportLogs() {
        const entries = filteredLogEntries().slice(-1000);
        if (!entries.length) return ui.notify('当前没有可导出的日志', 'warn');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = 'singbox-dash-logs-' + stamp + '.log';
        const status = ui.E('div', { 'class': 'sbd-modal-text' }, '正在准备导出文件...');
        const ref = ui.modal('导出日志', [status], { cancelText: '取消', width: '480px' });
        try {
            const result = await api.command('logs-export', [logSource, logLevel, logSearch]);
            status.textContent = '已筛选 ' + result.lines + ' 行日志。';
            ref.body.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('下载日志文件', {
                icon: 'download', variant: 'primary', onClick: () => {
                    submitLogDownload(result.path, filename);
                    window.setTimeout(() => ref.close(), 300);
                }
            })));
            window.setTimeout(() => api.removeUpload(result.path).catch(() => {}), 300000);
        } catch (error) {
            status.textContent = '日志导出失败：' + api.errorText(error);
        }
    }

    function renderLogCard() {
        logHost.innerHTML = '';
        logHost.appendChild(ui.card('运行日志', [
            ui.E('div', { 'class': 'sbd-log-toolbar sbd-log-toolbar-filter' }, [
                logSourceSelect,
                logLevelSelect,
                ui.E('div', { 'class': 'sbd-log-search' }, [ui.icon('search'), logSearchInput]),
                ui.E('label', { 'class': 'sbd-log-follow' }, [logFollowInput, ui.E('span', {}, '跟随最新')]),
                copyLogButton,
                exportLogButton,
                pauseLogButton,
                clearLogButton,
                ui.btn('刷新', { small: true, onClick: () => loadLogs() })
            ]),
            logMeta,
            logPre
        ], { icon: 'terminal', iconTone: 'purple' }));
    }

    async function loadDiagnostics(refresh) {
        checkHost.innerHTML = '';
        checkHost.appendChild(ui.card('系统环境检查', [ui.loading(refresh ? '正在重新检测模式依赖' : '正在检测环境')], { icon: 'shield', iconTone: 'green' }));
        try {
            diag = await api.diagnostics(!!refresh);
            ctx.status = diag.status;
            ctx.settings = await api.settings();
        } catch (error) {
            checkHost.innerHTML = '';
            checkHost.appendChild(ui.card('系统环境检查', [ui.note(api.errorText(error), 'bad')], { icon: 'shield', iconTone: 'red' }));
            return;
        }
        renderService();
        renderChecks();
    }

    async function loadLogs(silent) {
        if (!silent) logMeta.textContent = '读取日志...';
        try {
            const result = await api.command('logs');
            rawLogs = result.data || '';
            renderLogText();
        } catch (error) {
            logMeta.textContent = '日志读取失败：' + api.errorText(error);
        }
    }

    async function service(action) {
        if (action === 'stop') {
            const ok = await ui.confirm('停止服务', '停止后透明代理与 API 将中断。', '停止', true);
            if (!ok) return;
        }
        setBusy(true);
        try {
            await api.command('service', [action]);
            ui.notify(action === 'stop' ? '服务已停止' : action === 'start' ? '服务已启动' : '服务已重启', 'success');
            await loadDiagnostics(true);
            await loadLogs();
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally {
            setBusy(false);
        }
    }

    async function updateSubscription() {
        setBusy(true);
        try {
            const result = await api.command('subscription-update');
            if (result.job) await ctx.watchJob(result.job, '更新订阅');
            else ui.notify(result.message || '订阅内容无变化', 'success');
            await loadDiagnostics(true);
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally {
            setBusy(false);
        }
    }

    renderLogCard();
    renderService();
    await Promise.all([loadDiagnostics(), loadLogs()]);
    logTimer = window.setInterval(() => {
        if (!logsPaused && !document.hidden) loadLogs(true);
    }, 5000);
    ctx.onCleanup(() => {
        if (logTimer) window.clearInterval(logTimer);
    });
}

return baseclass.extend({ render });



