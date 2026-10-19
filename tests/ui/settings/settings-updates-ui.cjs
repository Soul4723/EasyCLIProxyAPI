// Settings → Updates UI test (browser mock). Run: PLAYWRIGHT_MODULE=... node tests/ui/settings/settings-updates-ui.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openApp, setPrivacy } = require('../../helpers/shell.cjs');

const invoke = (page, command, payload) => page.evaluate(([c, p]) => window.__TAURI_INTERNALS__.invoke(c, p), [command, payload]);

(async () => {
  let server;
  let browser;
  const runtimeErrors = [];
  try {
    const { createServer } = await import('vite');
    const react = (await import('@vitejs/plugin-react')).default;
    server = await createServer({
      configFile: false,
      root: path.resolve(__dirname, '../../..'),
      plugins: [react()],
      optimizeDeps: { entries: ['index.html'] },
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 5371, strictPort: false },
    });
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true, args: ['--no-proxy-server'] });

    const open = async (viewport = { width: 1280, height: 900 }, mock = 'running') => {
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(10000);
      page.on('pageerror', (error) => runtimeErrors.push(String(error)));
      await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
      await page.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
      await openApp(page, base, { mock, path: '/settings/updates' });
      await page.locator('.ec-upd-page').waitFor();
      return page;
    };

    // --- local mode: both cards, update available, install with progress result, bundled core, sources ---
    let page = await open();
    const appCard = page.getByRole('region', { name: 'Desktop app' });
    const coreCard = page.getByRole('region', { name: 'Proxy core' });
    await appCard.getByText('Update available').waitFor();
    assert.match(await appCard.innerText(), /v0\.2\.97/);
    assert.match(await appCard.innerText(), /v0\.3\.0/);
    await coreCard.getByText('Update available').waitFor();
    assert.match(await coreCard.innerText(), /7\.3\.16/);
    assert.ok(await appCard.getByRole('button', { name: 'Update Now' }).isEnabled());

    // Core update asks for confirmation, then installs the latest release.
    await coreCard.getByRole('button', { name: /Update to 7\.3\.16/ }).click();
    const confirm = page.getByRole('dialog');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await confirm.waitFor({ state: 'hidden' });
    assert.ok(await coreCard.getByText('Update available').count());
    await coreCard.getByRole('button', { name: /Update to 7\.3\.16/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Stop and Update' }).click();
    await coreCard.getByText('Up to date').waitFor();
    assert.match(await coreCard.innerText(), /7\.3\.16/);

    // Bundled core: shown with its version, installable (local mode).
    assert.match(await coreCard.innerText(), /Bundled core\s+7\.3\.15/);
    await coreCard.getByRole('button', { name: 'Use bundled' }).click();
    await coreCard.getByText('Update available').waitFor();
    assert.match(await coreCard.locator('.ec-upd-ver').first().innerText(), /7\.3\.15/);

    // Download sources: github selected, switch, gitcode, add / remove custom mirror, validation.
    const sources = page.locator('#updates-sources');
    const selectedSource = () => sources.locator('.ec-upd-source[data-selected="true"]').getAttribute('data-source');
    assert.equal(await selectedSource(), 'github');
    await sources.locator('[data-source="gh-fast"]').getByRole('button', { name: 'Use' }).click();
    await sources.locator('[data-source="gh-fast"]').getByText('Selected').waitFor();
    assert.equal(await selectedSource(), 'gh-fast');
    await sources.locator('[data-source="custom:https://gh-proxy.example.com/"]').getByRole('button', { name: 'Use' }).click();
    await sources.locator('[data-source="custom:https://gh-proxy.example.com/"]').getByText('Selected').waitFor();
    const input = sources.getByLabel('Add custom mirror');
    await input.fill('http://insecure.example.com/');
    await sources.getByRole('button', { name: 'Add and Switch' }).click();
    await sources.getByText('Enter an address starting with https://').waitFor();
    await input.fill('https://mirror.example.org/');
    await sources.getByRole('button', { name: 'Add and Switch' }).click();
    await sources.locator('[data-source="custom:https://mirror.example.org/"]').waitFor();
    assert.equal(await input.inputValue(), '');
    await sources.locator('[data-source="custom:https://mirror.example.org/"]').getByRole('button', { name: 'Remove custom source' }).click();
    await sources.locator('[data-source="custom:https://mirror.example.org/"]').waitFor({ state: 'detached' });
    await sources.locator('[data-source="custom:https://gh-proxy.example.com/"]').getByRole('button', { name: 'Remove custom source' }).click();
    await sources.locator('[data-source="custom:https://gh-proxy.example.com/"]').waitFor({ state: 'detached' });
    assert.equal(await selectedSource(), 'github');

    // Release notes: collapsed by default, expand shows the notes for the current language.
    const notes = page.getByRole('region', { name: 'Release notes' });
    const toggle = notes.getByRole('button', { name: /Release notes/ });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    await notes.getByText('Added UI mock mode').waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');

    await page.close();

    // Privacy: custom mirror URLs are masked in text (a fresh page still has the seeded mirror).
    page = await open();
    const seeded = page.locator('#updates-sources');
    await seeded.getByText('gh-proxy.example.com').waitFor();
    await setPrivacy(page, true);
    await page.waitForFunction(() => !document.querySelector('#updates-sources')?.textContent?.includes('gh-proxy.example.com'));
    await page.close();

    // --- remote mode: host-managed core has no local check/install controls; version is read-only ---
    page = await open();
    await invoke(page, 'stop_core_process');
    await invoke(page, 'save_core_connection', {
      connection: {
        mode: 'remote',
        managementOrigin: 'http://core.example.test:8317',
        managementKey: 'fixture-management-key',
        clientOrigin: 'http://client.example.test:8317',
        clientKey: 'fixture-client-key',
      },
    });
    const remoteCard = page.getByRole('region', { name: 'Proxy core' });
    await remoteCard.getByText('Remote core', { exact: true }).first().waitFor();
    await remoteCard.getByText(/Can't install or update the core in Remote mode/).waitFor();
    assert.equal(await remoteCard.getByRole('button', { name: /Install|Update to/ }).count(), 0);
    assert.equal(await remoteCard.getByRole('button', { name: 'Use bundled' }).count(), 0);
    assert.equal(await remoteCard.getByRole('button', { name: 'Check for Updates' }).count(), 0);
    await page.close();

    // --- narrow width: cards stack, no horizontal overflow ---
    page = await open({ width: 680, height: 900 });
    await page.getByRole('region', { name: 'Proxy core' }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `horizontal overflow ${overflow}px at 680`);
    await page.close();

    assert.deepEqual(runtimeErrors, []);
    console.log('PASS: settings updates — app/core cards, confirm + install + bundled, source switching, custom mirror add/validate/remove, release notes, privacy, remote host-managed without local controls, narrow layout.');
  } finally {
    await browser?.close();
    await server?.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
