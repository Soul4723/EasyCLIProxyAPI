const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser } = require('./ui-harness.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./helpers/shell.cjs');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1505, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [], externalRequests = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto(`${base}/?mock=running&mockDelay=5`);
    await page.locator('.ec-app').waitFor();
    await h.gotoPage(page, '/providers/all');
    await h.setPrivacy(page, false);
    // Credentials live in Providers → All credentials: a paginated table with a switch and a row menu per file.
    const rows = page.locator('table tbody tr');
    await rows.first().waitFor();
    assert.equal(await rows.count(), 10);
    await page.locator('select').filter({ has: page.locator('option[value="20"]') }).selectOption('20');
    await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length > 10);
    const card = name => rows.filter({ hasText: name });
    for (const name of ['codex-personal', 'claude-team', 'kimi-personal', 'devin-team', 'xai-subscription', 'antigravity-team-with-a-long-account-name']) {
      await card(name).first().waitFor();
    }
    const toggle = card('codex-disabled').getByRole('switch');
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    await page.waitForFunction(() => [...document.querySelectorAll('table tbody tr')].find(row => row.textContent.includes('codex-disabled'))?.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true');
    await card('codex-exhausted').getByRole('button', { name: /^Actions/ }).click();
    await page.getByRole('dialog', { name: 'Actions' }).getByRole('button', { name: 'Clear cooldown', exact: true }).click();
    // Cooldown reset is a plain confirmation (only deletes are danger alertdialogs).
    const confirm = page.getByRole('dialog');
    await confirm.getByRole('button', { name: 'Clear cooldown', exact: true }).click();
    await confirm.waitFor({ state: 'detached' });

    // Each public mock scenario boots through the shell without live requests.
    for (const [mock, status] of [['running', 'running'], ['stopped', 'stopped'], ['empty', 'notInstalled'], ['error', 'stopped']]) {
      await h.openApp(page, base, { mock });
      if (mock === 'error') {
        await assert.rejects(() => h.invoke(page, 'get_core_status'), /Browser Mock error scenario/);
        await h.waitForCoreLine(page, status);
      } else await h.waitForCoreStatus(page);
      assert.equal(await h.coreLineKind(page), status, `${mock}: core state`);
      assert.equal(await page.locator('main#main').count(), 1, `${mock}: main landmark`);
      assert.equal(await page.locator('.ec-nav [data-nav="settings"]').count(), 1, `${mock}: settings remains available`);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    console.log('PASS: real app browser mock, provider credentials table, pagination, credential toggle and cooldown reset without external requests.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
