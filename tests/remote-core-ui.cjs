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
    const savedConnection = async () => JSON.parse(await page.evaluate(() => sessionStorage.getItem('browser-mock.core-connection')));
    const openDialog = async () => {
      await page.getByRole('button', { name: 'Core connection settings', exact: true }).click();
      return page.getByRole('dialog', { name: 'Core connection' });
    };

    // Home: the gear beside Refresh opens the dialog; Escape discards the draft.
    let dialog = await openDialog();
    assert.equal(await dialog.getByRole('radio', { name: 'Local core' }).getAttribute('aria-checked'), 'true');
    assert.equal(await dialog.getByRole('button', { name: 'Use local core' }).isDisabled(), true, 'unchanged Local cannot be saved');
    await dialog.getByRole('radio', { name: 'Remote core' }).click();
    const save = dialog.getByRole('button', { name: 'Save & connect', exact: true });
    const testButton = dialog.getByRole('button', { name: 'Test connection', exact: true });
    assert.equal(await save.isDisabled(), true, 'an empty Remote draft cannot be saved');
    await dialog.getByLabel('Management URL').fill('core.example/v8');
    await dialog.getByLabel('Management key', { exact: true }).fill('secret');
    await dialog.getByText(/Enter only the scheme, host and port/).waitFor();
    assert.equal(await save.isDisabled(), true, 'an invalid URL cannot be saved');
    assert.equal(await testButton.isDisabled(), true, 'an invalid URL cannot be tested');
    await dialog.getByLabel('Management URL').fill('http://10.0.0.5:8317');
    await dialog.getByText(/HTTP is unencrypted/).waitFor();
    await dialog.getByRole('button', { name: 'Show key' }).click();
    assert.equal(await dialog.getByLabel('Management key', { exact: true }).getAttribute('type'), 'text', 'the key can be revealed');
    await testButton.click();
    await dialog.getByText('Connection failed').waitFor();
    await dialog.getByText('Browser Mock: no remote core').waitFor();
    assert.equal(await savedConnection(), null, 'Test must not save');
    await dialog.getByLabel('Management URL').fill('http://10.0.0.6:8317');
    assert.equal(await dialog.getByText('Connection failed').count(), 0, 'editing clears the stale result');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    dialog = await openDialog();
    assert.equal(await dialog.getByRole('radio', { name: 'Local core' }).getAttribute('aria-checked'), 'true', 'Escape discarded the draft');
    assert.equal(await dialog.getByLabel('Management URL').count(), 0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();

    // Advanced Features hosts the same component and reads the same saved state.
    await nav('Advanced Features').click();
    await page.locator('#config-subpage-tab-software').click();
    const card = page.locator('#config-core-connection');
    await card.waitFor({ state: 'visible' });
    assert.equal(await card.getByRole('radio', { name: 'Local core' }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#config-native-software').getByText('Silent Launch').count() > 0, true, 'Silent Launch shown locally');

    // Saving from the Home dialog reloads into Remote mode.
    await nav('Home').click();
    dialog = await openDialog();
    await dialog.getByRole('radio', { name: 'Remote core' }).click();
    await dialog.getByLabel('Management URL').fill('https://other.example');
    await dialog.getByLabel('Management key', { exact: true }).fill('secret');
    await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Save & connect', exact: true }).click()]);
    await page.locator('.app-shell').waitFor();
    assert.equal((await savedConnection()).managementOrigin, 'https://other.example');

    const runtime = page.locator('.control-panel');
    await runtime.getByText('Connected', { exact: true }).waitFor();
    await runtime.getByText('https://other.example').waitFor();
    for (const name of ['Start', 'Stop', 'Restart']) assert.equal(await runtime.getByRole('button', { name, exact: true }).count(), 0, `${name} hidden remotely`);
    for (const label of ['Installation Status', 'Process PID', 'Listening port']) assert.equal(await runtime.getByText(label).count(), 0, `${label} hidden remotely`);
    await runtime.getByRole('button', { name: 'Change connection' }).click();
    dialog = page.getByRole('dialog', { name: 'Core connection' });
    assert.equal(await dialog.getByRole('radio', { name: 'Remote core' }).getAttribute('aria-checked'), 'true');
    assert.equal(await dialog.getByLabel('Management URL').inputValue(), 'https://other.example');
    assert.equal(await dialog.getByRole('button', { name: 'Save & connect', exact: true }).isDisabled(), true, 'unchanged Remote cannot be saved');
    await page.keyboard.press('Escape');

    await page.waitForFunction(() => document.querySelector('.sidebar-easy-entry')?.disabled);
    for (const name of ['Agent Configuration', 'Usage', 'Version Management']) {
      assert.equal(await nav(name).isDisabled(), true, `${name} unavailable remotely`);
      assert.equal(await nav(name).getAttribute('title'), 'Not available in Remote mode');
    }
    assert.equal(await page.locator('#nav-plugin-children').count(), 0, 'cached plugin pages are hidden remotely');

    await nav('Advanced Features').click();
    const software = page.locator('#config-native-software');
    await software.waitFor({ state: 'visible' });
    await page.getByText(/Connected to a remote core\. Its settings are stored on that machine/).waitFor();
    assert.equal(await page.locator('#config-subpage-tab-software').getAttribute('aria-selected'), 'true');
    for (const id of ['general', 'aliases', 'routing', 'requests', 'oauth', 'diagnostics']) assert.equal(await page.locator(`#config-subpage-tab-${id}`).isDisabled(), true, `${id} category disabled remotely`);
    for (const label of ['Close behavior', 'Default terminal']) assert.equal(await software.getByLabel(label).count() > 0, true, `${label} shown remotely`);
    for (const text of ['Start Core on Launch', 'Silent Launch']) assert.equal(await software.getByText(text).count(), 0, `${text} hidden remotely`);
    assert.equal(await card.getByLabel('Management URL').inputValue(), 'https://other.example', 'both hosts show the saved connection');
    for (const id of ['keys', 'management', 'network', 'tls', 'routing', 'retry', 'logging']) assert.equal(await page.locator(`#config-native-${id}`).isVisible(), false, `${id} hidden remotely`);
    assert.equal(await page.locator('#config-template-panel').isVisible(), false, 'template editor hidden remotely');
    await page.getByRole('searchbox').fill('retry');
    await page.locator('.config-search-empty').waitFor();
    await page.getByRole('searchbox').fill('connection');
    await page.locator('.config-search-result-list').getByText('Core connection').waitFor();
    await page.getByRole('searchbox').fill('');

    await nav('Plugins').click();
    await page.getByRole('region', { name: 'Plugins' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Install local plugin' }).count(), 0, 'local plugin install is hidden remotely');
    await page.getByText(/unavailable in Remote mode/).first().waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: Home dialog and Advanced Features share one connection, Test never saves, Escape discards, Save reloads into Remote with Silent Launch hidden.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
