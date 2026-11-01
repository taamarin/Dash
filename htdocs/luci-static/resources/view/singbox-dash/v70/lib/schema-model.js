'use strict';
'require baseclass';

const FIELD_LABELS = {
    type: 'Jenis', tag: 'Label', listen: 'Alamat listen', listen_port: 'Port listen',
    disabled: 'Nonaktif', level: 'Level log', output: 'File output', timestamp: 'Stempel waktu',
    log: 'Log', ntp: 'NTP', dns: 'DNS', route: 'Rute', experimental: 'Konfigurasi eksperimental',
    http_clients: 'Klien HTTP', network_namespaces: 'Namespace jaringan', certificate_providers: 'Provider sertifikat',
    bind_interface: 'Ikat antarmuka', routing_mark: 'Tanda perutean', reuse_addr: 'Penggunaan ulang port',
    netns: 'Namespace jaringan', users: 'Pengguna', detour: 'Outbound perantara', domain_resolver: 'Resolver domain',
    server: 'Server', server_port: 'Port server', method: 'Metode enkripsi', password: 'Kata sandi',
    username: 'Nama pengguna', uuid: 'UUID', network: 'Jaringan', udp_timeout: 'Batas waktu UDP',
    udp_fragment: 'Fragmentasi UDP', udp_gso: 'UDP GSO', interface: 'Antarmuka',
    interface_name: 'Nama antarmuka', address: 'Alamat', auto_route: 'Rute otomatis',
    strict_route: 'Rute ketat', stack: 'Stack protokol', route_exclude_address: 'Alamat yang dikecualikan dari rute',
    route_address: 'Alamat rute', auto_redirect: 'Pengalihan otomatis', endpoint: 'Endpoint',
    tls: 'TLS', transport: 'Transport', multiplex: 'Multiplex', inbound: 'Inbound',
    outbound: 'Outbound', outbounds: 'Daftar outbound', providers: 'Provider', provider: 'Provider',
    include: 'Sertakan', exclude: 'Kecualikan', hidden: 'Tersembunyi', health_check: 'Pemeriksaan kesehatan',
    url: 'Alamat pengujian', interval: 'Interval pemeriksaan', tolerance: 'Toleransi', idle_timeout: 'Batas waktu idle',
    servers: 'Server DNS', rules: 'Aturan', final: 'Outbound akhir', reverse_mapping: 'Pemetaan balik',
    strategy: 'Strategi resolusi', timeout: 'Batas waktu', disable_cache: 'Nonaktifkan cache', disable_expire: 'Nonaktifkan kedaluwarsa',
    round_robin_cache: 'Cache round-robin', cache_capacity: 'Kapasitas cache', min_cache_ttl: 'TTL cache minimum',
    max_cache_ttl: 'TTL cache maksimum', optimistic: 'Cache optimistis', client_subnet: 'Subnet klien',
    tcp_concurrent: 'TCP konkuren', predefined: 'Pradefinisi', rule_set: 'Kumpulan aturan',
    auto_detect_interface: 'Deteksi antarmuka otomatis', override_android_vpn: 'Timpa Android VPN',
    default_domain_resolver: 'Resolver domain default', default_network_strategy: 'Strategi jaringan default',
    find_process: 'Cari proses', process_name: 'Nama proses', process_path: 'Path proses',
    package_name: 'Nama paket', user: 'Pengguna', user_id: 'ID pengguna', clash_mode: 'Mode Clash',
    network_type: 'Jenis jaringan', network_is_expensive: 'Jaringan berbiaya', network_is_constrained: 'Jaringan terbatas',
    wifi_ssid: 'SSID Wi-Fi', wifi_bssid: 'BSSID Wi-Fi', source_mac_address: 'Alamat MAC sumber',
    source_hostname: 'Nama host sumber', preferred_by: 'Sumber pilihan', ip_cidr: 'Rentang IP',
    ip_is_private: 'IP privat', domain: 'Domain', domain_suffix: 'Sufiks domain',
    domain_keyword: 'Kata kunci domain', domain_regex: 'Regex domain', protocol: 'Protokol',
    port: 'Port', port_range: 'Rentang port', action: 'Tindakan', no_drop: 'Jangan buang',
    override_address: 'Timpa alamat', override_port: 'Timpa port', enabled: 'Aktifkan',
    server_name: 'Nama server', insecure: 'Lewati verifikasi sertifikat', alpn: 'ALPN',
    min_version: 'Versi minimum', max_version: 'Versi maksimum', cipher_suites: 'Cipher suite',
    certificate: 'Sertifikat', certificate_path: 'Path sertifikat', key: 'Kunci privat', key_path: 'Path kunci privat',
    client_certificate: 'Sertifikat klien', client_key: 'Kunci privat klien', ech: 'ECH', utls: 'uTLS',
    reality: 'REALITY', acme: 'ACME', path: 'Path', headers: 'Header permintaan', host: 'Host',
    service_name: 'Nama layanan', ping_timeout: 'Batas waktu ping', max_early_data: 'Data awal maksimum',
    early_data_header_name: 'Nama header data awal', local: 'Pengambilalihan lokal', shared: 'Pengambilalihan bersama',
    data_plane: 'Data plane', dns_mode: 'Mode DNS', ipv6: 'IPv6', h3_congestion_control: 'Kontrol kongesti HTTP/3',
    bypass_private_address: 'Lewati alamat privat', fakeip_icmp: 'FakeIP ICMP',
    external_controller: 'Controller eksternal', external_ui: 'Panel eksternal', secret: 'Secret',
    default_mode: 'Mode default', cache_file: 'File cache', store_fakeip: 'Simpan FakeIP',
    clash_api: 'Clash API', observability: 'Observabilitas', debug: 'Debug', smart: 'Smart',
    geox: 'GeoX', rule: 'Aturan', final_outbound: 'Outbound akhir', format: 'Format',
    fallback: 'Fallback', fallback_for_alpn: 'Fallback ALPN', platform: 'Platform', invert: 'Balikkan',
    ip_accept_any: 'Terima IP apa pun', match_response: 'Cocokkan respons', rule_set_ip_cidr_match_source: 'Cocokkan IP sumber kumpulan aturan',
    network_interface_address: 'Alamat antarmuka jaringan', default_interface_address: 'Alamat antarmuka default',
    dns_server_address: 'Alamat server DNS', dns_search_domain: 'Domain pencarian DNS',
    override_dialer: 'Timpa dialer', override_tls: 'Timpa TLS', health_check_url: 'URL pemeriksaan kesehatan',
    tag_prefix: 'Awalan label', group: 'Grup', region: 'Wilayah', private_key: 'Kunci privat',
    pre_shared_key: 'Kunci prabagi', server_public_key: 'Kunci publik server', server_disco_key: 'Kunci discovery server',
    derp_map_url: 'URL peta DERP', token: 'Token', ha_connections: 'Koneksi ketersediaan tinggi',
    post_quantum: 'Enkripsi pascakuantum', edge_ip_version: 'Versi IP edge', datagram_version: 'Versi datagram',
    obfs_mode: 'Mode obfuscation', mode: 'Mode', version: 'Versi', tcp_fast_open: 'TCP Fast Open',
    tcp_multi_path: 'TCP Multipath', proxy_protocol: 'Proxy Protocol', proxy_protocol_accept_no_header: 'Proxy Protocol menerima tanpa header',
    disable_tcp_keep_alive: 'Nonaktifkan TCP Keep-Alive', tcp_keep_alive: 'TCP Keep-Alive',
    tcp_keep_alive_interval: 'Interval Keep-Alive', tcp_keep_alive_count: 'Jumlah Keep-Alive', tc_priority: 'Prioritas kontrol lalu lintas',
    dns_hijack: 'Pembajakan DNS'
};

const TOP_LEVEL_TITLES = {
    log: 'Log', dns: 'DNS', ntp: 'NTP', certificate: 'Sertifikat', certificate_providers: 'Provider sertifikat',
    http_clients: 'Klien HTTP', network_namespaces: 'Namespace jaringan', endpoints: 'Endpoint',
    inbounds: 'Inbound', outbounds: 'Outbound', providers: 'Provider', route: 'Rute',
    services: 'Layanan', experimental: 'Konfigurasi eksperimental'
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
    const type = variantType(root, schema) || schema.title || 'Objek';
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
    string: 'Teks', integer: 'Bilangan bulat', number: 'Angka', boolean: 'Sakelar',
    array: 'Daftar', object: 'Objek', null: 'Nilai kosong'
};

function variantLabelText(root, variant) {
    const kind = schemaKind(root, variant);
    if (kind === 'object') return variantLabel(root, variant);
    let label = KIND_LABELS[kind] || kind || 'Nilai';
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
