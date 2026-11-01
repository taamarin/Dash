#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium;
try {
    ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright'));
} catch (error) {
    console.error('Playwright tidak ditemukan. Jalankan npm install playwright atau atur PLAYWRIGHT_PATH.');
    process.exit(2);
}

const BASE = process.env.SBD_E2E_BASE || 'http://192.168.100.1/cgi-bin/luci/admin/services/singbox-dash';
const USERNAME = process.env.SBD_E2E_USERNAME || 'root';
const PASSWORD = process.env.SBD_E2E_PASSWORD || '';
const DESTRUCTIVE = process.env.SBD_E2E_DESTRUCTIVE === '1';
const KERNEL_FILE = process.env.SBD_E2E_KERNEL_FILE || '';
const OUTPUT = process.env.SBD_E2E_OUTPUT || path.resolve(__dirname, '../../outputs/e2e');
const MANAGER = '/usr/bin/singbox-dash/singbox-dash';

if (!PASSWORD) {
    console.error('SBD_E2E_PASSWORD wajib diatur.');
    process.exit(2);
}
fs.mkdirSync(OUTPUT, { recursive: true });

const summary = {
    startedAt: new Date().toISOString(),
    base: BASE,
    destructive: DESTRUCTIVE,
    tests: [],
    errors: []
};

function nowId() {
    return 'e2e-' + Date.now().toString(36);
}

async function waitToast(page, text, timeout = 45000) {
    await page.locator('.sbd-toast').filter({ hasText: text }).first().waitFor({ state: 'visible', timeout });
}

async function login(page) {
    await page.goto(BASE + '?verify=e2e-login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!await page.locator('input[type=password]').count()) return;
    await page.locator('input[type=text]').first().fill(USERNAME);
    const password = page.locator('input[type=password]').first();
    await password.fill(PASSWORD);
    await password.press('Enter');
    await page.waitForTimeout(2800);
    if (await page.locator('input[type=password]').count()) throw new Error('Login LuCI gagal');
}

async function go(page, name) {
    await page.goto(BASE + '?verify=e2e-' + name + '-' + Date.now() + '#' + name, {
        waitUntil: 'domcontentloaded', timeout: 30000
    });
    await page.locator('.sbd-app').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(1200);
}

async function manager(page, args) {
    const result = await page.evaluate(async ({ binary, argv }) => {
        const fs = await L.require('fs');
        return fs.exec(binary, argv);
    }, { binary: MANAGER, argv: args });
    const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
    if (!line) throw new Error('Manager tidak mengembalikan data: ' + String(result.stderr || ''));
    const value = JSON.parse(line);
    if (value.ok === false) throw new Error(value.error || 'Perintah Manager gagal');
    return value;
}

async function waitJob(page, id, timeout = 120000) {
    const started = Date.now();
    for (;;) {
        const job = (await manager(page, ['job', id])).job;
        if (job && ['done', 'failed', 'rolled_back', 'rollback_failed', 'cancelled'].includes(job.phase)) return job;
        if (Date.now() - started > timeout) throw new Error('Waktu tugas habis: ' + id);
        await page.waitForTimeout(700);
    }
}

async function restoreConfig(page, backup, expected) {
    const path = '/tmp/singbox-dash-e2e-restore-' + Date.now() + '.json';
    let queued = null;
    for (let attempt = 0; attempt < 30; attempt++) {
        const result = await page.evaluate(async ({ path, backup, expected }) => {
            const fs = await L.require('fs');
            await fs.write(path, JSON.stringify({ action: 'restore', target: 'config.yaml', expected, backup }), 0o600);
            try {
                return await fs.exec('/usr/bin/singbox-dash/singbox-dash', ['submit', path]);
            } finally {
                try { await fs.remove(path); } catch (_) {}
            }
        }, { path, backup, expected });
        const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
        queued = null;
        for (let index = lines.length - 1; index >= 0; index--) {
            try { queued = JSON.parse(lines[index]); break; } catch (_) {}
        }
        if (queued && queued.ok === false && /Tugas lain sedang berjalan|Operasi lain sedang berlangsung/i.test(queued.error || '')) {
            await page.waitForTimeout(700);
            continue;
        }
        break;
    }
    if (queued && queued.ok === false) throw new Error(queued.error || 'restore submit failed');
    if (queued && queued.id) return waitJob(page, queued.id);
    const started = Date.now();
    for (;;) {
        const latest = (await manager(page, ['job'])).job;
        if (latest && latest.action === 'restore' && ['done', 'failed', 'rolled_back', 'rollback_failed'].includes(latest.phase))
            return latest;
        if (Date.now() - started > 120000) throw new Error('restore job did not complete');
        await page.waitForTimeout(600);
    }
}

async function waitForJobAction(page, action, previousId, timeout = 120000) {
    const started = Date.now();
    for (;;) {
        const job = (await manager(page, ['job'])).job;
        if (job && job.id !== previousId && job.action === action &&
                ['done', 'failed', 'rolled_back', 'rollback_failed'].includes(job.phase))
            return job;
        if (Date.now() - started > timeout) throw new Error('Penyelesaian tugas ' + action + ' tidak teramati');
        await page.waitForTimeout(600);
    }
}

async function submitMode(page, mode, timeout = 120000) {
    const started = Date.now();
    for (;;) {
        try {
            return await manager(page, ['mode-apply', 'config.yaml', mode]);
        } catch (error) {
            if (!/Tugas lain sedang berjalan|Operasi lain sedang berlangsung/i.test(String(error.message || error))) throw error;
            if (Date.now() - started > timeout) throw error;
            await page.waitForTimeout(900);
        }
    }
}

async function runTest(name, fn) {
    const started = Date.now();
    try {
        const detail = await fn();
        summary.tests.push({ name, ok: true, ms: Date.now() - started, detail: detail || null });
        console.log('PASS', name);
    } catch (error) {
        summary.tests.push({ name, ok: false, ms: Date.now() - started, error: String(error.stack || error) });
        summary.errors.push({ name, error: String(error.stack || error) });
        console.error('FAIL', name, error.message);
    }
}

(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.SBD_E2E_CHROME || undefined,
        headless: process.env.SBD_E2E_HEADLESS !== '0',
        args: ['--disable-gpu']
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
    const page = await context.newPage();
    page.on('pageerror', error => summary.errors.push({ type: 'pageerror', error: error.message }));
    try {
        await login(page);

        await runTest('safe-pages', async () => {
            await go(page, 'overview');
            await page.locator('.sbd-dashboard').waitFor({ state: 'visible', timeout: 30000 });
            const status = await manager(page, ['status']);
            await go(page, 'config');
            await page.locator('.sbd-config-page').waitFor({ state: 'visible', timeout: 30000 });
            await go(page, 'rules');
            await page.locator('.sbd-rules-page').waitFor({ state: 'visible', timeout: 30000 });
            return { running: status.running, coreCount: status.core_count };
        });

        if (!DESTRUCTIVE) {
            summary.ok = summary.tests.every(item => item.ok);
            return;
        }

        await runTest('subscription-import', async () => {
            await go(page, 'config');
            await page.locator('.sbd-config-page').waitFor({ state: 'visible', timeout: 30000 });
            await page.locator('[data-config-tile="providers"]').click();
            await page.getByRole('button', { name: 'Tambah Provider', exact: true }).click();
            const modal = page.locator('.sbd-modal').last();
            await modal.getByLabel(/^Jenis/).selectOption('local');
            const tag = nowId();
            await modal.getByLabel(/^Label Provider/).fill(tag);
            await page.waitForTimeout(300);
            const providerPath = await modal.getByLabel(/^File node/).inputValue();
            assert.ok(providerPath.startsWith('/etc/sing-box/providers/'), 'Path file Provider tidak ditemukan');
            const link = 'vless://11111111-1111-4111-8111-111111111111@127.0.0.1:443?type=tcp&security=tls&sni=example.com#E2E';
            await modal.getByLabel(/^Konten node/).fill(link);
            await modal.getByRole('button', { name: 'Uraikan dan tulis ke file lokal', exact: true }).click();
            await page.waitForFunction(() => document.body.innerText.includes('node lokal dibuat') || !!document.querySelector('.sbd-provider-import-status .sbd-note'), null, { timeout: 30000 });
            const exists = await page.evaluate(async path => {
                const fs = await L.require('fs');
                try { return !!(await fs.stat(path)); } catch (_) { return false; }
            }, providerPath);
            assert.equal(exists, true, 'File Provider tidak ditulis: ' + providerPath);
            await page.evaluate(async path => {
                const fs = await L.require('fs');
                try { await fs.remove(path); } catch (_) {}
            }, providerPath);
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            return { tag, providerPath };
        });

        await runTest('rules-crud-config-save-restore', async () => {
            const baseline = await manager(page, ['status']);
            await go(page, 'rules');
            await page.locator('.sbd-rules-page').waitFor({ state: 'visible', timeout: 30000 });
            const beforeCount = await page.locator('.sbd-rule-row').count();
            const domain = nowId() + '.invalid';
            const updated = 'updated-' + domain;
            await page.getByRole('button', { name: 'Tambah aturan', exact: true }).click();
            let modal = page.locator('.sbd-modal').last();
            await modal.locator('select').nth(0).selectOption('domain_suffix');
            await modal.locator('textarea.sbd-rule-values').fill(domain);
            await modal.locator('select').nth(1).selectOption('__direct');
            await modal.locator('select').nth(2).selectOption('end');
            await modal.getByRole('button', { name: 'Tambah aturan', exact: true }).click();
            let row = page.locator('.sbd-rule-row').filter({ hasText: domain });
            await row.waitFor({ state: 'visible', timeout: 10000 });
            assert.equal(await page.locator('.sbd-rule-row').count(), beforeCount + 1);
            await row.locator('[title="Edit aturan"]').click();
            modal = page.locator('.sbd-modal').last();
            await modal.getByRole('button', { name: 'Simpan perubahan', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
            await modal.locator('textarea.sbd-rule-values').waitFor({ state: 'visible', timeout: 10000 });
            await modal.locator('textarea.sbd-rule-values').fill(updated);
            await modal.getByRole('button', { name: 'Simpan perubahan', exact: true }).click();
            row = page.locator('.sbd-rule-row').filter({ hasText: updated });
            await row.waitFor({ state: 'visible', timeout: 10000 });
            await row.locator('[title="Hapus aturan"]').click();
            const confirm = page.locator('.sbd-modal').filter({ hasText: 'Hapus aturan' });
            await confirm.getByRole('button', { name: 'Hapus', exact: true }).click();
            await page.waitForTimeout(500);
            assert.equal(await page.locator('.sbd-rule-row').count(), beforeCount);
            const previousJob = (await manager(page, ['job'])).job;
            await page.getByRole('button', { name: 'Simpan', exact: true }).click();
            await waitToast(page, 'Aturan disimpan', 60000);
            const saved = await manager(page, ['status']);
            const savedJob = await waitForJobAction(page, 'save', previousJob && previousJob.id, 120000);
            assert.equal(savedJob.action, 'save');
            assert.equal(savedJob.phase, 'done');
            assert.ok(savedJob.backup, 'Tugas penyimpanan tidak mengembalikan cadangan konfigurasi asli');
            const originalBackup = savedJob.backup;
            const restoreJob = await restoreConfig(page, originalBackup, saved.active_hash);
            assert.equal(restoreJob.phase, 'done', restoreJob.error || restoreJob.phase);
            const restored = await manager(page, ['status']);
            assert.equal(restored.active_hash, baseline.active_hash);
            return { beforeCount, originalBackup, restoreJob: restoreJob.id };
        });

        await runTest('mode-switch-restore', async () => {
            const baseline = await manager(page, ['status']);
            let job = null;
            let restored = false;
            try {
                const original = await manager(page, ['backups']);
                const seed = await submitMode(page, 'ebpf_cgroup');
                const seedJob = await waitJob(page, seed.id, 120000);
                if (seedJob.phase !== 'done') throw new Error(seedJob.error || seedJob.message || seedJob.phase);
                job = seedJob;
                const switched = await manager(page, ['status']);
                assert.equal(switched.mode.data_plane, 'cgroup');
                const restoreJob = await restoreConfig(page, job.backup, switched.active_hash);
                assert.equal(restoreJob.phase, 'done', restoreJob.error || restoreJob.phase);
                const after = await manager(page, ['status']);
                assert.equal(after.active_hash, baseline.active_hash);
                restored = true;
                return { switched: switched.mode, restoreJob: restoreJob.id, backupsBefore: original.backups.length };
            } finally {
                if (!restored && job && job.backup) {
                    const current = await manager(page, ['status']);
                    if (current.active_hash !== baseline.active_hash)
                        await restoreConfig(page, job.backup, current.active_hash);
                }
            }
        });

        await runTest('backup-cleanup', async () => {
            assert.equal(summary.tests.every(item => item.ok), true, 'Pengujian destruktif sebelumnya gagal; penghapusan cadangan dilewati');
            const before = (await manager(page, ['backups'])).backups;
            assert.ok(before.length <= 10, 'Jumlah cadangan melebihi batas');
            const candidate = before[0];
            assert.ok(candidate, 'Tidak ada cadangan untuk pengujian penghapusan');
            await manager(page, ['backup-delete', candidate.name]);
            const after = (await manager(page, ['backups'])).backups;
            assert.equal(after.length, Math.max(0, before.length - 1));
            return { deleted: candidate.name, before: before.length, after: after.length };
        });

        if (KERNEL_FILE) {
            await runTest('kernel-upload-rollback', async () => {
                assert.ok(fs.existsSync(KERNEL_FILE), 'File kernel tidak ada');
                await go(page, 'kernel');
                await page.waitForFunction(() => document.body.innerText.includes('arm64 / musl / 64-bit') || document.body.innerText.includes('x86_64 / musl'), null, { timeout: 60000 });
                await page.locator('input[type=file]').setInputFiles(KERNEL_FILE);
                await page.locator('.sbd-toast').filter({ hasText: 'Kernel diperbarui' }).first().waitFor({ state: 'visible', timeout: 180000 });
                const first = page.locator('.sbd-backup-list .sbd-row').first();
                await first.getByRole('button', { name: 'Rollback', exact: true }).click();
                const dialog = page.locator('.sbd-modal').filter({ hasText: 'Rollback kernel' });
                await dialog.getByRole('button', { name: 'Rollback', exact: true }).click();
                await page.waitForTimeout(5000);
                const status = await manager(page, ['status']);
                assert.equal(status.core_count, 1);
                return { file: path.basename(KERNEL_FILE) };
            });
        }
    } finally {
        summary.completedAt = new Date().toISOString();
        summary.ok = summary.errors.length === 0 && summary.tests.every(item => item.ok);
        fs.writeFileSync(path.join(OUTPUT, 'summary.json'), JSON.stringify(summary, null, 2));
        await context.close();
        await browser.close();
    }
    console.log(JSON.stringify({ ok: summary.ok, tests: summary.tests, output: OUTPUT }, null, 2));
    if (!summary.ok) process.exit(1);
})().catch(error => {
    summary.completedAt = new Date().toISOString();
    summary.ok = false;
    summary.errors.push({ type: 'fatal', error: String(error.stack || error) });
    fs.writeFileSync(path.join(OUTPUT, 'summary.json'), JSON.stringify(summary, null, 2));
    console.error(error.stack || error);
    process.exit(1);
});
