// Shared by the sign-in UI tests (devin-ui, meta-oauth-ui, plugin-oauth-providers-ui): a throwaway vite server for the
// fixture pages in tests/fixtures and a chromium launcher that follows the other fixture tests' conventions.
const path = require('node:path');

async function startFixtureServer(entryHtml, cacheName, port = 1440) {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '..', '..'),
    cacheDir: `node_modules/.vite-signin-${cacheName}`,
    plugins: [react()],
    logLevel: 'error',
    optimizeDeps: { entries: [`tests/fixtures/${entryHtml}`] },
    server: { host: '127.0.0.1', port, strictPort: false, watch: null },
  });
  await server.listen();
  return { base: `http://127.0.0.1:${server.httpServer.address().port}`, close: () => server.close() };
}

async function launchBrowser(chromium) {
  const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  return chromium.launch({ channel, headless: true, args: ['--no-proxy-server'] });
}

/** Opens a page that only talks to the fixture server (every other request is aborted). */
async function newOfflinePage(browser, base, viewport = { width: 1280, height: 900 }) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.route('**/*', (route) => (route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort()));
  return { page, errors };
}

module.exports = { startFixtureServer, launchBrowser, newOfflinePage };
