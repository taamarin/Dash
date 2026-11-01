/* Rule metadata, normalization and validation without page lifecycle code. */
'use strict';
'require baseclass';

const MATCH_FIELDS = [
    {
        key: 'rule_set', label: '规则集', group: '常用匹配', common: true,
        summary: '引用 route.rule_set 中已经定义的规则集标签。',
        example: 'geosite-google\ngeoip-cn',
        placeholder: '每行一个规则集 tag',
        hint: '可填写多个 tag，命中任意一个即可。规则集必须先存在于路由设置中。',
        note: '这是最常用的分流方式，适合服务分类、地区规则和广告规则。'
    },
    {
        key: 'domain_suffix', label: '域名及子域名', group: '常用匹配', common: true,
        summary: '匹配一个域名本身及其所有子域名。',
        example: 'openai.com\nyoutube.com',
        placeholder: '每行一个域名，例如 openai.com',
        hint: '不要填写协议、路径或通配符；openai.com 会同时匹配 api.openai.com。',
        note: '适合按服务域名分流，是最常用的域名匹配方式。'
    },
    {
        key: 'ip_cidr', label: '目标 IP / CIDR', group: '常用匹配', common: true,
        summary: '匹配目标地址是否属于指定 IP 网段。',
        example: '1.1.1.1/32\n2001:db8::/32',
        placeholder: '每行一个 CIDR，例如 1.1.1.1/32',
        hint: '必须使用 CIDR 格式；IPv4 和 IPv6 可以混合填写。',
        note: '适合没有域名信息或需要按地址段分流的连接。'
    },
    {
        key: 'domain', label: '完整域名', group: '域名匹配',
        summary: '只匹配完全相同的域名，不包含其子域名。',
        example: 'www.example.com',
        placeholder: '每行一个完整域名',
        hint: '不会自动包含子域名；需要子域名时请使用“域名及子域名”。'
    },
    {
        key: 'domain_keyword', label: '域名包含文字', group: '域名匹配',
        summary: '匹配域名中是否包含指定文字。',
        example: 'openai\ngoogle',
        placeholder: '每行一个关键字',
        hint: '按文字包含关系匹配，星号不会自动变成通配符。'
    },
    {
        key: 'domain_regex', label: '域名正则', group: '域名匹配',
        summary: '使用正则表达式匹配完整域名。',
        example: '(?i)^.*\\.example\\.com$',
        placeholder: '每行一个 Go RE2 正则',
        hint: '使用 Go RE2 语法；普通分流优先使用域名或规则集。',
        note: '正则过于宽泛时容易误匹配，建议先在链路查询中验证。'
    },
    {
        key: 'network', label: '传输类型', group: '网络匹配',
        summary: '区分 TCP 与 UDP 连接。',
        example: 'tcp\nudp',
        placeholder: 'tcp 或 udp，每行一个',
        hint: '只填写 tcp 或 udp；需要同时限制端口时请使用高级规则。'
    },
    {
        key: 'port', label: '目标端口', group: '网络匹配',
        summary: '匹配连接的目标端口。',
        example: '443\n8443',
        placeholder: '每行一个端口，例如 443',
        hint: '端口范围 1–65535；和传输类型、协议是两个不同条件。'
    },
    {
        key: 'port_range', label: '目标端口范围', group: '网络匹配',
        summary: '匹配一个连续的目标端口区间。',
        example: '6881:6999\n:3000\n4000:',
        placeholder: '每行一个范围，例如 6881:6999',
        hint: '支持单边范围 :3000、4000:；宽范围容易误命中普通流量。'
    },
    {
        key: 'source_ip_cidr', label: '来源 IP / CIDR', group: '网络匹配',
        summary: '按客户端来源地址匹配流量。',
        example: '192.168.1.20/32\n10.0.0.0/8',
        placeholder: '每行一个来源 CIDR',
        hint: '这里匹配的是发起连接的设备地址，不是目标网站地址。'
    },
    {
        key: 'source_port', label: '来源端口', group: '网络匹配',
        summary: '匹配客户端使用的来源端口。',
        example: '12345',
        placeholder: '每行一个来源端口',
        hint: '来源端口通常由系统随机分配，普通分流很少使用。'
    },
    {
        key: 'source_port_range', label: '来源端口范围', group: '网络匹配',
        summary: '匹配客户端来源端口区间。',
        example: '1000:2000',
        placeholder: '每行一个来源端口范围',
        hint: '格式与目标端口范围一致，支持单边范围。'
    },
    {
        key: 'ip_version', label: 'IP 版本', group: '网络匹配',
        summary: '只匹配 IPv4 或 IPv6 连接。',
        example: '4 或 6',
        placeholder: '填写 4 或 6',
        hint: '该字段只能填写一个值。'
    },
    {
        key: 'protocol', label: '嗅探协议', group: '应用与系统',
        summary: '匹配内核嗅探到的应用层协议。',
        example: 'tls\nhttp\nquic\nstun',
        placeholder: '每行一个协议，例如 tls',
        hint: '依赖协议嗅探；未嗅探到协议时该条件不会命中。'
    },
    {
        key: 'inbound', label: '入站标签', group: '应用与系统',
        summary: '只匹配来自指定入站监听器的连接。',
        example: 'mixed-in\ntun-in',
        placeholder: '每行一个 inbound tag',
        hint: '可从当前配置的入站标签中多选；多个标签按任意一个命中。'
    },
    {
        key: 'process_name', label: '本机进程名', group: '应用与系统',
        summary: '按发起连接的本机进程名匹配。',
        example: 'curl\naria2c',
        placeholder: '每行一个进程名',
        hint: '仅适用于运行 sing-box 的本机进程；网关无法识别局域网设备上的进程。',
        note: '在路由器透明代理场景通常不是首选条件。'
    },
    {
        key: 'process_path', label: '本机进程路径', group: '应用与系统',
        summary: '按本机进程可执行文件路径匹配。',
        example: '/usr/bin/curl',
        placeholder: '每行一个完整进程路径',
        hint: '仅支持本机进程，并需要内核能够读取进程信息。'
    },
    {
        key: 'process_path_regex', label: '进程路径正则', group: '应用与系统',
        summary: '使用正则表达式匹配本机进程路径。',
        example: '^/usr/bin/.+',
        placeholder: '每行一个 Go RE2 正则',
        hint: '仅适合高级场景，建议优先使用进程名或路径。'
    },
    {
        key: 'clash_mode', label: 'Clash 运行模式', group: '应用与系统',
        summary: '仅在 rule、global 或 direct 模式下生效。',
        example: 'global',
        placeholder: 'rule、global 或 direct',
        hint: '该字段只能填写一个模式；规则模式是 rule。'
    }
];

const FIELD_BY_KEY = Object.fromEntries(MATCH_FIELDS.map(field => [field.key, field]));
const MATCH_KEYS = MATCH_FIELDS.map(field => field.key);
const SINGLE_FIELDS = new Set(['ip_version', 'clash_mode']);
const NUMERIC_FIELDS = new Set(['port', 'source_port']);
const CATEGORY_DEFS = [
    { id: 'all', label: '全部', tone: '', icon: 'rules' },
    { id: 'proxy', label: '代理', tone: 'blue', icon: 'route' },
    { id: 'direct', label: '直连', tone: 'green', icon: 'link' },
    { id: 'block', label: '拦截', tone: 'red', icon: 'shield' },
    { id: 'advanced', label: '高级/系统', tone: 'purple', icon: 'sliders' }
];
const ACTION_LABELS = {
    route: '代理出站', direct: '直连', reject: '拦截', bypass: '绕过',
    sniff: '协议嗅探', 'hijack-dns': 'DNS 劫持', resolve: 'DNS 预解析',
    'route-options': '路由选项', 'sniff-override-destination': '覆盖目标'
};
const PROTOCOLS = ['tls', 'http', 'quic', 'stun', 'bittorrent', 'dtls', 'ssh', 'rdp', 'ntp', 'dns'];
function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valuesOf(rule, field) {
    const value = rule && rule[field];
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.filter(item => item !== undefined && item !== null).map(String);
    return [String(value)];
}

function simpleRule(rule) {
    if (!isObject(rule)) return null;
    const action = rule.action || (rule.outbound ? 'route' : '');
    if (!['route', 'direct', 'reject'].includes(action)) return null;
    if (action === 'route' && typeof rule.outbound !== 'string') return null;
    if (rule.type !== undefined && rule.type !== '' && rule.type !== 'default') return null;
    const present = MATCH_KEYS.filter(key => Object.prototype.hasOwnProperty.call(rule, key));
    if (present.length !== 1) return null;
    const allowed = new Set(['type', 'action', 'outbound', present[0]]);
    if (Object.keys(rule).some(key => !allowed.has(key))) return null;
    const values = valuesOf(rule, present[0]);
    if (!values.length || values.some(value => !value.trim() || /[\r\n]/.test(value))) return null;
    return { field: present[0], values, action, outbound: rule.outbound || '' };
}

function outboundMap(config) {
    const result = Object.create(null);
    ((config && config.outbounds) || []).forEach(item => {
        if (item && item.tag) result[String(item.tag)] = String(item.type || '');
    });
    return result;
}

function normalizedOutboundType(type) {
    const value = String(type || '').toLowerCase();
    if (value === 'direct') return 'direct';
    if (value === 'block' || value === 'reject') return 'block';
    return 'proxy';
}

function categoryOf(rule, outbounds) {
    const action = String((rule && (rule.action || (rule.outbound ? 'route' : ''))) || '');
    if (action === 'direct') return 'direct';
    if (action === 'reject') return 'block';
    if (action === 'route' && rule && rule.outbound) {
        const type = outbounds[String(rule.outbound)];
        if (type) return normalizedOutboundType(type);
        if (/direct|直连/i.test(String(rule.outbound))) return 'direct';
        if (/reject|block|拦截|阻断/i.test(String(rule.outbound))) return 'block';
        return 'proxy';
    }
    return 'advanced';
}

function targetKey(rule) {
    if (!rule) return '';
    const action = rule.action || (rule.outbound ? 'route' : '');
    if (action === 'direct') return '__direct';
    if (action === 'reject') return '__reject';
    if (action === 'route' && rule.outbound) return 'route::' + rule.outbound;
    return '';
}

function targetLabel(rule, outbounds) {
    if (!rule) return '未设置';
    const action = rule.action || (rule.outbound ? 'route' : '');
    if (action === 'direct') return '直连';
    if (action === 'reject') return '拦截';
    if (rule.outbound) {
        const type = outbounds[String(rule.outbound)];
        return String(rule.outbound) + (type ? ' · ' + type : '');
    }
    return ACTION_LABELS[action] || action || '高级规则';
}

function matchLabel(rule) {
    if (!isObject(rule)) return '未知条件';
    const keys = MATCH_KEYS.filter(key => Object.prototype.hasOwnProperty.call(rule, key));
    if (rule.type === 'logical' || Array.isArray(rule.rules)) return '组合条件';
    if (keys.length === 1) return FIELD_BY_KEY[keys[0]].label;
    if (keys.length) return keys.slice(0, 3).map(key => (FIELD_BY_KEY[key] && FIELD_BY_KEY[key].label) || key).join(' + ');
    const extras = Object.keys(rule).filter(key => !['type', 'action', 'outbound'].includes(key));
    if (extras.length) return '高级条件 · ' + extras.slice(0, 3).join(', ');
    return '兜底规则';
}

function ruleTitle(rule, simple, index) {
    if (!isObject(rule)) return '无效规则';
    if (simple) {
        const first = simple.values[0] || '未设置';
        return first + (simple.values.length > 1 ? ' +' + (simple.values.length - 1) : '');
    }
    if (rule.type === 'logical' || Array.isArray(rule.rules)) return '组合规则 #' + (index + 1);
    const action = rule.action || (rule.outbound ? 'route' : '');
    const keys = MATCH_KEYS.filter(key => Object.prototype.hasOwnProperty.call(rule, key));
    const extras = Object.keys(rule).filter(key => !['type', 'action', 'outbound'].includes(key));
    if (!keys.length && !extras.length && !rule.type) return '兜底规则';
    if (!['route', 'direct', 'reject'].includes(action)) {
        const value = keys.length ? valuesOf(rule, keys[0])[0] : '';
        return (ACTION_LABELS[action] || '高级规则') + (value ? ' · ' + (value.length > 48 ? value.slice(0, 46) + '…' : value) : '');
    }
    if (keys.length > 1) return matchLabel(rule);
    if (keys.length === 1) {
        const label = FIELD_BY_KEY[keys[0]].label;
        return label + ' → ' + (action === 'reject' ? '拦截' : action === 'direct' ? '直连' : targetLabel(rule, outbounds));
    }
    return ACTION_LABELS[action] || '高级规则 #' + (index + 1);
}

function isCatchAll(rule) {
    if (!isObject(rule)) return false;
    if (rule.type === 'logical' || Array.isArray(rule.rules)) return false;
    if (MATCH_KEYS.some(key => Object.prototype.hasOwnProperty.call(rule, key))) return false;
    return !Object.keys(rule).some(key => !['type', 'action', 'outbound'].includes(key));
}

function splitValues(text) {
    return String(text || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean)
        .filter((item, index, list) => list.indexOf(item) === index);
}

function validIPv4(value) {
    const parts = value.split('.');
    return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function validIPv6(value) {
    if (!value.includes(':')) return false;
    return /^[0-9a-fA-F:.]+$/.test(value);
}

function validCidr(value) {
    const parts = value.split('/');
    if (parts.length !== 2 || !/^\d{1,3}$/.test(parts[1])) return false;
    const address = parts[0];
    const prefix = Number(parts[1]);
    if (address.includes(':')) return validIPv6(address) && prefix >= 0 && prefix <= 128;
    return validIPv4(address) && prefix >= 0 && prefix <= 32;
}

function validPortRange(value) {
    const match = String(value || '').match(/^(\d*):(\d*)$/);
    if (!match || (!match[1] && !match[2])) return false;
    const start = match[1] ? Number(match[1]) : null;
    const end = match[2] ? Number(match[2]) : null;
    if (start !== null && (start < 1 || start > 65535)) return false;
    if (end !== null && (end < 1 || end > 65535)) return false;
    return start === null || end === null || start <= end;
}

function validateValues(field, text) {
    const values = splitValues(text);
    if (!values.length) throw new Error('至少填写一个匹配值');
    if (SINGLE_FIELDS.has(field) && values.length > 1) throw new Error('该匹配方式只能填写一个值');
    if (field === 'domain' || field === 'domain_suffix') {
        const bad = values.find(value => /\s|[:/@*]/.test(value));
        if (bad) throw new Error('域名格式不正确：' + bad + '。请去掉协议、路径和通配符');
    }
    if (field === 'ip_cidr' || field === 'source_ip_cidr') {
        const bad = values.find(value => !validCidr(value));
        if (bad) throw new Error('CIDR 格式不正确：' + bad + '，例如 1.1.1.1/32');
    }
    if (field === 'port' || field === 'source_port') {
        const bad = values.find(value => !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535);
        if (bad) throw new Error('端口无效：' + bad + '，范围应为 1–65535');
    }
    if (field === 'port_range' || field === 'source_port_range') {
        const bad = values.find(value => !validPortRange(value));
        if (bad) throw new Error('端口范围无效：' + bad + '，例如 6881:6999');
    }
    if (field === 'network') {
        const bad = values.find(value => !['tcp', 'udp'].includes(value.toLowerCase()));
        if (bad) throw new Error('传输类型只能是 tcp 或 udp：' + bad);
    }
    if (field === 'ip_version') {
        const bad = values.find(value => !['4', '6'].includes(value));
        if (bad) throw new Error('IP 版本只能是 4 或 6：' + bad);
    }
    if (field === 'clash_mode') {
        const bad = values.find(value => !['rule', 'global', 'direct'].includes(value.toLowerCase()));
        if (bad) throw new Error('运行模式只能是 rule、global 或 direct：' + bad);
    }
    if (field === 'process_path') {
        const bad = values.find(value => !value.startsWith('/'));
        if (bad) throw new Error('进程路径必须使用绝对路径：' + bad);
    }
    return values.map(value => ['network', 'protocol', 'clash_mode'].includes(field) ? value.toLowerCase() : value);
}

function buildRule(target, field, values) {
    const rule = {};
    if (target === '__direct') rule.action = 'direct';
    else if (target === '__reject') rule.action = 'reject';
    else if (target.indexOf('route::') === 0) {
        rule.action = 'route';
        rule.outbound = target.slice(7);
    } else throw new Error('请选择有效的动作或出站');
    if (field === 'ip_version') rule[field] = Number(values[0]);
    else if (NUMERIC_FIELDS.has(field)) rule[field] = values.map(Number);
    else rule[field] = values;
    return rule;
}

function suggestionValues(field, config) {
    if (field === 'inbound') return ((config.inbounds || []).map(item => item && item.tag).filter(Boolean)).map(String);
    if (field === 'rule_set') {
        const tags = [];
        (((config.route || {}).rule_set) || []).forEach(item => {
            [].concat((item && item.tag) || []).forEach(tag => { if (tag) tags.push(String(tag)); });
        });
        return Array.from(new Set(tags));
    }
    if (field === 'protocol') return PROTOCOLS.slice();
    if (field === 'network') return ['tcp', 'udp'];
    if (field === 'clash_mode') return ['rule', 'global', 'direct'];
    if (field === 'ip_version') return ['4', '6'];
    return [];
}

function safeJson(rule) {
    try { return JSON.stringify(rule || {}); } catch (_) { return ''; }
}

return baseclass.extend({
    MATCH_FIELDS, FIELD_BY_KEY, MATCH_KEYS, SINGLE_FIELDS, NUMERIC_FIELDS,
    CATEGORY_DEFS, ACTION_LABELS, PROTOCOLS, clone, isObject, valuesOf,
    simpleRule, outboundMap, normalizedOutboundType, categoryOf, targetKey,
    targetLabel, matchLabel, ruleTitle, isCatchAll, splitValues, validIPv4,
    validIPv6, validCidr, validPortRange, validateValues, buildRule,
    suggestionValues, safeJson
});
