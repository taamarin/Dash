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
        return 'Kernel ELF';
    if (head[0] === 0x1f && head[1] === 0x8b) return 'Arsip gzip';
    if (head[0] === 0x50 && head[1] === 0x4b) return 'Arsip zip';
    if (/\.tar$/i.test(file.name || '')) return 'Arsip tar';
    return '';
}

async function render(host, ctx) {
    let info = null;
    let infoLoading = true;
    let infoError = '';
    let infoRequest = 0;
    let releases = [];
    let releasesLoading = true;
    let releasesLoadingLabel = 'Memuat daftar versi';
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
            infoHost.appendChild(ui.card('Kernel saat ini', [ui.loading('Memuat informasi kernel')], {
                icon: 'kernel', iconTone: 'purple'
            }));
            return;
        }
        if (!info) {
            infoHost.appendChild(ui.card('Informasi kernel tidak tersedia', [
                ui.note(infoError || 'Layanan pengelolaan tidak memberikan informasi kernel', 'bad'),
                ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('Baca kembali', {
                    icon: 'refresh', onClick: () => loadInfo(true)
                }))
            ], { icon: 'kernel', iconTone: 'red' }));
            return;
        }
        const platform = info.platform || {};
        const probe = info.ebpf || {};
        infoHost.appendChild(ui.card('Kernel saat ini', [
            ui.E('div', { 'class': 'sbd-kernel-grid' }, [
                ui.E('div', { 'class': 'sbd-row-left' }, [
                    ui.appIcon('kernel', 'purple'),
                    ui.E('div', { 'class': 'sbd-kernel-main' }, [
                        ui.E('div', { 'class': 'sbd-kernel-version' }, info.version ? shortVersion(info.version) : 'Belum dipasang'),
                        ui.E('div', { 'class': 'sbd-row-sub' }, info.path || '/usr/bin/sing-box'),
                        ui.E('div', { 'class': 'sbd-btn-row' }, [
                            ui.badge(info.exists ? 'Terpasang' : 'Belum dipasang', info.exists ? 'green' : 'bad'),
                            ui.badge('Kernel: ' + (info.core_family_label || 'Tidak diketahui'), 'green'),
                            info.ebpf_build ? ui.badge('Build eBPF', 'orange') : ui.badge('Build standar', 'blue'),
                            ui.badge(platform.distrib_arch || platform.machine || 'Arsitektur tidak diketahui', 'purple')
                        ])
                    ])
                ]),
                ui.E('div', { 'class': 'sbd-kernel-actions' }, [
                    fileInput,
                    ui.btn('Instal lokal', { icon: 'upload', variant: 'primary', onClick: () => fileInput.click() }),
                    ui.btn('', { icon: 'refresh', iconOnly: true, title: 'Segarkan', onClick: () => loadInfo(true) })
                ])
            ]),
            infoError ? ui.note('Penyegaran gagal: ' + infoError, 'warn') : null,
            ui.E('div', { 'class': 'sbd-stat-grid sbd-stat-grid-4' }, [
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, 'Platform perangkat'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, platformName(platform)),
                    ui.E('div', { 'class': 'sbd-stat-sub' }, platform.kernel || '')
                ]),
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, 'Ukuran file'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, api.formatBytes(info.size)),
                    ui.E('div', { 'class': 'sbd-stat-sub' }, 'SHA256 ' + (info.hash || '—'))
                ]),
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, 'Dukungan eBPF'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, probe.deferred ? (probe.supported ? 'Didukung build' : 'Tidak didukung') : (probe.supported ? 'Tersedia' : 'Tidak tersedia')),
                    ui.E('div', { 'class': 'sbd-stat-sub' }, probe.deferred ? 'Verifikasi kemampuan runtime melalui alat diagnostik' : (probe.summary ? 'Pemeriksaan selesai' : 'Belum diperiksa'))
                ]),
                ui.E('div', { 'class': 'sbd-stat' }, [
                    ui.E('div', { 'class': 'sbd-stat-label' }, 'Cadangan tersimpan'),
                    ui.E('div', { 'class': 'sbd-stat-value' }, String((info.backups || []).length) + ' item'),
                    ui.E('div', { 'class': 'sbd-stat-sub' }, 'Rollback otomatis jika terjadi masalah')
                ])
            ]),
            probe.summary ? ui.E('details', { 'class': 'sbd-details' }, [
                ui.E('summary', {}, 'Detail lingkungan eBPF'),
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
            const value = await withTimeout(api.kernelInfo(force === true), 25000, 'Waktu membaca informasi kernel habis');
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
            if (!info) ui.notify('Gagal membaca informasi kernel: ' + infoError, 'error', 7000);
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
            backupHost.appendChild(ui.card('Cadangan kernel', [ui.loading('Memuat informasi cadangan')], {
                icon: 'backup', iconTone: 'orange'
            }));
            return;
        }
        if (!info) {
            backupHost.appendChild(ui.card('Cadangan kernel', [
                ui.note(infoError || 'Informasi kernel tidak tersedia; daftar cadangan tidak dapat dibaca', 'bad'),
                ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('Baca kembali', {
                    icon: 'refresh', onClick: () => loadInfo(true)
                }))
            ], { icon: 'backup', iconTone: 'orange' }));
            return;
        }
        const backups = info.backups || [];
        const body = ui.E('div', { 'class': 'sbd-backup-list' });
        if (!backups.length) body.appendChild(ui.empty('Belum ada cadangan kernel'));
        backups.forEach(item => {
            body.appendChild(ui.row(shortVersion(item.version) || item.name, [
                api.formatDate(item.time), ' · ', api.formatBytes(item.size)
            ], [
                ui.btn('Rollback', {
                    icon: 'backup', small: true, onClick: () => rollback(item)
                }),
                ui.btn('', {
                    icon: 'trash', iconOnly: true, small: true, variant: 'danger',
                    title: 'Hapus cadangan kernel ini', onClick: () => deleteBackup(item)
                })
            ], { icon: 'backup', color: 'orange' }));
        });
        backupHost.appendChild(ui.card('Cadangan kernel', [body], {
            icon: 'backup',
            iconTone: 'orange',
            subtitle: 'Simpan maksimal 10 cadangan; kernel terlama akan dihapus otomatis jika batas terlampaui',
            actions: [ui.btn('', { icon: 'refresh', iconOnly: true, title: 'Segarkan cadangan kernel', onClick: () => loadInfo(true) })]
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
        const wrap = ui.E('div', { 'class': 'sbd-build-switch', role: 'group', 'aria-label': 'Jenis build' });
        [['ebpf', 'eBPF'], ['standard', 'Non-eBPF']].forEach(item => {
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
                    ui.badge(assets.length ? assets.length + ' build' : 'Tidak ada build yang cocok', assets.length ? '' : 'warn')
                ]),
                ui.E('span', { 'class': 'sbd-chevron' }, ui.icon('chevron'))
            ])
        ]));
        const assetSelect = ui.E('select', { 'class': 'sbd-select' });
        assets.forEach(asset => assetSelect.appendChild(ui.E('option', { value: asset.name }, asset.name)));
        const installButton = ui.btn('Instal', {
            icon: 'download', variant: 'primary', onClick: () => installRelease(release, assetSelect.value)
        });
        installButton.disabled = !assets.length;
        details.appendChild(ui.E('div', { 'class': 'sbd-release-body' }, [
            ui.field('Paket build', assetSelect, source === 'ref1nd'
                ? 'Build terpadu reF1nd'
                : (buildType === 'ebpf' ? 'Build eBPF MiChongs' : 'Build non-eBPF MiChongs')),
            source === 'ref1nd' ? ui.note('Build reF1nd tidak membedakan sufiks eBPF; label build ditentukan oleh versi rilis.', 'info') : null,
            ui.E('div', { 'class': 'sbd-btn-row' }, installButton)
        ].filter(Boolean)));
        return details;
    }

    function renderReleases() {
        releaseHost.innerHTML = '';
        const sourceSelect = ui.E('select', {
            'class': 'sbd-select',
            'aria-label': 'Sumber kernel',
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
            'aria-label': 'Kanal versi',
            style: 'width:auto;min-width:110px;border-radius:999px',
            change: event => { channel = event.target.value; loadReleases(); }
        }, [
            ui.E('option', { value: 'all', selected: channel === 'all' ? '' : null }, 'Semua versi'),
            ui.E('option', { value: 'stable', selected: channel === 'stable' ? '' : null }, 'Stabil'),
            ui.E('option', { value: 'preview', selected: channel === 'preview' ? '' : null }, 'Pratinjau')
        ]);
        channelSelect.disabled = releasesLoading;
        channelSelect.classList.add('sbd-release-channel');
        const body = ui.E('div', { 'class': 'sbd-stack sbd-release-scroll' });
        if (releasesLoading) {
            body.appendChild(ui.loading(releasesLoadingLabel));
        } else if (releasesError) {
            body.appendChild(ui.note('Gagal memuat daftar versi: ' + releasesError, 'bad'));
            if (releases.length) releases.forEach(release => body.appendChild(releaseNode(release)));
            body.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('Coba muat versi lagi', {
                icon: 'refresh', onClick: () => loadReleases(true)
            })));
        } else if (!releases.length) {
            body.appendChild(ui.empty('Tidak ada versi yang tersedia'));
            body.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('Muat kembali', {
                icon: 'refresh', onClick: () => loadReleases(true)
            })));
        } else {
            releases.forEach(release => body.appendChild(releaseNode(release)));
        }
        const refreshButton = ui.btn('', {
            icon: 'refresh', iconOnly: true, title: 'Segarkan daftar versi',
            disabled: releasesLoading, onClick: () => loadReleases(true)
        });
        refreshButton.classList.add('sbd-release-refresh');
        releaseHost.appendChild(ui.card('Rilis versi online', [body], {
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
        releasesLoadingLabel = refresh ? 'Menyegarkan rilis online' : 'Memuat daftar versi';
        releasesError = '';
        renderReleases();
        try {
            const result = await withTimeout(api.kernelReleases(source, channel, !!refresh), 45000, 'Waktu memuat daftar versi habis');
            if (request !== releasesRequest) return;
            if (!result || !Array.isArray(result.releases))
                throw new Error('Respons daftar versi kosong. Coba lagi.');
            releases = result.releases;
            releasesError = '';
            repository = result.repository || KERNEL_SOURCES[source].repo;
            releasePlatform = result.platform || releasePlatform;
            if (info) info.platform = result.platform || info.platform;
        } catch (error) {
            if (request !== releasesRequest) return;
            releasesError = api.errorText(error);
            if (!releases.length) ui.notify('Gagal membaca daftar versi: ' + releasesError, 'error', 7000);
        } finally {
            if (request === releasesRequest) {
                releasesLoading = false;
                renderReleases();
            }
        }
    }

    async function installRelease(release, asset) {
        const ok = await ui.confirm('Instal kernel', 'Build yang dipilih dari ' + release.tag + ' akan dipasang dan kernel saat ini akan dicadangkan secara otomatis.', 'Instal');
        if (!ok) return;
        setBusy(true);
        try {
            const job = await api.installRelease(source, release.tag, asset);
            await ctx.watchJob(job, 'Memasang ' + release.tag);
            await loadInfo();
            ui.notify('Kernel diperbarui', 'success');
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally {
            setBusy(false);
        }
    }

    async function installFile(file) {
        if (file.size > 160 * 1024 * 1024) return ui.notify('File kernel tidak boleh melebihi 160 MB', 'error');
        let kind = '';
        try { kind = await kernelFileKind(file); }
        catch (_) { return ui.notify('Tidak dapat membaca file yang dipilih', 'error'); }
        if (!kind) return ui.notify('Pilih file kernel ELF atau arsip kernel tar.gz / zip', 'error', 7000);
        const status = ui.E('div', { 'class': 'sbd-modal-text' }, 'Menyiapkan unggahan melalui kanal streaming · ' + kind);
        const percent = ui.E('div', { 'class': 'sbd-modal-text' }, '0%');
        const bar = ui.E('div', { 'class': 'sbd-progress' }, ui.E('i'));
        const ref = ui.modal('Instal kernel lokal', [
            status, ui.E('div', { 'class': 'sbd-upload-meta' }, [ui.E('span', {}, file.name), ui.E('span', {}, api.formatBytes(file.size))]),
            bar, percent
        ], { dismissable: false, width: '480px' });
        try {
            const upload = await api.uploadBlob(file, 'kernel', (value, part, total, meta) => {
                bar.firstChild.style.width = value + '%';
                percent.textContent = value + '%';
                if (meta && meta.mode === 'stream') {
                    status.textContent = 'Unggahan streaming ' + api.formatBytes(part) + ' / ' +
                        api.formatBytes(total) + ' · ' + api.formatBytes(meta.speed || 0) + '/s';
                } else {
                    status.textContent = 'Unggahan potongan mode kompatibilitas ' + part + '/' + total;
                }
            });
            status.textContent = 'Unggahan selesai; memvalidasi kernel dan membuat tugas instalasi';
            let job;
            try {
                job = await api.installKernel(upload.path);
            } catch (error) {
                await api.removeUpload(upload.path);
                throw error;
            }
            ref.close();
            await ctx.watchJob(job, 'Memasang ' + file.name);
            await loadInfo();
            ui.notify('Kernel diperbarui', 'success');
        } catch (error) {
            ref.close();
            ui.notify(api.errorText(error), 'error', 8000);
        }
    }

    async function deleteBackup(item) {
        const ok = await ui.confirm('Hapus cadangan kernel',
            'Cadangan kernel ' + (shortVersion(item.version) || item.name) + ' akan dihapus permanen. Kernel yang sedang digunakan tidak akan dihapus.',
            'Hapus', true);
        if (!ok) return;
        setBusy(true);
        try {
            await api.deleteKernelBackup(item.name);
            ui.notify('Cadangan kernel dihapus', 'success');
            await loadInfo();
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally {
            setBusy(false);
        }
    }

    async function rollback(item) {
        const ok = await ui.confirm('Rollback kernel', 'Kernel akan dipulihkan ke ' + (shortVersion(item.version) || item.name) + ' dan layanan dimulai ulang.', 'Rollback', true);
        if (!ok) return;
        setBusy(true);
        try {
            const result = await api.rollbackKernel(item.name);
            ui.notify(result.message || 'Kernel berhasil di-rollback', 'success');
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


