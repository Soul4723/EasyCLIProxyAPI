const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('../../helpers/ui-harness.cjs');
const assert = require('node:assert/strict');

// Plugin OAuth sign-in dialog, opened from the Sign in button of an installed row (fixture: tests/fixtures/plugin-oauth.html).
runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    const signIn = () => page.getByRole('button', { name: /^(Sign in|账号授权)$/ });
    const open = async query => {
      await page.goto(`${base}/tests/fixtures/plugin-oauth.html?${query ?? ''}`, { waitUntil: 'domcontentloaded' });
      await signIn().click();
      await page.getByRole('dialog').waitFor();
    };
    const calls = cmd => page.evaluate(command => window.pluginOAuthFixture.calls.filter(call => call.cmd === command), cmd);
    const waitSession = () => page.getByLabel('Sign-in URL', { exact: true }).waitFor();

    await open(); await waitSession();
    assert.deepEqual((await calls('start_oauth_login'))[0].args, { provider: 'grok', browser: 'none', pluginProvider: true, expectedRevision: 0 });
    assert.equal((await calls('open_oauth_url')).length, 0, 'Opening the dialog must not launch a browser automatically');
    await page.getByRole('button', { name: 'Open in browser', exact: true }).click();
    assert.deepEqual((await calls('open_oauth_url'))[0].args, { url: 'https://login.example.test/authorize?state=plugin-1', browser: 'default', expectedRevision: 0 });
    await page.getByRole('button', { name: 'Copy link', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.pluginOAuthFixture.copied), ['https://login.example.test/authorize?state=plugin-1']);
    const callback = page.getByLabel('Callback URL', { exact: true });
    await callback.fill('http://localhost/callback?code=secret&state=wrong');
    await page.getByRole('button', { name: 'Submit callback', exact: true }).click();
    assert.equal(await callback.getAttribute('aria-invalid'), 'true');
    assert.equal((await calls('submit_oauth_callback')).length, 0);
    await callback.fill('http://localhost/callback?code=secret&state=plugin-1');
    await page.getByRole('button', { name: 'Submit callback', exact: true }).click();
    assert.deepEqual((await calls('submit_oauth_callback'))[0].args, { provider: 'grok', redirectUrl: 'http://localhost/callback?code=secret&state=plugin-1', pluginProvider: true, expectedRevision: 0 });
    await page.evaluate(() => { window.pluginOAuthFixture.status = 'ok'; });
    await page.getByText('Authorization completed and credentials saved.', { exact: true }).waitFor();
    await page.waitForFunction(() => window.pluginOAuthFixture.completed === 1);
    await page.getByRole('status').filter({ hasText: 'Account authorization complete' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.pluginOAuthFixture.cancelled), []);
    // Known gap: Sign in is disabled while the dialog is open (`locked`), so focus cannot return to it and falls back to <body>.
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), false);

    await open('device'); await waitSession();
    assert.equal(await page.getByLabel('Callback URL', { exact: true }).count(), 0);
    await page.getByText('ABCD-EFGH', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Copy code', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.pluginOAuthFixture.copied), ['ABCD-EFGH']);
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.pluginOAuthFixture.cancelled.includes('plugin-1'));

    await open('holdStart');
    await page.waitForFunction(() => window.pluginOAuthFixture.releaseStart !== null);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.pluginOAuthFixture.releaseStart());
    await page.waitForFunction(() => window.pluginOAuthFixture.cancelled.includes('plugin-1'));
    assert.equal(await page.evaluate(() => window.pluginOAuthFixture.completed), 0);

    await open('holdStatus'); await waitSession();
    await page.waitForFunction(() => window.pluginOAuthFixture.releaseStatus !== null);
    await page.evaluate(() => { window.pluginOAuthFixture.unmount(); });
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.evaluate(() => { window.pluginOAuthFixture.status = 'ok'; window.pluginOAuthFixture.releaseStatus(); });
    await page.waitForFunction(() => window.pluginOAuthFixture.cancelled.includes('plugin-1'));
    assert.equal(await page.evaluate(() => window.pluginOAuthFixture.completed), 0, 'Stale successful poll must not complete a dismissed session');

    await open('expiry'); await waitSession();
    await page.getByText('Sign-in expired. Request a new link.', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.pluginOAuthFixture.cancelled), ['plugin-1']);
    await page.getByRole('button', { name: 'Retry sign-in', exact: true }).click();
    await page.waitForFunction(() => window.pluginOAuthFixture.starts === 2);
    await waitSession();
    assert.equal(await page.getByLabel('Sign-in URL', { exact: true }).inputValue(), 'https://login.example.test/authorize?state=plugin-2');

    await open('startError');
    await page.getByText('Fixture start error', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Retry sign-in', exact: true }).click();
    await waitSession();
    assert.equal(await page.evaluate(() => window.pluginOAuthFixture.starts), 2);
    await open('pollError');
    await page.getByText('Fixture poll error', { exact: true }).waitFor();
    await page.waitForFunction(() => window.pluginOAuthFixture.cancelled.includes('plugin-1'));
    await open('missingState');
    await page.getByText('The kernel returned no sign-in session to check.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.pluginOAuthFixture.polls), 0);
    await open('invalidUrl');
    await page.getByText('Invalid sign-in URL.', { exact: true }).waitFor();
    await page.waitForFunction(() => window.pluginOAuthFixture.cancelled.includes('plugin-1'));
    // A plugin that is not effectively enabled offers no sign-in at all (the "unavailable" dialog state is unreachable from the UI).
    await page.goto(`${base}/tests/fixtures/plugin-oauth.html?disabled`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /^Configure/ }).waitFor();
    assert.equal(await signIn().count(), 0);
    assert.equal(await page.evaluate(() => window.pluginOAuthFixture.starts), 0);

    await page.setViewportSize({ width: 390, height: 680 });
    await open('device&locale=zh-CN&theme=dark');
    await page.getByText('ABCD-EFGH', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.waitForTimeout(400);
    const box = await page.getByRole('dialog').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 680);
    if (process.env.PLUGIN_OAUTH_SCREENSHOT) await page.screenshot({ path: process.env.PLUGIN_OAUTH_SCREENSHOT });
    assert.deepEqual(errors, []);
    console.log('Plugin OAuth UI passed: native contract, callback validation, device code, polling, expiry/retry, cancellation/stale responses, focus and mobile layout.');
  } finally { await browser.close(); }
}, { url: process.env.AGENT_TEST_URL });
