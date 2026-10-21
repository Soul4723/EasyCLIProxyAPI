// UI test: Settings → Access keys (client API keys + management secret) against the browser mock.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openApp, setPrivacy } = require('../../helpers/shell.cjs');

(async () => {
  let server;
  let browser;
  const errors = [];
  try {
    const { createServer } = await import('vite');
    const react = (await import('@vitejs/plugin-react')).default;
    server = await createServer({ configFile: false, root: path.resolve(__dirname, '../../..'), plugins: [react()], optimizeDeps: { entries: ['index.html'] }, logLevel: 'error', server: { host: '127.0.0.1', port: 5350, strictPort: false } });
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
    browser = await chromium.launch({ args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await openApp(page, base, { path: '/settings/access' });
    const rows = page.getByTestId('api-key-row');
    await rows.first().waitFor();
    assert.equal(await rows.count(), 2);
    assert.match(await rows.first().innerText(), /sk-browser-mock-2026/);

    // privacy masks the displayed key but not the copy value
    await setPrivacy(page, true);
    assert.doesNotMatch(await rows.first().innerText(), /sk-browser-mock-2026/, 'key masked under privacy');
    await setPrivacy(page, false);

    // add: validation then success
    const dialog = page.locator('[role=dialog], [role=alertdialog]');
    await page.getByRole('button', { name: 'Add Authentication Key' }).first().click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    assert.match(await dialog.getByRole('alert').innerText(), /cannot be empty/);
    await dialog.getByLabel('Authentication Key').fill('bad key');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    assert.match(await dialog.getByRole('alert').innerText(), /visible ASCII/);
    await dialog.getByLabel('Authentication Key').fill('sk-browser-mock-2026');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    assert.match(await dialog.getByRole('alert').innerText(), /already exists/);
    await dialog.getByRole('button', { name: 'Generate Key' }).click();
    const generated = await dialog.getByLabel('Authentication Key').inputValue();
    assert.match(generated, /^sk-[0-9a-f]{48}$/);
    await dialog.getByLabel('Remark').fill('x'.repeat(81).slice(0, 80) + 'y');
    // maxLength caps the input at 80, so the remark rule is enforced by the field itself
    assert.equal((await dialog.getByLabel('Remark').inputValue()).length, 80);
    await dialog.getByLabel('Remark').fill('CI key');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await rows.count(), 3);
    assert.match(await rows.last().innerText(), /CI key/);

    // edit remark
    await rows.last().getByRole('button', { name: /Edit authentication key 3/ }).click();
    await dialog.getByLabel('Remark').fill('CI key 2');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.match(await rows.last().innerText(), /CI key 2/);

    // delete with confirm; last-key warning only for the final key
    await rows.last().getByRole('button', { name: /Delete authentication key 3/ }).click();
    await dialog.waitFor();
    assert.equal(await dialog.getByText(/last key/).count(), 0);
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await rows.count(), 2);
    await rows.last().getByRole('button', { name: /Delete authentication key 2/ }).click();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await rows.last().getByRole('button', { name: /Delete authentication key 1/ }).click();
    await dialog.waitFor();
    assert.equal(await dialog.getByText(/last key/).count(), 1, 'warning on the last key');
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await rows.count(), 0);
    await page.getByText('No keys · all requests allowed').waitFor();

    // management secret: validation, generate, save, clear
    await page.getByRole('button', { name: 'Change key' }).click();
    await dialog.waitFor();
    await dialog.getByLabel('New management key').fill('abc');
    await dialog.getByLabel('Confirm new key').fill('abd');
    await dialog.getByRole('button', { name: 'Save key' }).click();
    assert.match(await dialog.getByRole('alert').innerText(), /do not match/);
    await dialog.getByRole('button', { name: 'Generate secure key' }).click();
    assert.match(await dialog.getByLabel('New management key').inputValue(), /^webui-[0-9a-f]{48}$/);
    await dialog.getByRole('button', { name: 'Save key' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByText('Configured', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Disable management' }).click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Disable management' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByText('Disabled', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Disable management' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Set key' }).waitFor();
    assert.ok(await page.locator('#config-group-management').count(), 'management template group stays reachable');
    assert.deepEqual(errors, []);
    console.log('settings-access-ui: ok');
  } finally {
    await browser?.close();
    await server?.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
