#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', 'htdocs/luci-static/resources/view/singbox-dash/v70');
const baseclass = { extend: value => value };

function loadLuciModule(file, bindings) {
    let source = fs.readFileSync(file, 'utf8');
    source = source.replace(/^'require[^']*';\s*$/gm, '');
    const names = Object.keys(bindings);
    const values = names.map(name => bindings[name]);
    const wrapper = `(function(${names.join(',')}) {\n${source}\n})`;
    const context = {
        console,
        window: { setTimeout, clearTimeout, crypto: null },
        L: { env: { cgi_base: '/cgi-bin' }, require: async () => ({}) },
        FileReader: global.FileReader,
        Blob: global.Blob,
        FormData: global.FormData
    };
    return vm.runInNewContext(wrapper, context, { filename: file })(...values);
}

async function main() {
    const calls = [];
    const fsStub = {
        exec: async (bin, args) => {
            calls.push({ bin, args });
            return { code: 0, stdout: 'diagnostic\n{"ok":true,"value":7}', stderr: '' };
        },
        write: async () => {},
        remove: async () => {}
    };
    const transport = loadLuciModule(path.join(root, 'lib/api-transport.js'), {
        baseclass, fs: fsStub
    });
    assert.equal((await transport.command('status', [])).value, 7);
    assert.equal(JSON.stringify(calls[0].args), JSON.stringify(['status']));
    assert.match(transport.errorText(new Error('XHR request timed out')), /waktu habis|latar belakang/i);
    assert.equal(transport.transientError(new Error('Operasi kehabisan waktu: sing-box')), true);
    assert.equal(transport.errorInfo(new Error('Verifikasi checksum SHA256 kernel gagal')).kind, 'kernel');
    assert.equal(transport.errorInfo(new Error('File kernel tidak ditemukan')).kind, 'kernel');
    assert.equal(transport.errorInfo(new Error('Clash API memiliki Nomor port tidak valid')).kind, 'clash');
    assert.equal(transport.errorInfo(new Error('sing-box check: invalid JSON')).kind, 'config');
    assert.equal(transport.errorInfo(new Error('cgi-upload failed')).kind, 'upload');
    assert.equal(transport.errorInfo(new Error('GitHub download timeout')).kind, 'network');
    assert.equal(transport.errorInfo(new Error('Alamat langganan belum dikonfigurasi')).kind, 'subscription');
    assert.equal(transport.errorInfo(new Error('Operasi gagal: Perintah tidak diketahui:')).text, 'Operasi gagal: Perintah tidak diketahui:');
    await assert.rejects(() => transport.command('', []), /Permintaan halaman tidak memiliki perintah tindakan/);
    fsStub.exec = async () => ({ code: 0, stdout: '', stderr: '' });
    await assert.rejects(() => transport.command('logs', []), /Layanan pengelolaan tidak memberikan hasil/);


    fsStub.exec = async () => ({ code: 2, stdout: '{"ok":false,"error":"bad request"}', stderr: '' });
    await assert.rejects(() => transport.command('status', []), /bad request/);

    const writes = [];
    const removals = [];
    const uploadFs = {
        write: async (value, content, mode) => writes.push({ value, content, mode }),
        remove: async value => removals.push(value)
    };
    const upload = loadLuciModule(path.join(root, 'lib/api-upload.js'), {
        baseclass,
        fs: uploadFs,
        request: {},
        rpc: { getSessionID: () => 'session' }
    }).create({
        command: async () => ({ token: 'a'.repeat(32), max_chunk: 524288 }),
        sendJson: async () => ({ ok: true }),
        errorText: transport.errorText,
        randomHex: () => '1234567890abcdef1234567890abcdef',
        tempPath: (tag, ext) => '/tmp/singbox-dash-' + tag + ext,
        TMP: '/tmp',
        CHUNK: 512 * 1024
    });
    const uploaded = await upload.uploadText('config', 'config');
    assert.equal(uploaded.path, '/tmp/singbox-dash-config-upload.conf');
    assert.equal(writes.length, 1);
    await upload.removeUpload('/tmp/singbox-dash-test');
    await upload.removeUpload('/etc/passwd');
    assert.equal(JSON.stringify(removals), JSON.stringify(['/tmp/singbox-dash-test']));

    const api = loadLuciModule(path.join(root, 'lib/api.js'), {
        baseclass,
        fs: fsStub,
        request: {},
        rpc: {},
        transport
    });
    assert.equal(api.formatBytes(1024), '1.0 KB');
    assert.equal(typeof api.uploadBlob, 'function');
    assert.equal(typeof api.overview, 'function');
    console.log('API transport/upload module tests OK');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
