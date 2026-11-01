'use strict';
'require baseclass';

const FIELD_LABELS = {
    type: '类型', tag: '标签', listen: '监听地址', listen_port: '监听端口',
    disabled: '禁用', level: '日志级别', output: '输出文件', timestamp: '时间戳',
    log: '日志', ntp: 'NTP', dns: 'DNS', route: '路由', experimental: '实验性配置',
    http_clients: 'HTTP 客户端', network_namespaces: '网络命名空间', certificate_providers: '证书提供者',
    bind_interface: '绑定接口', routing_mark: '路由标记', reuse_addr: '端口复用',
    netns: '网络命名空间', users: '用户', detour: '前置出站', domain_resolver: '域名解析器',
    server: '服务器', server_port: '服务器端口', method: '加密方式', password: '密码',
    username: '用户名', uuid: 'UUID', network: '网络', udp_timeout: 'UDP 超时',
    udp_fragment: 'UDP 分片', udp_gso: 'UDP GSO', interface: '接口',
    interface_name: '接口名称', address: '地址', auto_route: '自动路由',
    strict_route: '严格路由', stack: '协议栈', route_exclude_address: '路由排除地址',
    route_address: '路由地址', auto_redirect: '自动重定向', endpoint: '端点',
    tls: 'TLS', transport: '传输方式', multiplex: '多路复用', inbound: '入站',
    outbound: '出站', outbounds: '出站列表', providers: '提供者', provider: '提供者',
    include: '包含', exclude: '排除', hidden: '隐藏', health_check: '健康检查',
    url: '测试地址', interval: '检测间隔', tolerance: '容差', idle_timeout: '空闲超时',
    servers: 'DNS 服务器', rules: '规则', final: '最终出站', reverse_mapping: '反向映射',
    strategy: '解析策略', timeout: '超时', disable_cache: '禁用缓存', disable_expire: '禁用过期',
    round_robin_cache: '轮询缓存', cache_capacity: '缓存容量', min_cache_ttl: '最小 TTL',
    max_cache_ttl: '最大 TTL', optimistic: '乐观缓存', client_subnet: '客户端子网',
    tcp_concurrent: 'TCP 并发', predefined: '预定义', rule_set: '规则集',
    auto_detect_interface: '自动检测接口', override_android_vpn: '覆盖 Android VPN',
    default_domain_resolver: '默认域名解析器', default_network_strategy: '默认网络策略',
    find_process: '查找进程', process_name: '进程名', process_path: '进程路径',
    package_name: '包名', user: '用户', user_id: '用户 ID', clash_mode: 'Clash 模式',
    network_type: '网络类型', network_is_expensive: '计费网络', network_is_constrained: '受限网络',
    wifi_ssid: 'Wi-Fi SSID', wifi_bssid: 'Wi-Fi BSSID', source_mac_address: '源 MAC 地址',
    source_hostname: '源主机名', preferred_by: '优选来源', ip_cidr: 'IP 网段',
    ip_is_private: '私有 IP', domain: '域名', domain_suffix: '域名后缀',
    domain_keyword: '域名关键字', domain_regex: '域名正则', protocol: '协议',
    port: '端口', port_range: '端口范围', action: '动作', no_drop: '不丢弃',
    override_address: '重写地址', override_port: '重写端口', enabled: '启用',
    server_name: '服务器名称', insecure: '跳过证书校验', alpn: 'ALPN',
    min_version: '最低版本', max_version: '最高版本', cipher_suites: '加密套件',
    certificate: '证书', certificate_path: '证书路径', key: '私钥', key_path: '私钥路径',
    client_certificate: '客户端证书', client_key: '客户端私钥', ech: 'ECH', utls: 'uTLS',
    reality: 'REALITY', acme: 'ACME', path: '路径', headers: '请求头', host: '主机',
    service_name: '服务名称', ping_timeout: 'Ping 超时', max_early_data: '最大早期数据',
    early_data_header_name: '早期数据头名称', local: '本机接管', shared: '共享接管',
    data_plane: '数据平面', dns_mode: 'DNS 模式', ipv6: 'IPv6', h3_congestion_control: 'HTTP/3 拥塞控制',
    bypass_private_address: '绕过私有地址', fakeip_icmp: 'FakeIP ICMP',
    external_controller: '外部控制器', external_ui: '外部面板', secret: '密钥',
    default_mode: '默认模式', cache_file: '缓存文件', store_fakeip: '保存 FakeIP',
    clash_api: 'Clash API', observability: '可观测性', debug: '调试', smart: 'Smart',
    geox: 'GeoX', rule: '规则', final_outbound: '最终出站', format: '格式',
    fallback: '回退', fallback_for_alpn: 'ALPN 回退', platform: '平台', invert: '反选',
    ip_accept_any: '接受任意 IP', match_response: '匹配响应', rule_set_ip_cidr_match_source: '匹配规则集源 IP',
    network_interface_address: '网络接口地址', default_interface_address: '默认接口地址',
    dns_server_address: 'DNS 服务器地址', dns_search_domain: 'DNS 搜索域',
    override_dialer: '覆盖拨号器', override_tls: '覆盖 TLS', health_check_url: '健康检查地址',
    tag_prefix: '标签前缀', group: '分组', region: '地区', private_key: '私钥',
    pre_shared_key: '预共享密钥', server_public_key: '服务端公钥', server_disco_key: '服务端发现密钥',
    derp_map_url: 'DERP 地图地址', token: '令牌', ha_connections: '高可用连接数',
    post_quantum: '后量子加密', edge_ip_version: '边缘 IP 版本', datagram_version: '数据报版本',
    obfs_mode: '混淆模式', mode: '模式', version: '版本', tcp_fast_open: 'TCP Fast Open',
    tcp_multi_path: 'TCP Multipath', proxy_protocol: 'Proxy Protocol', proxy_protocol_accept_no_header: 'Proxy Protocol 允许无头',
    disable_tcp_keep_alive: '禁用 TCP Keep-Alive', tcp_keep_alive: 'TCP Keep-Alive',
    tcp_keep_alive_interval: 'Keep-Alive 间隔', tcp_keep_alive_count: 'Keep-Alive 次数', tc_priority: '流量控制优先级',
    dns_hijack: 'DNS 劫持'
};

const TOP_LEVEL_TITLES = {
    log: '日志', dns: 'DNS', ntp: 'NTP', certificate: '证书', certificate_providers: '证书提供者',
    http_clients: 'HTTP 客户端', network_namespaces: '网络命名空间', endpoints: '端点',
    inbounds: '入站', outbounds: '出站', providers: '提供者', route: '路由',
    services: '服务', experimental: '实验性配置'
};

const PRIORITY_KEYS = new Set([
    'type', 'tag', 'listen', 'listen_port', 'server', 'server_port', 'method',
    'password', 'username', 'uuid', 'tls', 'transport', 'multiplex', 'network',
    'address', 'interface_name', 'detour', 'outbounds', 'providers', 'exclude',
    'include', 'rules', 'rule_set', 'final', 'servers', 'strategy', 'path',
    'host', 'security', 'reality', 'handshake', 'domain_resolver', 'endpoint',
    'disabled', 'level', 'output', 'timestamp', 'enabled', 'users'
]);

let controlId = 0;

function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') {
        try { return structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
}

function humanize(value) {
    return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveSchema(root, schema, seen) {
    schema = schema || {};
    const visited = seen || new Set();
    while (schema && schema.$ref) {
        const ref = String(schema.$ref);
        if (visited.has(ref) || !ref.startsWith('#/$defs/')) return schema;
        visited.add(ref);
        schema = (root.$defs || {})[ref.slice('#/$defs/'.length)] || {};
    }
    return schema || {};
}

function mergeSchema(left, right) {
    const out = Object.assign({}, left || {});
    if (right && right.type) out.type = right.type;
    if (right && right.title) out.title = right.title;
    if (right && right.description) out.description = right.description;
    if (right && right.additionalProperties !== undefined) out.additionalProperties = right.additionalProperties;
    out.properties = Object.assign({}, (left && left.properties) || {}, (right && right.properties) || {});
    out.required = Array.from(new Set([].concat((left && left.required) || [], (right && right.required) || [])));
    if (right && right.enum) out.enum = right.enum;
    if (right && right.const !== undefined) out.const = right.const;
    if (right && right.items) out.items = right.items;
    return out;
}

function expandVariants(root, schema, seen) {
    schema = resolveSchema(root, schema, seen);
    const mark = seen || new Set();
    if (schema.allOf) {
        let merged = { type: 'object', properties: {}, required: [] };
        for (const part of schema.allOf) {
            const variants = expandVariants(root, part, mark);
            for (const item of variants) {
                if (schemaKind(root, item) === 'object') merged = mergeSchema(merged, item);
            }
        }
        return [mergeSchema(merged, schema)];
    }
    if (schema.oneOf || schema.anyOf) {
        const result = [];
        for (const branch of (schema.oneOf || schema.anyOf)) result.push(...expandVariants(root, branch, mark));
        if (!result.length) return [schema];
        const unique = [];
        const keys = new Set();
        for (const item of result) {
            const key = JSON.stringify(item);
            if (!keys.has(key)) { keys.add(key); unique.push(item); }
        }
        return unique;
    }
    return [schema];
}

function schemaKind(root, schema, value) {
    schema = resolveSchema(root, schema);
    if (schema.const !== undefined) return typeof schema.const;
    if (schema.enum) return schema.type || (typeof schema.enum[0] === 'number' ? 'integer' : 'string');
    if (schema.type) return schema.type;
    if (schema.properties || schema.additionalProperties || schema.allOf) return 'object';
    if (schema.items) return 'array';
    if (schema.oneOf || schema.anyOf) {
        const kinds = [];
        for (const branch of (schema.oneOf || schema.anyOf)) {
            const kind = schemaKind(root, branch, value);
            if (kind && !kinds.includes(kind)) kinds.push(kind);
        }
        if (Array.isArray(value) && kinds.includes('array')) return 'array';
        return kinds.find(kind => kind !== 'null') || 'string';
    }
    return Array.isArray(value) ? 'array' : isPlainObject(value) ? 'object' : 'string';
}

function objectVariants(root, schema) {
    return uniqueVariants(root, schema).filter(item => schemaKind(root, item) === 'object');
}

function variantType(root, schema) {
    schema = resolveSchema(root, schema);
    const prop = (schema.properties || {}).type || {};
    if (prop.const !== undefined) return String(prop.const);
    if (Array.isArray(prop.enum) && prop.enum.length) return String(prop.enum[0]);
    return '';
}

function variantLabel(root, schema) {
    schema = resolveSchema(root, schema);
    const type = variantType(root, schema) || schema.title || '对象';
    const props = schema.properties || {};
    const extras = [];
    ['version', 'mode'].forEach(key => {
        const prop = props[key] || {};
        const value = prop.const !== undefined ? prop.const : (prop.enum && prop.enum[0]);
        if (value !== undefined && type !== 'logical') extras.push(key + ' ' + value);
    });
    return extras.length ? type + ' · ' + extras.join(' · ') : type;
}

function chooseVariant(root, variants, value) {
    if (!variants.length) return null;
    if (!isPlainObject(value) || !value.type) return variants[0];
    const exact = variants.find(item => variantType(root, item) === String(value.type)
        && (!value.version || String(((item.properties || {}).version || {}).const ?? value.version) === String(value.version)));
    return exact || variants.find(item => variantType(root, item) === String(value.type)) || variants[0];
}


const KIND_LABELS = {
    string: '文本', integer: '整数', number: '数字', boolean: '开关',
    array: '列表', object: '对象', null: '空值'
};

function variantLabelText(root, variant) {
    const kind = schemaKind(root, variant);
    if (kind === 'object') return variantLabel(root, variant);
    let label = KIND_LABELS[kind] || kind || '值';
    if (variant && variant.const !== undefined)
        label += ' · ' + String(variant.const);
    else if (variant && Array.isArray(variant.enum) && variant.enum.length)
        label += ' · ' + variant.enum.slice(0, 3).map(String).join(' / ')
            + (variant.enum.length > 3 ? ' …' : '');
    return label;
}

function uniqueVariants(root, schema) {
    const result = [];
    const seen = new Set();
    for (const variant of expandVariants(root, schema)) {
        if (variant && variant['x-sbd-unsupported']) continue;
        const kind = schemaKind(root, variant);
        if (kind === 'null') continue;
        const props = (variant && variant.properties) || {};
        const key = [kind, variantType(root, variant), variant && variant.title || '',
            JSON.stringify(props.version && (props.version.const !== undefined ? props.version.const : props.version.enum) || ''),
            JSON.stringify(props.mode && (props.mode.const !== undefined ? props.mode.const : props.mode.enum) || '')].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(variant);
    }
    return result;
}

function variantMatches(root, variant, value) {
    const kind = schemaKind(root, variant);
    if (kind === 'object') {
        if (!isPlainObject(value)) return false;
        const type = variantType(root, variant);
        return !type || String(value.type || '') === type;
    }
    if (kind === 'array') return Array.isArray(value);
    if (kind === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (kind === 'number') return typeof value === 'number';
    if (kind === 'boolean') return typeof value === 'boolean';
    if (kind === 'string') return typeof value === 'string';
    return value !== undefined && value !== null;
}

function defaultVariantValue(root, variant, options) {
    const kind = schemaKind(root, variant);
    if (kind === 'object') return defaultObject(root, variant, options);
    if (kind === 'array') return [];
    if (kind === 'boolean') return variant && variant.default !== undefined ? variant.default : false;
    if (kind === 'integer' || kind === 'number') return variant && variant.default !== undefined ? variant.default : 0;
    if (kind === 'string') return variant && variant.default !== undefined ? variant.default : '';
    return undefined;
}

function getPath(target, path) {
    let value = target;
    for (const key of path) {
        if (value === null || value === undefined) return undefined;
        value = value[key];
    }
    return value;
}

function setPath(target, path, value) {
    if (!path.length) throw new Error('empty path');
    let parent = target;
    for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (!isPlainObject(parent[key]) && !Array.isArray(parent[key])) parent[key] = {};
        parent = parent[key];
    }
    parent[path[path.length - 1]] = value;
}

function deletePath(target, path) {
    if (!path.length) return;
    let parent = target;
    for (let i = 0; i < path.length - 1; i++) {
        if (parent == null) return;
        parent = parent[path[i]];
    }
    if (parent != null) delete parent[path[path.length - 1]];
}

function tagPool(options, kind) {
    const config = options.config || {};
    const tags = [];
    const add = value => { if (value !== undefined && value !== null && value !== '') tags.push(String(value)); };
    const arrays = {
        inbound: config.inbounds, outbound: config.outbounds, endpoint: config.endpoints,
        provider: config.providers, service: config.services
    };
    (arrays[kind] || []).forEach(item => add(item && item.tag));
    if (kind === 'dns_server') (config.dns && config.dns.servers || []).forEach(item => add(item && item.tag));
    if (kind === 'rule_set') (config.route && config.route.rule_set || []).forEach(item => add(item && item.tag));
    if (kind === 'certificate_provider') (config.certificate_providers || []).forEach(item => add(item && item.tag));
    if (kind === 'http_client') (config.http_clients || []).forEach(item => add(item && item.tag));
    if (kind === 'network_namespace') (config.network_namespaces || []).forEach(item => add(item && item.tag));
    return Array.from(new Set(tags));
}

function defaultObject(root, variant, options) {
    const value = {};
    const type = variantType(root, variant);
    if (type) value.type = type;
    const props = variant.properties || {};
    if (props.tag && !props.tag.const) {
        const pool = tagPool(options, type);
        let index = pool.length + 1;
        const inboundType = ['tun', 'ebpf', 'mixed', 'tproxy', 'redirect'].includes(type)
            || props.listen !== undefined || props.listen_port !== undefined;
        const outboundType = props.server !== undefined || props.server_port !== undefined
            || ['direct', 'block', 'pass', 'selector', 'urltest', 'smart', 'smart-loadbalance', 'loadbalance'].includes(type);
        let tag = type + (inboundType ? '-in' : outboundType ? '-out' : '-item');
        while (pool.includes(tag)) tag = type + '-' + (++index);
        value.tag = tag;
    }
    ['version', 'mode', 'network'].forEach(key => {
        const prop = props[key] || {};
        if (prop.const !== undefined) value[key] = prop.const;
    });
    return value;
}

function controlValue(schema, value) {
    if (value !== undefined && value !== null) return String(value);
    if (schema && schema.const !== undefined) return String(schema.const);
    return '';
}

function fieldLabel(key, schema) {
    return FIELD_LABELS[key] || TOP_LEVEL_TITLES[key] || schema.title || humanize(key);
}

function fieldDescription(schema) {
    return schema.description || '';
}
function objectInfo(root, schema) {
    const variants = expandVariants(root, schema);
    const merged = variants[0] || schema;
    return { schema: merged, properties: merged.properties || {}, required: merged.required || [] };
}

return baseclass.extend({
    FIELD_LABELS,
    TOP_LEVEL_TITLES,
    PRIORITY_KEYS,
    clone,
    humanize,
    isPlainObject,
    resolveSchema,
    mergeSchema,
    expandVariants,
    schemaKind,
    objectVariants,
    variantType,
    variantLabel,
    chooseVariant,
    KIND_LABELS,
    variantLabelText,
    uniqueVariants,
    variantMatches,
    defaultVariantValue,
    getPath,
    setPath,
    deletePath,
    tagPool,
    defaultObject,
    controlValue,
    fieldLabel,
    fieldDescription,
    objectInfo
});
