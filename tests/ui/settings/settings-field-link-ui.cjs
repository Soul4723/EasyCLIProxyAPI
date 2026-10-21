// UI test: setting deep links (#/settings/<tab>?field=<path>) land on, focus and highlight the exact field (browser mock).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { openApp } = require('../../helpers/shell.cjs');

const SHOTS = process.env.UI_SHOT_DIR || path.join(os.tmpdir(), 'easycli-ui-shots');

(async () => {
  let server;
  let browser;
  const errors = [];
  try {
    const { createServer } = await import('vite');
    const react = (await import('@vitejs/plugin-react')).default;
    server = await createServer({ configFile: false, root: path.resolve(__dirname, '../../..'), plugins: [react()], optimizeDeps: { entries: ['index.html'] }, logLevel: 'error', server: { host: '127.0.0.1', port: 5360, strictPort: false } });
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
    browser = await chromium.launch({ args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));

    const landed = async (field, tab) => {
      await page.waitForFunction((value) => document.activeElement?.closest('[data-field-path]')?.getAttribute('data-field-path') === value, field);
      assert.equal(await page.locator(`[data-field-path="${field}"]`).evaluate((el) => el.hasAttribute('data-field-highlight')), true, `${field} highlighted`);
      assert.equal(await page.locator(`[data-field-path="${field}"]`).isVisible(), true, `${field} visible`);
      assert.match(page.url(), new RegExp(`#/settings/${tab}$`), 'the field param is dropped once handled');
    };

    // Plugins → Settings "Configure token" lands on the GitHub token input in Settings → Access.
    await openApp(page, base, { path: '/plugins/settings' });
    await page.getByRole('button', { name: 'Configure token' }).click();
    await landed('server.github-token', 'access');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'INPUT');
    await page.screenshot({ path: path.join(SHOTS, 'field-link-github-token.png') });
    // highlight is brief
    await page.waitForFunction(() => !document.querySelector('[data-field-highlight]'), null, { timeout: 5000 });

    // Settings already open on another tab: a link switches tab, then lands on the field.
    await page.evaluate(() => { location.hash = '#/settings/connection'; });
    await page.getByTestId('connection-active').waitFor();
    await page.evaluate(() => { location.hash = '#/settings/logs?field=observability.usage.redis-usage-queue-retention-seconds'; });
    await landed('observability.usage.redis-usage-queue-retention-seconds', 'logs');
    await page.screenshot({ path: path.join(SHOTS, 'field-link-redis-retention.png') });

    // Wrong tab in the link is redirected to the tab that renders the field.
    await page.evaluate(() => { location.hash = '#/settings/network?field=routing.strategy'; });
    await page.waitForFunction(() => document.activeElement?.closest('[data-field-path]')?.getAttribute('data-field-path') === 'routing.strategy');
    assert.match(page.url(), /#\/settings\/routing$/);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'radio', 'focus lands on the selected strategy');

    // A field inside a collapsed template block opens the Defaults view and the block.
    await page.evaluate(() => { location.hash = '#/settings/models?field=requests.passthrough-headers'; });
    await landed('requests.passthrough-headers', 'models');
    await page.screenshot({ path: path.join(SHOTS, 'field-link-models-template.png') });

    // Reduced motion: no animation, still highlighted.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => { location.hash = '#/settings/access?field=management.allow-remote'; });
    await landed('management.allow-remote', 'access');
    assert.equal(await page.locator('[data-field-path="management.allow-remote"]').evaluate((el) => getComputedStyle(el).animationName), 'none');

    // Unknown field: stays on the page, param dropped, nothing breaks.
    await page.evaluate(() => { location.hash = '#/settings/access?field=nope.missing'; });
    await page.waitForFunction(() => location.hash === '#/settings/access');
    assert.deepEqual(errors, []);
    console.log('settings-field-link-ui: ok');
  } finally {
    await browser?.close();
    await server?.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
