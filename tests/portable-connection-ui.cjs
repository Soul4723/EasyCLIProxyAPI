const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser } = require('./ui-harness.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto(`${base}/?mock=stopped&mockDelay=5`);
    const open = async () => {
      await page.getByRole('button', { name: 'Core connection settings', exact: true }).click();
      return page.getByRole('dialog', { name: 'Core connection settings', exact: true });
    };
    let dialog = await open();
    await dialog.getByRole('button', { name: 'Import settings', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'invalid or corrupted' }).waitFor();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    dialog = await open();
    await dialog.getByLabel('Mode', { exact: true }).selectOption('remote');
    await dialog.getByLabel('Management origin', { exact: true }).fill('http://core.example:8317');
    await dialog.getByLabel('Management key', { exact: true }).fill('fixture-management-key');
    await dialog.getByLabel('Client API origin', { exact: true }).fill('http://client.example:8317');
    await dialog.getByLabel('Client API key', { exact: true }).fill('fixture-client-key');
    assert.equal(await dialog.getByRole('button', { name: 'Export settings', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await page.locator('.home-runtime-state').filter({ hasText: 'Connected' }).waitFor();
    dialog = await open();
    const secrets = dialog.getByRole('checkbox', { name: /Include API keys/ });
    assert.equal(await secrets.isChecked(), false);
    await dialog.getByLabel('Management origin', { exact: true }).fill('https://unsaved.example');
    assert.equal(await dialog.getByRole('button', { name: 'Export settings', exact: true }).isDisabled(), true);
    await dialog.getByLabel('Management origin', { exact: true }).fill('http://core.example:8317');
    await dialog.getByRole('button', { name: 'Export settings', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Settings exported.' }).waitFor();
    await dialog.getByRole('button', { name: 'Import settings', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Settings loaded.' }).waitFor();
    assert.equal(await dialog.getByLabel('Management key', { exact: true }).inputValue(), '');
    assert.equal(await dialog.getByLabel('Client API key', { exact: true }).inputValue(), '');
    assert.equal(await dialog.getByLabel('Client API origin', { exact: true }).inputValue(), 'http://client.example:8317');
    const saved = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_core_connection'));
    assert.equal(saved.managementKey, 'fixture-management-key');
    assert.equal(await dialog.getByRole('button', { name: 'Export settings', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    assert.equal(await dialog.getByLabel('Management key', { exact: true }).evaluate(el => el.validity.valueMissing), true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await page.locator('.home-runtime-state').innerText(), 'Connected');
    dialog = await open();
    assert.equal(await dialog.getByLabel('Management key', { exact: true }).inputValue(), '');
    await dialog.getByLabel('Management key', { exact: true }).fill('fixture-management-key');
    await dialog.getByLabel('Client API key', { exact: true }).fill('fixture-client-key');
    await dialog.getByRole('checkbox', { name: /Include API keys/ }).check();
    await dialog.getByRole('button', { name: 'Export settings', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Settings exported.' }).waitFor();
    await dialog.getByRole('button', { name: 'Import settings', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Settings loaded.' }).waitFor();
    assert.equal(await dialog.getByLabel('Management key', { exact: true }).inputValue(), 'fixture-management-key');
    assert.equal(await dialog.getByLabel('Client API key', { exact: true }).inputValue(), 'fixture-client-key');
    await page.setViewportSize({ width: 390, height: 844 });
    for (const name of ['Import settings', 'Export settings', 'Save connection']) {
      const button = dialog.getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      const bounds = await button.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, JSON.stringify(bounds));
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log('PASS: portable settings draft, secret exclusion/opt-in, failed import recovery, Back/Escape; no external requests.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
