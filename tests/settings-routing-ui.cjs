// UI test: Settings → Routing (strategy, session affinity, retries/cooldowns) against the browser mock.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openApp } = require('./helpers/shell.cjs');

(async () => {
  let server;
  let browser;
  const errors = [];
  try {
    const { createServer } = await import('vite');
    const react = (await import('@vitejs/plugin-react')).default;
    server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], optimizeDeps: { entries: ['index.html'] }, logLevel: 'error', server: { host: '127.0.0.1', port: 5361, strictPort: false } });
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
    browser = await chromium.launch({ args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.addInitScript(() => {
      window.__calls = [];
      const wrap = () => {
        const internals = window.__TAURI_INTERNALS__;
        if (!internals || internals.__wrapped) return false;
        const invoke = internals.invoke;
        internals.invoke = (command, args, options) => { window.__calls.push({ command, args }); return invoke(command, args, options); };
        internals.__wrapped = true;
        return true;
      };
      if (!wrap()) { const timer = setInterval(() => { if (wrap()) clearInterval(timer); }, 5); }
    });
    await openApp(page, base, { path: '/settings/routing' });
    const calls = () => page.evaluate(() => window.__calls);
    const savebar = page.getByRole('region', { name: 'Unsaved changes' });
    const navDot = page.locator('[data-settings-tab="routing"] .ec-set-nav-dot');

    // strategy: deep-link anchor, saves immediately, no save bar
    await page.locator('#routing-strategy').waitFor();
    const strategy = page.getByRole('radiogroup', { name: 'Routing Strategy' });
    assert.equal(await strategy.getByRole('radio', { name: 'Round Robin', exact: true }).getAttribute('aria-checked'), 'true');
    await strategy.getByRole('radio', { name: 'Fill First', exact: true }).click();
    await page.waitForFunction(() => window.__calls.some((c) => c.command === 'set_core_routing_strategy'));
    // Fenced commands carry the document's expectedRevision (documentTarget); only the strategy is under test.
    const { expectedRevision, ...strategyArgs } = (await calls()).find((c) => c.command === 'set_core_routing_strategy').args;
    assert.equal(typeof expectedRevision, 'number');
    assert.deepEqual(strategyArgs, { strategy: 'fill-first' });
    await page.waitForFunction(() => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent === 'Fill First');
    assert.equal(await savebar.count(), 0, 'strategy never opens the save bar');
    await strategy.getByRole('radio', { name: 'Weighted round robin' }).click();
    await page.waitForFunction(() => window.__calls.filter((c) => c.command === 'set_core_routing_strategy').length === 2);
    assert.equal((await calls()).filter((c) => c.command === 'set_core_routing_strategy').at(-1).args.strategy, 'weighted-round-robin');

    // session affinity + retry edits → dirty count, nav dot, discard
    const ttl = page.getByLabel('Session Affinity TTL');
    const retries = page.getByLabel('Request Retries', { exact: true });
    assert.equal(await ttl.inputValue(), '30m');
    await page.getByRole('switch', { name: 'Session Affinity', exact: true }).click();
    await ttl.fill('2h');
    await retries.fill('7');
    await savebar.waitFor();
    await savebar.getByText('3 unsaved changes').waitFor();
    await navDot.waitFor();
    await savebar.getByRole('button', { name: 'Discard' }).click();
    assert.equal(await ttl.inputValue(), '30m');
    assert.equal(await retries.inputValue(), '3');
    assert.equal(await savebar.count(), 0);

    // retry validation: empty value is rejected, nothing is sent
    await retries.fill('');
    await page.getByLabel('Maximum Retry Wait (seconds)').fill('-5');
    await savebar.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'non-negative integers' }).first().waitFor();
    assert.equal((await calls()).some((c) => c.command === 'save_retry_settings'), false);

    // valid save: session settings and retry settings go to their own commands; negative wait is allowed
    await retries.fill('7');
    await page.getByLabel('Maximum Credentials Tried').fill('2');
    await page.getByLabel('Streaming Bootstrap Retries').fill('1');
    await page.getByRole('switch', { name: 'Enable cooldowns' }).click();
    await page.getByRole('switch', { name: 'Session Affinity', exact: true }).click();
    await ttl.fill(' 2h ');
    await savebar.getByRole('button', { name: 'Save', exact: true }).click();
    await savebar.getByText('Saved', { exact: true }).waitFor();
    const all = await calls();
    assert.deepEqual(all.find((c) => c.command === 'save_session_routing_settings').args.settings, { routingSessionAffinity: false, routingSessionAffinityTtl: '2h' });
    assert.deepEqual(all.find((c) => c.command === 'save_retry_settings').args.settings, { disableCooling: true, requestRetry: 7, maxRetryCredentials: 2, maxRetryInterval: -5, streamingBootstrapRetries: 1 });
    assert.equal(await ttl.inputValue(), '2h');

    // values survive leaving and returning to the tab; the extended routing group is present
    await page.locator('[data-settings-tab="logs"]').click();
    await page.locator('[data-settings-tab="routing"]').click();
    assert.equal(await page.getByLabel('Request Retries', { exact: true }).inputValue(), '7');
    await page.getByRole('heading', { name: 'Session & cooldown behavior' }).waitFor();
    assert.deepEqual(errors, []);
    console.log('settings-routing-ui: ok');
  } finally {
    await browser?.close();
    await server?.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
