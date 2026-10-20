const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '..'),
    plugins: [react()],
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL, headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));

    for (const [scenario, label] of [
      ['stopped', 'Core stopped · collection paused'],
      ['unknown', 'Core status unknown · history only'],
    ]) {
      await page.goto(`${base}/tests/fixtures/usage-layout.html?locale=en&core=${scenario}`);
      const state = page.locator('.usage-collector-state');
      await page.waitForFunction(expected => document.querySelector('.usage-collector-state')?.textContent?.includes(expected), label);
      assert.equal(await state.getAttribute('data-live'), 'false', `${scenario} core is never presented as live`);
      assert.ok((await state.innerText()).includes(label));
      assert.match(await state.innerText(), /Last record/, 'the most recent collection time is shown when known');
    }

    await page.goto(`${base}/tests/fixtures/usage-layout.html?locale=en&core=running`);
    await page.waitForFunction(() => document.querySelector('.usage-collector-state')?.textContent?.includes('Collecting Locally'));
    assert.equal(await page.locator('.usage-collector-state').getAttribute('data-live'), 'true');
    assert.deepEqual(errors, []);
    console.log('PASS: stopped, unknown and running core states label stored Usage history honestly.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
