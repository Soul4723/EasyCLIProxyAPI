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
    await dialog.getByRole('button', { name: 'Show key' }).first().click();
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

    // This computer as a remote host: opt-in, off by default, validated address, key generated on save.
    const host = page.locator('#config-host-control');
    await host.waitFor({ state: 'visible' });
    const allow = host.getByRole('switch', { name: 'Allow remote control' });
    assert.equal(await allow.isChecked(), false, 'remote control is off by default');
    await host.getByText('Remote control is off.').waitFor();
    const hostSave = host.getByRole('button', { name: 'Save', exact: true });
    assert.equal(await hostSave.isDisabled(), true, 'unchanged settings cannot be saved');
    const listen = host.getByLabel('Listen address');
    assert.equal(await listen.inputValue(), '', 'no address is saved by default');
    assert.equal(await listen.getAttribute('placeholder'), '0.0.0.0:8417', 'the default follows the core port + 100, apart from every channel core port');
    await host.getByText(/Leave empty for the default, 0\.0\.0\.0:8417/).waitFor();
    await listen.fill('localhost:8417');
    await host.getByText(/Enter an IP address and a port/).waitFor();
    assert.equal(await hostSave.isDisabled(), true, 'a host name is not a listen address');
    await listen.fill('0.0.0.0:8317');
    assert.equal(await hostSave.isDisabled(), true, 'the core port cannot be reused');
    await listen.fill('100.64.0.1:8417');
    await allow.click();
    await host.getByText(/Anyone who can reach this address with the key/).waitFor();
    assert.equal(await host.getByRole('button', { name: 'Generate new key' }).isDisabled(), true, 'unsaved changes come first');
    await hostSave.click();
    await host.getByText('Listening on 100.64.0.1:8417').waitFor();
    const hostKey = host.getByLabel('Host control key');
    const firstKey = await hostKey.inputValue();
    assert.match(firstKey, /^ehc_/, 'saving with remote control allowed generates a key');
    assert.equal(await hostKey.getAttribute('type'), 'password', 'the key is masked');
    await host.getByRole('button', { name: 'Generate new key' }).click();
    await host.getByText(/New key generated/).waitFor();
    assert.notEqual(await hostKey.inputValue(), firstKey, 'the key can be replaced');

    // Saving from the Home dialog reloads into Remote mode.
    await nav('Home').click();
    dialog = await openDialog();
    await dialog.getByRole('radio', { name: 'Remote core' }).click();
    await dialog.getByLabel('Management URL').fill('https://other.example');
    await dialog.getByLabel('Management key', { exact: true }).fill('secret');
    await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Save & connect', exact: true }).click()]);
    await page.locator('.app-shell').waitFor();
    assert.equal((await savedConnection()).managementOrigin, 'https://other.example');

    // Remote Home keeps Local's layout: overview, Model Health, the same Runtime Control grid and Connect to CPA.
    await page.locator('[data-stat="credentials"] .home-stat-value').filter({ hasText: /^\d+$/ }).waitFor();
    assert.equal(await page.locator('[data-stat="usage"] .home-stat-value').textContent(), '—', 'local usage is never shown as the remote core\'s');
    assert.equal(await page.getByRole('button', { name: 'Model Health' }).isEnabled(), true);
    const runtime = page.locator('.control-panel');
    await runtime.getByText('Connected', { exact: true }).waitFor();
    await runtime.getByText('other.example', { exact: true }).waitFor();
    assert.equal(await runtime.locator('.panel-detail-row').count(), 6, 'same grid as Local');
    // Which machine: the core's host in the sidebar and on the core cards; no app version on a remote core's card.
    assert.equal(await page.locator('.sidebar-brand .scope-label').textContent(), 'Core · other.example');
    assert.equal(await runtime.locator('.scope-label').textContent(), 'Core · other.example');
    assert.equal(await runtime.getByText('App Version').count(), 0, 'this app\'s version is not shown as the core\'s');
    await runtime.locator('[data-runtime="host-control"]').getByText('Not set up').waitFor();
    assert.equal(await runtime.getByText('443', { exact: true }).count(), 1, 'port comes from the remote origin');
    for (const name of ['Stop', 'Restart']) {
      const button = runtime.getByRole('button', { name, exact: true });
      assert.equal(await button.isDisabled(), true, `${name} shown but disabled without remote host control`);
      assert.equal(await button.getAttribute('title'), 'Set up remote host control in Core connection to start, stop or restart this core');
    }
    await page.locator('.home-access-panel').getByText('https://other.example/v1').waitFor();
    await page.getByRole('button', { name: 'Core connection settings', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Core connection' });
    assert.equal(await dialog.getByRole('radio', { name: 'Remote core' }).getAttribute('aria-checked'), 'true');
    assert.equal(await dialog.getByLabel('Management URL').inputValue(), 'https://other.example');
    assert.equal(await dialog.getByRole('button', { name: 'Save & connect', exact: true }).isDisabled(), true, 'unchanged Remote cannot be saved');
    await page.keyboard.press('Escape');

    await page.waitForFunction(() => document.querySelector('.sidebar-easy-entry')?.disabled === false);
    assert.equal(await nav('Agent Configuration').isEnabled(), true, 'local agent clients available against the remote core');
    assert.equal(await nav('Usage').isDisabled(), true, 'Usage locked without remote host control');
    assert.equal(await nav('Usage').getAttribute('title'), 'Set up reachable remote host control in Core connection to read usage recorded on the core’s computer.');
    await page.locator('#nav-plugin-children').waitFor();

    // Version Management stays open for this app's own updates; only the core's versions need host control.
    await page.locator('.nav-section').getByRole('button', { name: /^Version Management/ }).click();
    const coreCard = page.locator('.core-module-card');
    const coreVersionsReason = 'Set up remote host control in Core connection to check and install versions of this core.';
    await coreCard.getByText(coreVersionsReason).waitFor();
    assert.equal(await coreCard.getByRole('button', { name: 'Check for Updates' }).isDisabled(), true);
    assert.equal(await coreCard.getByRole('button', { name: 'Check for Updates' }).getAttribute('title'), coreVersionsReason);
    assert.equal(await page.getByRole('button', { name: 'Install Bundled Core' }).count(), 0, 'the bundled core is for this computer only');
    assert.equal(await page.locator('.app-module-card').getByRole('button', { name: 'Check for Updates' }).isEnabled(), true, 'this app checks its own updates');
    assert.equal(await page.locator('.app-module-card .scope-label').textContent(), 'This computer · mock-desktop');

    // Agents and Codex sessions belong to this computer, even with a remote core.
    await page.evaluate(() => localStorage.setItem('cpa-gui.agent-selected-client.v1', 'codex'));
    await nav('Agent Configuration').click();
    assert.deepEqual(await page.locator('.agent-target-route .scope-label').allTextContents(), ['This computer · mock-desktop', 'Core · other.example'],
      'agents configure this computer\'s clients against the remote core');
    await page.locator('#agent-subpage-tab-sessions').click();
    await page.locator('#agent-subpage-panel-sessions').waitFor({ state: 'visible' });
    await page.locator('.sidebar-easy-entry').click();
    await page.locator('.simple-mode-topbar').waitFor({ state: 'visible' });
    await page.locator('.simple-mode-exit-btn').click();

    // Advanced Features keeps every category and search and edits the remote core's settings, except
    // those that decide how this app reaches it (address, port, TLS, management key).
    await nav('Advanced Features').click();
    await page.locator('.config-remote-notice').getByText(/Saved on this core\./).waitFor();
    assert.equal(await page.locator('.config-remote-notice .scope-label').textContent(), 'Core · other.example');
    for (const id of ['general', 'aliases', 'routing', 'requests', 'oauth', 'diagnostics', 'software']) assert.equal(await page.locator(`#config-subpage-tab-${id}`).isEnabled(), true, `${id} category available remotely`);
    const keys = page.locator('#config-native-keys');
    await keys.getByRole('button', { name: /Copy/ }).first().waitFor();
    assert.equal(await keys.getByRole('button', { name: 'Add Authentication Key' }).isEnabled(), true, 'remote keys can be added');
    assert.equal(await keys.getByRole('button', { name: /Copy/ }).first().isEnabled(), true, 'remote keys can be copied');
    const connectionHint = "This decides how this app reaches the remote core. Change it on the core's computer, then update Core connection.";
    const port = page.locator('#config-input-config-network-port');
    assert.equal(await port.isDisabled(), true, 'the remote core\'s port is changed on its computer');
    assert.equal(await port.getAttribute('title'), connectionHint);
    assert.equal(await page.locator('#config-network-proxy-url').isEnabled(), true, 'the remote core\'s proxy can be edited');
    assert.equal(await page.locator('#config-native-tls').getByRole('switch', { name: 'Enable TLS' }).isDisabled(), true, 'TLS decides the connection');
    await page.locator('#config-native-management').getByText(connectionHint).waitFor();
    await page.getByRole('searchbox').fill('retry');
    await page.locator('.config-search-result-list').waitFor();
    await page.getByRole('searchbox').fill('');
    await page.locator('#config-subpage-tab-software').click();
    const software = page.locator('#config-native-software');
    await software.waitFor({ state: 'visible' });
    // App preferences are this computer's: no remote-core banner, and no local core to start or keep in the tray.
    assert.equal(await page.locator('.config-remote-notice').count(), 0, 'the remote-core banner is not over this computer\'s settings');
    assert.equal(await software.locator('.scope-label').textContent(), 'This computer · mock-desktop');
    assert.equal(await software.getByText('Start Core on Launch').count(), 0, 'this computer\'s Start Core on Launch is for Local mode');
    assert.equal(await software.getByText('Silent Launch').count(), 0, 'Silent Launch hidden remotely');
    assert.equal(await card.getByLabel('Management URL').inputValue(), 'https://other.example', 'both hosts show the saved connection');
    // The host app's own setting has its own card, disabled until remote host control is set up.
    const hostApp = page.locator('#config-remote-host');
    assert.equal(await hostApp.locator('.scope-label').textContent(), 'App on other.example');
    assert.equal(await hostApp.getByRole('switch', { name: 'Start Core on Launch' }).isDisabled(), true);
    await hostApp.getByText('Needs remote host control, set up in Core connection.').waitFor();
    const remoteHost = page.locator('#config-host-control');
    await remoteHost.getByText(/^Off while this app uses a remote core\./).waitFor();
    assert.equal(await remoteHost.getByRole('switch', { name: 'Allow remote control' }).count(), 0, 'no hosting form while Remote');

    await nav('Plugins').click();
    await page.getByRole('region', { name: 'Plugins' }).waitFor();
    const install = page.getByRole('button', { name: 'Install local plugin' });
    assert.equal(await install.isDisabled(), true, 'local plugin install shown but disabled remotely');
    assert.equal(await install.getAttribute('title'), "The plugin file is on this computer. Install it on the core's computer, or from the store.");

    // Remote host control: optional URL and key, validated, tested next to the management API, then saved.
    await nav('Home').click();
    dialog = await openDialog();
    const hostUrl = dialog.getByLabel('Host control URL');
    const hostKeyField = dialog.getByLabel('Host control key', { exact: true });
    const saveRemote = dialog.getByRole('button', { name: 'Save & connect', exact: true });
    await hostUrl.fill('http://other.example:8417');
    await dialog.getByText('Enter both the host control URL and key, or leave both empty.').waitFor();
    assert.equal(await saveRemote.isDisabled(), true, 'host control needs both URL and key');
    await hostKeyField.fill('secret');
    await dialog.getByText(/not the management key/).waitFor();
    assert.equal(await saveRemote.isDisabled(), true, 'the management key is not a host control key');
    await hostKeyField.fill('ehc_test-host-control-key-0123456789abcdef');
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
    await dialog.getByText('Remote host control available').waitFor();
    await dialog.getByText('The core is running on the remote host.').waitFor();
    await Promise.all([page.waitForEvent('load'), saveRemote.click()]);
    await page.locator('.app-shell').waitFor();
    assert.equal((await savedConnection()).hostControlOrigin, 'http://other.example:8417');

    // Home's Start/Stop/Restart now go to the remote host's EasyCLIProxyAPI.
    const controlled = page.locator('.control-panel');
    await controlled.getByText('52817', { exact: true }).waitFor();
    const stop = controlled.getByRole('button', { name: 'Stop', exact: true });
    assert.equal(await stop.isEnabled(), true, 'Stop is available through remote host control');
    assert.equal(await stop.getAttribute('title'), null);
    await stop.click();
    await controlled.getByText('Stopped on remote host', { exact: true }).waitFor();
    assert.equal(await controlled.getByRole('button', { name: 'Restart', exact: true }).isDisabled(), true, 'a stopped core cannot be restarted');
    await controlled.getByRole('button', { name: /^start$/i }).click();
    await controlled.getByText('Connected', { exact: true }).waitFor();
    await controlled.getByRole('button', { name: 'Restart', exact: true }).click();
    await controlled.getByText('52819', { exact: true }).waitFor();

    await controlled.locator('[data-runtime="host-control"]').getByText('Available').waitFor();

    // Start Core on Launch is the remote host's own setting, changed at once in the host app's card.
    await nav('Advanced Features').click();
    await page.locator('#config-subpage-tab-software').click();
    const remoteLaunch = page.locator('#config-remote-host').getByRole('switch', { name: 'Start Core on Launch' });
    await page.waitForFunction(() => !document.querySelector('#config-remote-host [role="switch"][aria-label="Start Core on Launch"]')?.disabled);
    assert.equal(await remoteLaunch.isChecked(), true, 'shows the host value');
    await page.locator('#config-remote-host').getByText('Starts the core when the app on that computer starts. Changes apply there at once.').waitFor();
    await remoteLaunch.click();
    await page.waitForFunction(() => document.querySelector('#config-remote-host [role="switch"][aria-label="Start Core on Launch"]')?.checked === false);
    assert.equal(await page.locator('#config-native-software').getByRole('button', { name: 'Save', exact: true }).isDisabled(), true, 'no local software draft became dirty');

    // With host control the core's versions are checked and installed on its computer, with that computer's
    // source; this computer's source stays editable for this app's own updates.
    // The item can carry the update indicator, which extends its accessible name.
    await page.locator('.nav-section').getByRole('button', { name: /^Version Management/ }).click();
    await page.getByText('Checked and installed by the app on that computer, with its own download source.').waitFor();
    await page.getByText("In Remote mode this source is used only for this app's own updates.").waitFor();
    assert.equal(await page.getByRole('button', { name: 'Add Custom Source' }).isEnabled(), true, 'this computer\'s download source stays editable');
    assert.equal(await page.getByRole('button', { name: 'Install Bundled Core' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Stop and Update' }).isEnabled(), true, 'the remote core can be updated');
    // Usage reads the host store, with a distinct fixture from this computer's Local history.
    assert.equal(await nav('Usage').isEnabled(), true);
    await nav('Usage').click();
    await page.getByText("Usage history is recorded on the core's computer and is read-only here.").waitFor();
    assert.equal(await page.locator('.usage-remote-scope .scope-label').textContent(), 'App on other.example');
    await page.getByRole('tab', { name: 'Price Statistics', exact: true }).click();
    await page.getByText(/Read-only host data/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Add Manually', exact: true }).isDisabled(), true);
    await page.getByRole('tab', { name: 'Data Management', exact: true }).click();
    assert.equal(await page.locator('.usage-data-management-panel input').first().isDisabled(), true);
    await nav('Home').click();
    await page.locator('[data-stat="usage"] .home-stat-value').filter({ hasText: /90/ }).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: one connection component on Home and in Advanced Features; Remote keeps the Local layout with remote values, editable remote settings and in-place disabled local actions; every card names its machine; this computer\'s preferences, the host app\'s settings and hosting are separate; remote host control hosts locally and drives Start/Stop/Restart, versions and usage remotely.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
