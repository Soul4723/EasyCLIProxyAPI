const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), cacheDir: 'node_modules/.vite-oauth-lifecycle-test', plugins: [react()], logLevel: 'error', optimizeDeps: { entries: ['tests/fixtures/meta-oauth.html'] }, server: { host: '127.0.0.1', port: 1436, strictPort: false, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    browser = await chromium.launch({ channel, headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());

    const cards = '.oauth-card, .simple-mode-provider-card';
    const fixture = () => page.evaluate(() => window.metaFixture);
    const startCalls = () => page.evaluate(() => window.metaFixture.calls.filter(call => call.cmd === 'start_oauth_login').length);
    const managementCard = () => page.locator('.oauth-card').filter({ hasText: /Muse \(Meta\) OAuth|Muse OAuth|Meta OAuth/ });
    const easyCard = () => page.locator('.simple-mode-provider-card').filter({ hasText: /Muse \(Meta\) OAuth|Muse OAuth|Meta OAuth/ });
    const views = [
      { name: 'OAuth page', query: '', signIn: () => managementCard().getByRole('button', { name: 'Sign In', exact: true }), success: () => managementCard().getByText('Authorization successful. Credentials saved to Authentication Files.', { exact: true }) },
      { name: 'Easy mode', query: 'view=easy&', signIn: () => easyCard().getByRole('button', { name: 'Start Sign-In', exact: true }), success: () => easyCard().locator('.state-pill.success') },
    ];
    const open = async (view, extra = '') => {
      await page.goto(`${base}/tests/fixtures/meta-oauth.html?${view.query}locale=en${extra}`, { waitUntil: 'domcontentloaded' });
      await page.locator(cards).first().waitFor();
    };

    for (const view of views) {
      // Leaving the page cancels the pending session and stops polling; a late success changes nothing.
      await open(view);
      await page.evaluate(() => { window.metaFixture.holdStatus = true; });
      await view.signIn().click();
      await page.waitForFunction(() => window.metaFixture.releaseStatus !== null);
      await page.evaluate(() => window.metaUnmount());
      await page.waitForFunction(() => window.metaFixture.cancelledStates.includes('meta-attempt-1'));
      const stoppedPolls = (await fixture()).statusCalls;
      await page.evaluate(() => window.metaFixture.releaseStatus());
      await page.waitForTimeout(150);
      assert.equal((await fixture()).statusCalls, stoppedPolls, `${view.name}: polling must stop on unmount`);
      assert.deepEqual((await fixture()).priorityPatches, [], `${view.name}: a late success must not apply credential priority`);

      // Returning starts a clean flow, not the remembered one.
      await page.evaluate(() => window.metaMount());
      await page.locator(cards).first().waitFor();
      assert.equal(await view.success().count(), 0, `${view.name}: a late success must not be remembered`);
      await view.signIn().click();
      await page.getByText('META-CODE-2', { exact: true }).waitFor();
      assert.equal(await startCalls(), 2, `${view.name}: remount starts one new session`);

      // A start answered after the page is gone is cancelled and never polled.
      await open(view, '&holdStart=1');
      await view.signIn().click();
      await page.waitForFunction(() => window.metaFixture.releaseStart !== null);
      await page.evaluate(() => window.metaUnmount());
      await page.evaluate(() => window.metaFixture.releaseStart());
      await page.waitForFunction(() => window.metaFixture.cancelledStates.includes('meta-attempt-1'));
      await page.waitForTimeout(150);
      assert.equal((await fixture()).statusCalls, 0, `${view.name}: a late start must never be polled`);
    }

    assert.deepEqual(errors, []);
    console.log('OAuth page lifecycle UI passed: unmount cancellation, polling stop, late success and late start fencing, clean remount.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
