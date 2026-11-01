#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium;
try {
    ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright'));
} catch (error) {
    console.error('缺少 Playwright。请先执行 npm install playwright，或设置 PLAYWRIGHT_PATH。');
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
    console.error('必须设置 SBD_E2E_PASSWORD。');
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
    if (await page.locator('input[type=password]').count()) throw new Error('LuCI 登录失败');
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
    if (!line) throw new Error('Manager 未返回数据：' + String(result.stderr || ''));
    const value = JSON.parse(line);
    if (value.ok === false) throw new Error(value.error || 'Manager 命令失败');
    return value;
}

async function waitJob(page, id, timeout = 120000) {
    const started = Date.now();
    for (;;) {
        const job = (await manager(page, ['job', id])).job;
        if (job && ['done', 'failed', 'rolled_back', 'rollback_failed', 'cancelled'].includes(job.phase)) return job;
        if (Date.now() - started > timeout) throw new Error('任务超时：' + id);
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
        if (queued && queued.ok === false && /已有任务|正在执行/.test(queued.error || '')) {
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
        if (Date.now() - started > timeout) throw new Error('未观察到 ' + action + ' 任务完成');
        await page.waitForTimeout(600);
    }
}

async function submitMode(page, mode, timeout = 120000) {
    const started = Date.now();
    for (;;) {
        try {
            return await manager(page, ['mode-apply', 'config.yaml', mode]);
        } catch (error) {
            if (!/已有任务|正在执行/.test(String(error.message || error))) throw error;
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
            await page.getByRole('button', { name: '新增提供者', exact: true }).click();
            const modal = page.locator('.sbd-modal').last();
            await modal.getByLabel(/^类型/).selectOption('local');
            const tag = nowId();
            await modal.getByLabel(/^Provider 标签/).fill(tag);
            await page.waitForTimeout(300);
            const providerPath = await modal.getByLabel(/^节点文件/).inputValue();
            assert.ok(providerPath.startsWith('/etc/sing-box/providers/'), '未找到 Provider 文件路径');
            const link = 'vless://11111111-1111-4111-8111-111111111111@127.0.0.1:443?type=tcp&security=tls&sni=example.com#E2E';
            await modal.getByLabel(/^节点内容/).fill(link);
            await modal.getByRole('button', { name: '解析并写入本地文件', exact: true }).click();
            await page.waitForFunction(() => document.body.innerText.includes('已生成 ') || !!document.querySelector('.sbd-provider-import-status .sbd-note'), null, { timeout: 30000 });
            const exists = await page.evaluate(async path => {
                const fs = await L.require('fs');
                try { return !!(await fs.stat(path)); } catch (_) { return false; }
            }, providerPath);
            assert.equal(exists, true, 'Provider 文件未写入：' + providerPath);
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
            await page.getByRole('button', { name: '新增规则', exact: true }).click();
            let modal = page.locator('.sbd-modal').last();
            await modal.locator('select').nth(0).selectOption('domain_suffix');
            await modal.locator('textarea.sbd-rule-values').fill(domain);
            await modal.locator('select').nth(1).selectOption('__direct');
            await modal.locator('select').nth(2).selectOption('end');
            await modal.getByRole('button', { name: '添加规则', exact: true }).click();
            let row = page.locator('.sbd-rule-row').filter({ hasText: domain });
            await row.waitFor({ state: 'visible', timeout: 10000 });
            assert.equal(await page.locator('.sbd-rule-row').count(), beforeCount + 1);
            await row.locator('[title="编辑规则"]').click();
            modal = page.locator('.sbd-modal').last();
            await modal.getByRole('button', { name: '保存修改', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
            await modal.locator('textarea.sbd-rule-values').waitFor({ state: 'visible', timeout: 10000 });
            await modal.locator('textarea.sbd-rule-values').fill(updated);
            await modal.getByRole('button', { name: '保存修改', exact: true }).click();
            row = page.locator('.sbd-rule-row').filter({ hasText: updated });
            await row.waitFor({ state: 'visible', timeout: 10000 });
            await row.locator('[title="删除规则"]').click();
            const confirm = page.locator('.sbd-modal').filter({ hasText: '删除规则' });
            await confirm.getByRole('button', { name: '删除', exact: true }).click();
            await page.waitForTimeout(500);
            assert.equal(await page.locator('.sbd-rule-row').count(), beforeCount);
            const previousJob = (await manager(page, ['job'])).job;
            await page.getByRole('button', { name: '保存', exact: true }).click();
            await waitToast(page, '规则已保存', 60000);
            const saved = await manager(page, ['status']);
            const savedJob = await waitForJobAction(page, 'save', previousJob && previousJob.id, 120000);
            assert.equal(savedJob.action, 'save');
            assert.equal(savedJob.phase, 'done');
            assert.ok(savedJob.backup, '保存任务未返回原始配置备份');
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
            assert.equal(summary.tests.every(item => item.ok), true, '前置破坏性测试失败，跳过备份删除');
            const before = (await manager(page, ['backups'])).backups;
            assert.ok(before.length <= 10, '备份数量超过上限');
            const candidate = before[0];
            assert.ok(candidate, '没有可用于删除测试的备份');
            await manager(page, ['backup-delete', candidate.name]);
            const after = (await manager(page, ['backups'])).backups;
            assert.equal(after.length, Math.max(0, before.length - 1));
            return { deleted: candidate.name, before: before.length, after: after.length };
        });

        if (KERNEL_FILE) {
            await runTest('kernel-upload-rollback', async () => {
                assert.ok(fs.existsSync(KERNEL_FILE), '内核文件不存在');
                await go(page, 'kernel');
                await page.waitForFunction(() => document.body.innerText.includes('arm64 / musl / 64-bit') || document.body.innerText.includes('x86_64 / musl'), null, { timeout: 60000 });
                await page.locator('input[type=file]').setInputFiles(KERNEL_FILE);
                await page.locator('.sbd-toast').filter({ hasText: '内核已更新' }).first().waitFor({ state: 'visible', timeout: 180000 });
                const first = page.locator('.sbd-backup-list .sbd-row').first();
                await first.getByRole('button', { name: '回滚', exact: true }).click();
                const dialog = page.locator('.sbd-modal').filter({ hasText: '回滚内核' });
                await dialog.getByRole('button', { name: '回滚', exact: true }).click();
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
