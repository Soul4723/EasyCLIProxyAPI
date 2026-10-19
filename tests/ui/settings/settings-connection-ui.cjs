// Settings → Connection: Local/Remote choice, draft test with mapped failures, save-to-activate, unsaved guard, portable export/import.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openApp, setPrivacy, invoke } = require('../../helpers/shell.cjs');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '../../..'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [], externalRequests = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await openApp(page, base, { path: '/settings/connection' });
    const active = page.getByTestId('connection-active');
    const footer = page.locator('a.ec-core-line');
    await active.getByText('Connected', { exact: true }).waitFor();
    assert.equal(await active.getAttribute('data-mode'), 'local');
    await page.getByRole('heading', { name: 'This computer' }).waitFor();
    assert.match(await page.locator('.ec-con').innerText(), /127\.0\.0\.1:8317/);

    // Local → Remote while the app-owned core still runs: save is blocked with a reason.
    await page.getByRole('radio', { name: 'Remote core' }).click();
    await page.locator('#con-mgmt-origin').fill('https://core.example.test');
    await page.locator('#con-mgmt-key').fill('fixture-management-key');
    // Save is disabled before Test/Save can reveal field errors, so the save bar must say why.
    await page.getByText('Cannot save yet: Enter a valid client API origin').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save & connect' }).isDisabled(), true);
    await page.locator('#con-client-origin').fill('https://core.example.test');
    await page.getByText('still running — stop it in Overview first').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save & connect' }).isDisabled(), true);
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('stop_core_process'));
    await page.getByText('still running — stop it in Overview first').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: 'Save & connect' }).isEnabled(), true);
    // Nav dot + count show the unsaved draft.
    await page.locator('[data-settings-tab=connection] [role=img]').waitFor();
    await page.getByText(/unsaved changes/).first().waitFor();

    // Export is disabled until saved; secrets toggle warns.
    assert.equal(await page.getByRole('button', { name: 'Export settings' }).isDisabled(), true);
    await page.getByRole('switch', { name: 'Include keys' }).click();
    await page.getByText('File will contain plain-text keys').waitFor();
    await page.getByRole('switch', { name: 'Include keys' }).click();

    // Validation.
    await page.locator('#con-client-origin').fill('https://core.example.test/v1');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.getByText('Enter an http(s) origin without path or credentials').first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save & connect' }).isDisabled(), true);
    await page.locator('#con-client-origin').fill('https://core.example.test');

    // Mapped failures; the active connection stays untouched by tests.
    const result = page.getByTestId('connection-test');
    const expectFailure = async (origin, key, kind, text) => {
      await page.locator('#con-mgmt-origin').fill(origin);
      await page.locator('#con-mgmt-key').fill(key);
      await page.getByRole('button', { name: 'Test connection' }).click();
      const alert = result.getByRole('alert');
      await alert.waitFor();
      assert.equal(await alert.getAttribute('data-failure'), kind);
      assert.match(await alert.innerText(), text);
    };
    await expectFailure('https://core.example.test', 'wrong', 'auth', /Management key rejected \(401\)/);
    await expectFailure('https://forbidden.example.test', 'x', 'forbidden', /allow-remote: true/);
    assert.equal(await page.getByTestId('connection-http-warning').count(), 0, 'https origins carry no cleartext warning');
    await expectFailure('http://legacy.example.test', 'x', 'legacy', /Not a v8 core/);
    await page.getByTestId('connection-http-warning').getByText(/sent unencrypted/).waitFor();
    await expectFailure('https://broken.example.test', 'x', 'http', /HTTP 500/);
    await expectFailure('https://offline.example.test', 'x', 'unreachable', /certificate may be untrusted/);
    await expectFailure('http://offline.example.test', 'x', 'unreachable', /Check the host, the port/);
    assert.equal(await active.getAttribute('data-mode'), 'local');

    // Success shows the core version; still not active until saved.
    await page.locator('#con-mgmt-origin').fill('https://core.example.test');
    await page.locator('#con-mgmt-key').fill('fixture-management-key');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await result.getByRole('status').filter({ hasText: 'Connected · core 8.0.29' }).waitFor();
    assert.equal(await active.getAttribute('data-mode'), 'local');

    // Unsaved guard: leaving the page asks first; cancel keeps the draft, discard leaves.
    await page.locator('[data-settings-tab=routing]').click();
    const guard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await guard.waitFor();
    await guard.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await page.locator('#con-mgmt-origin').inputValue(), 'https://core.example.test');

    // Save activates it. The app reloads itself onto the new target: no beforeunload prompt may appear and
    // the pre-save document must be replaced (a Stay choice would leave a fenced, unusable document).
    await page.locator('#con-mgmt-origin').fill('https://core.example.test');
    await page.locator('#con-mgmt-key').fill('fixture-management-key');
    const dialogs = [];
    page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    await page.evaluate(() => { window.__beforeSave = true; });
    await page.getByRole('button', { name: 'Save & connect' }).click();
    await page.waitForFunction(() => window.__beforeSave === undefined
      && document.querySelector('[data-testid=connection-active]')?.getAttribute('data-mode') === 'remote');
    assert.deepEqual(dialogs, [], 'saving a connection must not trigger a leave-site prompt');
    assert.match((await footer.innerText()), /core\.example\.test/);
    assert.equal(await invoke(page, 'get_management_target_revision'), 1, 'saving a target bumps the revision and the reloaded document owns it');
    assert.equal(await page.locator('[data-settings-tab=connection] [role=img]').count(), 0);

    // Privacy mode masks the target host.
    await setPrivacy(page, true);
    assert.ok(!(await active.innerText()).includes('core.example.test'), 'host must be masked');
    await setPrivacy(page, false);

    // Portable export (saved + clean) then import into the draft.
    await page.getByRole('button', { name: 'Export settings' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Export settings' }).isEnabled(), true);
    await page.getByRole('button', { name: 'Export settings' }).click();
    await page.getByText('Settings exported.').waitFor();
    await page.locator('#con-mgmt-origin').fill('https://other.example.test');
    await page.getByRole('button', { name: 'Import settings' }).click();
    await page.getByText('Loaded into the draft').waitFor();
    assert.equal(await page.locator('#con-mgmt-origin').inputValue(), 'https://core.example.test');
    assert.equal(await page.locator('#con-mgmt-key').inputValue(), '', 'secrets are not exported unless chosen');

    // Back to local.
    await page.getByRole('button', { name: 'Discard' }).click().catch(() => undefined);
    await page.getByRole('radio', { name: 'This computer' }).click();
    await page.getByRole('button', { name: 'Save & use this computer' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid=connection-active]')?.getAttribute('data-mode') === 'local');

    // Narrow width keeps the page inside the viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `horizontal overflow ${overflow}`);

    // A credential read started on an old target must never invoke the upload command.
    await page.evaluate(async () => {
      const { managementApi } = await import('/src/services/managementApi.ts');
      const originalInvoke = window.__TAURI_INTERNALS__.invoke;
      const uploads = [];
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'upload_auth_file') { uploads.push(args); return { ok: true }; }
        return originalInvoke(command, args);
      };
      try {
        let current = true;
        let finishRead;
        const file = new File(['{}'], 'target-race.json', { type: 'application/json' });
        file.arrayBuffer = () => new Promise(resolve => { finishRead = resolve; });
        const pending = managementApi.uploadAuthFile(file, () => current);
        while (!finishRead) await new Promise(resolve => setTimeout(resolve, 0));
        current = false;
        finishRead(new TextEncoder().encode('{}').buffer);
        let rejected = false;
        try { await pending; } catch { rejected = true; }
        if (!rejected || uploads.length) throw new Error('Stale file read invoked upload');
        await managementApi.uploadAuthFile(new File(['{}'], 'current.json'), () => true);
        if (typeof uploads[0]?.expectedRevision !== 'number') throw new Error('Missing native upload revision');
        if (uploads.length !== 1 || uploads[0].name !== 'current.json') throw new Error('Upload command contract changed');
      } finally { window.__TAURI_INTERNALS__.invoke = originalInvoke; }
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    console.log('PASS: Settings → Connection — local summary, blocked remote switch while the owned core runs, validation, mapped test failures (401/403/legacy/HTTP/unreachable+TLS hint), draft test never changes the active target, unsaved guard, save activates remote, privacy masks host, portable export/import without secrets, narrow layout, stale upload cancelled, no external requests.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
