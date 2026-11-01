/* Configuration group metadata and compact tile summaries. */
'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';

const GROUPS = {
    general: { title: 'Konfigurasi global', icon: 'sliders', color: 'green', keys: ['log'], desc: 'Level log, output, dan stempel waktu' },
    dns: { title: 'Resolusi DNS', icon: 'globe', color: 'blue', keys: ['dns'], desc: 'Server resolusi, aturan perutean, dan cache' },
    ntp: { title: 'Sinkronisasi NTP', icon: 'clock', color: 'purple', keys: ['ntp'], desc: 'Layanan sinkronisasi waktu jaringan' },
    inbounds: { title: 'Koneksi inbound', icon: 'inbound', color: 'orange', keys: ['inbounds'], desc: 'TUN, TProxy, eBPF, dan port listen' },
    outbounds: { title: 'Proxy outbound', icon: 'outbound', color: 'blue', keys: ['outbounds'], desc: 'Node, grup kebijakan, dan outbound default' },
    endpoints: { title: 'Jaringan endpoint', icon: 'link', color: 'purple', keys: ['endpoints'], desc: 'Endpoint jaringan dan tunnel' },
    certificates: { title: 'Sertifikat dan klien', icon: 'shield', color: 'red', keys: ['certificate', 'certificate_providers', 'http_clients'], desc: 'Sertifikat TLS dan klien HTTP' },
    providers: { title: 'Provider node', icon: 'database', color: 'green', keys: ['providers'], desc: 'Provider node jarak jauh atau lokal' },
    network: { title: 'Namespace jaringan', icon: 'network', color: 'blue', keys: ['network_namespaces'], desc: 'Isolasi jaringan dan pengikatan antarmuka' },
    services: { title: 'Layanan kernel', icon: 'cpu', color: 'purple', keys: ['services'], desc: 'Layanan kernel seperti API, OOM Killer, dan SSM' },
    experimental: { title: 'Konfigurasi eksperimental', icon: 'activity', color: 'orange', keys: ['experimental'], desc: 'Clash API, cache, Smart, dan debugging' }
};

const HUB_SECTIONS = [
    {
        label: 'Jaringan inti dan resolusi (Core & DNS)',
        rows: [
            ['general', 'dns', 'ntp'],
            ['inbounds', 'outbounds']
        ]
    },
    {
        label: 'Modul ekstensi dan penimpaan skrip (Extensions & Raw)',
        rows: [
            ['experimental', 'providers', 'endpoints'],
            ['certificates', 'network', 'services'],
            ['advanced']
        ]
    }
];

const TILE_SPAN = count => count === 1 ? 'sbd-config-span-6' : count === 2 ? 'sbd-config-span-3' : 'sbd-config-span-2';
const arrayCount = value => Array.isArray(value) ? value.length : 0;

function groupBadges(config, id) {
    const c = config || {};
    if (id === 'general') {
        const lvl = (c.log && c.log.level) || 'default';
        return [ui.badge('Level log: ' + String(lvl), '')];
    }
    if (id === 'dns') {
        return [
            ui.badge(arrayCount((c.dns || {}).servers) + ' server', ''),
            ui.badge(arrayCount((c.dns || {}).rules) + ' aturan', '')
        ];
    }
    if (id === 'ntp') {
        const on = !!(c.ntp && c.ntp.enabled);
        return [ui.badge(on ? 'Aktif' : 'Nonaktif', on ? 'green' : '')];
    }
    if (id === 'inbounds') return [ui.badge(arrayCount(c.inbounds) + ' inbound', '')];
    if (id === 'outbounds') return [ui.badge(arrayCount(c.outbounds) + ' outbound', '')];
    if (id === 'endpoints') return [ui.badge(arrayCount(c.endpoints) + ' endpoint', '')];
    if (id === 'certificates') return [
        ui.badge(arrayCount(c.certificate_providers) + ' sertifikat', ''),
        ui.badge(arrayCount(c.http_clients) + ' klien', '')
    ];
    if (id === 'providers') return [ui.badge(arrayCount(c.providers) + ' sumber node', '')];
    if (id === 'network') return [ui.badge(arrayCount(c.network_namespaces) + ' namespace jaringan', '')];
    if (id === 'services') return [ui.badge(arrayCount(c.services) + ' layanan', '')];
    if (id === 'experimental') {
        const endpoint = (((c.experimental || {}).clash_api || {}).external_controller);
        return [ui.badge(endpoint ? 'API: ' + endpoint : 'Clash API nonaktif', endpoint ? 'green' : 'orange')];
    }
    return [];
}

return baseclass.extend({ GROUPS, HUB_SECTIONS, TILE_SPAN, arrayCount, groupBadges });
