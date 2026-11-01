/* Configuration group metadata and compact tile summaries. */
'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';

const GROUPS = {
    general: { title: '全局配置', icon: 'sliders', color: 'green', keys: ['log'], desc: '日志级别、输出与时间戳' },
    dns: { title: 'DNS 解析', icon: 'globe', color: 'blue', keys: ['dns'], desc: '解析服务器、分流规则与缓存' },
    ntp: { title: 'NTP 同步', icon: 'clock', color: 'purple', keys: ['ntp'], desc: '网络时间同步服务' },
    inbounds: { title: '入站接入', icon: 'inbound', color: 'orange', keys: ['inbounds'], desc: 'TUN、TProxy、eBPF 与监听端口' },
    outbounds: { title: '出站代理', icon: 'outbound', color: 'blue', keys: ['outbounds'], desc: '节点、策略组与默认出站' },
    endpoints: { title: '端点网络', icon: 'link', color: 'purple', keys: ['endpoints'], desc: '网络端点与隧道' },
    certificates: { title: '证书与客户端', icon: 'shield', color: 'red', keys: ['certificate', 'certificate_providers', 'http_clients'], desc: 'TLS 证书与 HTTP 客户端' },
    providers: { title: '节点提供者', icon: 'database', color: 'green', keys: ['providers'], desc: '远程或本地节点提供者' },
    network: { title: '网络命名空间', icon: 'network', color: 'blue', keys: ['network_namespaces'], desc: '网络隔离与接口绑定' },
    services: { title: '内核服务', icon: 'cpu', color: 'purple', keys: ['services'], desc: 'API、OOM Killer、SSM 等内核服务' },
    experimental: { title: '实验性配置', icon: 'activity', color: 'orange', keys: ['experimental'], desc: 'Clash API、缓存、Smart 与调试' }
};

const HUB_SECTIONS = [
    {
        label: '核心网络与解析 (Core & DNS)',
        rows: [
            ['general', 'dns', 'ntp'],
            ['inbounds', 'outbounds']
        ]
    },
    {
        label: '扩展模块与脚本覆写 (Extensions & Raw)',
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
        return [ui.badge('日志级别：' + String(lvl), '')];
    }
    if (id === 'dns') {
        return [
            ui.badge(arrayCount((c.dns || {}).servers) + ' 个服务器', ''),
            ui.badge(arrayCount((c.dns || {}).rules) + ' 条规则', '')
        ];
    }
    if (id === 'ntp') {
        const on = !!(c.ntp && c.ntp.enabled);
        return [ui.badge(on ? '已启用' : '已关闭', on ? 'green' : '')];
    }
    if (id === 'inbounds') return [ui.badge(arrayCount(c.inbounds) + ' 个入站', '')];
    if (id === 'outbounds') return [ui.badge(arrayCount(c.outbounds) + ' 个出站', '')];
    if (id === 'endpoints') return [ui.badge(arrayCount(c.endpoints) + ' 个端点', '')];
    if (id === 'certificates') return [
        ui.badge(arrayCount(c.certificate_providers) + ' 个证书', ''),
        ui.badge(arrayCount(c.http_clients) + ' 个客户端', '')
    ];
    if (id === 'providers') return [ui.badge(arrayCount(c.providers) + ' 个节点源', '')];
    if (id === 'network') return [ui.badge(arrayCount(c.network_namespaces) + ' 个网络命名空间', '')];
    if (id === 'services') return [ui.badge(arrayCount(c.services) + ' 个服务', '')];
    if (id === 'experimental') {
        const endpoint = (((c.experimental || {}).clash_api || {}).external_controller);
        return [ui.badge(endpoint ? 'API：' + endpoint : 'Clash API 未启用', endpoint ? 'green' : 'orange')];
    }
    return [];
}

return baseclass.extend({ GROUPS, HUB_SECTIONS, TILE_SPAN, arrayCount, groupBadges });
