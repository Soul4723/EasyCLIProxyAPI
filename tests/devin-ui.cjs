// Devin sign-in through the Providers sign-in dialog (useOAuthSignIn + SignInDialog). Devin on Easy Mode, auth files and
// quota is covered by those sections' own tests.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startFixtureServer, launchBrowser, newOfflinePage } = require('./helpers/signinFixture.cjs');

(async () => {
  const server = await startFixtureServer('devin.html', 'devin');
  const browser = await launchBrowser(chromium);
  try {
    const { base } = server;
    const { page, errors } = await newOfflinePage(browser, base);
    const open = (query) => page.goto(`${base}/tests/fixtures/devin.html?${query || ''}`, { waitUntil: 'domcontentloaded' });
    const dialog = () => page.getByRole('dialog');
    const calls = () => page.evaluate(() => window.devinFixture.calls);
    const start = async () => {
      await page.locator('[data-provider=devin]').click();
      await dialog().getByRole('textbox').waitFor();
    };
    const submit = () => dialog().getByRole('button', { name: 'Submit', exact: true }).click();

    // Sign in: start args, callback validation (state must match), accepted callback, success + default priority.
    await open();
    assert.equal(await page.locator('[data-provider]').count(), 8, 'seven OAuth providers plus Vertex');
    await page.evaluate(() => { window.devinFixture.completeOnSubmit = false; });
    await start();
    assert.ok((await calls()).some(call => call.cmd === 'start_oauth_login' && call.args.provider === 'devin' && call.args.browser === 'none'));
    await dialog().getByRole('textbox').fill('http://127.0.0.1:8317/callback?state=old&code=code');
    await submit();
    await dialog().getByText('The callback state does not match', { exact: false }).waitFor();
    assert.equal((await calls()).filter(call => call.cmd === 'submit_oauth_callback').length, 0);
    await dialog().getByRole('textbox').fill('http://127.0.0.1:8317/callback?state=attempt-1&code=code');
    await submit();
    await dialog().getByText('Callback submitted. Waiting for authentication to finish.', { exact: true }).waitFor();
    const submitted = (await calls()).find(call => call.cmd === 'submit_oauth_callback');
    assert.deepEqual(submitted.args, { provider: 'devin', redirectUrl: 'http://127.0.0.1:8317/callback?state=attempt-1&code=code', expectedRevision: 0 });
    await page.evaluate(() => { window.devinFixture.status = 'ok'; });
    await dialog().getByText('Devin signed in', { exact: true }).waitFor();
    assert.equal(await dialog().getByRole('textbox').count(), 0);
    assert.ok((await page.evaluate(() => window.devinFixture.priorityPatches)).some(patch => patch.name === 'devin-test.json' && patch.priority === 0));
    assert.deepEqual(await page.evaluate(() => window.signinSuccesses), ['devin']);
    assert.equal(await page.locator('[data-provider=devin]').getAttribute('data-flow'), 'success');
    const viewAccounts = dialog().getByRole('link', { name: 'View accounts', exact: true });
    assert.equal(await viewAccounts.getAttribute('href'), '#/providers?p=devin');

    // Refresh cancels the old session; a late "ok" for the old attempt must not complete the new one.
    await open();
    await start();
    await page.evaluate(() => { window.devinFixture.holdStatus = true; });
    await page.waitForFunction(() => window.devinFixture.releaseStatus !== null);
    await dialog().getByRole('button', { name: 'Refresh link', exact: true }).click();
    await page.waitForFunction(() => window.devinFixture.attempts === 2);
    await page.evaluate(() => window.devinFixture.releaseStatus());
    await page.waitForTimeout(150);
    assert.equal(await dialog().getByText('Devin signed in', { exact: true }).count(), 0);
    assert.ok(await dialog().getByRole('textbox').isVisible());
    assert.ok((await calls()).some(call => call.cmd === 'management_request' && call.args.request.path === '/oauth/session' && call.args.request.query.state === 'attempt-1'));
    // A failed cancel keeps the current session alive and says so.
    await page.evaluate(() => { window.devinFixture.cancelError = true; });
    await dialog().getByRole('button', { name: 'Refresh link', exact: true }).click();
    await dialog().getByText('Cancellation failed', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.devinFixture.attempts), 2);

    // Remote core: the paste step is the primary path and nothing opens a local browser automatically.
    await open('remote=1');
    await page.evaluate(() => localStorage.setItem('easy-cli-proxy-api.oauth-browser.v3', 'default'));
    await open('remote=1');
    await page.locator('[data-provider=devin]').click();
    await dialog().getByRole('textbox').waitFor();
    await dialog().getByText('Remote core:', { exact: false }).first().waitFor();
    assert.ok((await calls()).some(call => call.cmd === 'start_oauth_login' && call.args.browser === 'none'), 'remote core never auto-opens a local browser');
    assert.equal(await dialog().getByRole('combobox').isDisabled(), true);

    // Both themes, a narrow window and Chinese: the dialog stays inside the viewport and the logo follows the theme.
    fs.mkdirSync('misc', { recursive: true });
    for (const [theme, width] of [['light', 1280], ['dark', 390]]) {
      await page.setViewportSize({ width, height: 800 });
      await open(`theme=${theme}&locale=zh-CN`);
      await page.locator('[data-provider=devin]').click();
      await dialog().getByRole('textbox').waitFor();
      await dialog().getByText('登录 Devin', { exact: true }).waitFor();
      await dialog().getByRole('button', { name: '提交', exact: true }).waitFor();
      const filter = await dialog().locator('.ec-provider-logo__img').first().evaluate(node => getComputedStyle(node).filter);
      assert.equal(filter, theme === 'dark' ? 'invert(1)' : 'none');
      const box = await dialog().boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 800, `${theme} dialog fits the viewport`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} layout has no horizontal overflow`);
      await page.screenshot({ path: `misc/devin-oauth-${theme}.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log('Devin browser checks passed: sign-in dialog, callback validation, session refresh and cancel failure, remote core and both themes.');
  } finally {
    await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
