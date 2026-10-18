// UI test: Settings → Logs (core logging, usage statistics, open logs folder, local-only gating) against the browser mock.
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
    server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], optimizeDeps: { entries: ['index.html'] }, logLevel: 'error', server: { host: '127.0.0.1', port: 5362, strictPort: false } });
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
    await openApp(page, base, { path: '/settings/logs' });
    const calls = () => page.evaluate(() => window.__calls);
    const savebar = page.getByRole('region', { name: 'Unsaved changes' });
    const navDot = page.locator('[data-settings-tab="logs"] .ec-set-nav-dot');

    const maxSize = page.getByLabel('Maximum total log size (MB)');
    await maxSize.waitFor();
    assert.equal(await maxSize.inputValue(), '256');
    assert.equal(await savebar.count(), 0);

    // dirty count + discard
    await page.getByRole('switch', { name: 'Debug mode' }).click();
    await maxSize.fill('512');
    await savebar.getByText('2 unsaved changes').waitFor();
    await navDot.waitFor();
    await savebar.getByRole('button', { name: 'Discard' }).click();
    assert.equal(await maxSize.inputValue(), '256');
    assert.equal(await page.getByRole('switch', { name: 'Debug mode' }).getAttribute('aria-checked'), 'false');

    // validation: negative size and out-of-range retention are rejected, nothing is sent
    await maxSize.fill('-1');
    await savebar.getByRole('button', { name: 'Save', exact: true }).click();
    await savebar.getByText('non-negative integers').waitFor();
    await maxSize.fill('256');
    await page.getByLabel('Usage queue retention (seconds)').fill('4000');
    await savebar.getByRole('button', { name: 'Save', exact: true }).click();
    await savebar.getByText('between 1 and 3600').waitFor();
    assert.equal((await calls()).some((c) => c.command === 'save_core_logging_settings'), false);

    // valid save, with commercial mode → local core restart
    await page.getByLabel('Usage queue retention (seconds)').fill('120');
    await page.getByRole('switch', { name: 'Debug mode' }).click();
    await page.getByRole('switch', { name: 'Commercial mode' }).click();
    await page.getByRole('switch', { name: 'Usage statistics' }).click();
    await page.getByText('Saving restarts the local core').waitFor();
    await savebar.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved · core restarted').waitFor();
    const all = await calls();
    assert.deepEqual(all.find((c) => c.command === 'save_core_logging_settings').args.settings, {
      debug: true, commercialMode: true, loggingToFile: true, logsMaxTotalSizeMb: 256, errorLogsMaxFiles: 10, usageStatisticsEnabled: false, redisUsageQueueRetentionSeconds: 120,
    });
    assert.equal(all.some((c) => c.command === 'restart_core_process'), true);

    // request logging lives in the diagnostics group of the same tab
    await page.getByRole('checkbox', { name: 'Log requests and responses' }).waitFor();

    // open logs folder (local)
    await page.getByRole('button', { name: 'Open Log Folder' }).last().click();
    await page.waitForFunction(() => window.__calls.some((c) => c.command === 'open_core_logs_directory'));

    // remote: folder button disabled with a reason; commercial mode no longer promises a local restart
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      await invoke('stop_core_process', {});
      await invoke('save_core_connection', { connection: { mode: 'remote', managementOrigin: 'https://core.example.test', managementKey: 'fixture-management-key', clientOrigin: 'https://core.example.test', clientKey: 'fixture-client-key' } });
    });
    await openApp(page, base, { path: '/settings/logs' });
    const folder = page.getByRole('button', { name: 'Open Log Folder' }).last();
    await folder.waitFor();
    assert.equal(await folder.isDisabled(), true);
    assert.match(await folder.getAttribute('title'), /remote host/);
    await page.getByText("Logs live on the remote host and can't be opened here").waitFor();
    assert.deepEqual(errors, []);
    console.log('settings-logs-ui: ok');
  } finally {
    await browser?.close();
    await server?.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
