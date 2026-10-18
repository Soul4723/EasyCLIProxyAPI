const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Plugin-provided OAuth sign-in cards (src/sections/plugins/OAuthProviders.tsx), hosted by tests/fixtures/plugin-oauth-providers.html.
(async () => {
  const base = process.env.AGENT_TEST_URL || 'http://127.0.0.1:1421';
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    const open = async (query = '') => {
      await page.goto(`${base}/tests/fixtures/plugin-oauth-providers.html?${query}`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Choose Browser', { exact: true }).waitFor();
      await page.waitForFunction(() => window.pluginOAuthProvidersFixture.calls.some(call => call.cmd === 'get_plugin_support'));
    };
    // One <section> card per eligible plugin provider; the title is the <strong> "<name> OAuth".
    const cards = () => page.locator('section').filter({ has: page.locator('strong') });
    const card = name => cards().filter({ has: page.locator('strong').filter({ hasText: new RegExp(`^${name}$`) }) });
    const calls = cmd => page.evaluate(command => window.pluginOAuthProvidersFixture.calls.filter(call => call.cmd === command), cmd);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const screenshot = async (name, fullPage = true) => {
      const directory = process.env.PLUGIN_OAUTH_PROVIDERS_SCREENSHOT_DIR;
      if (!directory) return;
      fs.mkdirSync(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, name), fullPage });
    };

    await open();
    await card('ZCode OAuth').waitFor();
    await card('CodeBuddy OAuth').waitFor();
    assert.equal(await cards().count(), 2, 'only the two eligible plugin providers get a card');
    for (const name of ['Disabled provider', 'Unregistered provider', 'Non OAuth provider', 'Invalid provider', 'Missing provider', 'Duplicate ZCode', 'Duplicate Codex']) {
      assert.equal(await page.getByText(`${name} OAuth`, { exact: true }).count(), 0, `${name} must not become a provider card`);
    }
    await screenshot('plugin-oauth-providers-light-desktop.png');
    await page.getByLabel('Choose Browser', { exact: true }).selectOption('edge');

    const zcodeLogin = card('ZCode OAuth').getByRole('button', { name: 'Start Sign-In', exact: true });
    await zcodeLogin.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: /^Plugin sign-in/ }).waitFor();
    await page.getByLabel('Sign-in URL', { exact: true }).waitFor();
    assert.deepEqual((await calls('start_oauth_login'))[0].args, { provider: 'zcode', browser: 'none', pluginProvider: true });
    await page.getByRole('button', { name: 'Open in browser', exact: true }).click();
    assert.deepEqual((await calls('open_oauth_url'))[0].args, {
      url: 'https://login.example.test/authorize?state=plugin-session-1', browser: 'edge',
    });
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true);
    }
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.pluginOAuthProvidersFixture.cancelled.includes('plugin-session-1'));
    assert.equal(await zcodeLogin.evaluate(element => element === document.activeElement), true);

    await card('CodeBuddy OAuth').getByRole('button', { name: 'Start Sign-In', exact: true }).click();
    await page.getByText('BUDDY-CODE', { exact: true }).waitFor();
    assert.deepEqual((await calls('start_oauth_login'))[1].args, { provider: 'codebuddy', browser: 'none', pluginProvider: true });
    assert.equal(await page.getByLabel('Callback URL', { exact: true }).count(), 0, 'device flow must not show callback input');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });

    // Reloading provider metadata must expose newly installed plugins and remove disabled ones.
    await open('empty');
    await page.waitForFunction(() => window.pluginOAuthProvidersFixture.listCalls === 1);
    assert.equal(await cards().count(), 0);
    await page.evaluate(() => {
      const fixture = window.pluginOAuthProvidersFixture;
      fixture.plugins = structuredClone(fixture.installedPlugins);
      fixture.refresh();
    });
    await card('ZCode OAuth').waitFor();
    await card('CodeBuddy OAuth').waitFor();
    await page.evaluate(() => {
      const fixture = window.pluginOAuthProvidersFixture;
      fixture.plugins = fixture.plugins.map(plugin => plugin.id === 'zcode' ? { ...plugin, enabled: false, effective_enabled: false } : plugin);
      fixture.refresh();
    });
    await card('ZCode OAuth').waitFor({ state: 'detached' });
    assert.equal(await card('CodeBuddy OAuth').count(), 1);

    await page.evaluate(() => {
      const fixture = window.pluginOAuthProvidersFixture;
      fixture.plugins = structuredClone(fixture.installedPlugins);
      fixture.refresh();
    });
    await card('ZCode OAuth').waitFor();

    // A previous in-flight list response cannot restore an already disabled provider.
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
    await card('CodeBuddy OAuth').waitFor({ state: 'detached' });
    await page.evaluate(() => window.pluginOAuthProvidersFixture.releaseList());
    await settle();
    assert.equal(await cards().count(), 0, 'stale provider response must be ignored');

    // Refocusing the window discovers changes made outside this page.
    await page.evaluate(() => {
      const fixture = window.pluginOAuthProvidersFixture;
      fixture.plugins = structuredClone(fixture.installedPlugins);
      window.dispatchEvent(new Event('focus'));
    });
    await card('ZCode OAuth').waitFor();
    await card('CodeBuddy OAuth').waitFor();

    // Plugin registration can finish after navigating away from the installer.
    // The provider should appear from the bounded retry without another event.
    await open('pendingRegistration');
    await page.waitForFunction(() => window.pluginOAuthProvidersFixture.listCalls === 1);
    await settle();
    assert.equal(await card('ZCode OAuth').count(), 0, 'pending plugin is not ready for login');
    await page.evaluate(() => {
      const fixture = window.pluginOAuthProvidersFixture;
      fixture.plugins = [structuredClone(fixture.installedPlugins[0])];
    });
    await card('ZCode OAuth').waitFor();
    assert.ok(await page.evaluate(() => window.pluginOAuthProvidersFixture.listCalls > 1), 'registration must be refreshed automatically');
    assert.equal(await cards().count(), 1);

    await open('unsupported');
    await settle();
    assert.equal(await cards().count(), 0);
    assert.equal(await page.evaluate(() => window.pluginOAuthProvidersFixture.listCalls), 0, 'unsupported kernel must not request plugins');
    await open('listError');
    await page.waitForFunction(() => window.pluginOAuthProvidersFixture.listCalls > 0);
    await page.getByRole('alert').filter({ hasText: /./ }).waitFor();
    assert.equal(await cards().count(), 0, 'a plugin list failure shows no plugin cards and an error banner');
    await page.evaluate(() => { window.pluginOAuthProvidersFixture.listError = false; });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await card('ZCode OAuth').waitFor();
    await card('CodeBuddy OAuth').waitFor();
    assert.equal(await page.getByRole('alert').count(), 0, 'a successful reload clears the error banner');

    await page.setViewportSize({ width: 390, height: 844 });
    await open('theme=dark&locale=zh-CN');
    await card('ZCode OAuth').waitFor();
    await card('CodeBuddy OAuth').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot('plugin-oauth-providers-dark-mobile.png');
    await card('CodeBuddy OAuth').getByRole('button', { name: '开始登录', exact: true }).click();
    await page.getByText('BUDDY-CODE', { exact: true }).waitFor();
    await page.waitForTimeout(400);
    const box = await page.getByRole('dialog').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
    await screenshot('plugin-oauth-providers-dark-mobile-dialog.png', false);
    assert.deepEqual(errors, []);
    console.log('Plugin OAuth provider UI passed: dynamic visibility, eligibility/deduplication, refresh/install/disable, stale responses, native plugin login, focus trap/cancellation, unsupported kernels and responsive layout.');
  } finally {
    await browser?.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
