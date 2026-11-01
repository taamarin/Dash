'use strict';
'require baseclass';
'require fs';
'require request';
'require rpc';
'require view.singbox-dash.v70.lib.api-transport as transport';

const BIN = transport.BIN;
const { command, errorText } = transport;
const TMP = '/tmp';
const CHUNK = 512 * 1024;
function randomHex(bytes) {
    const data = new Uint8Array(bytes || 16);
    if (window.crypto && window.crypto.getRandomValues)
        window.crypto.getRandomValues(data);
    else
        for (let i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256);
    return Array.from(data, value => value.toString(16).padStart(2, '0')).join('');
}

function safeName(value) {
    return String(value || 'file').replace(/[^A-Za-z0-9_.-]+/g, '-').slice(-48) || 'file';
}

function tempPath(tag, ext) {
    return TMP + '/singbox-dash-' + safeName(tag) + '-' + Date.now() + '-' + randomHex(6) + (ext || '');
}

const readCache = new Map();
const readPending = new Map();
const swrCache = new Map();
const swrPending = new Map();
const SWR_SESSION_PREFIX = 'singbox-dash.swr.v4.';

function cacheInvalidate(prefix) {
    const match = value => !prefix || String(value).startsWith(prefix);
    for (const key of Array.from(swrCache.keys())) if (match(key)) swrCache.delete(key);
    for (const key of Array.from(swrPending.keys())) if (match(key)) swrPending.delete(key);
    try {
        for (let index = window.sessionStorage.length - 1; index >= 0; index--) {
            const key = window.sessionStorage.key(index);
            if (!key || key.indexOf(SWR_SESSION_PREFIX) !== 0) continue;
            const logical = key.slice(SWR_SESSION_PREFIX.length);
            if (match(logical)) window.sessionStorage.removeItem(key);
        }
    } catch (_) {}
}

function readSessionSnapshot(key) {
    try {
        const entry = JSON.parse(window.sessionStorage.getItem(SWR_SESSION_PREFIX + key) || 'null');
        if (entry && entry.time && Object.prototype.hasOwnProperty.call(entry, 'value'))
            return entry;
    } catch (_) {}
    return null;
}

function storeSessionSnapshot(key, entry) {
    try {
        const text = JSON.stringify(entry);
        if (text.length > 2500000) return;
        window.sessionStorage.setItem(SWR_SESSION_PREFIX + key, text);
    } catch (_) {}
}

function staleWhileRevalidate(key, ttl, loader, force, persist) {
    let current = swrCache.get(key);
    if (current && current.value == null) {
        swrCache.delete(key);
        current = null;
    }
    if (!current && !force && persist) {
        current = readSessionSnapshot(key);
        if (current && current.value != null) swrCache.set(key, current);
        else current = null;
    }
    const load = () => {
        if (swrPending.has(key)) return swrPending.get(key);
        const pending = Promise.resolve().then(loader).then(value => {
            const entry = { time: Date.now(), value };
            swrCache.set(key, entry);
            if (persist) storeSessionSnapshot(key, entry);
            return value;
        }).finally(() => swrPending.delete(key));
        swrPending.set(key, pending);
        return pending;
    };
    if (!force && current) {
        if (Date.now() - current.time > Math.max(1000, Number(ttl) || 0) && !swrPending.has(key)) {
            // Return the last snapshot immediately and refresh it in the
            // background. Explicit refresh buttons pass force=true.
            load().catch(() => {});
        }
        return Promise.resolve(current.value);
    }
    return load();
}

function runtimeConfigHash() {
    const value = statusState.value || (bootstrapCached() && bootstrapCached().status);
    return String(value && value.active_hash || 'unchecked');
}

function cachedRead(key, ttl, loader, force) {
    const now = Date.now();
    const entry = readCache.get(key);
    if (!force && entry && now - entry.time < ttl) return Promise.resolve(entry.value);
    if (readPending.has(key)) return readPending.get(key);
    const pending = Promise.resolve().then(loader).then(value => {
        readCache.set(key, { time: Date.now(), value });
        return value;
    }).finally(() => readPending.delete(key));
    readPending.set(key, pending);
    return pending;
}

const SCHEMA_PREFIX = 'singbox-dash.schema.v4.';

function readStoredSchema(kernelKey) {
    try {
        const value = JSON.parse(window.sessionStorage.getItem(SCHEMA_PREFIX + (kernelKey || 'default')) || 'null');
        return value && typeof value === 'object' && value.properties ? value : null;
    } catch (_) {
        return null;
    }
}

function storeSchema(kernelKey, value) {
    if (!value || typeof value !== 'object') return;
    const key = SCHEMA_PREFIX + (kernelKey || 'default');
    readCache.set('schema:' + key, { time: Date.now(), value });
    try {
        for (let index = window.sessionStorage.length - 1; index >= 0; index--) {
            const old = window.sessionStorage.key(index);
            if (old && old.indexOf(SCHEMA_PREFIX) === 0 && old !== key)
                window.sessionStorage.removeItem(old);
        }
        window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
}

function schemaCached(kernelKey) {
    return readStoredSchema(kernelKey);
}

async function sendJson(action, payload, prefix) {
    const path = tempPath(prefix || ('request-' + action), '.json');
    await fs.write(path, JSON.stringify(payload), 0o600);
    try {
        return await command(action, [path]);
    } finally {
        try { await fs.remove(path); } catch (_) {}
    }
}

let uploadApiPromise = null;

function getUploadApi() {
    if (!uploadApiPromise) {
        uploadApiPromise = L.require('view.singbox-dash.v70.lib.api-upload').then(module => module.create({
            command, sendJson, errorText, randomHex, tempPath, TMP, CHUNK
        })).catch(error => {
            uploadApiPromise = null;
            throw error;
        });
    }
    return uploadApiPromise;
}

async function uploadBlob(blob, kind, onProgress) {
    return (await getUploadApi()).uploadBlob(blob, kind, onProgress);
}

async function uploadText(text, kind, onProgress, tag) {
    return (await getUploadApi()).uploadText(text, kind, onProgress, tag);
}

async function removeUpload(path) {
    return (await getUploadApi()).removeUpload(path);
}

let statusState = { value: null, time: 0, pending: null };
let settingsState = { value: null, time: 0, pending: null };
const BOOTSTRAP_KEY = 'singbox-dash.bootstrap.v3';
let bootstrapMemory = null;

function readBootstrapCache() {
    if (bootstrapMemory && Date.now() - bootstrapMemory.time < 300000)
        return bootstrapMemory;
    try {
        const value = JSON.parse(window.sessionStorage.getItem(BOOTSTRAP_KEY) || 'null');
        if (value && value.time && value.value && Date.now() - value.time < 300000) {
            bootstrapMemory = value;
            return value;
        }
    } catch (_) {}
    return null;
}

function storeBootstrap(value) {
    bootstrapMemory = { time: Date.now(), value };
    try { window.sessionStorage.setItem(BOOTSTRAP_KEY, JSON.stringify(bootstrapMemory)); } catch (_) {}
}

function bootstrapCached() {
    const entry = readBootstrapCache();
    return entry ? entry.value : null;
}

function updateBootstrapStatus(value) {
    const entry = readBootstrapCache();
    if (!entry) return;
    entry.value.status = value;
    entry.time = Date.now();
    bootstrapMemory = entry;
    try { window.sessionStorage.setItem(BOOTSTRAP_KEY, JSON.stringify(entry)); } catch (_) {}
    statusState = { value, time: Date.now(), pending: null };
}

async function status(force) {
    if (!force && statusState.value && Date.now() - statusState.time < 3000)
        return statusState.value;
    if (statusState.pending) return statusState.pending;
    statusState.pending = command('status', [], { retries: 1 }).then(value => {
        statusState = { value, time: Date.now(), pending: null };
        updateBootstrapStatus(value);
        return value;
    }, error => {
        statusState.pending = null;
        throw error;
    });
    return statusState.pending;
}

async function bootstrap(force, includeOverview) {
    const cached = bootstrapCached();
    if (!force && cached) return cached;
    const value = await command('bootstrap', includeOverview ? ['overview'] : [], { retries: 1 });
    if (value && value.status)
        statusState = { value: value.status, time: Date.now(), pending: null };
    if (value && value.settings)
        settingsState = { value: value.settings, time: Date.now(), pending: null };
    storeBootstrap(value);
    return value;
}

async function overview(force) {
    return staleWhileRevalidate('overview:' + runtimeConfigHash(), 2500,
        () => command('overview', [], { retries: 1 }), !!force, false);
}

async function diagnostics(refresh) {
    if (refresh) {
        const value = await command('diag', ['refresh'], { retries: 1 });
        swrCache.set('diagnostics', { time: Date.now(), value });
        storeSessionSnapshot('diagnostics', { time: Date.now(), value });
        return value;
    }
    return staleWhileRevalidate('diagnostics', 300000,
        () => command('diag', [], { retries: 1 }), false, true);
}

async function repairTun() {
    const value = await command('tun-repair', [], { retries: 1 });
    cacheInvalidate('diagnostics');
    return value;
}

async function settings(force) {
    if (!force && settingsState.value && Date.now() - settingsState.time < 30000)
        return settingsState.value;
    if (settingsState.pending) return settingsState.pending;
    settingsState.pending = command('settings-get', [], { retries: 1 }).then(value => {
        settingsState = { value: value.settings, time: Date.now(), pending: null };
        return value.settings;
    }, error => {
        settingsState.pending = null;
        throw error;
    });
    return settingsState.pending;
}

async function saveSettings(values) {
    const result = await sendJson('settings-set', values, 'settings');
    settingsState = { value: result.settings, time: Date.now(), pending: null };
    cacheInvalidate();
    return result;
}

async function configGet(name) {
    const key = 'config-get:' + String(name || '') + ':' + runtimeConfigHash();
    return staleWhileRevalidate(key, 15000,
        () => command('config-get', [name], { retries: 1 }), false, true);
}

async function configBundle(name, kernelKey, force) {
    // Never combine Schema with the config bundle: the UBus reply would
    // exceed its size limit. Schema is fetched through its own read request.
    const key = 'config-bundle:' + String(name || 'active') + ':' + String(kernelKey || 'default') + ':' + runtimeConfigHash();
    return staleWhileRevalidate(key, 30000, async () => {
        const result = await command('config-bundle', [name || '', 'no-schema'], { retries: 1 });
        if (result && result.schema) storeSchema(result.kernel_key || kernelKey, result.schema);
        return result;
    }, !!force, true);
}

async function validateConfig(text, kind, onProgress) {
    const upload = await uploadText(text, kind || 'config', onProgress, 'validate');
    try {
        return await command('validate', [upload.path]);
    } finally {
        try { await fs.remove(upload.path); } catch (_) {}
    }
}

async function schema(kernelKey, force) {
    const key = kernelKey || 'default';
    if (!force) {
        const stored = readStoredSchema(key);
        if (stored) return stored;
    }
    return cachedRead('schema:' + key, 300000, async () => {
        const value = (await command('schema', [], { retries: 1 })).schema;
        storeSchema(key, value);
        return value;
    }, force);
}

async function validateConfigObject(data) {
    return sendJson('validate-object', { data }, 'validate-object');
}

async function importProvider(options) {
    return sendJson('provider-import', {
        tag: options.tag,
        path: options.path,
        source_type: options.sourceType || 'text',
        source: options.source || ''
    }, 'provider-import');
}

async function submitConfigObject(options) {
    const result = await sendJson('submit-object', {
        action: options.action || 'save',
        target: options.target,
        expected: options.expected,
        data: options.data
    }, 'submit-object');
    cacheInvalidate('config-');
    cacheInvalidate('provider-status:');
    return result;
}

async function submitConfig(options) {
    const upload = await uploadText(options.data, 'config', options.onProgress, 'config-' + options.target);
    try {
        const result = await sendJson('submit', {
            action: options.action || 'save',
            target: options.target,
            expected: options.expected,
            source: upload.path,
            backup: options.backup || '',
            mode: options.mode || ''
        }, 'submit-config');
        cacheInvalidate('config-');
        return result;
    } catch (error) {
        try { await fs.remove(upload.path); } catch (_) {}
        throw error;
    }
}

async function job(id) {
    return (await command('job', [id], { retries: 1 })).job;
}

async function kernelInfo(force) {
    return staleWhileRevalidate('kernel-info', 60000,
        () => command('kernel-info', [], { retries: 1 }), force === true, true);
}

async function kernelReleases(source, channel, refresh) {
    const selectedSource = source || 'michongs';
    const selected = channel || 'all';
    return staleWhileRevalidate('kernel-releases:' + selectedSource + ':' + selected, 300000, async () => {
        const args = [selectedSource, selected];
        if (refresh) args.push('refresh');
        const value = await command('kernel-releases', args, { retries: 1 });
        if (!value || !Array.isArray(value.releases))
            throw new Error('版本列表响应为空，请重试');
        return value;
    }, !!refresh, true);
}

async function kernelUpdateNotice() {
    return command('kernel-update-notice', [], { retries: 0 });
}

async function setKernelUpdateNotice(action, source, tag) {
    return sendJson('kernel-update-notice-set', {
        action: action || 'disable',
        source: source || '',
        tag: tag || ''
    }, 'kernel-update-notice');
}

async function installRelease(source, tag, asset) {
    const args = [source || 'michongs', tag];
    if (asset) args.push(asset);
    const value = await command('kernel-install-release', args);
    cacheInvalidate('kernel-');
    return value;
}

async function installKernel(path) {
    const value = await command('kernel-install', [path]);
    cacheInvalidate('kernel-');
    return value;
}

async function rollbackKernel(name) {
    const value = await command('kernel-rollback', [name]);
    cacheInvalidate('kernel-');
    return value;
}

async function deleteConfigBackup(name) {
    const value = await command('backup-delete', [name], { retries: 1 });
    cacheInvalidate('config-');
    return value;
}

async function deleteKernelBackup(name) {
    const value = await command('kernel-backup-delete', [name], { retries: 1 });
    cacheInvalidate('kernel-');
    return value;
}

async function subscriptionInfo() {
    return (await command('subscription-info', [], { retries: 1 })).subscription;
}

async function setSubscription(url) {
    return (await sendJson('subscription-set', { url }, 'subscription')).subscription;
}

async function providerStatus(force) {
    return staleWhileRevalidate('provider-status:' + runtimeConfigHash(), 15000,
        () => command('provider-status', [], { retries: 1 }), !!force, true);
}

async function traceTarget(query) {
    return command('trace', [query], { retries: 0 });
}

async function clash(method, path, body) {
    const verb = String(method || 'GET').toUpperCase();
    if (verb !== 'GET') {
        const value = await sendJson('api', { method: verb, path, body }, 'clash');
        cacheInvalidate('clash:');
        return value;
    }
    return staleWhileRevalidate('clash:' + path + ':' + runtimeConfigHash(), 5000,
        () => sendJson('api', { method: verb, path, body }, 'clash'), false, true);
}

async function clashFresh(method, path, body) {
    const verb = String(method || 'GET').toUpperCase();
    const value = await sendJson('api', { method: verb, path, body }, 'clash');
    if (verb !== 'GET') cacheInvalidate('clash:');
    return value;
}

function formatBytes(value) {
    let number = Number(value || 0);
    if (!number) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let index = 0;
    while (number >= 1024 && index < units.length - 1) {
        number /= 1024;
        index++;
    }
    return (number >= 10 || index === 0 ? number.toFixed(0) : number.toFixed(1)) + ' ' + units[index];
}

function formatUptime(seconds) {
    let value = Math.max(0, Number(seconds || 0));
    if (value < 60) return value + ' 秒';
    const days = Math.floor(value / 86400);
    value %= 86400;
    const hours = Math.floor(value / 3600);
    value %= 3600;
    const minutes = Math.floor(value / 60);
    if (days) return days + ' 天 ' + hours + ' 小时';
    if (hours) return hours + ' 小时 ' + minutes + ' 分';
    return minutes + ' 分钟';
}

function formatDate(value, withTime) {
    if (!value) return '未知';
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const options = withTime === false
        ? { year: 'numeric', month: '2-digit', day: '2-digit' }
        : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
    return date.toLocaleString('zh-CN', options);
}

return baseclass.extend({
    BIN, CHUNK, command, sendJson, uploadBlob, uploadText, removeUpload, status, bootstrap, bootstrapCached, overview, diagnostics, repairTun,
    settings, saveSettings, configGet, configBundle, schemaCached, validateConfig, schema, validateConfigObject,
    importProvider, submitConfigObject, submitConfig, job,
    subscriptionInfo, setSubscription, providerStatus, traceTarget, clash, clashFresh, kernelInfo, kernelReleases,
    kernelUpdateNotice, setKernelUpdateNotice,
    installRelease, installKernel, rollbackKernel, deleteConfigBackup, deleteKernelBackup, randomHex, tempPath,
    formatBytes, formatUptime, formatDate, errorText
});

