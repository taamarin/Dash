/* Node-provider manager modal separated from config page lifecycle. */
'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';

function create(env) {
    const { providers, markDirty } = env;

    function providerSlug(tag) {
        const value = String(tag || '').trim();
        let slug = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 48);
        if (!slug) {
            let hash = 2166136261;
            for (let index = 0; index < value.length; index++) {
                hash ^= value.charCodeAt(index);
                hash = Math.imul(hash, 16777619);
            }
            slug = 'provider-' + (hash >>> 0).toString(16);
        }
        return slug || 'provider';
    }

    function providerPath(tag) {
        return '/etc/sing-box/providers/' + providerSlug(tag) + '.yaml';
    }

    function openProviders() {
        let manager = null;
        const body = ui.E('div', { 'class': 'sbd-stack sbd-provider-manager' });
        function refresh() {
            body.innerHTML = '';
            body.appendChild(ui.note('Provider jarak jauh diambil dari URL sesuai interval pembaruan; Provider lokal tidak diperbarui melalui jaringan dan menghasilkan file node statis dari konten yang ditempel atau tautan yang diuraikan.', 'info'));
            const list = ui.E('div', { 'class': 'sbd-provider-list' });
            providers().forEach((provider, index) => {
                const type = provider && provider.type === 'local' ? 'local' : 'remote';
                const source = type === 'local' ? provider.path || 'Path belum diatur' : provider.url || 'URL belum diatur';
                list.appendChild(ui.row(provider.tag || 'Provider tanpa nama', [
                    ui.E('div', { 'class': 'sbd-provider-meta' }, [
                        ui.badge(type === 'local' ? 'Statis lokal' : 'Langganan jarak jauh', type === 'local' ? 'green' : 'blue'),
                        ui.E('span', { 'class': 'sbd-provider-source' }, source),
                        type === 'remote' ? ui.E('span', { 'class': 'sbd-provider-path' }, provider.path || '') : null
                    ].filter(Boolean))
                ], [
                    ui.btn('Edit', { icon: 'edit', small: true, onClick: () => openProviderEditor(index, refresh) }),
                    ui.btn('', { icon: 'trash', iconOnly: true, small: true, variant: 'danger',
                        title: 'Hapus Provider', onClick: () => deleteProvider(index, refresh) })
                ], { icon: type === 'local' ? 'database' : 'link', color: type === 'local' ? 'green' : 'blue' }));
            });
            if (!providers().length) list.appendChild(ui.empty('Belum ada Provider node'));
            body.appendChild(list);
            body.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, ui.btn('Tambah Provider', {
                icon: 'plus', variant: 'primary', onClick: () => openProviderEditor(null, refresh)
            })));
        }
        refresh();
        manager = ui.modal('Provider node', body, {
            subtitle: 'Kelola langganan jarak jauh dan node statis lokal secara terpisah',
            confirmText: 'Selesai', width: '780px'
        });
        return manager;
    }

    async function deleteProvider(index, refresh) {
        const provider = providers()[index] || {};
        const ok = await ui.confirm('Hapus Provider node',
            'Setelah menghapus ' + (provider.tag || 'Provider ini') + ', grup kebijakan yang merujuknya mungkin menampilkan kesalahan saat disimpan. Yakin ingin menghapus?',
            'Hapus', true);
        if (!ok) return;
        providers().splice(index, 1);
        markDirty();
        refresh();
        ui.notify('Provider dihapus dari konfigurasi yang menunggu disimpan', 'success');
    }

    function openProviderEditor(index, refreshParent) {
        const existing = index === null || index === undefined ? null : providers()[index];
        const provider = existing || {};
        const working = {
            type: provider.type === 'local' ? 'local' : 'remote',
            tag: provider.tag || '',
            url: provider.url || '',
            path: provider.path || '',
            update_interval: provider.update_interval || '6h',
            exclude: provider.exclude || '',
            include: provider.include || '',
            http_client: provider.http_client || '',
            healthEnabled: !provider.health_check || provider.health_check.enabled !== false,
            healthUrl: (provider.health_check && provider.health_check.url) || 'https://www.gstatic.com/generate_200',
            healthInterval: (provider.health_check && provider.health_check.interval) || '30m',
            sourceType: 'text',
            source: ''
        };
        if (working.healthUrl === 'https://www.gstatic.com/generate_200')
            working.healthUrl = 'https://www.gstatic.com/generate_204';
        let autoPath = !existing;
        if (!working.path) working.path = providerPath(working.tag);
        let imported = existing && provider.type === 'local' ? { path: existing.path, count: 0, tags: [] } : null;
        const formHost = ui.E('div', { 'class': 'sbd-stack sbd-provider-form' });
        const statusHost = ui.E('div', { 'class': 'sbd-provider-import-status' });
        let editor = null;
        function input(value, placeholder, onInput, type) {
            const node = ui.E('input', { 'class': 'sbd-input', type: type || 'text', value: value || '', placeholder: placeholder || '' });
            node.addEventListener('input', () => onInput(node.value));
            return node;
        }
        function textarea(value, placeholder) {
            const node = ui.E('textarea', { 'class': 'sbd-textarea sbd-provider-textarea', spellcheck: 'false', placeholder });
            node.value = value || '';
            node.addEventListener('input', () => { working.source = node.value; });
            return node;
        }
        function renderStatus() {
            statusHost.innerHTML = '';
            if (!imported) return;
            statusHost.appendChild(ui.note(imported.count
                ? 'Provider lokal ditulis: ' + imported.count + ' node · ' + imported.path
                : 'Menggunakan file lokal yang ada: ' + imported.path, 'success'));
            if (imported.tags && imported.tags.length) {
                statusHost.appendChild(ui.E('div', { 'class': 'sbd-provider-tags' },
                    imported.tags.slice(0, 12).map(tag => ui.badge(tag, 'green'))));
            }
        }
        async function importLocal(button) {
            try {
                if (!working.tag.trim()) throw new Error('Masukkan label Provider terlebih dahulu');
                if (!/^\/etc\/sing-box\/providers\/[^/]+$/.test(working.path)) throw new Error('File lokal harus berada di /etc/sing-box/providers/');
                if (!working.source.trim()) throw new Error(working.sourceType === 'url' ? 'Masukkan tautan untuk diuraikan' : 'Tempel tautan node atau konten Base64');
                button.disabled = true;
                button.textContent = 'Menguraikan dan menulis...';
                const result = await api.importProvider({
                    tag: working.tag.trim(), path: working.path,
                    sourceType: working.sourceType, source: working.source
                });
                imported = { path: result.path, count: result.count, tags: result.tags || [] };
                renderStatus();
                ui.notify(result.count + ' node lokal dibuat', 'success');
                if (result.skipped && result.skipped.length)
                    ui.notify(result.skipped.length + ' baris node tidak dikenali; periksa log atau tempel ulang kontennya', 'warn', 6000);
            } catch (error) {
                ui.notify(api.errorText(error), 'error', 8000);
            } finally {
                button.disabled = false;
                button.textContent = 'Uraikan dan tulis ke file lokal';
            }
        }
        function renderEditor() {
            formHost.innerHTML = '';
            const typeSelect = ui.E('select', { 'class': 'sbd-select' }, [
                ui.E('option', { value: 'remote', selected: working.type === 'remote' ? '' : null }, 'Provider langganan jarak jauh'),
                ui.E('option', { value: 'local', selected: working.type === 'local' ? '' : null }, 'Provider statis lokal')
            ]);
            typeSelect.addEventListener('change', () => { working.type = typeSelect.value; renderEditor(); });
            let pathInput = null;
            const tagInput = input(working.tag, 'misalnya HIMEMY', value => {
                working.tag = value;
                if (autoPath) {
                    working.path = providerPath(value);
                    if (pathInput) pathInput.value = working.path;
                }
            });
            pathInput = ui.E('input', { 'class': 'sbd-input', value: working.path || '' });
            pathInput.addEventListener('input', () => {
                autoPath = false;
                working.path = pathInput.value;
                imported = null;
                renderStatus();
            });
            formHost.appendChild(ui.E('div', { 'class': 'sbd-provider-type-row' }, [
                ui.field('Jenis', typeSelect, 'Langganan jarak jauh diperbarui secara berkala; Provider statis lokal tidak meminta URL langganan.'),
                ui.field('Label Provider', tagInput, 'Juga digunakan sebagai nama filter grup kebijakan; sebaiknya gunakan nama yang konsisten.')
            ]));
            formHost.appendChild(ui.field('File node', pathInput, 'File Provider lokal harus disimpan di /etc/sing-box/providers/.'));
            if (working.type === 'remote') {
                formHost.appendChild(ui.field('Tautan jarak jauh', input(working.url, 'https://example.com/subscribe', value => { working.url = value; }, 'url'),
                    'Masukkan URL langganan. Node diperbarui otomatis oleh sing-box sesuai update_interval.'));
                formHost.appendChild(ui.E('div', { 'class': 'sbd-provider-form-grid' }, [
                    ui.field('Interval pembaruan', input(working.update_interval, '6h', value => { working.update_interval = value; }), 'Misalnya 30m, 6h, 24h.'),
                    ui.field('Klien HTTP', input(working.http_client, 'misalnya provider_direct', value => { working.http_client = value; }), 'Opsional; harus berupa tag HTTP Client yang sudah ada dalam konfigurasi.')
                ]));
                formHost.appendChild(ui.E('div', { 'class': 'sbd-provider-form-grid' }, [
                    ui.field('Regex penyertaan', input(working.include, 'opsional, misalnya Hong Kong|Jepang|US', value => { working.include = value; }), 'Hanya pertahankan node dengan nama yang cocok.'),
                    ui.field('Regex pengecualian', input(working.exclude, 'situs resmi|kedaluwarsa|lalu lintas|tersisa', value => { working.exclude = value; }), 'Filter informasi paket atau node yang tidak tersedia.')
                ]));
            } else {
                const sourceSelect = ui.E('select', { 'class': 'sbd-select' }, [
                    ui.E('option', { value: 'text', selected: working.sourceType === 'text' ? '' : null }, 'Tempel node atau konten Base64'),
                    ui.E('option', { value: 'url', selected: working.sourceType === 'url' ? '' : null }, 'Masukkan tautan penguraian jarak jauh')
                ]);
                sourceSelect.addEventListener('change', () => {
                    working.sourceType = sourceSelect.value;
                    working.source = '';
                    renderEditor();
                });
                formHost.appendChild(ui.field('Sumber node lokal', sourceSelect,
                    'Tautan penguraian hanya digunakan untuk unduhan kali ini; file yang dibuat tidak lagi bergantung pada URL tersebut.'));
                if (working.sourceType === 'url') {
                    formHost.appendChild(ui.field('Tautan penguraian', input(working.source, 'https://example.com/subscribe', value => { working.source = value; }, 'url'),
                        'Backend mengunduh langganan Base64/tautan berbagi dan mengubahnya menjadi outbounds statis.'));
                } else {
                    formHost.appendChild(ui.field('Konten node', textarea(working.source,
                        'Tempel tautan berbagi vless://, vmess://, trojan://, ss://, atau seluruh konten langganan Base64'),
                        'Mendukung satu tautan berbagi per baris maupun seluruh konten Base64 dari penyedia.'));
                }
                const importButton = ui.btn('Uraikan dan tulis ke file lokal', { icon: 'download', variant: 'primary',
                    onClick: () => importLocal(importButton) });
                formHost.appendChild(ui.E('div', { 'class': 'sbd-btn-row' }, importButton));
            }
            const healthToggle = ui.E('select', { 'class': 'sbd-select' }, [
                ui.E('option', { value: '1', selected: working.healthEnabled ? '' : null }, 'Aktifkan'),
                ui.E('option', { value: '0', selected: working.healthEnabled ? null : '' }, 'Nonaktifkan')
            ]);
            healthToggle.addEventListener('change', () => { working.healthEnabled = healthToggle.value === '1'; renderEditor(); });
            formHost.appendChild(ui.E('div', { 'class': 'sbd-provider-form-grid' }, [
                ui.field('Pemeriksaan kesehatan', healthToggle),
                ui.field('Alamat pemeriksaan', input(working.healthUrl, 'https://www.gstatic.com/generate_204', value => { working.healthUrl = value; }), 'Hanya ditulis saat fitur diaktifkan.'),
                ui.field('Interval pemeriksaan', input(working.healthInterval, '30m', value => { working.healthInterval = value; }), 'Misalnya 5m, 30m.')
            ]));
            formHost.appendChild(statusHost);
            renderStatus();
            if (editor) {
                const subtitle = editor.dialog.querySelector('.sbd-modal-sub');
                if (subtitle) subtitle.textContent = working.type === 'local'
                    ? 'Buat dan kelola file node statis lokal' : 'URL langganan jarak jauh dan parameter pembaruan';
            }
        }
        renderEditor();
        editor = ui.modal(existing ? 'Edit Provider node' : 'Tambah Provider node', formHost, {
            subtitle: working.type === 'local' ? 'Buat dan kelola file node statis lokal' : 'URL langganan jarak jauh dan parameter pembaruan',
            cancelText: 'Batal', confirmText: existing ? 'Simpan Provider' : 'Tambah Provider', width: '780px',
            onConfirm: () => {
                const tag = working.tag.trim();
                const path = working.path.trim();
                if (!tag) throw new Error('Label Provider tidak boleh kosong');
                if (providers().some((item, itemIndex) => item && item.tag === tag && itemIndex !== index))
                    throw new Error('Label Provider sudah digunakan');
                if (!/^\/etc\/sing-box\/providers\/[^/]+$/.test(path)) throw new Error('File node harus berada di /etc/sing-box/providers/');
                if (working.type === 'remote') {
                    const url = working.url.trim();
                    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('Tautan jarak jauh harus berupa URL HTTP/HTTPS');
                } else if (!existing || existing.type !== 'local') {
                    if (!imported || !imported.count) throw new Error('Uraikan node dan tulis ke file lokal terlebih dahulu');
                    if (imported.path !== path) throw new Error('Path file node berubah; uraikan kembali');
                } else if (imported && imported.path !== path) {
                    throw new Error('Path file node berubah; uraikan kembali');
                }
                const value = { type: working.type, tag, path };
                if (working.healthEnabled) value.health_check = {
                    enabled: true,
                    url: working.healthUrl.trim() || 'https://www.gstatic.com/generate_204',
                    interval: working.healthInterval.trim() || '30m'
                };
                if (working.type === 'remote') {
                    value.url = working.url.trim();
                    value.update_interval = working.update_interval.trim() || '6h';
                    if (working.exclude.trim()) value.exclude = working.exclude.trim();
                    if (working.include.trim()) value.include = working.include.trim();
                    if (working.http_client.trim()) value.http_client = working.http_client.trim();
                }
                if (existing) providers()[index] = value;
                else providers().push(value);
                markDirty();
                refreshParent();
                ui.notify(existing ? 'Perubahan Provider ditambahkan ke daftar simpan' : 'Provider ditambahkan ke daftar simpan', 'success');
            }
        });
        return editor;
    }

    return { openProviders };
}

return baseclass.extend({ create });
