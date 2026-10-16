const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true, args: ['--no-proxy-server'] });
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
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 30000 });
    await page.locator('.app-shell').waitFor();
    await page.getByRole('button', { name: 'Core connection settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Core connection settings', exact: true });
    await dialog.getByLabel('Mode', { exact: true }).selectOption('remote');
    await dialog.getByLabel('Management origin', { exact: true }).fill('http://core.example.test:8317');
    await dialog.getByLabel('Management key', { exact: true }).fill('fixture-management-key');
    await dialog.getByLabel('Client API origin', { exact: true }).fill('http://client.example.test:8317');
    await dialog.getByLabel('Client API key', { exact: true }).fill('fixture-client-key');
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
    // Testing a draft must not switch the active runtime.
    assert.equal(await page.locator('[data-runtime="installation"]').count(), 1);
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Stop the GUI-managed local core' }).waitFor();
    assert.equal(await page.locator('[data-runtime="installation"]').count(), 1);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByRole('button', { name: 'Core connection settings', exact: true }).click();
    assert.equal(await dialog.getByLabel('Management origin', { exact: true }).inputValue(), 'http://core.example.test:8317');
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('http://core.example.test:8317', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-runtime="installation"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: /^start$/i }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Restart', exact: true }).count(), 0);
    await page.getByText('http://client.example.test:8317/v1', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^Version Management/ }).click();
    assert.equal(await page.getByRole('button', { name: 'Install Latest', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Install Bundled Core', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    // Failed draft authentication leaves the active successful connection alone.
    await page.getByRole('button', { name: 'Core connection settings', exact: true }).click();
    const retry = page.getByRole('dialog', { name: 'Core connection settings', exact: true });
    await retry.getByLabel('Management key', { exact: true }).fill('wrong-fixture-key');
    await retry.getByRole('button', { name: 'Test connection', exact: true }).click();
    await retry.getByRole('status').filter({ hasText: 'Connection failed' }).waitFor();
    assert.equal(await page.locator('.home-runtime-state').innerText(), 'Connected');
    await retry.getByRole('button', { name: 'Save connection', exact: true }).click();
    await retry.waitFor({ state: 'hidden' });
    await page.locator('.home-runtime-state').filter({ hasText: 'Disconnected' }).waitFor();
    await page.getByRole('button', { name: 'Core connection settings', exact: true }).click();
    await retry.getByLabel('Management key', { exact: true }).fill('fixture-management-key');
    await retry.getByRole('button', { name: 'Test connection', exact: true }).click();
    await retry.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
    assert.equal(await page.locator('.home-runtime-state').innerText(), 'Disconnected');
    await retry.getByRole('button', { name: 'Save connection', exact: true }).click();
    await retry.waitFor({ state: 'hidden' });
    await page.locator('.home-runtime-state').filter({ hasText: 'Connected' }).waitFor();
    // Returning to local preserves its process state and restores its controls.
    await page.getByRole('button', { name: 'Core connection settings', exact: true }).click();
    await retry.getByLabel('Mode', { exact: true }).selectOption('local');
    await retry.getByRole('button', { name: 'Save connection', exact: true }).click();
    await retry.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: /^start$/i }).waitFor();
    assert.equal(await page.locator('[data-runtime="installation"]').count(), 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    console.log('PASS: draft test leaves local target unchanged; saving remote hides local lifecycle and shows distinct client endpoint, with auth failure, recovery and return to local; no external requests.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
