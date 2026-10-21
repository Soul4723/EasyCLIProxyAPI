// Helpers for the Providers → credentials UI tests (src/sections/providers/creds). They drive the real app in the browser
// mock at `#/providers?preview=creds`, so every assertion runs against the actual list, panel and dialogs.
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { openApp, setTheme } = require('./shell.cjs');

/** Uses UI_BASE when set, otherwise starts a private vite server on a free port. */
async function startApp() {
  if (process.env.UI_BASE) return { base: process.env.UI_BASE, close: async () => {} };
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({
    configFile: false, root: path.resolve(__dirname, '..', '..'), plugins: [react()], logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  await server.listen();
  return { base: `http://127.0.0.1:${server.httpServer.address().port}/`, close: () => server.close() };
}

async function launch() {
  const channel = process.env.PLAYWRIGHT_CHANNEL;
  return chromium.launch(channel ? { channel, headless: true, args: ['--no-proxy-server'] } : { headless: true, args: ['--no-proxy-server'] });
}

/**
 * Opens the creds preview. `creds` is the mock fixture (one | states | forty | none | fail). Installs, before the app
 * loads, a thin wrapper around the Tauri IPC entry point that records every management request and lets a test hold a
 * response (`window.__creds.hold(method, path)` returns a release function).
 */
async function openCreds(browser, base, { creds = 'states', width = 1440, height = 900, theme, privacy = false, remote = false, clock } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.setDefaultTimeout(10000);
  if (clock) await page.clock.install({ time: clock });
  await page.addInitScript((wantPrivacy) => {
    localStorage.setItem('easy-cli-proxy-api.locale', 'en');
    if (wantPrivacy) localStorage.setItem('easy-cli-proxy-api.privacy-mode', 'on');
    window.__creds = { requests: [], holds: [], failNext: [], staleRead: null };
    const wrap = () => {
      const internals = window.__TAURI_INTERNALS__;
      if (!internals || internals.__credsWrapped) return !!internals;
      internals.__credsWrapped = true;
      const original = internals.invoke.bind(internals);
      internals.invoke = async (cmd, args, options) => {
        if (cmd !== 'management_request') return original(cmd, args, options);
        const request = args && args.request ? args.request : {};
        const entry = { method: String(request.method).toUpperCase(), path: request.path, body: request.body, query: request.query };
        window.__creds.requests.push(entry);
        const failIndex = window.__creds.failNext.findIndex((item) => item.method === entry.method && item.path === entry.path);
        if (failIndex >= 0) { const [{ message }] = window.__creds.failNext.splice(failIndex, 1); throw new Error(message); }
        const holdIndex = window.__creds.holds.findIndex((item) => item.method === entry.method && item.path === entry.path && item.when === 'before');
        if (holdIndex >= 0) { const [{ gate }] = window.__creds.holds.splice(holdIndex, 1); await gate; }
        let result = await original(cmd, args, options);
        const afterIndex = window.__creds.holds.findIndex((item) => item.method === entry.method && item.path === entry.path && item.when === 'after');
        if (afterIndex >= 0) { const [{ gate }] = window.__creds.holds.splice(afterIndex, 1); await gate; }
        if (entry.method === 'GET' && entry.path === '/credentials' && window.__creds.mapFiles) {
          result = { ...result, files: result.files.map((file) => window.__creds.mapFiles(file)) };
        }
        return result;
      };
      return true;
    };
    // The mock installs the IPC bridge during startup; wrap it as soon as it exists.
    const timer = setInterval(() => { if (wrap()) clearInterval(timer); }, 5);
    window.__creds.hold = (method, path, when = 'before') => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      window.__creds.holds.push({ method, path, when, gate });
      return release;
    };
  }, privacy);
  await openApp(page, base, { path: '/providers', query: `creds=${creds}&preview_dummy=1` });
  // openApp builds the hash from a path without a query string; add the preview parameter.
  await page.evaluate((hash) => { window.location.hash = hash; }, CREDS_HASH);
  await page.waitForFunction(() => document.querySelector('.ec-page-title') && /Providers/.test(document.querySelector('.ec-page-title').textContent));
  // The dev-only mock toolbar floats over the bottom-right corner, where the panel footer buttons are.
  await page.addStyleTag({ content: '#browser-mock-toolbar { display: none !important; }' });
  if (theme) await setTheme(page, theme);
  if (remote) {
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      await invoke('stop_core_process');
      await invoke('save_core_connection', { connection: { mode: 'remote', managementOrigin: 'http://127.0.0.1:9', managementKey: 'fixture-management-key', clientOrigin: 'http://127.0.0.1:9', clientKey: 'fixture-client-key' } });
    });
    // Stopping the local core gates Providers; the target switch reloads the document.
    // Wait for the new target before reopening the credentials route.
    await page.waitForFunction(() => document.querySelector('.ec-core-line')?.dataset.coreStatus === 'remote');
    await page.evaluate(hash => { location.hash = hash; }, CREDS_HASH);
  }
  await page.waitForSelector('.ec-table tbody tr.ec-table__row, .ec-empty, [role=alert]');
  return { page, errors };
}

// Where the credentials list lives. Retarget these two lines when the Providers page composition replaces the preview harness.
const CREDS_HASH = '/providers?preview=creds';
const openExclusions = (page) => page.getByText('Model exclusions', { exact: true }).click();

const requestsOf = (page, method, pathName) => page.evaluate(([m, p]) => window.__creds.requests.filter((item) => item.method === m && item.path === p), [method, pathName]);
const rowOf = (page, text) => page.locator('tr.ec-table__row', { hasText: text });
const pills = (page) => page.locator('tr.ec-table__row .ec-pill, tr.ec-table__row [class*="ec-status"]');

module.exports = { startApp, launch, openCreds, openExclusions, requestsOf, rowOf, pills };
