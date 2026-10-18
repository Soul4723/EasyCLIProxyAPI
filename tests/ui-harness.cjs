// Shared harness for tests/*-ui.cjs: browser selection and a self-contained Vite server.
//
// Browser: PLAYWRIGHT_CHANNEL (for example `msedge` or `chrome`) when set; otherwise
// bundled Chromium on every platform. THEME_BROWSER retains the older theme-suite
// override. Set PLAYWRIGHT_MODULE to use an existing Playwright installation.
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function browserChannel() {
  return process.env.PLAYWRIGHT_CHANNEL || process.env.THEME_BROWSER || undefined;
}

// Playwright launch options for Chromium; `extra` (for example `{ args }`) is merged in.
function launchOptions(extra = {}) {
  const channel = browserChannel();
  return { ...(channel ? { channel } : {}), headless: true, ...extra };
}

function launchBrowser(engine, extra = {}) {
  return engine.launch(launchOptions(extra));
}

// Starts a private Vite dev server on a free port for the fixtures under tests/fixtures.
// Pass `existingUrl` (usually a *_TEST_URL environment override) to reuse a running server instead.
async function startDevServer(existingUrl) {
  if (existingUrl) return { base: existingUrl.replace(/\/$/, ''), close: async () => {} };
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({
    configFile: false, root, plugins: [react()], logLevel: 'error',
    cacheDir: path.join(root, 'node_modules/.vite-ui-tests'),
    optimizeDeps: { entries: ['index.html', 'tests/fixtures/**/*.html'] },
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  await server.listen();
  return { base: `http://127.0.0.1:${server.httpServer.address().port}`, close: () => server.close() };
}

// Runs `main({ base })` against a private dev server (or `options.url`), always closing the
// server and failing the process with exit code 1 when `main` throws.
async function runUi(main, options = {}) {
  let devServer;
  try {
    devServer = await startDevServer(options.url);
    await main({ base: devServer.base });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (devServer) await devServer.close();
  }
}

module.exports = { browserChannel, launchOptions, launchBrowser, startDevServer, runUi };
