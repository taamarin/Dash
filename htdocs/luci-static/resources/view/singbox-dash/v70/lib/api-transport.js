/* Manager CLI execution, retry policy and user-facing error normalization. */
'use strict';
'require baseclass';
'require fs';

const BIN = '/usr/bin/singbox-dash/singbox-dash';

function errorInfo(error) {
    if (!error) return { kind: 'unknown', text: 'Operasi gagal. Muat ulang halaman dan coba lagi.' };
    const raw = (typeof error === 'string' ? error : String(
        error.message || error.stdout || error.stderr || error
    )).replace(/^Error:\s*/, '').trim();
    if (!raw) return { kind: 'unknown', text: 'Operasi gagal. Muat ulang halaman dan coba lagi.' };
    if (/XHR request timed out/i.test(raw))
        return { kind: 'timeout', text: 'Waktu permintaan habis: tugas latar belakang mungkin masih berjalan. Muat ulang nanti atau periksa kesalahan sing-box di “Diagnostik & Log”.' };
    if (/XHR request aborted by browser/i.test(raw))
        return { kind: 'aborted', text: 'Permintaan dihentikan oleh browser. Biarkan halaman tetap terbuka dan coba lagi; jika terus terjadi, periksa status tugas latar belakang di “Diagnostik & Log”.' };
    if (/alamat langganan|subscription URL/i.test(raw))
        return { kind: 'subscription', text: 'Alamat langganan belum dikonfigurasi. Isi URL langganan di pusat konfigurasi, lalu simpan.' };
    if (/内核|kernel|inti|SHA256|架构|arsitektur|ABI|ELF|glibc|musl/i.test(raw))
        return { kind: 'kernel', text: 'Masalah kernel: ' + raw + '. Pastikan file cocok dengan arsitektur perangkat, libc, dan jenis build saat ini, lalu unduh atau unggah ulang.' };
    if (/Clash API|external_controller|clash_api/i.test(raw))
        return { kind: 'clash', text: 'Masalah konfigurasi Clash API: ' + raw + '. Periksa external_controller, port, dan secret dalam konfigurasi.' };
    if (/unggah|cgi-upload|ukuran file|file kosong/i.test(raw))
        return { kind: 'upload', text: 'Pengunggahan gagal: ' + raw + '. Pastikan ukuran file tidak melebihi batas, biarkan halaman terbuka, lalu coba lagi.' };
    if (/konfigurasi|sing-box check|JSON|YAML|inbound|outbound|aturan/i.test(raw))
        return { kind: 'config', text: 'Masalah konfigurasi: ' + raw + '. Perbaiki lalu validasi kembali; konfigurasi asli tidak akan ditimpa.' };
    if (/network|fetch|timeout|TLS|certificate|HTTP|URL|GitHub|DNS|koneksi|sertifikat/i.test(raw))
        return { kind: 'network', text: 'Masalah jaringan: ' + raw + '. Periksa jaringan upstream router, proxy, dan DNS, lalu coba lagi.' };
    if (/proses|mulai|berhenti|mulai ulang|service/i.test(raw))
        return { kind: 'service', text: 'Masalah layanan: ' + raw + '. Muat ulang status; jika proses bermasalah, periksa log di halaman diagnostik.' };
    if (/^(?:Operasi gagal|Error)[：:]\s*/.test(raw))
        return { kind: 'unknown', text: raw };
    return { kind: 'unknown', text: 'Operasi gagal: ' + raw };
}

function errorText(error) {
    return errorInfo(error).text;
}

function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function transientError(error) {
    return errorText(error).search(/timed out|timeout|waktu habis|kehabisan waktu|aborted|Resource temporarily unavailable/i) >= 0;
}

async function commandOnce(action, args) {
    const name = String(action == null ? '' : action).trim();
    if (!name)
        throw new Error('Permintaan halaman tidak memiliki perintah tindakan. Muat ulang halaman dan coba lagi.');
    const result = await fs.exec(BIN, [name].concat((args || []).map(String)));
    const stdout = String((result && result.stdout) || '').trim();
    const stderr = String((result && result.stderr) || '').trim();
    if (!stdout)
        throw new Error(stderr || 'Layanan pengelolaan tidak memberikan hasil. Coba lagi.');
    let value = null;
    if (stdout) {
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        try {
            value = JSON.parse(lines[lines.length - 1]);
        } catch (_) {
            throw new Error(stderr || stdout.slice(-500) || 'Layanan pengelolaan memberikan hasil yang tidak valid');
        }
    }
    if ((result && Number(result.code || 0) !== 0) || (value && value.ok === false))
        throw new Error((value && value.error) || stderr || 'Operasi pengelolaan gagal');
    return value;
}

async function command(action, args, options) {
    const name = String(action == null ? '' : action).trim();
    if (!name)
        throw new Error('Permintaan halaman tidak memiliki perintah tindakan. Muat ulang halaman dan coba lagi.');
    const retries = Math.max(0, Number(options && options.retries) || 0);
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await commandOnce(name, args);
        } catch (error) {
            lastError = error;
            if (attempt >= retries || !transientError(error)) break;
            await sleep(280 * (attempt + 1));
        }
    }
    const wrapped = new Error(errorText(lastError));
    if (lastError && lastError.name) wrapped.name = lastError.name;
    throw wrapped;
}

return baseclass.extend({ BIN, errorInfo, errorText, sleep, transientError, commandOnce, command });
