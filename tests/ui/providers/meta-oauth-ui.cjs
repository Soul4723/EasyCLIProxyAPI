// Muse (Meta) sign-in: a device-code flow with no callback step, driven through the sign-in dialog.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startFixtureServer, launchBrowser, newOfflinePage } = require('../../helpers/signinFixture.cjs');

(async () => {
  const server = await startFixtureServer('meta-oauth.html', 'meta');
  const browser = await launchBrowser(chromium);
  try {
    const { base } = server;
    const { page, errors } = await newOfflinePage(browser, base);
    const open = async (query = '') => {
      await page.goto(`${base}/tests/fixtures/meta-oauth.html?${query}`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-provider=meta]').waitFor();
    };
    const dialog = () => page.getByRole('dialog');
    const calls = () => page.evaluate(() => window.metaFixture.calls);
    const fixture = () => page.evaluate(() => window.metaFixture);
    const installClipboard = () => page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (value) => window.metaFixture.copied.push(String(value)) },
      });
    });
    const waitForStatusCall = () => page.waitForFunction(() => window.metaFixture.statusCalls > 0);
    const startMeta = async (attempt = 1) => {
      await page.locator('[data-provider=meta]').click();
      await dialog().getByText(`META-CODE-${attempt}`, { exact: true }).waitFor();
    };

    // Meta is the seventh OAuth provider next to Vertex: device code, no callback input.
    await open('locale=en');
    assert.equal(await page.locator('[data-provider]').count(), 8);
    assert.equal(await page.locator('[data-provider=meta]').count(), 1);
    await installClipboard();
    await startMeta();
    assert.equal(await dialog().getByRole('textbox').count(), 0, 'Meta must not render a callback textbox');
    assert.ok((await calls()).some(call => call.cmd === 'start_oauth_login' && call.args.provider === 'meta' && call.args.browser === 'none'));
    assert.equal(await dialog().getByText('Enter the device code', { exact: true }).count(), 1);
    await dialog().getByRole('button', { name: 'Copy device code', exact: true }).click();
    await page.waitForFunction(() => window.metaFixture.copied.includes('META-CODE-1'));
    await dialog().getByRole('button', { name: 'Copy', exact: true }).click();
    await page.waitForFunction(() => window.metaFixture.copied.includes('https://auth.meta.ai/device?state=meta-attempt-1'));
    await dialog().getByRole('button', { name: 'Open in browser', exact: true }).click();
    assert.ok((await calls()).some(call => call.cmd === 'open_oauth_url'
      && call.args.url === 'https://auth.meta.ai/device?state=meta-attempt-1' && call.args.browser === 'default'));

    // Completion assigns priority zero to the new credential and clears the device code.
    await waitForStatusCall();
    await page.evaluate(() => { window.metaFixture.status = 'ok'; });
    await dialog().getByText('Muse (Meta) signed in', { exact: true }).waitFor();
    assert.ok((await fixture()).priorityPatches.some(patch => patch.name === 'meta-oauth-1.json' && patch.priority === 0));
    assert.equal(await dialog().getByText('META-CODE-1', { exact: true }).count(), 0, 'success clears the device code');
    assert.deepEqual(await page.evaluate(() => window.signinSuccesses), ['meta']);

    // A refresh cancels the old session and a stale completion cannot win over attempt two.
    await open('locale=en');
    await page.evaluate(() => { window.metaFixture.holdStatus = true; });
    await startMeta();
    await page.waitForFunction(() => window.metaFixture.releaseStatus !== null);
    await dialog().getByRole('button', { name: 'Refresh link', exact: true }).click();
    await page.waitForFunction(() => window.metaFixture.attempts === 2);
    await dialog().getByText('META-CODE-2', { exact: true }).waitFor();
    assert.ok((await fixture()).cancelledStates.includes('meta-attempt-1'));
    assert.equal(await dialog().getByText('META-CODE-1', { exact: true }).count(), 0);
    await page.evaluate(() => { if (window.metaFixture.releaseStatus) window.metaFixture.releaseStatus(); });
    await page.waitForTimeout(100);
    assert.equal(await dialog().getByText('Muse (Meta) signed in', { exact: true }).count(), 0, 'stale attempt must not complete the refreshed login');
    assert.ok(await dialog().getByText('META-CODE-2', { exact: true }).isVisible());

    // A failure can be retried and a later success still clears the code.
    await open('locale=en');
    await startMeta();
    await waitForStatusCall();
    await page.evaluate(() => { window.metaFixture.status = 'error'; });
    await dialog().getByText('Meta authorization failed', { exact: false }).waitFor();
    assert.equal(await page.locator('[data-provider=meta]').getAttribute('data-flow'), 'error');
    await dialog().getByRole('button', { name: 'Try again', exact: true }).click();
    await page.waitForFunction(() => window.metaFixture.attempts === 2);
    await dialog().getByText('META-CODE-2', { exact: true }).waitFor();
    await page.waitForFunction(() => window.metaFixture.statusCalls > 1);
    await page.evaluate(() => { window.metaFixture.status = 'ok'; });
    await dialog().getByText('Muse (Meta) signed in', { exact: true }).waitFor();

    // The sign-in link stays usable when the browser cannot be launched.
    await open('locale=en&openError=1');
    await installClipboard();
    await startMeta();
    await dialog().getByText('browser could not be opened: Fixture browser open failed', { exact: false }).waitFor();
    await dialog().getByRole('button', { name: 'Open in browser', exact: true }).click();
    assert.ok((await calls()).some(call => call.cmd === 'open_oauth_url'));

    // Cancelling stops polling immediately, deletes the session, and fences an in-flight success.
    await open('locale=en');
    await page.evaluate(() => { window.metaFixture.holdStatus = true; });
    await startMeta();
    await page.waitForFunction(() => window.metaFixture.releaseStatus !== null);
    await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog().waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.metaFixture.cancelledStates.includes('meta-attempt-1'));
    const stoppedCalls = (await fixture()).statusCalls;
    await page.evaluate(() => window.metaFixture.releaseStatus());
    await page.waitForTimeout(150);
    assert.equal((await fixture()).statusCalls, stoppedCalls, 'Cancel must stop polling');
    assert.equal(await page.locator('[data-provider=meta]').getAttribute('data-flow'), 'idle');
    assert.equal(await dialog().count(), 0, 'a stale success must not reopen the dialog');
    assert.deepEqual(await page.evaluate(() => window.signinSuccesses), []);

    // Escape is cancellation too, and a later sign-in creates a fresh session.
    await startMeta(2);
    await page.keyboard.press('Escape');
    await dialog().waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.metaFixture.cancelledStates.includes('meta-attempt-2'));

    // Unmount stops active polling and fences its in-flight response.
    await open('locale=en');
    await page.evaluate(() => { window.metaFixture.holdStatus = true; });
    await startMeta();
    await page.waitForFunction(() => window.metaFixture.releaseStatus !== null);
    await page.evaluate(() => window.metaUnmount());
    await page.waitForFunction(() => window.metaFixture.cancelledStates.includes('meta-attempt-1'));
    const unmountedCalls = (await fixture()).statusCalls;
    await page.evaluate(() => window.metaFixture.releaseStatus());
    await page.waitForTimeout(150);
    assert.equal((await fixture()).statusCalls, unmountedCalls);
    assert.deepEqual(await page.evaluate(() => window.signinSuccesses), []);

    // A start that returns after Cancel or unmount must be cancelled, never polled.
    for (const unmount of [false, true]) {
      await open('locale=en&holdStart=1');
      await page.locator('[data-provider=meta]').click();
      await page.waitForFunction(() => window.metaFixture.releaseStart !== null);
      if (unmount) await page.evaluate(() => window.metaUnmount());
      else await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.evaluate(() => window.metaFixture.releaseStart());
      await page.waitForFunction(() => window.metaFixture.cancelledStates.includes('meta-attempt-1'));
      await page.waitForTimeout(150);
      assert.equal((await fixture()).statusCalls, 0);
      assert.equal(await dialog().count(), 0);
    }

    // Chinese labels at desktop and phone widths in both themes, without horizontal overflow.
    fs.mkdirSync('misc', { recursive: true });
    for (const [theme, width] of [['light', 1280], ['dark', 390]]) {
      await page.setViewportSize({ width, height: 900 });
      await open(`locale=zh-CN&theme=${theme}`);
      await installClipboard();
      await page.locator('[data-provider=meta]').click();
      await dialog().getByText('META-CODE-1', { exact: true }).waitFor();
      assert.equal(await dialog().getByText('输入设备码', { exact: true }).count(), 1);
      assert.equal(await dialog().getByRole('button', { name: '复制设备码', exact: true }).count(), 1);
      assert.equal(await dialog().getByRole('textbox').count(), 0);
      const box = await dialog().boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, `${theme} dialog fits the width`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} viewport overflows horizontally`);
      if (!process.env.NO_SCREENSHOTS) await page.screenshot({ path: `misc/meta-oauth-${theme}.png`, fullPage: true });
    }

    assert.deepEqual(errors, []);
    console.log('Meta OAuth browser checks passed: device code copy/open, refresh cancellation, stale poll isolation, success priority, retry, open failure, close cancellation and responsive labels.');
  } finally {
    await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
