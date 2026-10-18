// Settings → Connection → Portable settings: failed-import recovery, export gating, secret exclusion/opt-in,
// import into the draft (review, then save), narrow layout. Core starts stopped so Remote can be saved.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser } = require('./ui-harness.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openApp, invoke } = require('./helpers/shell.cjs');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await openApp(page, base, { mock: 'stopped', path: '/settings/connection' });
    const button = name => page.getByRole('button', { name, exact: true });
    const field = id => page.locator(`#con-${id}`);
    const notice = text => page.getByRole('status').filter({ hasText: text });
    const active = page.getByTestId('connection-active');
    const portable = page.getByRole('switch', { name: 'Include keys' });
    await button('Import settings').waitFor();

    // Importing before anything was exported fails with a recoverable message.
    await button('Import settings').click();
    await page.getByText('invalid or corrupted').first().waitFor();

    // Remote draft: export stays disabled until the connection is saved.
    await page.getByRole('radio', { name: 'Remote core' }).click();
    await field('mgmt-origin').fill('http://core.example:8317');
    await field('mgmt-key').fill('fixture-management-key');
    await field('client-origin').fill('http://client.example:8317');
    await field('client-key').fill('fixture-client-key');
    assert.equal(await button('Export settings').isDisabled(), true);
    await button('Save & connect').click();
    await page.waitForFunction(() => document.querySelector('[data-testid=connection-active]')?.getAttribute('data-mode') === 'remote');
    await active.getByText('Connected', { exact: true }).waitFor();

    // Keys are excluded by default; an unsaved edit blocks export again.
    assert.equal(await portable.getAttribute('aria-checked'), 'false');
    await field('mgmt-origin').fill('https://unsaved.example');
    assert.equal(await button('Export settings').isDisabled(), true);
    await field('mgmt-origin').fill('http://core.example:8317');
    assert.equal(await button('Export settings').isEnabled(), true);
    await button('Export settings').click();
    await notice('Settings exported.').waitFor();

    // Import lands in the draft for review: no keys, the saved connection is untouched until Save.
    await button('Import settings').click();
    await notice('Loaded into the draft').waitFor();
    assert.equal(await field('mgmt-key').inputValue(), '');
    assert.equal(await field('client-key').inputValue(), '');
    assert.equal(await field('client-origin').inputValue(), 'http://client.example:8317');
    const saved = await invoke(page, 'get_core_connection');
    assert.equal(saved.managementKey, 'fixture-management-key');
    assert.equal(await button('Export settings').isDisabled(), true);
    assert.equal(await button('Save & connect').isDisabled(), true, 'a draft without the management key cannot be saved');
    await button('Discard').click();
    assert.equal(await field('mgmt-key').inputValue(), 'fixture-management-key');

    // Opting in exports the keys and the import restores them.
    await portable.click();
    await page.getByText('File will contain plain-text keys').waitFor();
    await button('Export settings').click();
    await notice('Settings exported.').waitFor();
    await field('mgmt-key').fill('changed');
    await field('client-key').fill('changed');
    await button('Import settings').click();
    await notice('Loaded into the draft').waitFor();
    assert.equal(await field('mgmt-key').inputValue(), 'fixture-management-key');
    assert.equal(await field('client-key').inputValue(), 'fixture-client-key');

    // Narrow width keeps the portable actions inside the viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const name of ['Import settings', 'Export settings']) {
      const target = button(name);
      await target.scrollIntoViewIfNeeded();
      const bounds = await target.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, JSON.stringify(bounds));
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log('PASS: portable settings draft, secret exclusion/opt-in, failed import recovery, save gating; no external requests.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
