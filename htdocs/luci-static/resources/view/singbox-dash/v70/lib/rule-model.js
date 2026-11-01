/* Rule metadata, normalization and validation without page lifecycle code. */
'use strict';
'require baseclass';

const MATCH_FIELDS = [
    {
        key: 'rule_set', label: 'Kumpulan aturan', group: 'Pencocokan umum', common: true,
        summary: 'Mengacu pada label kumpulan aturan yang telah ditentukan di route.rule_set.',
        example: 'geosite-google\ngeoip-cn',
        placeholder: 'Satu tag kumpulan aturan per baris',
        hint: 'Beberapa tag dapat dimasukkan; cocok jika salah satunya terpenuhi. Kumpulan aturan harus sudah ada di pengaturan perutean.',
        note: 'Ini cara perutean yang paling umum, cocok untuk kategori layanan, aturan wilayah, dan aturan iklan.'
    },
    {
        key: 'domain_suffix', label: 'Domain dan subdomain', group: 'Pencocokan umum', common: true,
        summary: 'Cocokkan domain dan semua subdomainnya.',
        example: 'openai.com\nyoutube.com',
        placeholder: 'Satu domain per baris, misalnya openai.com',
        hint: 'Jangan masukkan protokol, path, atau wildcard; openai.com juga akan cocok dengan api.openai.com.',
        note: 'Cocok untuk merutekan berdasarkan domain layanan dan merupakan metode pencocokan domain yang paling umum.'
    },
    {
        key: 'ip_cidr', label: 'IP tujuan / CIDR', group: 'Pencocokan umum', common: true,
        summary: 'Cocokkan apakah alamat tujuan termasuk dalam rentang IP yang ditentukan.',
        example: '1.1.1.1/32\n2001:db8::/32',
        placeholder: 'Satu CIDR per baris, misalnya 1.1.1.1/32',
        hint: 'Gunakan format CIDR; IPv4 dan IPv6 boleh dicampur.',
        note: 'Cocok untuk koneksi tanpa informasi domain atau yang perlu dirutekan berdasarkan rentang alamat.'
    },
    {
        key: 'domain', label: 'Domain lengkap', group: 'Pencocokan domain',
        summary: 'Hanya cocok dengan domain yang sama persis, tidak termasuk subdomainnya.',
        example: 'www.example.com',
        placeholder: 'Satu domain lengkap per baris',
        hint: 'Subdomain tidak disertakan secara otomatis; untuk menyertakan subdomain, gunakan “Domain dan subdomain”.'
    },
    {
        key: 'domain_keyword', label: 'Kata dalam domain', group: 'Pencocokan domain',
        summary: 'Cocokkan apakah domain mengandung teks yang ditentukan.',
        example: 'openai\ngoogle',
        placeholder: 'Satu kata kunci per baris',
        hint: 'Pencocokan menggunakan keberadaan teks; tanda bintang tidak otomatis menjadi wildcard.'
    },
    {
        key: 'domain_regex', label: 'Regex domain', group: 'Pencocokan domain',
        summary: 'Gunakan ekspresi reguler untuk mencocokkan domain lengkap.',
        example: '(?i)^.*\\.example\\.com$',
        placeholder: 'Satu regex Go RE2 per baris',
        hint: 'Gunakan sintaks Go RE2; untuk perutean biasa, utamakan domain atau kumpulan aturan.',
        note: 'Regex yang terlalu umum dapat menyebabkan kecocokan yang salah; sebaiknya verifikasi terlebih dahulu melalui penelusuran rute.'
    },
    {
        key: 'network', label: 'Jenis transport', group: 'Pencocokan jaringan',
        summary: 'Bedakan koneksi TCP dan UDP.',
        example: 'tcp\nudp',
        placeholder: 'tcp atau udp, satu per baris',
        hint: 'Masukkan hanya tcp atau udp; gunakan aturan lanjutan untuk membatasi port sekaligus.'
    },
    {
        key: 'port', label: 'Port tujuan', group: 'Pencocokan jaringan',
        summary: 'Cocokkan port tujuan koneksi.',
        example: '443\n8443',
        placeholder: 'Satu port per baris, misalnya 443',
        hint: 'Rentang port 1–65535; ini adalah kondisi terpisah dari jenis transport dan protokol.'
    },
    {
        key: 'port_range', label: 'Rentang port tujuan', group: 'Pencocokan jaringan',
        summary: 'Cocokkan rentang port tujuan yang berurutan.',
        example: '6881:6999\n:3000\n4000:',
        placeholder: 'Satu rentang per baris, misalnya 6881:6999',
        hint: 'Mendukung rentang satu sisi seperti :3000 dan 4000:; rentang yang lebar dapat salah mencocokkan lalu lintas biasa.'
    },
    {
        key: 'source_ip_cidr', label: 'IP sumber / CIDR', group: 'Pencocokan jaringan',
        summary: 'Cocokkan lalu lintas berdasarkan alamat sumber klien.',
        example: '192.168.1.20/32\n10.0.0.0/8',
        placeholder: 'Satu CIDR sumber per baris',
        hint: 'Alamat yang dicocokkan adalah perangkat pemulai koneksi, bukan alamat situs tujuan.'
    },
    {
        key: 'source_port', label: 'Port sumber', group: 'Pencocokan jaringan',
        summary: 'Cocokkan port sumber yang digunakan klien.',
        example: '12345',
        placeholder: 'Satu port sumber per baris',
        hint: 'Port sumber biasanya dialokasikan secara acak oleh sistem dan jarang digunakan untuk perutean biasa.'
    },
    {
        key: 'source_port_range', label: 'Rentang port sumber', group: 'Pencocokan jaringan',
        summary: 'Cocokkan rentang port sumber klien.',
        example: '1000:2000',
        placeholder: 'Satu rentang port sumber per baris',
        hint: 'Format sama dengan rentang port tujuan dan mendukung rentang satu sisi.'
    },
    {
        key: 'ip_version', label: 'Versi IP', group: 'Pencocokan jaringan',
        summary: 'Hanya cocokkan koneksi IPv4 atau IPv6.',
        example: '4 atau 6',
        placeholder: 'Masukkan 4 atau 6',
        hint: 'Kolom ini hanya dapat berisi satu nilai.'
    },
    {
        key: 'protocol', label: 'Protokol hasil sniffing', group: 'Aplikasi dan sistem',
        summary: 'Cocokkan protokol lapisan aplikasi yang dideteksi kernel.',
        example: 'tls\nhttp\nquic\nstun',
        placeholder: 'Satu protokol per baris, misalnya tls',
        hint: 'Memerlukan sniffing protokol; kondisi ini tidak cocok jika protokol tidak terdeteksi.'
    },
    {
        key: 'inbound', label: 'Label inbound', group: 'Aplikasi dan sistem',
        summary: 'Hanya cocokkan koneksi dari listener inbound yang ditentukan.',
        example: 'mixed-in\ntun-in',
        placeholder: 'Satu tag inbound per baris',
        hint: 'Pilih beberapa label dari tag inbound di konfigurasi saat ini; koneksi cocok jika salah satunya sesuai.'
    },
    {
        key: 'process_name', label: 'Nama proses lokal', group: 'Aplikasi dan sistem',
        summary: 'Cocokkan berdasarkan nama proses lokal yang memulai koneksi.',
        example: 'curl\naria2c',
        placeholder: 'Satu nama proses per baris',
        hint: 'Hanya berlaku untuk proses lokal yang menjalankan sing-box; gateway tidak dapat mengenali proses pada perangkat LAN.',
        note: 'Biasanya bukan kondisi utama untuk proxy transparan router.'
    },
    {
        key: 'process_path', label: 'Path proses lokal', group: 'Aplikasi dan sistem',
        summary: 'Cocokkan berdasarkan path file executable proses lokal.',
        example: '/usr/bin/curl',
        placeholder: 'Satu path proses lengkap per baris',
        hint: 'Hanya mendukung proses lokal dan memerlukan kernel untuk membaca informasi proses.'
    },
    {
        key: 'process_path_regex', label: 'Regex path proses', group: 'Aplikasi dan sistem',
        summary: 'Gunakan ekspresi reguler untuk mencocokkan path proses lokal.',
        example: '^/usr/bin/.+',
        placeholder: 'Satu regex Go RE2 per baris',
        hint: 'Hanya cocok untuk penggunaan lanjutan; sebaiknya utamakan nama atau path proses.'
    },
    {
        key: 'clash_mode', label: 'Mode operasi Clash', group: 'Aplikasi dan sistem',
        summary: 'Hanya berlaku dalam mode rule, global, atau direct.',
        example: 'global',
        placeholder: 'rule, global, atau direct',
        hint: 'Kolom ini hanya dapat berisi satu mode; mode aturan adalah rule.'
    }
];

const FIELD_BY_KEY = Object.fromEntries(MATCH_FIELDS.map(field => [field.key, field]));
const MATCH_KEYS = MATCH_FIELDS.map(field => field.key);
const SINGLE_FIELDS = new Set(['ip_version', 'clash_mode']);
const NUMERIC_FIELDS = new Set(['port', 'source_port']);
const CATEGORY_DEFS = [
    { id: 'all', label: 'Semua', tone: '', icon: 'rules' },
    { id: 'proxy', label: 'Proxy', tone: 'blue', icon: 'route' },
    { id: 'direct', label: 'Langsung', tone: 'green', icon: 'link' },
    { id: 'block', label: 'Blokir', tone: 'red', icon: 'shield' },
    { id: 'advanced', label: 'Lanjutan/sistem', tone: 'purple', icon: 'sliders' }
];
const ACTION_LABELS = {
    route: 'Proxy outbound', direct: 'Langsung', reject: 'Blokir', bypass: 'Lewati',
    sniff: 'Sniffing protokol', 'hijack-dns': 'Pembajakan DNS', resolve: 'Resolusi DNS awal',
    'route-options': 'Opsi perutean', 'sniff-override-destination': 'Timpa tujuan'
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
    if (!rule) return 'Belum diatur';
    const action = rule.action || (rule.outbound ? 'route' : '');
    if (action === 'direct') return 'Langsung';
    if (action === 'reject') return 'Blokir';
    if (rule.outbound) {
        const type = outbounds[String(rule.outbound)];
        return String(rule.outbound) + (type ? ' · ' + type : '');
    }
    return ACTION_LABELS[action] || action || 'Aturan lanjutan';
}

function matchLabel(rule) {
    if (!isObject(rule)) return 'Kondisi tidak diketahui';
    const keys = MATCH_KEYS.filter(key => Object.prototype.hasOwnProperty.call(rule, key));
    if (rule.type === 'logical' || Array.isArray(rule.rules)) return 'Kondisi gabungan';
    if (keys.length === 1) return FIELD_BY_KEY[keys[0]].label;
    if (keys.length) return keys.slice(0, 3).map(key => (FIELD_BY_KEY[key] && FIELD_BY_KEY[key].label) || key).join(' + ');
    const extras = Object.keys(rule).filter(key => !['type', 'action', 'outbound'].includes(key));
    if (extras.length) return 'Kondisi lanjutan · ' + extras.slice(0, 3).join(', ');
    return 'Aturan fallback';
}

function ruleTitle(rule, simple, index) {
    if (!isObject(rule)) return 'Aturan tidak valid';
    if (simple) {
        const first = simple.values[0] || 'Belum diatur';
        return first + (simple.values.length > 1 ? ' +' + (simple.values.length - 1) : '');
    }
    if (rule.type === 'logical' || Array.isArray(rule.rules)) return 'Aturan gabungan #' + (index + 1);
    const action = rule.action || (rule.outbound ? 'route' : '');
    const keys = MATCH_KEYS.filter(key => Object.prototype.hasOwnProperty.call(rule, key));
    const extras = Object.keys(rule).filter(key => !['type', 'action', 'outbound'].includes(key));
    if (!keys.length && !extras.length && !rule.type) return 'Aturan fallback';
    if (!['route', 'direct', 'reject'].includes(action)) {
        const value = keys.length ? valuesOf(rule, keys[0])[0] : '';
        return (ACTION_LABELS[action] || 'Aturan lanjutan') + (value ? ' · ' + (value.length > 48 ? value.slice(0, 46) + '…' : value) : '');
    }
    if (keys.length > 1) return matchLabel(rule);
    if (keys.length === 1) {
        const label = FIELD_BY_KEY[keys[0]].label;
        return label + ' → ' + (action === 'reject' ? 'Blokir' : action === 'direct' ? 'Langsung' : targetLabel(rule, outbounds));
    }
    return ACTION_LABELS[action] || 'Aturan lanjutan #' + (index + 1);
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
    if (!values.length) throw new Error('Masukkan setidaknya satu nilai pencocokan');
    if (SINGLE_FIELDS.has(field) && values.length > 1) throw new Error('Metode pencocokan ini hanya dapat menggunakan satu nilai');
    if (field === 'domain' || field === 'domain_suffix') {
        const bad = values.find(value => /\s|[:/@*]/.test(value));
        if (bad) throw new Error('Format domain tidak valid: ' + bad + '. Hapus protokol, path, dan wildcard.');
    }
    if (field === 'ip_cidr' || field === 'source_ip_cidr') {
        const bad = values.find(value => !validCidr(value));
        if (bad) throw new Error('Format CIDR tidak valid: ' + bad + ', misalnya 1.1.1.1/32');
    }
    if (field === 'port' || field === 'source_port') {
        const bad = values.find(value => !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535);
        if (bad) throw new Error('Port tidak valid: ' + bad + ', rentangnya harus 1–65535');
    }
    if (field === 'port_range' || field === 'source_port_range') {
        const bad = values.find(value => !validPortRange(value));
        if (bad) throw new Error('Rentang port tidak valid: ' + bad + ', misalnya 6881:6999');
    }
    if (field === 'network') {
        const bad = values.find(value => !['tcp', 'udp'].includes(value.toLowerCase()));
        if (bad) throw new Error('Jenis transport hanya boleh tcp atau udp: ' + bad);
    }
    if (field === 'ip_version') {
        const bad = values.find(value => !['4', '6'].includes(value));
        if (bad) throw new Error('Versi IP hanya boleh 4 atau 6: ' + bad);
    }
    if (field === 'clash_mode') {
        const bad = values.find(value => !['rule', 'global', 'direct'].includes(value.toLowerCase()));
        if (bad) throw new Error('Mode operasi hanya boleh rule, global, atau direct: ' + bad);
    }
    if (field === 'process_path') {
        const bad = values.find(value => !value.startsWith('/'));
        if (bad) throw new Error('Path proses harus berupa path absolut: ' + bad);
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
    } else throw new Error('Pilih tindakan atau outbound yang valid');
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
