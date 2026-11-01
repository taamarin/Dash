/* File upload transport. Loaded only when a page imports a file. */
'use strict';
'require baseclass';
'require fs';
'require request';
'require rpc';

function create(dependencies) {
    const deps = dependencies || {};
    const { command, sendJson, errorText, randomHex, tempPath, TMP, CHUNK } = deps;

    function blobBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('Gagal membaca file'));
            reader.onload = () => {
                const value = String(reader.result || '');
                const comma = value.indexOf(',');
                if (comma < 0) reject(new Error('Gagal membaca file'));
                else resolve(value.slice(comma + 1));
            };
            reader.readAsDataURL(blob);
        });
    }

    async function uploadBlobStreaming(blob, kind, onProgress) {
        const token = randomHex(16);
        const ext = kind === 'kernel' ? '.bin' : '.conf';
        const path = TMP + '/singbox-dash-' + kind + '-' + token + ext;
        const form = new FormData();
        form.append('sessionid', rpc.getSessionID());
        form.append('filename', path);
        form.append('filedata', blob, 'singbox-dash-' + kind + ext);
        const started = Date.now();
        try {
            const response = await request.post((L.env.cgi_base || '/cgi-bin') + '/cgi-upload', form, {
                timeout: 0,
                progress(event) {
                    if (!onProgress || !event || !event.lengthComputable || !event.total) return;
                    const percent = Math.min(96, Math.max(0, Math.round(event.loaded / event.total * 96)));
                    const seconds = Math.max(0.001, (Date.now() - started) / 1000);
                    onProgress(percent, event.loaded, event.total, {
                        mode: 'stream', speed: event.loaded / seconds
                    });
                }
            });
            let reply = null;
            try { reply = response.json(); }
            catch (_) { throw new Error('Antarmuka unggah memberikan hasil yang tidak valid'); }
            if (reply && reply.failure)
                throw new Error(reply.message || reply.failure || 'Unggah cepat gagal');
            const size = Number(reply && reply.size);
            if (!Number.isFinite(size) || size !== blob.size)
                throw new Error('Validasi ukuran file unggahan gagal');
            if (onProgress) onProgress(98, blob.size, blob.size, {
                mode: 'stream', speed: blob.size / Math.max(0.001, (Date.now() - started) / 1000)
            });
            return {
                ok: true, path, size: blob.size, token, stream: true,
                sha256sum: reply.sha256sum || '', checksum: reply.checksum || ''
            };
        } catch (error) {
            try { await fs.remove(path); } catch (_) {}
            throw new Error('Unggah cepat gagal: ' + errorText(error));
        }
    }

    async function uploadBlobChunked(blob, kind, onProgress) {
        const session = await command('upload-session', [kind]);
        const token = String((session && session.token) || '');
        if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Tidak dapat membuat sesi unggah');
        const chunkSize = Math.max(64 * 1024,
            Math.min(CHUNK, Number(session.max_chunk) || CHUNK));
        const total = Math.ceil(blob.size / chunkSize);
        for (let index = 0; index < total; index++) {
            const part = blob.slice(index * chunkSize,
                Math.min(blob.size, (index + 1) * chunkSize));
            const encoded = await blobBase64(part);
            const name = 'singbox-dash-upload-' + token + '-' + String(index).padStart(5, '0') + '.b64';
            await fs.write(TMP + '/' + name, encoded, 0o600);
            if (onProgress) onProgress(Math.round(((index + 1) / total) * 88), index + 1, total,
                { mode: 'chunks' });
        }
        const result = await sendJson('assemble-upload', { token, kind }, 'assemble-' + kind);
        if (onProgress) onProgress(100, total, total, { mode: 'chunks' });
        return result;
    }

    async function uploadBlob(blob, kind, onProgress) {
        if (!blob || !blob.size) throw new Error('File kosong');
        if (kind !== 'config' && kind !== 'kernel') throw new Error('Jenis unggahan tidak valid');
        try {
            if (kind === 'kernel') {
                // Kernel images are large: stream them through cgi-io instead of
                // base64-encoding hundreds of individual ubus write requests.
                return await uploadBlobStreaming(blob, kind, onProgress);
            }
            return await uploadBlobChunked(blob, kind, onProgress);
        } catch (error) {
            throw new Error(errorText(error));
        }
    }

    async function removeUpload(path) {
        const value = String(path || '');
        if (!value.startsWith(TMP + '/singbox-dash-')) return;
        try { await fs.remove(value); } catch (_) {}
    }

    async function uploadText(text, kind, onProgress, tag) {
        const blob = new Blob([String(text ?? '')], { type: 'text/plain' });
        if (blob.size <= CHUNK) {
            const path = tempPath(tag || (kind + '-upload'), kind === 'kernel' ? '.bin' : '.conf');
            await fs.write(path, String(text ?? ''), 0o600);
            if (onProgress) onProgress(100, 1, 1);
            return { path, size: blob.size };
        }
        return uploadBlob(blob, kind, onProgress);
    }
    return { uploadBlob, uploadText, removeUpload };
}

return baseclass.extend({ create });
