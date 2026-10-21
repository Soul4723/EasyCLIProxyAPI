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
    const page = await (await browser.newContext({ viewport: { width: 1505, height: 1000 } })).newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto(`${base}/?mock=stopped&mockPluginPages=2`);
    const nav = name => page.locator('.nav-section').getByRole('button', { name, exact: true });
    await nav('Advanced Features').click();
    await page.locator('#config-subpage-tab-software').click();
    const panel = page.locator('section[aria-labelledby="core-connection-title"]');
    await panel.getByLabel('Connection mode').selectOption('remote');
    await panel.getByLabel('Management origin').fill('https://core.example');
    await panel.getByLabel('Management password').fill('secret');
    await panel.getByRole('button', { name: 'Test connection', exact: true }).click();
    await panel.getByText(/Connection failed/).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('browser-mock.core-connection')), null, 'Test must not save');
    await panel.getByLabel('Management origin').fill('https://other.example');
    assert.equal(await panel.getByText(/Connection failed/).count(), 0, 'editing clears the stale result');

    await Promise.all([page.waitForEvent('load'), panel.getByRole('button', { name: 'Save', exact: true }).click()]);
    await page.locator('.app-shell').waitFor();
    assert.equal(JSON.parse(await page.evaluate(() => sessionStorage.getItem('browser-mock.core-connection'))).managementOrigin, 'https://other.example');
    await page.waitForFunction(() => document.querySelector('.sidebar-easy-entry')?.disabled);
    assert.equal(await page.locator('.sidebar-easy-entry').isDisabled(), true);
    for (const name of ['Agent Configuration', 'Usage', 'Version Management']) assert.equal(await nav(name).isDisabled(), true, `${name} unavailable remotely`);
    assert.equal(await page.locator('#nav-plugin-children').count(), 0, 'cached plugin pages are hidden remotely');
    await nav('Plugins').click();
    await page.getByRole('region', { name: 'Plugins' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Install local plugin' }).count(), 0, 'local plugin install is hidden remotely');
    await page.getByText(/unavailable in Remote mode/).first().waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: remote core panel Test never saves, failed results clear on edit, Save reloads into remote gating.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
