'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.api as api';
'require view.singbox-dash.v70.lib.components as components';

const PAGES = [
    ['overview', '仪表盘'], ['proxies', '策略分流'], ['subscriptions', '节点与订阅'], ['connections', '活动连接'], ['trace', '链路查询'], ['rules', '规则中心'],
    ['config', '配置中心'], ['kernel', '内核管理'], ['tools', '诊断工具']
];

async function render(host, ctx) {
    let settings = ctx.settings || await api.settings();
    const root = ui.E('div', { 'class': 'sbd-grid' });
    host.appendChild(root);

    const enabledInput = ui.E('input', { type: 'checkbox', 'aria-label': '开机自启' });
    enabledInput.checked = String(settings.enabled) === '1';
    const defaultSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': '默认主页' }, PAGES.map(item =>
        ui.E('option', { value: item[0], selected: settings.default_page === item[0] ? '' : null }, item[1])
    ));
    const intervalInput = ui.E('input', {
        'class': 'sbd-input', type: 'number', 'aria-label': '订阅更新周期（分钟）', min: '0', max: '10080', step: '1',
        value: String(settings.update_interval || 0)
    });
    const ebpfSelect = ui.E('select', { 'class': 'sbd-select', 'aria-label': '内核构建偏好' }, [
        ui.E('option', { value: 'auto', selected: settings.prefer_ebpf === 'auto' ? '' : null }, '自动识别'),
        ui.E('option', { value: 'on', selected: settings.prefer_ebpf === 'on' ? '' : null }, '优先 eBPF'),
        ui.E('option', { value: 'off', selected: settings.prefer_ebpf === 'off' ? '' : null }, '禁用 eBPF')
    ]);
    const proxyInput = ui.E('input', {
        'class': 'sbd-input', type: 'url', value: settings.github_proxy || '',
        placeholder: 'https://gh-proxy.example/'
    });
    const kernelNoticeInput = ui.E('input', { type: 'checkbox', 'aria-label': '上游内核更新提醒' });
    kernelNoticeInput.checked = String(settings.kernel_update_notice || '1') === '1';
    const dnsFailoverInput = ui.E('input', { type: 'checkbox', 'aria-label': '自动切换 DNS' });
    dnsFailoverInput.checked = String(settings.dns_failover || '1') === '1';
    const detectedDnsPort = String(settings.dns_singbox_port_detected || '').trim();
    const dnsSingboxPortInput = ui.E('input', {
        'class': 'sbd-input', type: 'number', 'aria-label': 'SingBox DNS 端口', min: '1', max: '65535', step: '1',
        value: detectedDnsPort || String(settings.dns_singbox_port || ''),
        placeholder: detectedDnsPort ? '自动读取，例如 5335' : '未自动读取，请手动填写'
    });
    const dnsBackupPortInput = ui.E('input', {
        'class': 'sbd-input', type: 'number', 'aria-label': '备份 DNS 服务端口', min: '1', max: '65535', step: '1',
        value: String(settings.dns_backup_port || settings.dns_smartdns_port || 1153),
        placeholder: '例如 1153'
    });
    const dnsFallbackServerInput = ui.E('input', {
        'class': 'sbd-input', type: 'text', 'aria-label': '兜底 DNS 服务配置',
        value: settings.dns_fallback_server || '223.5.5.5',
        placeholder: '例如 223.5.5.5'
    });
    const dnsIntervalInput = ui.E('input', {
        'class': 'sbd-input', type: 'number', 'aria-label': 'DNS 故障检测间隔（秒）', min: '2', max: '60', step: '1',
        value: String(settings.dns_guard_interval || 5),
        placeholder: '2-60 秒'
    });

    function setBusy(value) {
        components.setBusy(root, value, { selector: 'button, input, select' });
    }

    async function save() {
        const interval = Number(intervalInput.value);
        if (!Number.isInteger(interval) || interval < 0 || interval > 10080) {
            return ui.notify('更新间隔需在 0 到 10080 分钟之间', 'error');
        }
        const proxy = proxyInput.value.trim();
        if (proxy && !/^https:\/\/[^\s]+$/.test(proxy)) {
            return ui.notify('GitHub 加速地址需为 HTTPS 链接', 'error');
        }
        const fallbackServer = dnsFallbackServerInput.value.trim();
        if (fallbackServer && !/^[A-Za-z0-9_.:-]+(?:#[0-9]{1,5})?$/.test(fallbackServer)) {
            return ui.notify('兜底 DNS 格式不正确，例如 223.5.5.5 或 1.1.1.1#53', 'error');
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
            ui.notify('设置已保存', 'success');
        } catch (error) {
            ui.notify(api.errorText(error), 'error', 7000);
        } finally {
            setBusy(false);
        }
    }

    const saveButton = ui.btn('保存设置', {
        icon: 'save', variant: 'primary', onClick: save
    });
    root.appendChild(ui.card('服务与面板选项', [
        ui.row('开机自启', '系统启动时自动拉起 sing-box', ui.E('label', { 'class': 'sbd-switch' }, [
            enabledInput,
            ui.E('span')
        ]), { icon: 'play', color: 'green' }),
        ui.row('默认主页', '进入面板时打开的标签页', defaultSelect, { icon: 'overview', color: 'blue' }),
        ui.row('订阅更新周期', '单位：分钟（0 为关闭）', intervalInput, { icon: 'clock', color: 'orange' })
    ], { className: 'sbd-span-6', icon: 'sliders', iconTone: 'blue' }));

    root.appendChild(ui.card('内核与下载代理', [
        ui.row('内核构建偏好', '自动模式下按系统内核能力匹配', ebpfSelect, { icon: 'zap', color: 'purple' }),
        ui.row('上游内核更新提醒', '仅在打开面板时检查，不后台轮询', ui.E('label', { 'class': 'sbd-switch' }, [
            kernelNoticeInput,
            ui.E('span')
        ]), { icon: 'bell', color: 'orange' }),
        ui.field('GitHub 下载加速', proxyInput, '填写 HTTPS 代理前缀或 {url} 模板')
    ], { className: 'sbd-span-6', icon: 'kernel', iconTone: 'purple' }));

    const dnsRows = [
        ui.row('自动切换DNS', '', ui.E('label', { 'class': 'sbd-switch' }, [
            dnsFailoverInput,
            ui.E('span')
        ]), { icon: 'shield', color: 'green' }),
        ui.row('SingBox DNS 端口', '', dnsSingboxPortInput, { icon: 'config', color: 'blue' }),
        ui.row('备份DNS服务端口', '', dnsBackupPortInput, { icon: 'network', color: 'orange' }),
        ui.row('兜底DNS服务配置', '', dnsFallbackServerInput, { icon: 'globe', color: 'green' }),
        ui.row('检测间隔', '', dnsIntervalInput, { icon: 'clock', color: 'purple' })
    ];
    root.appendChild(ui.card('DNS 故障转移', dnsRows,
        { className: 'sbd-span-6 sbd-dns-failover-card', icon: 'link', iconTone: 'green' }));

    root.appendChild(ui.card('', [
        ui.E('div', { 'class': 'sbd-btn-row' }, [
            saveButton,
            ui.btn('重置表单', {
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



