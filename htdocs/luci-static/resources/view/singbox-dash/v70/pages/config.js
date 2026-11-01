'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';
'require view.singbox-dash.v70.lib.components as components';
'require view.singbox-dash.v70.lib.schema-form as schemaForm';
'require view.singbox-dash.v70.lib.config-model as configModel';
'require view.singbox-dash.v70.lib.config-hub as configHub';
'require view.singbox-dash.v70.lib.config-provider-editor as configProviderEditor';

const EMPTY_CONFIG_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const { GROUPS, HUB_SECTIONS, TILE_SPAN, groupBadges } = configModel;

async function render(host, ctx) {
    let status = ctx.status || null;
    let current = null;
    let schema = null;
    let draft = {};
    let backups = [];
    let subscription = { url: '', interval: 0, enabled: false };
    let dirty = false;
    let busy = false;
    let view = 'hub';
    let validationText = '';

    const root = ui.E('div', { 'class': 'sbd-config-page' });
    host.appendChild(root);
    const toolbarHost = ui.E('div', { 'class': 'sbd-config-toolbar-host' });
    const viewHost = ui.E('div', { 'class': 'sbd-config-view' });
    const statusBadge = ui.E('span', { 'class': 'sbd-inline' }, '');
    const slotSelect = ui.E('select', { 'class': 'sbd-select sbd-config-slot' });
    const importInput = ui.E('input', {
        type: 'file', accept: '.yaml,.yml,.json,application/json,text/yaml', style: 'display:none',
        change: async event => {
            const file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (!file) return;
            try {
                const text = await file.text();
                if (!current) {
                    await createConfigFromFile(file, text);
                    return;
                }
                view = 'advanced';
                dirty = false;
                renderView();
                rawEditor.value = text;
                dirty = true;
                updateSavebar();
                ui.notify('Editor lanjutan dimuat', 'success');
            } catch (error) { ui.notify('Gagal membaca: ' + error.message, 'error'); }
        }
    });
    const rawEditor = ui.E('textarea', {
        'class': 'sbd-textarea sbd-editor', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
        placeholder: 'Edit langsung teks konfigurasi YAML / JSON'
    });
    const validateButton = ui.btn('Validasi', { icon: 'shield', onClick: () => validateDraft() });
    const revertButton = ui.btn('Buang perubahan', { icon: 'refresh', onClick: () => reloadCurrent() });
    const saveButton = ui.btn('Simpan', { icon: 'save', onClick: () => saveDraft('save') });
    const applyButton = ui.btn('Simpan dan terapkan', { icon: 'check', variant: 'primary', onClick: () => saveDraft('apply') });
    const savebar = components.saveBar([validateButton, revertButton, saveButton, applyButton], {
        className: 'sbd-config-savebar', emptyText: 'Memuat konfigurasi', idleText: 'Konfigurasi tersinkron'
    });
    root.appendChild(toolbarHost);
    root.appendChild(viewHost);
    root.appendChild(savebar.node);
    root.appendChild(importInput);

    function setBusy(value) {
        busy = !!value;
        components.setBusy(root, busy, { exclude: importInput });
        if (ctx && typeof ctx.setBusy === 'function') ctx.setBusy(busy);
        updateSavebar();
    }
    function markDirty() {
        dirty = true;
        validationText = '';
        updateSavebar();
        if (view === 'hub') refreshTileSummaries();
    }
    function updateSavebar() {
        savebar.update({ busy, dirty, validationText, available: !!current });
    }
    function renderToolbar() {
        toolbarHost.innerHTML = '';
        const left = ui.E('div', { 'class': 'sbd-config-toolbar-main' });
        if (view !== 'hub') left.appendChild(ui.btn('Kembali ke kategori', {
            icon: 'chevron', onClick: leaveView
        }));
        left.appendChild(ui.E('label', { 'class': 'sbd-inline sbd-config-slot-wrap' }, [
            ui.E('span', { 'class': 'sbd-field-label' }, 'Slot konfigurasi'), slotSelect
        ]));
        left.appendChild(statusBadge);
        toolbarHost.appendChild(ui.E('div', { 'class': 'sbd-config-toolbar' }, [
            left,
            ui.E('div', { 'class': 'sbd-config-toolbar-actions' }, [
                ui.btn('Impor', { icon: 'upload', onClick: () => importInput.click() }),
                ui.btn('Edit kode sumber', { icon: 'terminal', onClick: openAdvanced }),
                ui.btn('', { icon: 'refresh', iconOnly: true, title: 'Muat ulang', onClick: () => reloadCurrent() })
            ])
        ]));
        statusBadge.innerHTML = '';
        if (current) {
            const active = current.active !== undefined ? current.active : !!(status && status.active === current.name);
            statusBadge.appendChild(ui.badge(active ? 'Aktif' : 'Tidak aktif', active ? 'green' : ''));
            statusBadge.appendChild(ui.badge('Keluarga field: ' + ((status && status.core_family_label) || 'Tidak diketahui'), 'green'));
            statusBadge.appendChild(ui.badge('Mode: ' + (current.mode && current.mode.mode !== 'unknown' ? current.mode.mode : 'custom'), ''));
        }
    }
    function renderView() {
        renderToolbar();
        viewHost.innerHTML = '';
        if (view === 'hub') renderHub();
        else renderAdvanced();
        updateSavebar();
    }

    function refreshTileSummaries() {
        configHub.refreshTileSummaries(viewHost, draft);
    }

    function renderHub() {
        configHub.render({
            host: viewHost,
            config: draft,
            busy,
            onGroup: openGroup,
            onAdvanced: openAdvanced,
            subscriptionCard,
            backupCard
        });
    }

    function formOptions(customRerender) {
        return {
            root: schema,
            draft,
            config: draft,
            onChange: markDirty,
            rerender: customRerender || renderView
        };
    }

    function providers() {
        if (!Array.isArray(draft.providers)) draft.providers = [];
        return draft.providers;
    }

    const providerEditor = configProviderEditor.create({ providers, markDirty });

    function openGroup(id) {
        if (id === 'providers') { providerEditor.openProviders(); return; }
        const group = GROUPS[id];
        if (!group) return;
        const modalBody = ui.E('div', { 'class': 'sbd-schema-modal-body sbd-stack' });
        function drawModalGroup() {
            modalBody.innerHTML = '';
            const options = formOptions(() => {
                drawModalGroup();
                refreshTileSummaries();
                updateSavebar();
            });
            group.keys.forEach(key => {
                if (!(schema.properties || {})[key]) return;
                schemaForm.renderTopLevel(modalBody, key, options);
            });
            refreshTileSummaries();
            updateSavebar();
        }
        drawModalGroup();
        ui.modal(group.title, modalBody, {
            subtitle: group.desc,
            confirmText: 'Selesai',
            width: '760px',
            onClose: () => {
                    refreshTileSummaries();
                updateSavebar();
            }
        });
    }

    function openAdvanced() {
        if (dirty) {
            ui.confirm('Beralih ke editor kode sumber', 'Perubahan visual belum disimpan dan akan hilang jika Anda beralih.', 'Lanjutkan').then(ok => {
                if (!ok) return;
                dirty = false;
                view = 'advanced';
                renderView();
            });
            return;
        }
        view = 'advanced';
        renderView();
    }

    function renderAdvanced() {
        viewHost.innerHTML = '';
        rawEditor.value = current ? current.data : '';
        dirty = false;
        rawEditor.oninput = () => { dirty = true; validationText = ''; updateSavebar(); };
        const card = ui.card('Editor kode sumber', [
            ui.note('Editor kode sumber mempertahankan seluruh kolom konfigurasi; validasi kernel otomatis dijalankan sebelum penyimpanan dan konfigurasi tidak ditulis jika gagal.', 'info'),
            rawEditor,
            ui.E('div', { 'class': 'sbd-editor-foot' }, [
                ui.E('span', {}, 'UTF-8 · YAML / JSON · validasi kernel dan rollback kegagalan otomatis saat menyimpan'),
                ui.E('span', {}, current ? current.name : '')
            ])
        ], { className: 'sbd-span-12', icon: 'terminal', iconTone: 'green' });
        viewHost.appendChild(ui.E('div', { 'class': 'sbd-grid' }, card));
    }

    async function loadConfig(name) {
        if (!name) throw new Error('Tidak ada slot konfigurasi yang tersedia');
        setBusy(true);
        try {
            current = await api.configGet(name);
            draft = schemaForm.clone(current.parsed || {});
            slotSelect.value = current.name;
            dirty = false;
            validationText = '';
            view = 'hub';
                renderView();
        } finally { setBusy(false); }
    }

    async function createConfigFromFile(file, text) {
        if (!text.trim()) return ui.notify('File konfigurasi kosong', 'error');
        const targetName = (status && status.active) || 'config.yaml';
        const expected = (status && status.active_hash) || EMPTY_CONFIG_SHA;
        ctx.setBusy(true);
        try {
            const job = await api.submitConfig({
                action: 'save', target: targetName, expected, data: text
            });
            const compatibility = job && job.compatibility || {};
            await ctx.watchJob(job, 'Mengimpor file konfigurasi');
            await loadInitial();
            const apiInfo = (job && job.api) || (current && current.api) || null;
            const apiSummary = apiInfo && apiInfo.port
                ? ', port Clash API ' + apiInfo.port
                : (apiInfo && apiInfo.endpoint ? '' : ', Clash API nonaktif');
            const removed = Array.isArray(compatibility.removed) ? compatibility.removed.length : 0;
            const compatibilitySummary = removed
                ? ', disesuaikan dengan kernel saat ini dan ' + removed + ' kolom yang tidak kompatibel dihapus'
                : compatibility.converted ? ', dikonversi ke format konfigurasi yang didukung kernel saat ini' : '';
            ui.notify('Konfigurasi ' + targetName + ' divalidasi dan diimpor' + apiSummary + compatibilitySummary,
                'success', 8000);
        } catch (error) {
            ui.notify('Gagal mengimpor konfigurasi: ' + api.errorText(error), 'error', 9000);
        } finally {
            ctx.setBusy(false);
        }
    }

    async function loadInitial() {
        viewHost.innerHTML = '';
        viewHost.appendChild(ui.loading('Memuat konfigurasi dan Schema'));
        try {
            status = ctx.status || await api.status(true);
            ctx.status = status;
            const requestedName = status.active || (status.slots[0] && status.slots[0].name);
            if (!requestedName) throw new Error('Tidak ada slot konfigurasi yang tersedia');
            const cachedSchema = api.schemaCached(status.kernel_key);
            const schemaPromise = cachedSchema
                ? Promise.resolve(cachedSchema)
                : api.schema(status.kernel_key);
            const [bundle, initialSchema] = await Promise.all([
                api.configBundle(requestedName, status.kernel_key),
                schemaPromise
            ]);
            const schemaKey = bundle.kernel_key || status.kernel_key;
            schema = api.schemaCached(schemaKey) || initialSchema
                || await api.schema(schemaKey, true);
            const slots = bundle.slots || status.slots || [];
            slotSelect.innerHTML = '';
            slots.forEach(slot => slotSelect.appendChild(ui.E('option', {
                value: slot.name, selected: slot.active ? '' : null
            }, slot.name + (slot.active ? ' (saat ini)' : ''))));
            current = bundle.config;
            draft = schemaForm.clone(current.parsed || {});
            slotSelect.value = current.name;
            backups = bundle.backups || [];
            subscription = bundle.subscription || { url: '', interval: 0, enabled: false };
            dirty = false;
            validationText = '';
            view = 'hub';
                renderView();
        } catch (error) {
            current = null;
            draft = {};
            dirty = false;
            slotSelect.innerHTML = '';
            toolbarHost.innerHTML = '';
            viewHost.innerHTML = '';
            viewHost.appendChild(components.errorCard('Gagal memuat konfigurasi', api.errorText(error), loadInitial, {
                className: 'sbd-span-12', icon: 'config',
                hint: 'Pilih file konfigurasi YAML / JSON yang ada untuk diimpor; slot konfigurasi baru akan dibuat setelah validasi berhasil.',
                retryPrimary: false,
                actions: [ui.btn('Impor file konfigurasi', { icon: 'upload', variant: 'primary', onClick: () => importInput.click() })]
            }));
            updateSavebar();
        }
    }

    async function switchSlot() {
        if (!slotSelect.value || (current && slotSelect.value === current.name)) return;
        if (dirty) {
            const ok = await ui.confirm('Alih slot konfigurasi', 'Perubahan saat ini belum disimpan dan akan hilang setelah beralih.', 'Alih');
            if (!ok) { slotSelect.value = current ? current.name : ''; return; }
        }
        try { await loadConfig(slotSelect.value); }
        catch (error) { ui.notify(api.errorText(error), 'error', 7000); }
    }

    async function reloadCurrent() {
        if (dirty) {
            const ok = await ui.confirm('Buang perubahan', 'Perubahan yang belum disimpan akan hilang.', 'Muat ulang');
            if (!ok) return;
        }
        try {
            await loadConfig(current ? current.name : slotSelect.value);
            ui.notify('Konfigurasi dimuat ulang', 'success');
        } catch (error) { ui.notify(api.errorText(error), 'error', 7000); }
    }

    async function validateDraft() {
        if (view === 'advanced') {
            if (!rawEditor.value.trim()) return ui.notify('Konfigurasi kosong', 'error');
            setBusy(true);
            try {
                const result = await api.validateConfig(rawEditor.value, 'config');
                const removed = result && result.compatibility && Array.isArray(result.compatibility.removed)
                    ? result.compatibility.removed.length : 0;
                validationText = 'Validasi berhasil · ' + (result.outbounds || 0) + ' outbound · '
                    + (result.rules || 0) + ' aturan' + (removed ? ' · ' + removed + ' kolom disesuaikan' : '');
                ui.notify('Konfigurasi berhasil divalidasi', 'success');
            } catch (error) {
                validationText = 'Validasi gagal';
                ui.notify(api.errorText(error), 'error', 7000);
            } finally { setBusy(false); }
            return;
        }
        setBusy(true);
        try {
            const result = await api.validateConfigObject(draft);
            validationText = 'Validasi berhasil · ' + (result.outbounds || 0) + ' outbound · ' + (result.rules || 0) + ' aturan';
            ui.notify('Konfigurasi berhasil divalidasi', 'success');
        } catch (error) {
            validationText = 'Validasi gagal';
            ui.notify(api.errorText(error), 'error', 7000);
        } finally { setBusy(false); }
    }

    async function saveDraft(action) {
        if (!current || !dirty) return ui.notify('Tidak ada perubahan untuk disimpan', 'info');
        if (action === 'apply') {
            const ok = await ui.confirm('Simpan dan terapkan', 'Konfigurasi akan ditulis ke ' + current.name + '; setelah validasi berhasil, sing-box akan dimulai ulang.', 'Terapkan');
            if (!ok) return;
        }
        setBusy(true);
        try {
            let job;
            if (view === 'advanced') {
                job = await api.submitConfig({
                    action, target: current.name, expected: current.hash,
                    data: rawEditor.value
                });
            } else {
                job = await api.submitConfigObject({
                    action, target: current.name, expected: current.hash, data: draft
                });
            }
            await ctx.watchJob(job, action === 'apply' ? 'Menerapkan konfigurasi' : 'Menyimpan konfigurasi');
            const name = current.name;
            await loadConfig(name);
            await loadBackups();
            if (action === 'apply') await ctx.refreshStatus().catch(() => {});
            ui.notify(action === 'apply' ? 'Konfigurasi diterapkan' : 'Konfigurasi disimpan', 'success');
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 8000);
        } finally { setBusy(false); }
    }

    function leaveView() {
        if (dirty) {
            ui.confirm('Kembali ke pusat konfigurasi', 'Perubahan yang belum disimpan akan hilang.', 'Kembali').then(ok => {
                if (!ok) return;
                dirty = false;
                view = 'hub';
                renderView();
            });
            return;
        }
        view = 'hub';
        renderView();
    }

    function subscriptionCard() {
        const input = ui.E('input', {
            'class': 'sbd-input', type: 'url', placeholder: 'https://example.com/subscribe',
            value: subscription.url || ''
        });
        const info = ui.E('div', { 'class': 'sbd-inline' }, [
            ui.E('span', { 'class': 'sbd-check-circle ' + (subscription.url ? 'checked' : '') }, ui.icon('check')),
            ui.badge(subscription.url ? 'Langganan dikonfigurasi' : 'Langganan belum dikonfigurasi', subscription.url ? 'blue' : ''),
            ui.badge(subscription.interval ? 'Pembaruan otomatis: ' + subscription.interval + ' menit' : 'Pembaruan manual', subscription.interval ? 'green' : '')
        ]);
        async function saveAddress() {
            setBusy(true);
            try {
                subscription = await api.setSubscription(input.value.trim());
                ui.notify('Alamat langganan disimpan', 'success');
                if (view === 'hub') renderHub();
            } catch (error) { ui.notify(api.errorText(error), 'error', 6000); }
            finally { setBusy(false); }
        }
        async function updateNow() {
            if (dirty) return ui.notify('Simpan perubahan saat ini terlebih dahulu', 'warn');
            setBusy(true);
            try {
                const result = await api.command('subscription-update');
                if (result.job) await ctx.watchJob(result.job, 'Memperbarui langganan');
                else ui.notify(result.message || 'Konten langganan tidak berubah', 'success');
                await loadConfig(current ? current.name : slotSelect.value);
                await loadBackups();
            } catch (error) { ui.notify(api.errorText(error), 'error', 7000); }
            finally { setBusy(false); }
        }
        return ui.card('Sumber langganan jarak jauh', [
            ui.E('div', { 'class': 'sbd-stack' }, [
                info,
                ui.field('URL langganan', input),
                ui.E('div', { 'class': 'sbd-btn-row' }, [
                    ui.btn('Simpan alamat', { icon: 'save', onClick: saveAddress }),
                    ui.btn('Sinkronkan sekarang', { icon: 'refresh', variant: 'primary', onClick: updateNow })
                ])
            ])
        ], { className: 'sbd-span-6', icon: 'link', iconTone: 'orange' });
    }

    function backupCard() {
        const body = ui.E('div', { 'class': 'sbd-backup-list' });
        if (!backups.length) body.appendChild(ui.empty('Belum ada cadangan konfigurasi'));
        backups.slice(0, 10).forEach(item => {
            body.appendChild(ui.row(item.slot || 'Snapshot konfigurasi', [
                api.formatDate(item.time), ' · ', api.formatBytes(item.size)
            ], [
                ui.btn('Pulihkan', { icon: 'backup', small: true, onClick: () => restoreBackup(item) }),
                ui.btn('', {
                    icon: 'trash', iconOnly: true, small: true, variant: 'danger',
                    title: 'Hapus cadangan ini', onClick: () => deleteBackup(item)
                })
            ], { icon: 'backup', color: 'purple' }));
        });
        return ui.card('Cadangan snapshot sebelumnya', [body], {
            className: 'sbd-span-6',
            icon: 'backup',
            iconTone: 'purple',
            subtitle: 'Simpan maksimal 10 snapshot; snapshot terlama akan dihapus otomatis jika batas terlampaui',
            actions: [ui.btn('', { icon: 'refresh', iconOnly: true, title: 'Segarkan cadangan', onClick: loadBackups })]
        });
    }

    async function loadBackups() {
        try { backups = (await api.command('backups')).backups || []; }
        catch (_) { backups = []; }
        if (view === 'hub') renderHub();
    }

    async function loadSubscription() {
        try { subscription = await api.subscriptionInfo(); }
        catch (_) { subscription = { url: '', interval: 0, enabled: false }; }
        if (view === 'hub') renderHub();
    }

    async function deleteBackup(item) {
        const ok = await ui.confirm('Hapus snapshot konfigurasi',
            'Snapshot ' + (item.slot || 'konfigurasi') + ' tanggal ' + api.formatDate(item.time) +
            ' akan dihapus permanen. Tindakan ini tidak memengaruhi konfigurasi aktif.', 'Hapus', true);
        if (!ok) return;
        setBusy(true);
        try {
            await api.deleteConfigBackup(item.name);
            ui.notify('Snapshot konfigurasi dihapus', 'success');
            await loadBackups();
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally { setBusy(false); }
    }

    async function restoreBackup(item) {
        setBusy(true);
        try {
            const target = await api.configGet(item.slot);
            const ok = await ui.confirm('Pulihkan cadangan sebelumnya',
                item.slot + ' akan dipulihkan ke versi cadangan tanggal ' + api.formatDate(item.time) + '.', 'Pulihkan');
            if (!ok) return;
            const job = await api.sendJson('submit', {
                action: 'restore', target: item.slot, expected: target.hash, backup: item.name
            }, 'restore-config');
            await ctx.watchJob(job, 'Memulihkan konfigurasi');
            await loadConfig(current && current.name === item.slot ? item.slot : current.name);
            await loadBackups();
        } catch (error) { ui.notify(api.errorText(error), 'error', 7000); }
        finally { setBusy(false); }
    }

    slotSelect.addEventListener('change', switchSlot);
    await loadInitial();
}

return baseclass.extend({ render });

