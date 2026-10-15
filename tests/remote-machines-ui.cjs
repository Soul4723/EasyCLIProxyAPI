// Real React UI with mockIPC only. No SSH, real client files, or external HTTP.
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => { if (route.request().url().startsWith(base + '/')) return route.continue(); external.push(route.request().url()); return route.abort(); });
    page.setDefaultTimeout(15000);
    const button = name => page.getByRole('button', { name, exact: true });
    const selector = page.getByLabel('Client machine', { exact: true });
    const inspect = async () => { await button('Inspect remote configuration').click(); await page.getByText('Inspected and reachable', { exact: true }).waitFor(); };
    const apply = button('Apply on selected machine');
    const target = async model => {
      await page.getByLabel('Model ID', { exact: true }).fill(model);
      await page.getByLabel('Client API key', { exact: true }).fill('client-only');
    };
    await page.goto(base + '/tests/fixtures/remote-machines.html');
    await page.locator('.agent-workbench').waitFor();
    await selector.selectOption('alpha');
    await page.getByRole('heading', { name: 'Write target: Alpha Linux', exact: true }).waitFor();
    assert.equal(await page.locator('.agent-workbench').count(), 0);
    assert.equal(await apply.isDisabled(), true);
    await inspect();
    assert.equal(await page.locator('.machine-capabilities').evaluate(element => element.open), false);
    await page.getByText('Capabilities and paths', { exact: true }).press('Enter');
    await page.getByText('identity-alpha', { exact: true }).waitFor();
    await page.getByText('Capabilities and paths', { exact: true }).press('Enter');
    assert.equal(await page.getByRole('option', { name: 'Codex — Unsupported by remote prototype' }).evaluate(option => option.disabled), true);
    await target('first-model');
    await page.getByLabel('Client API key', { exact: true }).fill('management-only');
    assert.equal(await apply.isDisabled(), true);
    await page.getByLabel('Client API key', { exact: true }).fill('client-only');
    await page.getByLabel('Client API origin (from remote machine)', { exact: true }).fill('http://wrong.test');
    assert.equal(await apply.isDisabled(), true);
    await page.getByLabel('Client API origin (from remote machine)', { exact: true }).fill('http://core.test:8317');
    await apply.click();
    await page.getByText(/Remote configuration applied/).waitFor();
    assert.equal(await apply.isDisabled(), true);
    assert.equal(await page.getByLabel('Client API key', { exact: true }).inputValue(), '');
    await inspect();
    assert.equal(await page.getByLabel('Model ID', { exact: true }).inputValue(), 'first-model');

    // Invalid config blocks Apply/Clear, while backup and known-good restore stay available.
    await button('Create remote backup').click();
    await page.getByText('Remote backup created from current disk files.', { exact: true }).waitFor();
    await page.evaluate(() => { window.invalidConfig = true; });
    await inspect(); await target('must-not-write-invalid-config');
    await page.getByText(/Repair valid JSON on the remote machine outside this app/).waitFor();
    assert.equal(await apply.isDisabled(), true);
    assert.equal(await button('Clear remote integration').isDisabled(), true);
    assert.equal(await button('Create remote backup').isEnabled(), true);
    await button('Remote backups').click();
    await button('Preview restore').last().click();
    assert.equal(await button('Restore on selected machine').isEnabled(), true);
    await button('Restore on selected machine').click();
    await inspect();
    assert.equal(await button('Clear remote integration').isEnabled(), true);
    assert.equal(await page.getByLabel('Model ID', { exact: true }).inputValue(), 'first-model');

    // Disconnect after commit: never auto-retry. Inspect reconciles committed state.
    await page.evaluate(() => { window.failApply = true; });
    await target('committed-before-disconnect');
    await apply.click();
    await page.getByRole('alert').filter({ hasText: 'Disconnected after apply' }).waitFor();
    assert.equal(await apply.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.args?.operation?.kind === 'apply').length), 2);
    await page.evaluate(() => { window.failApply = false; window.offline = true; });
    await button('Inspect remote configuration').click();
    await page.getByRole('alert').filter({ hasText: 'host key verification failed' }).waitFor();
    await page.evaluate(() => { window.offline = false; });
    await inspect();
    assert.equal(await page.getByLabel('Model ID', { exact: true }).inputValue(), 'committed-before-disconnect');
    await button('Remote backups').click();
    await button('Preview restore').first().click();
    await button('Cancel').click();
    assert.equal(await button('Restore on selected machine').count(), 0);
    await button('Preview restore').first().click();
    await page.evaluate(() => { window.failRestore = true; });
    await button('Restore on selected machine').click();
    await page.getByRole('alert').filter({ hasText: 'Disconnected after restore' }).waitFor();
    assert.equal(await button('Restore on selected machine').count(), 0);
    await page.evaluate(() => { window.failRestore = false; });
    await inspect();
    assert.equal(await page.getByLabel('Model ID', { exact: true }).inputValue(), '');
    await button('Remote backups').click();
    await button('Preview restore').nth(1).click();
    await button('Restore on selected machine').click();
    await page.getByText(/Remote backup restored/).waitFor();
    await inspect();
    assert.equal(await page.getByLabel('Model ID', { exact: true }).inputValue(), 'first-model');

    // Client switch invalidates inspection and backup preview.
    await page.getByLabel('Remote client', { exact: true }).selectOption('opencode');
    assert.equal(await apply.isDisabled(), true);
    await inspect();
    assert.equal(await page.getByLabel('Model ID', { exact: true }).inputValue(), '');
    await page.evaluate(() => { window.identityChanged = true; });
    await button('Inspect remote configuration').click();
    await page.getByRole('alert').filter({ hasText: 'identity changed' }).waitFor();
    assert.equal(await apply.isDisabled(), true);
    await page.evaluate(() => { window.identityChanged = false; });

    // Old machine reads cannot repopulate the newly selected machine.
    await page.evaluate(() => { window.defer = 'inspect'; });
    await button('Inspect remote configuration').click();
    await page.waitForFunction(() => !!window.finish);
    await selector.selectOption('beta');
    await page.getByRole('heading', { name: 'Write target: Beta Linux', exact: true }).waitFor();
    await page.evaluate(() => { window.finish(); window.finish = null; });
    await inspect();
    assert.equal(await page.getByLabel('Model ID', { exact: true }).inputValue(), '');

    // Leaving long writes stays possible; old success must not enter destination view.
    await target('old-write');
    await page.evaluate(() => { window.defer = 'apply'; });
    await apply.click();
    await page.waitForFunction(() => !!window.finish);
    assert.equal(await button('Back to Local').isEnabled(), true);
    await selector.selectOption('alpha');
    await page.evaluate(() => { window.finish(); window.finish = null; });
    await inspect();
    assert.equal(await page.getByText(/Remote configuration applied/).count(), 0);
    assert.equal(await page.getByLabel('Model ID', { exact: true }).inputValue(), 'first-model');

    await button('Create remote backup').click();
    await page.getByText('Remote backup created from current disk files.', { exact: true }).waitFor();
    await button('Clear remote integration').click();
    await button('Cancel').click();
    assert.equal(await button('Confirm clear on selected machine').count(), 0);
    await button('Clear remote integration').click();
    await button('Confirm clear on selected machine').click();
    await page.getByText(/Remote integration cleared/).waitFor();
    assert.equal(await apply.isDisabled(), true);
    await inspect();
    assert.equal(await page.getByLabel('Model ID', { exact: true }).inputValue(), '');
    await button('Remote backups').click();
    await button('Preview restore').last().click();
    await button('Restore on selected machine').click();
    await inspect();
    assert.equal(await page.getByLabel('Model ID', { exact: true }).inputValue(), 'first-model');

    // Core change renews selection lease, drops old reads, clears client secret/inspection.
    await page.getByLabel('Client API key', { exact: true }).fill('client-only');
    await page.evaluate(() => { window.defer = 'inspect'; });
    await button('Inspect remote configuration').click();
    await page.waitForFunction(() => !!window.finish);
    await page.evaluate(() => window.changeCore());
    await page.waitForFunction(() => document.querySelector('input[type=url]')?.value === 'https://changed-core.test');
    await page.evaluate(() => { window.finish(); window.finish = null; });
    assert.equal(await apply.isDisabled(), true);
    assert.equal(await page.getByLabel('Client API key', { exact: true }).inputValue(), '');
    await inspect();
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.cmd === 'remote_machine_request').at(-1).args.coreRevision), 8);
    await page.evaluate(() => { window.conflictApply = true; });
    await page.getByLabel('Model ID', { exact: true }).fill('new-core-model');
    await page.getByLabel('Client API key', { exact: true }).fill('new-client-key');
    await apply.click();
    await page.getByText(/Remote operation reported conflicting files/).waitFor();
    assert.equal(await apply.isDisabled(), true);
    await page.evaluate(() => { window.conflictApply = false; });
    await inspect();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/phase4-remote-mobile.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.evaluate(() => { window.defer = 'select'; });
    await button('Back to Local').click();
    await page.waitForFunction(() => !!window.finish);
    assert.equal(await page.locator('.agent-workbench').count(), 0);
    assert.equal(await selector.isDisabled(), true);
    await page.evaluate(() => { window.finish(); window.finish = null; });
    await page.locator('.agent-workbench').waitFor();
    assert.equal(await selector.evaluate(element => element === document.activeElement), true);
    await selector.selectOption('add');
    await page.getByText(/Requires OpenSSH/).waitFor();
    await page.getByLabel('Machine name', { exact: true }).fill('Gamma Linux');
    await page.getByLabel('SSH destination (user@host or SSH config alias)', { exact: true }).fill('tester@gamma');
    assert.equal(await button('Enroll machine').isDisabled(), true);
    await button('Test and inspect').click();
    await page.getByText('identity-gamma', { exact: true }).waitFor();
    await page.getByLabel('SSH destination (user@host or SSH config alias)', { exact: true }).fill('tester@changed');
    assert.equal(await button('Enroll machine').isDisabled(), true);
    await button('Test and inspect').click();
    await button('Enroll machine').click();
    await page.getByRole('heading', { name: 'Write target: Gamma Linux', exact: true }).waitFor();
    await page.setViewportSize({ width: 1280, height: 900 });
    await inspect();
    await page.screenshot({ path: '/tmp/phase4-remote-desktop.png', fullPage: true });
    await button('Forget machine').click();
    await page.locator('.agent-workbench').waitFor();
    assert.equal(await selector.locator('option[value="new-machine"]').count(), 0);
    const writes = await page.evaluate(() => window.calls.filter(call => call.args?.operation?.kind === 'apply'));
    assert.ok(writes.every(call => call.args.operation.apiKey === (call.args.coreRevision === 7 ? 'client-only' : 'new-client-key')));
    assert.ok(writes.every(call => [7, 8].includes(call.args.coreRevision)));
    assert.equal(writes.at(-1).args.operation.origin, 'https://changed-core.test');
    await page.goto(base + '/tests/fixtures/remote-machines.html?local-core');
    await page.locator('.agent-workbench').waitFor();
    await selector.selectOption('alpha'); await inspect(); await target('blocked-local-core');
    await page.getByText(/Set a Remote core connection/).waitFor();
    assert.equal(await apply.isDisabled(), true);
    // Matching selected-core targets still reject literal loopback/unspecified origins.
    for (const origin of ['http://localhost:8317', 'http://localhost.:8317', 'http://localhost..:8317', 'http://api.localhost.', 'http://127.0.0.1:8317', 'http://127.42.1.9', 'http://127.1', 'http://0x7f000001', 'http://2130706433', 'http://0.0.0.0:8317', 'http://0', 'http://[::1]:8317', 'http://[0:0:0:0:0:0:0:1]', 'http://[::]:8317', 'http://[::ffff:127.0.0.1]', 'http://[::127.0.0.1]', 'http://[::ffff:0.0.0.0]']) {
      await page.goto(base + '/tests/fixtures/remote-machines.html?origin=' + encodeURIComponent(origin));
      await page.locator('.agent-workbench').waitFor(); await selector.selectOption('alpha'); await inspect(); await target('blocked-loopback');
      await page.getByText(/This prototype rejects localhost, literal loopback and unspecified addresses/).waitFor();
      assert.equal(await apply.isDisabled(), true, origin);
      assert.equal(await button('Clear remote integration').isEnabled(), true, 'Origin gate affects Apply only');
      assert.equal(await page.evaluate(() => window.calls.filter(call => call.args?.operation?.kind === 'apply').length), 0);
    }
    for (const origin of ['http://192.168.1.8:8317', 'http://localhost.example', 'http://100.64.0.2:8317', 'https://[fd00::2]:8317']) {
      await page.goto(base + '/tests/fixtures/remote-machines.html?origin=' + encodeURIComponent(origin));
      await page.locator('.agent-workbench').waitFor(); await selector.selectOption('alpha'); await inspect(); await target('network-target');
      assert.equal(await apply.isEnabled(), true, origin);
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log('PASS remote machine UI: enrollment prerequisites, capabilities, explicit client target, offline/apply/restore reconciliation, stale reads/writes, client/machine/core switching, manual backup, clear/recovery, Local return, narrow viewport, invalid config backup/restore recovery and loopback/unspecified origin guards; mock IPC only.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exit(1); });
