'use strict';
'require baseclass';
'require rpc';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';
'require view.singbox-dash.v70.lib.components as components';

const MODE_DIAGNOSTICS = [
    { id: 'ebpf', name: 'eBPF · TC', icon: 'zap', color: 'orange', detail: 'Pengambilalihan lokal TC adaptif versi' },
    { id: 'ebpf_cgroup', name: 'eBPF · Cgroup', icon: 'cpu', color: 'purple', detail: 'Pengambilalihan lokal cgroup v2' },
    { id: 'tun', name: 'TUN', icon: 'shield', color: 'blue', detail: 'Pengambilalihan seluruh lalu lintas melalui kartu jaringan virtual' },
    { id: 'tproxy', name: 'TProxy', icon: 'network', color: 'green', detail: 'Proxy transparan TCP / UDP' },
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
        return fields.length >= 4 ? api.formatBytes(Number(fields[3]) * 1024) + ' tersedia' : line;
    }

    function renderService() {
        serviceHost.innerHTML = '';
        const status = diag && diag.status || ctx.status || {};
        serviceHost.appendChild(ui.card('Kontrol layanan', [
            ui.E('div', { 'class': 'sbd-service-state' }, [
                ui.E('span', { 'class': 'sbd-dot ' + (status.running ? 'on' : 'off') }),
                ui.E('span', {}, status.running ? 'Berjalan · PID ' + status.pid : 'Berhenti')
            ]),
            ui.E('div', { 'class': 'sbd-btn-stack sbd-service-actions' }, [
                ui.btn(status.running ? 'Hentikan kernel' : 'Mulai kernel', {
                    icon: status.running ? 'stop' : 'play',
                    variant: status.running ? 'danger' : 'primary',
                    onClick: () => service(status.running ? 'stop' : 'start')
                }),
                ui.btn('Mulai ulang kernel', { icon: 'restart', onClick: () => service('restart') }),
                ui.btn('Perbarui langganan', { icon: 'refresh', onClick: updateSubscription }),
                ui.btn('Periksa kembali', { icon: 'activity', onClick: () => loadDiagnostics(true) })
            ])
        ], { icon: 'tools', iconTone: 'orange' }));
    }

    function modeCard(meta, mode) {
        const data = mode || {};
        const available = !!data.available;
        const active = !!data.active;
        const state = !available ? ['Tidak tersedia', 'red']
            : active && data.running ? ['Berjalan', 'green']
            : ['Tersedia', 'green'];
        const checks = Array.isArray(data.checks) ? data.checks : [];
        const issues = Array.isArray(data.issues) ? data.issues.slice(0, 12) : [];
        const blocking = issues.filter(item => ['fail', 'unknown'].includes(String(item.severity || '').toLowerCase()));
        const warnings = issues.filter(item => String(item.severity || '').toLowerCase() === 'warn');
        function technicalDetails(items) {
            if (!items.length) return null;
            return ui.E('details', { 'class': 'sbd-mode-tech' }, [
                ui.E('summary', {}, 'Lihat detail teknis'),
                ui.E('div', { 'class': 'sbd-mode-tech-list' }, items.map(item => ui.E('div', { 'class': 'sbd-mode-tech-item' }, [
                    ui.E('strong', {}, [item.scope, item.name].filter(Boolean).join(' · ')),
                    item.detail ? ui.E('span', {}, item.detail) : null
                ].filter(Boolean))))
            ]);
        }
        const blockingNodes = blocking.map(item => {
            const severity = String(item.severity || 'fail').toLowerCase();
            return ui.E('div', { 'class': 'sbd-mode-issue ' + severity }, [
                ui.badge('Perlu ditangani', severity === 'unknown' ? 'purple' : 'red'),
                ui.E('div', { 'class': 'sbd-mode-issue-copy' }, [
                    ui.E('strong', {}, item.title || item.name || 'Kemampuan wajib tidak lulus'),
                    item.advice ? ui.E('span', {}, item.advice) : null
                ].filter(Boolean))
            ]);
        });
        function repairTun(button) {
            button.disabled = true;
            api.repairTun().then(async result => {
                if (result && result.ok) {
                    ui.notify(result.created ? 'Node perangkat TUN dibuat' : 'Perangkat TUN siap', 'success');
                    await loadDiagnostics(true);
                } else {
                    ui.notify((result && result.reason) || 'Perbaikan TUN gagal', 'error', 8000);
                }
            }).catch(error => {
                ui.notify(api.errorText(error), 'error', 8000);
            }).finally(() => {
                button.disabled = false;
            });
        }
        const repairAction = data.repair_available
            ? ui.E('div', { 'class': 'sbd-mode-repair' }, ui.btn(
                data.kernel_support ? 'Buat node perangkat TUN' : 'Coba muat modul TUN',
                { icon: 'tools', small: true, onClick: () => repairTun(repairAction.firstChild) }))
            : null;
        const warningHint = available && warnings.length
            ? ui.E('div', { 'class': 'sbd-mode-hint' }, [
                ui.icon('info'),
                ui.E('div', { 'class': 'sbd-mode-hint-copy' }, [
                    ui.E('strong', {}, 'Tersedia, dengan catatan runtime'),
                    ui.E('span', {}, warnings.map(item => item.title || item.name).filter(Boolean).slice(0, 3).join('；'))
                ]),
                technicalDetails(warnings)
            ].filter(Boolean))
            : null;
        const summaryText = !available && blocking.length
            ? (blocking.length + ' kemampuan wajib tidak lulus; lihat alasannya')
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
                ? ui.E('div', { 'class': 'sbd-mode-issue fail' }, [ui.badge('Perlu ditangani', 'red'),
                    ui.E('div', { 'class': 'sbd-mode-issue-copy' }, ui.E('span', {},
                        data.probe_result && data.probe_result !== 'preflight_passed'
                            ? 'Prapemeriksaan terstruktur tidak lulus: ' + data.probe_result
                            : 'Gagal memuat objek program eBPF yang sebenarnya; tidak dapat ditandai tersedia.'))])
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
                ? ui.E('div', { 'class': 'sbd-mode-issue fail' }, [ui.badge('Perlu ditangani', 'red'),
                    ui.E('div', { 'class': 'sbd-mode-issue-copy' }, ui.E('span', {}, data.reason))])
                : null
        ].filter(Boolean));
    }

    function renderChecks() {
        checkHost.innerHTML = '';
        const checks = diag && diag.checks || {};
        const names = { nft: 'nftables', tun: 'Node perangkat TUN', tun_kernel: 'Kernel TUN', cgroup2: 'cgroup v2', bpffs: 'bpffs', ebpf: 'Kernel eBPF' };
        const checkNodes = Object.keys(names).map(key => ui.E('div', { 'class': 'sbd-check' }, [
            ui.E('div', { 'class': 'sbd-check-name' }, names[key]),
            ui.E('div', { 'class': 'sbd-check-value ' + (checks[key] ? 'good' : 'bad') }, checks[key] ? 'Normal' : 'Tidak ada')
        ]));
        checkHost.appendChild(ui.card('Pemeriksaan lingkungan sistem', [
            ui.E('div', { 'class': 'sbd-stat-grid sbd-stat-grid-3' }, [
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, 'Memori sistem'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, memoryText())
                ]),
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, 'Ruang Overlay'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, diskText())
                ]),
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, 'Waktu pemeriksaan'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, diag ? api.formatDate(diag.time) : '—')
                ])
            ]),
            ui.E('div', { 'class': 'sbd-checks' }, checkNodes),
            diag && diag.status && diag.status.api && diag.status.api.port
                ? ui.row('Clash API', diag.status.api.endpoint, ui.badge('Online', 'green'), { icon: 'globe', color: 'green' })
                : ui.note('Clash API saat ini tidak aktif.', 'warn')
        ], { icon: 'shield', iconTone: 'green' }));

        const modes = diag && diag.modes || {};
        checkHost.appendChild(ui.card('Diagnostik mode pengambilalihan', [
            ui.E('div', { 'class': 'sbd-mode-diag-grid' },
                MODE_DIAGNOSTICS.map(meta => modeCard(meta, modes[meta.id])))
        ], {
            icon: 'network',
            iconTone: 'orange',
            subtitle: 'Dependensi, prapemeriksaan, dan status runtime saat ini',
            actions: [ui.btn('', { icon: 'refresh', iconOnly: true, title: 'Periksa kembali', onClick: () => loadDiagnostics(true) })]
        }));
    }

    let logsPaused = false;
    let logTimer = null;
    let rawLogs = '';
    let logSource = 'all';
    let logLevel = 'all';
    let logSearch = '';
    let logFollow = true;
    const logPre = ui.E('pre', { 'class': 'sbd-pre sbd-log', role: 'log', tabindex: '0', 'aria-label': 'Log runtime' }, 'Memuat...');
    const logMeta = ui.E('div', { 'class': 'sbd-log-meta' }, 'Membaca log...');
    const logSourceSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': 'Sumber log', change: event => {
        logSource = event.target.value; renderLogText();
    } });
    const logLevelSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': 'Level log', change: event => {
        logLevel = event.target.value; renderLogText();
    } }, [
        ui.E('option', { value: 'all' }, 'Semua level'),
        ui.E('option', { value: 'error' }, 'Kesalahan'),
        ui.E('option', { value: 'warn' }, 'Peringatan'),
        ui.E('option', { value: 'info' }, 'Informasi'),
        ui.E('option', { value: 'debug' }, 'Debug')
    ]);
    const logSearchInput = ui.E('input', {
        type: 'search', 'class': 'sbd-input', 'aria-label': 'Filter kata kunci log', placeholder: 'Filter kata kunci log...',
        input: event => { logSearch = String(event.target.value || '').trim().toLowerCase(); renderLogText(); }
    });
    const logFollowInput = ui.E('input', { type: 'checkbox', checked: '' });
    logFollowInput.checked = true;
    logFollowInput.addEventListener('change', () => {
        logFollow = logFollowInput.checked;
        if (logFollow) renderLogText();
    });
    const pauseLogButton = ui.btn('Jeda', { small: true, onClick: () => {
        logsPaused = !logsPaused;
        const label = pauseLogButton.querySelector('span');
        if (label) label.textContent = logsPaused ? 'Lanjutkan' : 'Jeda';
        ui.notify(logsPaused ? 'Penyegaran log otomatis dijeda' : 'Penyegaran log otomatis dilanjutkan', 'info');
        renderLogText();
    } });
    const copyLogButton = ui.btn('Salin', { small: true, onClick: async () => {
        try {
            await navigator.clipboard.writeText(filteredLogText());
            ui.notify('Log saat ini disalin', 'success');
        } catch (_) {
            ui.notify('Browser tidak mengizinkan penyalinan otomatis; pilih teks log secara manual', 'warn');
        }
    } });
    const exportLogButton = ui.btn('Ekspor', { small: true, icon: 'download', onClick: () => exportLogs() });
    const clearLogButton = ui.btn('Bersihkan tampilan', { small: true, onClick: () => {
        rawLogs = '';
        renderLogText();
    } });

    function sourceLabel(source) {
        const value = String(source || '').trim();
        if (/sing-box 运行日志/.test(value)) return 'Runtime kernel';
        if (/sing-box 系统日志/.test(value)) return 'Log sistem';
        if (/配置错误/.test(value)) return 'Kesalahan konfigurasi';
        return value || 'Lainnya';
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
        logSourceSelect.appendChild(ui.E('option', { value: 'all' }, 'Semua sumber'));
        values.forEach(value => logSourceSelect.appendChild(ui.E('option', { value }, value)));
        logSourceSelect.value = current;
    }

    function renderLogText() {
        syncLogSources();
        const entries = filteredLogEntries();
        const all = parseLogLines(rawLogs);
        if (!rawLogs) {
            logPre.textContent = 'Tampilan log dibersihkan; log akan dibaca kembali saat penyegaran berikutnya.';
        } else if (!entries.length) {
            logPre.textContent = 'Tidak ada log yang cocok dengan filter saat ini.';
        } else {
            logPre.textContent = entries.map(entry => (entry.source ? '[' + entry.label + '] ' : '') + entry.line).join('\n');
        }
        logMeta.textContent = 'Menampilkan ' + entries.length + ' / ' + all.length + ' baris · ' +
            (logsPaused ? 'Penyegaran otomatis dijeda' : 'Penyegaran otomatis setiap 5 detik');
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
        if (!entries.length) return ui.notify('Tidak ada log untuk diekspor saat ini', 'warn');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = 'singbox-dash-logs-' + stamp + '.log';
        const status = ui.E('div', { 'class': 'sbd-modal-text' }, 'Menyiapkan file ekspor...');
        const ref = ui.modal('Ekspor log', [status], { cancelText: 'Batal', width: '480px' });
        try {
            const result = await api.command('logs-export', [logSource, logLevel, logSearch]);
            status.textContent = result.lines + ' baris log difilter.';
            ref.body.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('Unduh file log', {
                icon: 'download', variant: 'primary', onClick: () => {
                    submitLogDownload(result.path, filename);
                    window.setTimeout(() => ref.close(), 300);
                }
            })));
            window.setTimeout(() => api.removeUpload(result.path).catch(() => {}), 300000);
        } catch (error) {
            status.textContent = 'Gagal mengekspor log: ' + api.errorText(error);
        }
    }

    function renderLogCard() {
        logHost.innerHTML = '';
        logHost.appendChild(ui.card('Log runtime', [
            ui.E('div', { 'class': 'sbd-log-toolbar sbd-log-toolbar-filter' }, [
                logSourceSelect,
                logLevelSelect,
                ui.E('div', { 'class': 'sbd-log-search' }, [ui.icon('search'), logSearchInput]),
                ui.E('label', { 'class': 'sbd-log-follow' }, [logFollowInput, ui.E('span', {}, 'Ikuti terbaru')]),
                copyLogButton,
                exportLogButton,
                pauseLogButton,
                clearLogButton,
                ui.btn('Segarkan', { small: true, onClick: () => loadLogs() })
            ]),
            logMeta,
            logPre
        ], { icon: 'terminal', iconTone: 'purple' }));
    }

    async function loadDiagnostics(refresh) {
        checkHost.innerHTML = '';
        checkHost.appendChild(ui.card('Pemeriksaan lingkungan sistem', [ui.loading(refresh ? 'Memeriksa ulang dependensi mode' : 'Memeriksa lingkungan')], { icon: 'shield', iconTone: 'green' }));
        try {
            diag = await api.diagnostics(!!refresh);
            ctx.status = diag.status;
            ctx.settings = await api.settings();
        } catch (error) {
            checkHost.innerHTML = '';
            checkHost.appendChild(ui.card('Pemeriksaan lingkungan sistem', [ui.note(api.errorText(error), 'bad')], { icon: 'shield', iconTone: 'red' }));
            return;
        }
        renderService();
        renderChecks();
    }

    async function loadLogs(silent) {
        if (!silent) logMeta.textContent = 'Membaca log...';
        try {
            const result = await api.command('logs');
            rawLogs = result.data || '';
            renderLogText();
        } catch (error) {
            logMeta.textContent = 'Gagal membaca log: ' + api.errorText(error);
        }
    }

    async function service(action) {
        if (action === 'stop') {
            const ok = await ui.confirm('Hentikan layanan', 'Proxy transparan dan API akan terputus setelah dihentikan.', 'Berhenti', true);
            if (!ok) return;
        }
        setBusy(true);
        try {
            await api.command('service', [action]);
            ui.notify(action === 'stop' ? 'Layanan dihentikan' : action === 'start' ? 'Layanan dimulai' : 'Layanan dimulai ulang', 'success');
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
            if (result.job) await ctx.watchJob(result.job, 'Memperbarui langganan');
            else ui.notify(result.message || 'Konten langganan tidak berubah', 'success');
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


