'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';
'require view.singbox-dash.v70.lib.components as components';

const PAGES = [
    ['overview', 'Dasbor'], ['proxies', 'Perutean proxy'], ['subscriptions', 'Node dan langganan'], ['connections', 'Koneksi aktif'], ['trace', 'Penelusuran rute'], ['rules', 'Pusat aturan'],
    ['config', 'Pusat konfigurasi'], ['kernel', 'Pengelolaan kernel'], ['tools', 'Diagnostik']
];

async function render(host, ctx) {
    let settings = ctx.settings || await api.settings();
    const root = ui.E('div', { 'class': 'sbd-grid' });
    host.appendChild(root);

    const enabledInput = ui.E('input', { type: 'checkbox', 'aria-label': 'Mulai otomatis saat boot' });
    enabledInput.checked = String(settings.enabled) === '1';
    const defaultSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': 'Halaman beranda default' }, PAGES.map(item =>
        ui.E('option', { value: item[0], selected: settings.default_page === item[0] ? '' : null }, item[1])
    ));
    const intervalInput = ui.E('input', {
        'class': 'sbd-input', type: 'number', 'aria-label': 'Interval pembaruan langganan (menit)', min: '0', max: '10080', step: '1',
        value: String(settings.update_interval || 0)
    });
    const ebpfSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': 'Preferensi build kernel' }, [
        ui.E('option', { value: 'auto', selected: settings.prefer_ebpf === 'auto' ? '' : null }, 'Deteksi otomatis'),
        ui.E('option', { value: 'on', selected: settings.prefer_ebpf === 'on' ? '' : null }, 'Utamakan eBPF'),
        ui.E('option', { value: 'off', selected: settings.prefer_ebpf === 'off' ? '' : null }, 'Nonaktifkan eBPF')
    ]);
    const proxyInput = ui.E('input', {
        'class': 'sbd-input', type: 'url', value: settings.github_proxy || '',
        placeholder: 'https://gh-proxy.example/'
    });
    const kernelNoticeInput = ui.E('input', { type: 'checkbox', 'aria-label': 'Pemberitahuan pembaruan kernel upstream' });
    kernelNoticeInput.checked = String(settings.kernel_update_notice || '1') === '1';
    const dnsFailoverInput = ui.E('input', { type: 'checkbox', 'aria-label': 'Alih DNS otomatis' });
    dnsFailoverInput.checked = String(settings.dns_failover || '1') === '1';
    const detectedDnsPort = String(settings.dns_singbox_port_detected || '').trim();
    const dnsSingboxPortInput = ui.E('input', {
        'class': 'sbd-input', type: 'number', 'aria-label': 'Port DNS SingBox', min: '1', max: '65535', step: '1',
        value: detectedDnsPort || String(settings.dns_singbox_port || ''),
        placeholder: detectedDnsPort ? 'Dibaca otomatis, misalnya 5335' : 'Tidak dibaca otomatis; masukkan secara manual'
    });
    const dnsBackupPortInput = ui.E('input', {
        'class': 'sbd-input', type: 'number', 'aria-label': 'Port layanan DNS cadangan', min: '1', max: '65535', step: '1',
        value: String(settings.dns_backup_port || settings.dns_smartdns_port || 1153),
        placeholder: 'Misalnya 1153'
    });
    const dnsFallbackServerInput = ui.E('input', {
        'class': 'sbd-input', type: 'text', 'aria-label': 'Konfigurasi layanan DNS fallback',
        value: settings.dns_fallback_server || '223.5.5.5',
        placeholder: 'Misalnya 223.5.5.5'
    });
    const dnsIntervalInput = ui.E('input', {
        'class': 'sbd-input', type: 'number', 'aria-label': 'Interval pemeriksaan kegagalan DNS (detik)', min: '2', max: '60', step: '1',
        value: String(settings.dns_guard_interval || 5),
        placeholder: '2–60 detik'
    });

    function setBusy(value) {
        components.setBusy(root, value, { selector: 'button, input, select' });
    }

    async function save() {
        const interval = Number(intervalInput.value);
        if (!Number.isInteger(interval) || interval < 0 || interval > 10080) {
            return ui.notify('Interval pembaruan harus antara 0 dan 10080 menit', 'error');
        }
        const proxy = proxyInput.value.trim();
        if (proxy && !/^https:\/\/[^\s]+$/.test(proxy)) {
            return ui.notify('Alamat akselerasi GitHub harus berupa tautan HTTPS', 'error');
        }
        const fallbackServer = dnsFallbackServerInput.value.trim();
        if (fallbackServer && !/^[A-Za-z0-9_.:-]+(?:#[0-9]{1,5})?$/.test(fallbackServer)) {
            return ui.notify('Format DNS fallback tidak valid, misalnya 223.5.5.5 atau 1.1.1.1#53', 'error');
        }
        setBusy(true);
        try {
            const result = await api.saveSettings({
                enabled: enabledInput.checked ? '1' : '0',
                default_page: defaultSelect.value,
                update_interval: String(interval),
                prefer_ebpf: ebpfSelect.value,
                github_proxy: proxy,
                dns_failover: dnsFailoverInput.checked ? '1' : '0',
                dns_singbox_port: String(dnsSingboxPortInput.value).trim(),
                dns_backup_port: String(dnsBackupPortInput.value),
                dns_fallback_server: fallbackServer,
                dns_guard_interval: String(dnsIntervalInput.value),
                kernel_update_notice: kernelNoticeInput.checked ? '1' : '0'
            });
            settings = result.settings;
            ctx.settings = settings;
            await ctx.refreshStatus();
            ui.notify('Pengaturan disimpan', 'success');
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally {
            setBusy(false);
        }
    }

    const saveButton = ui.btn('Simpan pengaturan', {
        icon: 'save', variant: 'primary', onClick: save
    });
    root.appendChild(ui.card('Opsi layanan dan panel', [
        ui.row('Mulai otomatis saat boot', 'Mulai sing-box secara otomatis saat sistem dinyalakan', ui.E('label', { 'class': 'sbd-switch' }, [
            enabledInput,
            ui.E('span')
        ]), { icon: 'play', color: 'green' }),
        ui.row('Halaman beranda default', 'Tab yang dibuka saat memasuki panel', defaultSelect, { icon: 'overview', color: 'blue' }),
        ui.row('Interval pembaruan langganan', 'Satuan: menit (0 untuk menonaktifkan)', intervalInput, { icon: 'clock', color: 'orange' })
    ], { className: 'sbd-span-6', icon: 'sliders', iconTone: 'blue' }));

    root.appendChild(ui.card('Kernel dan proxy unduhan', [
        ui.row('Preferensi build kernel', 'Dalam mode otomatis, pencocokan didasarkan pada kemampuan kernel sistem', ebpfSelect, { icon: 'zap', color: 'purple' }),
        ui.row('Pemberitahuan pembaruan kernel upstream', 'Pemeriksaan hanya dilakukan saat panel dibuka, bukan melalui polling latar belakang', ui.E('label', { 'class': 'sbd-switch' }, [
            kernelNoticeInput,
            ui.E('span')
        ]), { icon: 'bell', color: 'orange' }),
        ui.field('Akselerasi unduhan GitHub', proxyInput, 'Masukkan awalan proxy HTTPS atau templat {url}')
    ], { className: 'sbd-span-6', icon: 'kernel', iconTone: 'purple' }));

    const dnsRows = [
        ui.row('Alih DNS otomatis', '', ui.E('label', { 'class': 'sbd-switch' }, [
            dnsFailoverInput,
            ui.E('span')
        ]), { icon: 'shield', color: 'green' }),
        ui.row('Port DNS SingBox', '', dnsSingboxPortInput, { icon: 'config', color: 'blue' }),
        ui.row('Port layanan DNS cadangan', '', dnsBackupPortInput, { icon: 'network', color: 'orange' }),
        ui.row('Konfigurasi layanan DNS fallback', '', dnsFallbackServerInput, { icon: 'globe', color: 'green' }),
        ui.row('Interval pemeriksaan', '', dnsIntervalInput, { icon: 'clock', color: 'purple' })
    ];
    root.appendChild(ui.card('Failover DNS', dnsRows,
        { className: 'sbd-span-6 sbd-dns-failover-card', icon: 'link', iconTone: 'green' }));

    root.appendChild(ui.card('', [
        ui.E('div', { 'class': 'sbd-btn-row' }, [
            saveButton,
            ui.btn('Atur ulang formulir', {
                icon: 'refresh',
                onClick: async () => {
                    try {
                        settings = await api.settings();
                        ctx.settings = settings;
                        await ctx.refreshPage();
                    } catch (error) {
                        ui.notify(api.errorText(error), 'error');
                    }
                }
            })
        ])
    ], { className: 'sbd-span-12' }));
}

return baseclass.extend({ render });


