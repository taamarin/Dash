/* Configuration hub rendering, independent from page state and save flow. */
'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.dom as ui';
'require view.singbox-dash.v70.lib.config-model as configModel';

const { GROUPS, HUB_SECTIONS, TILE_SPAN, groupBadges } = configModel;

function refreshTileSummaries(host, config) {
    host.querySelectorAll('[data-config-tile]').forEach(node => {
        const id = node.getAttribute('data-config-tile');
        if (id && id !== 'advanced') {
            const sub = node.querySelector('.sbd-config-tile-sub');
            if (sub) {
                sub.innerHTML = '';
                groupBadges(config, id).forEach(badge => sub.appendChild(badge));
            }
        }
    });
}

function render(options) {
    const opt = options || {};
    const host = opt.host;
    const config = opt.config || {};
    host.innerHTML = '';
    HUB_SECTIONS.forEach(section => {
        host.appendChild(ui.E('div', { 'class': 'sbd-config-group-label' }, section.label));
        const list = ui.E('ul', { 'class': 'sbd-config-grid' });
        section.rows.forEach(row => {
            row.forEach(id => {
                let title;
                let badges;
                let iconName;
                let colorName;
                if (id === 'advanced') {
                    title = '源码改写与高级编辑';
                    badges = [ui.badge('YAML / JSON', '')];
                    iconName = 'terminal';
                    colorName = 'green';
                } else {
                    const group = GROUPS[id];
                    if (!group) return;
                    title = group.title;
                    badges = groupBadges(config, id);
                    iconName = group.icon || 'config';
                    colorName = group.color || 'blue';
                }
                const tile = ui.E('li', {
                    'class': TILE_SPAN(row.length),
                    'data-config-tile': id
                }, [
                    ui.E('div', { 'class': 'sbd-config-tile-left' }, [
                        ui.appIcon(iconName, colorName),
                        ui.E('div', { 'class': 'sbd-config-tile-main' }, [
                            ui.E('div', { 'class': 'sbd-config-tile-title' }, title),
                            ui.E('div', { 'class': 'sbd-config-tile-sub' }, badges)
                        ])
                    ]),
                    ui.E('span', { 'class': 'sbd-config-tile-arrow' }, ui.icon('chevronRight'))
                ]);
                tile.addEventListener('click', () => {
                    if (opt.busy) return;
                    if (id === 'advanced') {
                        if (opt.onAdvanced) opt.onAdvanced();
                    } else if (opt.onGroup) {
                        opt.onGroup(id);
                    }
                });
                list.appendChild(tile);
            });
        });
        host.appendChild(list);
    });
    host.appendChild(ui.E('div', { 'class': 'sbd-config-group-label' }, '规则订阅与配置备份 (Subscriptions & Backups)'));
    host.appendChild(ui.E('div', { 'class': 'sbd-grid sbd-config-maintenance' }, [
        opt.subscriptionCard ? opt.subscriptionCard() : null,
        opt.backupCard ? opt.backupCard() : null
    ].filter(Boolean)));
}

return baseclass.extend({ refreshTileSummaries, render });
