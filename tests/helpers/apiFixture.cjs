// Shared plumbing for the API-key package UI tests: a vite server for fixture pages and a locked-down chromium.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');

async function startFixtureServer(entries) {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '..', '..'),
    plugins: [react()],
    optimizeDeps: { entries },
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  await server.listen();
  return { server, base: `http://127.0.0.1:${server.httpServer.address().port}` };
}

async function launchBrowser() {
  const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  return chromium.launch({ channel, headless: true, args: ['--no-proxy-server'] });
}

/** New page that only talks to the fixture server and records page errors (and console errors when `consoleErrors`). */
async function openPage(browser, base, viewport, { consoleErrors = false } = {}) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  if (consoleErrors) page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', (route) => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
  return { page, errors };
}

/** Locators for the package's DOM contract (see src/sections/providers/api). */
const selectors = {
  row: '[data-testid=api-key-row]',
  advancedSummary: '.ec-api-form > details > summary',
  modelEntryInputs: '.ec-api-model__row input',
};

module.exports = { startFixtureServer, launchBrowser, openPage, selectors };
