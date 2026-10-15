const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
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
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
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
      await page.getByRole('button', { name: 'Core connection', exact: true }).click();
      return page.getByRole('dialog', { name: 'Core connection', exact: true });
    };
    let dialog = await open();
    await dialog.getByRole('button', { name: 'Import settings', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'invalid or corrupted' }).waitFor();
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    dialog = await open();
    await dialog.getByRole('radio', { name: 'Remote', exact: true }).check();
    await dialog.getByLabel('Remote server origin', { exact: true }).fill('http://core.example:8317');
    await dialog.getByLabel('Management key', { exact: true }).fill('mock-management');
    await dialog.getByLabel('Client API origin', { exact: true }).fill('http://client.example:8317');
    await dialog.getByLabel('Client API key', { exact: true }).fill('mock-client');
    assert.equal(await dialog.getByRole('button', { name: 'Export settings', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Authenticated and reachable', { exact: true }).waitFor();
    dialog = await open();
    const secrets = dialog.getByRole('checkbox', { name: /Include API keys/ });
    assert.equal(await secrets.isChecked(), false);
    await dialog.getByRole('button', { name: 'Export settings', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Settings exported.' }).waitFor();
    await dialog.getByRole('button', { name: 'Import settings', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Settings loaded.' }).waitFor();
    assert.equal(await dialog.getByLabel('Management key', { exact: true }).inputValue(), '');
    assert.equal(await dialog.getByLabel('Client API key', { exact: true }).inputValue(), '');
    assert.equal(await dialog.getByLabel('Client API origin', { exact: true }).inputValue(), 'http://client.example:8317');
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    dialog = await open();
    assert.equal(await dialog.getByLabel('Management key', { exact: true }).inputValue(), 'mock-management');
    await dialog.getByRole('checkbox', { name: /Include API keys/ }).check();
    await dialog.getByRole('button', { name: 'Export settings', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Settings exported.' }).waitFor();
    await dialog.getByRole('button', { name: 'Import settings', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Settings loaded.' }).waitFor();
    assert.equal(await dialog.getByLabel('Management key', { exact: true }).inputValue(), 'mock-management');
    assert.equal(await dialog.getByLabel('Client API key', { exact: true }).inputValue(), 'mock-client');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log('PASS: portable settings draft, secret exclusion/opt-in, failed import recovery, Back/Escape; no external requests.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
