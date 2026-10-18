// Plugin-declared OAuth providers inside the Providers sign-in controller: eligibility, dynamic refresh and the plugin
// flow run through the same SignInDialog as the built-in providers.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startFixtureServer, launchBrowser, newOfflinePage } = require('./helpers/signinFixture.cjs');

const BASE_PROVIDERS = 8; // seven built-in OAuth providers plus Vertex

(async () => {
  const server = await startFixtureServer('plugin-oauth-providers.html', 'plugin-providers');
  const browser = await launchBrowser(chromium);
  try {
    const { base } = server;
    const { page, errors } = await newOfflinePage(browser, base, { width: 1366, height: 1000 });
    const open = async (query = '') => {
      await page.goto(`${base}/tests/fixtures/plugin-oauth-providers.html?${query}`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-provider=codex]').waitFor();
      await page.waitForFunction(() => window.pluginOAuthProvidersFixture.calls.some(call => call.cmd === 'get_plugin_support'));
      await page.waitForFunction(() => window.pluginOAuthProvidersFixture.calls.some(call => call.cmd === 'list_oauth_browsers'));
    };
    const provider = id => page.locator(`[data-provider=${id}]`);
    const providerCount = () => page.locator('[data-provider]').count();
    const dialog = () => page.getByRole('dialog');
    const calls = cmd => page.evaluate(command => window.pluginOAuthProvidersFixture.calls.filter(call => call.cmd === command), cmd);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const screenshot = async (name, fullPage = true) => {
      const directory = process.env.PLUGIN_OAUTH_PROVIDERS_SCREENSHOT_DIR;
      if (!directory) return;
      fs.mkdirSync(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, name), fullPage });
    };

    await open();
    await provider('zcode').waitFor();
    await provider('codebuddy').waitFor();
    assert.equal(await providerCount(), BASE_PROVIDERS + 2, 'built-ins, Vertex and two eligible plugin providers');
    for (const name of ['Disabled provider', 'Unregistered provider', 'Non OAuth provider', 'Invalid provider', 'Missing provider', 'Duplicate ZCode', 'Duplicate Codex']) {
      assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, `${name} must not become a provider`);
    }
    assert.equal(await page.getByRole('button', { name: 'ZCode', exact: true }).count(), 1, 'duplicate provider ids collapse to one');
    await screenshot('plugin-oauth-providers-light-desktop.png');

    // Authorization-code plugin: starts without opening a browser, opens on demand in the chosen browser, validates the callback.
    await provider('zcode').focus();
    await page.keyboard.press('Enter');
    await dialog().waitFor();
    await dialog().getByText('Sign in to ZCode', { exact: true }).waitFor();
    await dialog().getByText('auth', { exact: false }).first().waitFor();
    await dialog().getByRole('button', { name: 'Open in browser', exact: true }).waitFor();
    assert.deepEqual((await calls('start_oauth_login'))[0].args, { provider: 'zcode', browser: 'none', pluginProvider: true });
    assert.equal((await calls('open_oauth_url')).length, 0, 'opening the dialog must not launch a browser');
    await dialog().getByLabel('Browser', { exact: true }).selectOption('edge');
    await dialog().getByRole('button', { name: 'Open in browser', exact: true }).click();
    assert.deepEqual((await calls('open_oauth_url'))[0].args, {
      url: 'https://login.example.test/authorize?state=plugin-session-1', browser: 'edge',
    });
    const callback = dialog().getByRole('textbox');
    await callback.fill('http://localhost/callback?code=secret&state=wrong');
    await dialog().getByRole('button', { name: 'Submit', exact: true }).click();
    await dialog().getByText('Enter a complete callback URL containing the current state and a code or error.', { exact: true }).waitFor();
    assert.equal(await callback.getAttribute('aria-invalid'), 'true');
    assert.equal((await calls('submit_oauth_callback')).length, 0);
    await callback.fill('http://localhost/callback?code=secret&state=plugin-session-1');
    await dialog().getByRole('button', { name: 'Submit', exact: true }).click();
    await dialog().getByText('Callback submitted. Waiting for authentication to finish.', { exact: true }).waitFor();
    assert.deepEqual((await calls('submit_oauth_callback'))[0].args, {
      provider: 'zcode', redirectUrl: 'http://localhost/callback?code=secret&state=plugin-session-1', pluginProvider: true,
    });
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true, 'focus stays inside the dialog');
    }
    await page.keyboard.press('Escape');
    await dialog().waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.pluginOAuthProvidersFixture.cancelled.includes('plugin-session-1'));
    assert.equal(await provider('zcode').getAttribute('data-flow'), 'idle', 'closing a plugin sign-in cancels it');
    assert.equal(await provider('zcode').evaluate(element => element === document.activeElement), true, 'focus returns to the trigger');

    // Device-code plugin: no callback step.
    await provider('codebuddy').click();
    await dialog().getByText('BUDDY-CODE', { exact: true }).waitFor();
    assert.deepEqual((await calls('start_oauth_login'))[1].args, { provider: 'codebuddy', browser: 'none', pluginProvider: true });
    assert.equal(await dialog().getByRole('textbox').count(), 0, 'device flow must not show a callback input');
    await page.evaluate(() => { window.pluginOAuthProvidersFixture.status = 'ok'; });
    await dialog().getByText('CodeBuddy signed in', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.signinSuccesses), ['codebuddy']);
    await page.keyboard.press('Escape');
    await dialog().waitFor({ state: 'detached' });
    await page.evaluate(() => { window.pluginOAuthProvidersFixture.status = 'wait'; });

    // Reloading provider metadata exposes newly installed plugins and removes disabled ones.
    await open('empty');
    await page.waitForFunction(() => window.pluginOAuthProvidersFixture.listCalls === 1);
    assert.equal(await providerCount(), BASE_PROVIDERS);
    await page.evaluate(() => {
      const fixture = window.pluginOAuthProvidersFixture;
      fixture.plugins = structuredClone(fixture.installedPlugins);
      fixture.refresh();
    });
    await provider('zcode').waitFor();
    await provider('codebuddy').waitFor();
    await page.evaluate(() => {
      const fixture = window.pluginOAuthProvidersFixture;
      fixture.plugins = fixture.plugins.map(plugin => plugin.id === 'zcode' ? { ...plugin, enabled: false, effective_enabled: false } : plugin);
      fixture.refresh();
    });
    await provider('zcode').waitFor({ state: 'detached' });
    assert.equal(await provider('codebuddy').count(), 1);

    await page.evaluate(() => {
      const fixture = window.pluginOAuthProvidersFixture;
      fixture.plugins = structuredClone(fixture.installedPlugins);
    });
    await page.getByTestId('reload').click();
    await provider('zcode').waitFor();

    // A previous in-flight list response cannot restore an already removed provider.
    await page.evaluate(() => {
      const fixture = window.pluginOAuthProvidersFixture;
      fixture.holdNextList = true;
      fixture.refresh();
    });
    await page.waitForFunction(() => window.pluginOAuthProvidersFixture.releaseList !== null);
    await page.evaluate(() => {
      const fixture = window.pluginOAuthProvidersFixture;
      fixture.plugins = [];
      fixture.refresh();
    });
    await provider('codebuddy').waitFor({ state: 'detached' });
    await page.evaluate(() => window.pluginOAuthProvidersFixture.releaseList());
    await settle();
    assert.equal(await providerCount(), BASE_PROVIDERS, 'stale provider response must be ignored');

    // Refocusing the window discovers changes made outside this page.
    await page.evaluate(() => {
      const fixture = window.pluginOAuthProvidersFixture;
      fixture.plugins = structuredClone(fixture.installedPlugins);
      window.dispatchEvent(new Event('focus'));
    });
    await provider('zcode').waitFor();
    await provider('codebuddy').waitFor();

    // A plugin removed while its dialog is open takes the dialog with it (and cancels the session).
    await provider('zcode').click();
    await dialog().getByRole('button', { name: 'Open in browser', exact: true }).waitFor();
    await page.evaluate(() => {
      const fixture = window.pluginOAuthProvidersFixture;
      fixture.plugins = [];
      fixture.refresh();
    });
    await dialog().waitFor({ state: 'detached' });
    await provider('zcode').waitFor({ state: 'detached' });

    // Plugin registration can finish after navigating away from the installer; the bounded retry picks it up.
    await open('pendingRegistration');
    await page.waitForFunction(() => window.pluginOAuthProvidersFixture.listCalls === 1);
    await settle();
    assert.equal(await provider('zcode').count(), 0, 'a pending plugin is not ready for login');
    await page.evaluate(() => {
      const fixture = window.pluginOAuthProvidersFixture;
      fixture.plugins = [structuredClone(fixture.installedPlugins[0])];
    });
    await provider('zcode').waitFor();
    assert.ok(await page.evaluate(() => window.pluginOAuthProvidersFixture.listCalls > 1), 'registration must be refreshed automatically');
    assert.equal(await providerCount(), BASE_PROVIDERS + 1);

    // A link that outlives its expiry fails and cancels the session.
    await open('expire=1');
    await provider('zcode').click();
    await dialog().getByText('Sign-in expired. Request a new link.', { exact: false }).waitFor();
    await page.waitForFunction(() => window.pluginOAuthProvidersFixture.cancelled.length === 1);
    await dialog().getByRole('button', { name: 'Try again', exact: true }).click();
    await page.waitForFunction(() => window.pluginOAuthProvidersFixture.starts === 2);
    await page.keyboard.press('Escape');

    await open('unsupported');
    await settle();
    assert.equal(await providerCount(), BASE_PROVIDERS);
    assert.equal(await page.evaluate(() => window.pluginOAuthProvidersFixture.listCalls), 0, 'an unsupported kernel must not request plugins');
    await open('listError');
    await page.waitForFunction(() => window.pluginOAuthProvidersFixture.listCalls > 0);
    await page.getByTestId('plugin-error').waitFor();
    assert.equal(await providerCount(), BASE_PROVIDERS, 'plugin failure must leave built-in sign-in available');
    assert.equal(await provider('codex').isEnabled(), true);
    await provider('codex').click();
    await dialog().getByText('Sign in to Codex', { exact: true }).waitFor();
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 390, height: 844 });
    await open('theme=dark&locale=zh-CN');
    await provider('zcode').waitFor();
    await provider('codebuddy').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot('plugin-oauth-providers-dark-mobile.png');
    await provider('codebuddy').click();
    await page.getByText('BUDDY-CODE', { exact: true }).waitFor();
    const box = await dialog().boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
    await screenshot('plugin-oauth-providers-dark-mobile-dialog.png', false);
    assert.deepEqual(errors, []);
    console.log('Plugin OAuth provider UI passed: dynamic visibility, eligibility/deduplication, refresh/install/disable, stale responses, plugin flow through the shared dialog, callback validation, focus trap/cancellation, expiry, unsupported kernels and responsive layout.');
  } finally {
    await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
