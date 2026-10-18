// UI test: Settings → App (appearance, privacy, startup & window software settings, version link) against the browser mock.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openApp } = require('./helpers/shell.cjs');

(async () => {
  let server;
  let browser;
  const errors = [];
  try {
    const { createServer } = await import('vite');
    const react = (await import('@vitejs/plugin-react')).default;
    server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], optimizeDeps: { entries: ['index.html'] }, logLevel: 'error', server: { host: '127.0.0.1', port: 5363, strictPort: false } });
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
    browser = await chromium.launch({ args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.addInitScript(() => {
      window.__calls = [];
      const wrap = () => {
        const internals = window.__TAURI_INTERNALS__;
        if (!internals || internals.__wrapped) return false;
        const invoke = internals.invoke;
        internals.invoke = (command, args, options) => { window.__calls.push({ command, args }); return invoke(command, args, options); };
        internals.__wrapped = true;
        return true;
      };
      if (!wrap()) { const timer = setInterval(() => { if (wrap()) clearInterval(timer); }, 5); }
    });
    await openApp(page, base, { path: '/settings/app' });
    const calls = () => page.evaluate(() => window.__calls);
    const savebar = page.getByRole('region', { name: 'Unsaved changes' });
    const navDot = page.locator('[data-settings-tab="app"] .ec-set-nav-dot');

    // appearance: theme + density apply instantly (no save bar), language switches the page text
    const content = page.locator('.ec-set-content');
    await content.getByRole('radio', { name: 'Ember Light' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await content.getByRole('radio', { name: 'Compact' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.density === 'compact');
    await content.getByRole('radio', { name: 'Ember Dark' }).click();
    await content.getByRole('radio', { name: 'Comfortable' }).click();
    assert.equal(await savebar.count(), 0, 'appearance never opens the save bar');

    // privacy default is instant and stays in sync with the header eye
    const privacy = page.getByRole('switch', { name: 'Privacy mode' });
    await privacy.click();
    assert.equal(await page.getByTestId('privacy-toggle').getAttribute('aria-pressed'), 'true');
    await privacy.click();
    assert.equal(await page.getByTestId('privacy-toggle').getAttribute('aria-pressed'), 'false');

    // version chip → Updates
    const version = page.locator('a.ec-app-version');
    await version.waitFor();
    assert.match(await version.innerText(), /^v\d/);
    assert.match(await version.getAttribute('href'), /#\/settings\/updates$/);

    // software settings: dirty count, discard, save payload
    const close = page.getByLabel('Close behavior');
    await close.waitFor();
    assert.equal(await close.inputValue(), 'ask');
    await page.getByRole('switch', { name: 'Launch at startup' }).click();
    await close.selectOption('minimize-to-tray');
    await page.getByLabel('Default terminal').selectOption({ index: 1 });
    await savebar.getByText('3 unsaved changes').waitFor();
    await navDot.waitFor();
    await savebar.getByRole('button', { name: 'Discard' }).click();
    assert.equal(await close.inputValue(), 'ask');
    assert.equal(await savebar.count(), 0);

    await page.getByRole('switch', { name: 'Launch at startup' }).click();
    await page.getByRole('switch', { name: 'Silent Launch' }).click();
    await page.getByRole('switch', { name: 'Start Core on Launch' }).click();
    await close.selectOption('exit');
    const terminal = await page.getByLabel('Default terminal').evaluate((el) => el.options[1].value);
    await page.getByLabel('Default terminal').selectOption(terminal);
    await savebar.getByRole('button', { name: 'Save', exact: true }).click();
    await savebar.getByText('Saved', { exact: true }).waitFor();
    assert.deepEqual((await calls()).find((c) => c.command === 'save_software_settings').args.settings, {
      closeBehavior: 'exit', autostartEnabled: true, startCoreOnLaunch: false, silentStartEnabled: true, defaultTerminal: terminal,
    });
    assert.equal(await navDot.count(), 0);
    assert.deepEqual(errors, []);
    console.log('settings-app-ui: ok');
  } finally {
    await browser?.close();
    await server?.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
