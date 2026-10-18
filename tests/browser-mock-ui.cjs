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
    await h.gotoPage(page, 'oauth');
    await h.setPrivacy(page, false);
    await page.getByRole('tab', { name: 'Authentication Files', exact: true }).click();
    await page.locator('.auth-file-card').first().waitFor();
    assert.equal(await page.locator('.auth-file-card').count(), 10);
    await page.locator('.auth-list-pagination select').selectOption('20');
    await page.waitForFunction(() => document.querySelectorAll('.auth-file-card').length > 10);
    await page.locator('.auth-files-heading-actions').getByRole('button', { name: 'Refresh quota', exact: true }).click();
    const card = name => page.locator('.auth-file-card').filter({ has: page.locator(`.auth-card-filename[title="${name}"]`) });
    for (const name of ['codex-personal.json', 'claude-team.json', 'kimi-personal.json', 'devin-team.json', 'xai-subscription.json', 'antigravity-team-with-a-long-account-name.json']) {
      await card(name).locator('[role="progressbar"]').first().waitFor();
    }
    assert.equal(await card('codex-disabled.json').getByRole('switch').getAttribute('aria-checked'), 'false');
    await card('codex-disabled.json').getByRole('switch').click();
    await page.waitForFunction(() => document.querySelector('.auth-card-filename[title="codex-disabled.json"]')?.closest('.auth-file-card')?.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true');
    const cooling = card('codex-exhausted.json');
    await cooling.getByRole('button', { name: 'Clear cooldown', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Clear cooldown', exact: true }).click();
    await cooling.locator('.auth-file-health-compact').waitFor({ state: 'hidden' });

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
    console.log('PASS: real app browser mock, six provider quotas, pagination, credential toggle and cooldown reset without external requests.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
