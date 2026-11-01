'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';
'require view.singbox-dash.v70.lib.components as components';

const KERNEL_SOURCES = {
    michongs: { label: 'MiChongs', repo: 'MiChongs/sing-box' },
    ref1nd: { label: 'reF1nd', repo: 'reF1nd/sing-box-releases' }
};

function shortVersion(value) {
    const line = String(value || '').split(/\r?\n/).find(item => /sing-box version/i.test(item)) || String(value || '');
    return line.replace(/^.*?sing-box version\s*/i, '').trim() || '—';
}

function withTimeout(promise, milliseconds, message) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
        if (timer) window.clearTimeout(timer);
    });
}

async function kernelFileKind(file) {
    if (!file || file.size < 4) return '';
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)
        return 'ELF 内核';
    if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip 压缩包';
    if (head[0] === 0x50 && head[1] === 0x4b) return 'zip 压缩包';
    if (/\.tar$/i.test(file.name || '')) return 'tar 压缩包';
    return '';
}

async function render(host, ctx) {
    let info = null;
    let infoLoading = true;
    let infoError = '';
    let infoRequest = 0;
    let releases = [];
    let releasesLoading = true;
    let releasesLoadingLabel = '获取版本列表';
    let releasesError = '';
    let releasesRequest = 0;
    let channel = 'all';
    const savedBuildType = window.localStorage.getItem('singbox-dash-build-type');
    let buildType = savedBuildType === 'ebpf' || savedBuildType === 'standard'
        ? savedBuildType
        : (ctx.status ? (ctx.status.ebpf ? 'ebpf' : 'standard') : '');
    const savedSource = window.localStorage.getItem('singbox-dash-kernel-source');
    let source = KERNEL_SOURCES[savedSource] ? savedSource
        : (ctx.status && KERNEL_SOURCES[ctx.status.core_family] ? ctx.status.core_family : 'michongs');
    let repository = KERNEL_SOURCES[source].repo;
    let releasePlatform = null;
    let busy = false;
    const root = ui.E('div', { 'class': 'sbd-grid' });
    host.appendChild(root);

    const infoHost = ui.E('div', { 'class': 'sbd-span-12' });
    const releaseHost = ui.E('div', { 'class': 'sbd-span-7' });
    const backupHost = ui.E('div', { 'class': 'sbd-span-5' });
    root.appendChild(infoHost);
    root.appendChild(releaseHost);
    root.appendChild(backupHost);

    const fileInput = ui.E('input', {
        type: 'file',
        style: 'display:none', change: event => {
            const file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (file) installFile(file);
        }
    });

    function setBusy(value) {
        busy = value;
        components.setBusy(root, value, { selector: 'button, select' });
    }

    function platformName(platform) {
        if (!platform) return '—';
        return (platform.core_arch || platform.machine || '—') + ' / ' + (platform.libc || 'unknown') +
            (platform.bits ? ' / ' + platform.bits + '-bit' : '');
    }

    function renderInfo() {
        infoHost.innerHTML = '';
        if (infoLoading && !info) {
            infoHost.appendChild(ui.card('当前内核', [ui.loading('读取内核信息')], {
                icon: 'kernel', iconTone: 'purple'
            }));
            return;
        }
        if (!info) {
            infoHost.appendChild(ui.card('内核信息不可用', [
                ui.note(infoError || '管理服务没有返回内核信息', 'bad'),
                ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('重新读取', {
                    icon: 'refresh', onClick: () => loadInfo(true)
                }))
            ], { icon: 'kernel', iconTone: 'red' }));
            return;
        }
        const platform = info.platform || {};
        const probe = info.ebpf || {};
        infoHost.appendChild(ui.card('当前内核', [
            ui.E('div', { 'class': 'sbd-kernel-grid' }, [
                ui.E('div', { 'class': 'sbd-row-left' }, [
                    ui.appIcon('kernel', 'purple'),
                    ui.E('div', { 'class': 'sbd-kernel-main' }, [
                        ui.E('div', { 'class': 'sbd-kernel-version' }, info.version ? shortVersion(info.version) : '未安装'),
                        ui.E('div', { 'class': 'sbd-row-sub' }, info.path || '/usr/bin/sing-box'),
                        ui.E('div', { 'class': 'sbd-btn-row' }, [
                            ui.badge(info.exists ? '已安装' : '未安装', info.exists ? 'green' : 'bad'),
                            ui.badge('内核：' + (info.core_family_label || '未知'), 'green'),
                            info.ebpf_build ? ui.badge('eBPF 构建', 'orange') : ui.badge('标准构建', 'blue'),
                            ui.badge(platform.distrib_arch || platform.machine || '未知架构', 'purple')
                        ])
                    ])
                ]),
                ui.E('div', { 'class': 'sbd-kernel-actions' }, [
                    fileInput,
                    ui.btn('本地安装', { icon: 'upload', variant: 'primary', onClick: () => fileInput.click() }),
                    ui.btn('', { icon: 'refresh', iconOnly: true, title: '刷新', onClick: () => loadInfo(true) })
                ])
            ]),
            infoError ? ui.note('刷新失败：' + infoError, 'warn') : null,
            ui.E('div', { 'class': 'sbd-stat-grid sbd-stat-grid-4' }, [
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, '设备平台'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, platformName(platform)),
                    ui.E('div', { 'class': 'sbd-stat-sub' }, platform.kernel || '')
                ]),
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, '文件体积'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, api.formatBytes(info.size)),
                    ui.E('div', { 'class': 'sbd-stat-sub' }, 'SHA256 ' + (info.hash || '—'))
                ]),
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, 'eBPF 支持'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, probe.deferred ? (probe.supported ? '构建支持' : '不支持') : (probe.supported ? '可用' : '不可用')),
                    ui.E('div', { 'class': 'sbd-stat-sub' }, probe.deferred ? '请到诊断工具验证运行能力' : (probe.summary ? '已完成探测' : '未探测'))
                ]),
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, '历史备份'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, String((info.backups || []).length) + ' 个'),
                    ui.E('div', { 'class': 'sbd-stat-sub' }, '异常时自动回滚')
                ])
            ]),
            probe.summary ? ui.E('details', { 'class': 'sbd-details' }, [
                ui.E('summary', {}, 'eBPF 环境详情'),
                ui.E('pre', { 'class': 'sbd-pre' }, probe.summary)
            ]) : null
        ].filter(Boolean), { icon: 'kernel', iconTone: 'purple' }));
    }

    async function loadInfo(force) {
        const request = ++infoRequest;
        infoLoading = true;
        infoError = '';
        renderInfo();
        renderBackups();
        try {
            const value = await withTimeout(api.kernelInfo(force === true), 25000, '读取内核信息超时');
            if (request !== infoRequest) return;
            info = value;
            if (!buildType) {
                buildType = info.ebpf_build ? 'ebpf' : 'standard';
                window.localStorage.setItem('singbox-dash-build-type', buildType);
            }
            renderReleases();
        } catch (error) {
            if (request !== infoRequest) return;
            infoError = api.errorText(error);
            if (!info) ui.notify('内核信息读取失败：' + infoError, 'error', 7000);
        } finally {
            if (request === infoRequest) {
                infoLoading = false;
                renderInfo();
                renderBackups();
            }
        }
    }

    function renderBackups() {
        backupHost.innerHTML = '';
        if (infoLoading && !info) {
            backupHost.appendChild(ui.card('内核备份', [ui.loading('读取备份信息')], {
                icon: 'backup', iconTone: 'orange'
            }));
            return;
        }
        if (!info) {
            backupHost.appendChild(ui.card('内核备份', [
                ui.note(infoError || '内核信息不可用，无法读取备份列表', 'bad'),
                ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('重新读取', {
                    icon: 'refresh', onClick: () => loadInfo(true)
                }))
            ], { icon: 'backup', iconTone: 'orange' }));
            return;
        }
        const backups = info.backups || [];
        const body = ui.E('div', { 'class': 'sbd-backup-list' });
        if (!backups.length) body.appendChild(ui.empty('暂无内核备份'));
        backups.forEach(item => {
            body.appendChild(ui.row(shortVersion(item.version) || item.name, [
                api.formatDate(item.time), ' · ', api.formatBytes(item.size)
            ], [
                ui.btn('回滚', {
                    icon: 'backup', small: true, onClick: () => rollback(item)
                }),
                ui.btn('', {
                    icon: 'trash', iconOnly: true, small: true, variant: 'danger',
                    title: '删除此内核备份', onClick: () => deleteBackup(item)
                })
            ], { icon: 'backup', color: 'orange' }));
        });
        backupHost.appendChild(ui.card('内核备份', [body], {
            icon: 'backup',
            iconTone: 'orange',
            subtitle: '最多保留 10 份，超出后自动删除最旧的内核',
            actions: [ui.btn('', { icon: 'refresh', iconOnly: true, title: '刷新内核备份', onClick: () => loadInfo(true) })]
        }));
    }

    function assetMatchesPlatform(name) {
        const platform = (info && info.platform) || releasePlatform || {};
        const aliases = {
            amd64: 'amd64', 'x86_64': 'amd64', 386: '386', 'i386': '386', 'i686': '386',
            arm64: 'arm64', aarch64: 'arm64', armv7: 'arm-v7', armv7l: 'arm-v7',
            mipsle: 'mipsle-softfloat', mips64le: 'mips64le-softfloat',
            riscv64: 'riscv64', loong64: 'loong64'
        };
        const arch = aliases[platform.core_arch] || aliases[platform.machine];
        if (!arch) return true;
        const marker = '-linux-' + arch;
        const index = String(name).indexOf(marker);
        if (index < 0) return false;
        const tail = String(name).slice(index + marker.length);
        if (tail && tail[0] !== '-' && tail[0] !== '.') return false;
        const tokens = String(name).replace(/\.tar\.gz$/i, '').split('-');
        if (tokens.some(token => token === 'v2' || token === 'v3' || token === 'v4')) return false;
        const libc = tokens.includes('musl') ? 'musl' : (tokens.includes('glibc') ? 'glibc' : '');
        return !libc || !platform.libc || libc === platform.libc;
    }

    function assetPlatformScore(name) {
        const platform = (info && info.platform) || releasePlatform || {};
        const tokens = String(name).replace(/\.tar\.gz$/i, '').split('-');
        const libc = tokens.includes('musl') ? 'musl' : (tokens.includes('glibc') ? 'glibc' : '');
        let score = 0;
        if (libc && platform.libc && libc === platform.libc) score += 20;
        if (!libc) score += 10;
        return score;
    }

    function buildAssets(release) {
        const ebpf = buildType === 'ebpf' ||
            (!buildType && !!(info && info.ebpf_build));
        return (release.assets || []).filter(asset => {
            const tokens = String(asset.name).replace(/\.tar\.gz$/i, '').split('-');
            const variantMatches = source === 'ref1nd' || tokens.includes('ebpf') === ebpf;
            return variantMatches && assetMatchesPlatform(asset.name);
        }).sort((left, right) =>
            assetPlatformScore(right.name) - assetPlatformScore(left.name) ||
            left.name.localeCompare(right.name));
    }

    function buildSwitcher() {
        if (source === 'ref1nd') return null;
        const wrap = ui.E('div', { 'class': 'sbd-build-switch', role: 'group', 'aria-label': '构建类型' });
        [['ebpf', 'eBPF'], ['standard', '非 eBPF']].forEach(item => {
            const button = ui.E('button', {
                type: 'button',
                'class': item[0] === buildType ? 'active' : '',
                'aria-pressed': item[0] === buildType ? 'true' : 'false',
                click: () => {
                    if (buildType === item[0]) return;
                    buildType = item[0];
                    window.localStorage.setItem('singbox-dash-build-type', buildType);
                    renderReleases();
                }
            }, item[1]);
            wrap.appendChild(button);
        });
        return wrap;
    }

    function releaseNode(release) {
        const assets = buildAssets(release);
        const details = ui.E('details', { 'class': 'sbd-release' });
        details.appendChild(ui.E('summary', {}, [
            ui.E('div', { 'class': 'sbd-release-head' }, [
                ui.E('div', { 'class': 'sbd-row-main' }, [
                    ui.E('div', { 'class': 'sbd-release-tag' }, release.tag),
                    ui.E('div', { 'class': 'sbd-release-date' }, api.formatDate(release.published))
                ]),
                ui.E('div', { 'class': 'sbd-release-badges' }, [
                    ui.badge(release.channel === 'preview' ? 'PREVIEW' : 'STABLE', release.channel === 'preview' ? 'orange' : 'blue'),
                    ui.badge(assets.length ? assets.length + ' 个构建' : '无匹配构建', assets.length ? '' : 'warn')
                ]),
                ui.E('span', { 'class': 'sbd-chevron' }, ui.icon('chevron'))
            ])
        ]));
        const assetSelect = ui.E('select', { 'class': 'sbd-select' });
        assets.forEach(asset => assetSelect.appendChild(ui.E('option', { value: asset.name }, asset.name)));
        const installButton = ui.btn('安装', {
            icon: 'download', variant: 'primary', onClick: () => installRelease(release, assetSelect.value)
        });
        installButton.disabled = !assets.length;
        details.appendChild(ui.E('div', { 'class': 'sbd-release-body' }, [
            ui.field('构建包', assetSelect, source === 'ref1nd'
                ? 'reF1nd 统一构建包'
                : (buildType === 'ebpf' ? 'MiChongs eBPF 构建包' : 'MiChongs 非 eBPF 构建包')),
            source === 'ref1nd' ? ui.note('reF1nd 构建不区分 eBPF 后缀，构建标签由发布版本决定。', 'info') : null,
            ui.E('div', { 'class': 'sbd-btn-row' }, installButton)
        ].filter(Boolean)));
        return details;
    }

    function renderReleases() {
        releaseHost.innerHTML = '';
        const sourceSelect = ui.E('select', {
            'class': 'sbd-select',
            'aria-label': '内核来源',
            style: 'width:auto;min-width:118px;border-radius:999px',
            change: event => {
                if (!KERNEL_SOURCES[event.target.value]) return;
                source = event.target.value;
                repository = KERNEL_SOURCES[source].repo;
                window.localStorage.setItem('singbox-dash-kernel-source', source);
                releases = [];
                loadReleases();
            }
        }, Object.keys(KERNEL_SOURCES).map(id => ui.E('option', {
            value: id, selected: source === id ? '' : null
        }, KERNEL_SOURCES[id].label)));
        sourceSelect.disabled = releasesLoading;
        sourceSelect.classList.add('sbd-release-source');
        const channelSelect = ui.E('select', {
            'class': 'sbd-select',
            'aria-label': '版本频道',
            style: 'width:auto;min-width:110px;border-radius:999px',
            change: event => { channel = event.target.value; loadReleases(); }
        }, [
            ui.E('option', { value: 'all', selected: channel === 'all' ? '' : null }, '全部版本'),
            ui.E('option', { value: 'stable', selected: channel === 'stable' ? '' : null }, '稳定版'),
            ui.E('option', { value: 'preview', selected: channel === 'preview' ? '' : null }, '预览版')
        ]);
        channelSelect.disabled = releasesLoading;
        channelSelect.classList.add('sbd-release-channel');
        const body = ui.E('div', { 'class': 'sbd-stack sbd-release-scroll' });
        if (releasesLoading) {
            body.appendChild(ui.loading(releasesLoadingLabel));
        } else if (releasesError) {
            body.appendChild(ui.note('版本列表获取失败：' + releasesError, 'bad'));
            if (releases.length) releases.forEach(release => body.appendChild(releaseNode(release)));
            body.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('重试获取版本', {
                icon: 'refresh', onClick: () => loadReleases(true)
            })));
        } else if (!releases.length) {
            body.appendChild(ui.empty('未获取到可用版本'));
            body.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('重新获取', {
                icon: 'refresh', onClick: () => loadReleases(true)
            })));
        } else {
            releases.forEach(release => body.appendChild(releaseNode(release)));
        }
        const refreshButton = ui.btn('', {
            icon: 'refresh', iconOnly: true, title: '刷新版本列表',
            disabled: releasesLoading, onClick: () => loadReleases(true)
        });
        refreshButton.classList.add('sbd-release-refresh');
        releaseHost.appendChild(ui.card('在线版本订阅', [body], {
            className: 'sbd-release-card',
            icon: 'download',
            iconTone: 'blue',
            subtitle: KERNEL_SOURCES[source].label + ' · ' + repository,
            actions: [sourceSelect, buildSwitcher(), channelSelect, refreshButton].filter(Boolean)
        }));
    }

    async function loadReleases(refresh) {
        const request = ++releasesRequest;
        releasesLoading = true;
        releasesLoadingLabel = refresh ? '刷新在线版本' : '获取版本列表';
        releasesError = '';
        renderReleases();
        try {
            const result = await withTimeout(api.kernelReleases(source, channel, !!refresh), 45000, '获取版本列表超时');
            if (request !== releasesRequest) return;
            if (!result || !Array.isArray(result.releases))
                throw new Error('版本列表响应为空，请重试');
            releases = result.releases;
            releasesError = '';
            repository = result.repository || KERNEL_SOURCES[source].repo;
            releasePlatform = result.platform || releasePlatform;
            if (info) info.platform = result.platform || info.platform;
        } catch (error) {
            if (request !== releasesRequest) return;
            releasesError = api.errorText(error);
            if (!releases.length) ui.notify('版本列表读取失败：' + releasesError, 'error', 7000);
        } finally {
            if (request === releasesRequest) {
                releasesLoading = false;
                renderReleases();
            }
        }
    }

    async function installRelease(release, asset) {
        const ok = await ui.confirm('安装内核', '将安装 ' + release.tag + ' 的所选构建，并自动备份当前内核。', '安装');
        if (!ok) return;
        setBusy(true);
        try {
            const job = await api.installRelease(source, release.tag, asset);
            await ctx.watchJob(job, '安装 ' + release.tag);
            await loadInfo();
            ui.notify('内核已更新', 'success');
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally {
            setBusy(false);
        }
    }

    async function installFile(file) {
        if (file.size > 160 * 1024 * 1024) return ui.notify('内核文件不能超过 160 MB', 'error');
        let kind = '';
        try { kind = await kernelFileKind(file); }
        catch (_) { return ui.notify('无法读取所选文件', 'error'); }
        if (!kind) return ui.notify('请选择 ELF 内核文件或 tar.gz / zip 内核压缩包', 'error', 7000);
        const status = ui.E('div', { 'class': 'sbd-modal-text' }, '准备通过流式通道上传 · ' + kind);
        const percent = ui.E('div', { 'class': 'sbd-modal-text' }, '0%');
        const bar = ui.E('div', { 'class': 'sbd-progress' }, ui.E('i'));
        const ref = ui.modal('安装本地内核', [
            status, ui.E('div', { 'class': 'sbd-upload-meta' }, [ui.E('span', {}, file.name), ui.E('span', {}, api.formatBytes(file.size))]),
            bar, percent
        ], { dismissable: false, width: '480px' });
        try {
            const upload = await api.uploadBlob(file, 'kernel', (value, part, total, meta) => {
                bar.firstChild.style.width = value + '%';
                percent.textContent = value + '%';
                if (meta && meta.mode === 'stream') {
                    status.textContent = '流式上传 ' + api.formatBytes(part) + ' / ' +
                        api.formatBytes(total) + ' · ' + api.formatBytes(meta.speed || 0) + '/s';
                } else {
                    status.textContent = '兼容模式上传分片 ' + part + '/' + total;
                }
            });
            status.textContent = '上传完成，正在校验内核并创建安装任务';
            let job;
            try {
                job = await api.installKernel(upload.path);
            } catch (error) {
                await api.removeUpload(upload.path);
                throw error;
            }
            ref.close();
            await ctx.watchJob(job, '安装 ' + file.name);
            await loadInfo();
            ui.notify('内核已更新', 'success');
        } catch (error) {
            ref.close();
            ui.notify(api.errorText(error), 'error', 8000);
        }
    }

    async function deleteBackup(item) {
        const ok = await ui.confirm('删除内核备份',
            '将永久删除 ' + (shortVersion(item.version) || item.name) + ' 的内核备份。当前正在使用的内核不会被删除。',
            '删除', true);
        if (!ok) return;
        setBusy(true);
        try {
            await api.deleteKernelBackup(item.name);
            ui.notify('内核备份已删除', 'success');
            await loadInfo();
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally {
            setBusy(false);
        }
    }

    async function rollback(item) {
        const ok = await ui.confirm('回滚内核', '将恢复至 ' + (shortVersion(item.version) || item.name) + ' 并重启服务。', '回滚', true);
        if (!ok) return;
        setBusy(true);
        try {
            const result = await api.rollbackKernel(item.name);
            ui.notify(result.message || '内核已回滚', 'success');
            await loadInfo();
            await ctx.refreshStatus();
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally {
            setBusy(false);
        }
    }

    renderInfo();
    renderBackups();
    renderReleases();
    await Promise.allSettled([loadInfo(), loadReleases(false)]);
}

return baseclass.extend({ render });



