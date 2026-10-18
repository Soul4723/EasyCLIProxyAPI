// UI test: Settings → Network & TLS (host/port, upstream proxy, TLS) against the browser mock.
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
    server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], optimizeDeps: { entries: ['index.html'] }, logLevel: 'error', server: { host: '127.0.0.1', port: 5351, strictPort: false } });
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
    browser = await chromium.launch({ args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
    await openApp(page, base, { path: '/settings/network' });
    const port = page.getByLabel('Port', { exact: true });
    const host = page.getByLabel('Custom Listen IP');
    await port.waitFor();
    assert.equal(await port.inputValue(), '8317');
    const navDot = page.locator('[data-settings-tab="network"] .ec-set-nav-dot');
    const savebar = page.getByRole('region', { name: 'Unsaved changes' });
    assert.equal(await savebar.count(), 0, 'clean state has no save bar');

    // dirty dot + count; discard restores
    await port.fill('9000');
    await navDot.waitFor();
    await savebar.getByText('1 unsaved changes').waitFor();
    await savebar.getByRole('button', { name: 'Discard' }).click();
    assert.equal(await port.inputValue(), '8317');
    await navDot.waitFor({ state: "detached" });

    // port validation
    await port.fill('0');
    await savebar.getByRole('button', { name: 'Save', exact: true }).click();
    assert.match(await page.getByRole('alert').first().innerText(), /1 to 65535/);

    // allow LAN toggles host; save restarts the running local core
    await port.fill('8317');
    const lan = page.getByRole('switch', { name: 'Allow LAN access' });
    await lan.click();
    assert.equal(await host.inputValue(), '0.0.0.0');
    await savebar.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved · core restarted').waitFor();
    let calls = await page.evaluate(() => window.__calls);
    const endpoint = calls.filter((c) => c.command === 'save_network_endpoint_settings').pop();
    assert.deepEqual(endpoint.args.settings, { host: '0.0.0.0', port: 8317 }, 'proxy fields are only sent when dirty');
    assert.ok(calls.some((c) => c.command === 'restart_core_process'));
    await navDot.waitFor({ state: "detached" });

    // proxy: follow system off + URL → proxy fields sent, no restart
    await page.evaluate(() => { window.__calls.length = 0; });
    const proxyUrl = page.getByLabel('Proxy URL');
    assert.equal(await proxyUrl.isDisabled(), true);
    await page.getByRole('switch', { name: 'Follow system' }).click();
    await proxyUrl.fill('socks5://127.0.0.1:7890');
    await savebar.getByText('2 unsaved changes').waitFor();
    await savebar.getByRole('button', { name: 'Save', exact: true }).click();
    await savebar.getByText('Saved').waitFor();
    calls = await page.evaluate(() => window.__calls);
    assert.deepEqual(calls.find((c) => c.command === 'save_network_endpoint_settings').args.settings, { host: '0.0.0.0', port: 8317, proxyUrl: 'socks5://127.0.0.1:7890', proxyOverride: true });
    assert.ok(!calls.some((c) => c.command === 'restart_core_process'), 'proxy change does not restart');

    // TLS: enable requires paths; file picker fills the cert; save restarts
    await page.evaluate(() => { window.__calls.length = 0; });
    await page.getByRole('switch', { name: 'Enable TLS' }).click();
    await savebar.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText(/paths are required/).first().waitFor();
    await page.getByRole('button', { name: 'Choose File' }).first().click();
    await page.waitForFunction(() => document.querySelector('#ec-net-tls-cert')?.value.includes('mock.pem'));
    await page.locator('#ec-net-tls-key').fill('/etc/ssl/private/mock.key');
    await savebar.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved · core restarted').waitFor();
    calls = await page.evaluate(() => window.__calls);
    assert.deepEqual(calls.find((c) => c.command === 'save_core_tls_settings').args.settings, { enabled: true, cert: 'C:\\Users\\Mock\\Certificates\\mock.pem', key: '/etc/ssl/private/mock.key' });
    await page.getByText('HTTPS', { exact: true }).waitFor();

    // remote: file pickers disabled with a reason; no local restart
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      await invoke('stop_core_process', {});
      await invoke('save_core_connection', { connection: { mode: 'remote', managementOrigin: 'https://core.example.test', managementKey: 'fixture-management-key', clientOrigin: 'https://core.example.test', clientKey: 'fixture-client-key' } });
    });
    await openApp(page, base, { path: '/settings/network' });
    await page.getByRole('button', { name: 'Choose File' }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Choose File' }).first().isDisabled(), true);
    assert.match(await page.getByRole('button', { name: 'Choose File' }).first().getAttribute('title'), /remote host/);
    assert.equal(await page.locator('#ec-net-tls-cert').isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log('settings-network-ui: ok');
  } finally {
    await browser?.close();
    await server?.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
