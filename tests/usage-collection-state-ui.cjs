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
    // The `success` tone class marks a collector that is live; every other state is not.
    const isLive = locator => locator.evaluate(element => element.classList.contains('success'));
    page.on('pageerror', error => errors.push(String(error)));

    await page.goto(`${base}/tests/fixtures/usage-layout.html?locale=en&core=running`);
    const state = page.locator('.usage-collector-state');
    const setCore = scenario => page.evaluate(value => window.usageStateFixture.setCore(value), scenario);
    await page.waitForFunction(() => document.querySelector('.usage-collector-state')?.textContent?.includes('Collecting Locally'));
    assert.equal(await isLive(state), true);
    assert.doesNotMatch(await state.innerText(), /Last record/, 'the timestamp is hidden while live');
    await setCore('stopped');
    await page.waitForFunction(() => document.querySelector('.usage-collector-state')?.textContent?.includes('Core stopped'));
    assert.equal(await isLive(state), false);
    assert.match(await state.innerText(), /Last record/, 'the timestamp is shown when stopped');
    await setCore('running');
    await page.waitForFunction(() => document.querySelector('.usage-collector-state')?.textContent?.includes('Collecting Locally'));
    assert.equal(await isLive(state), true);

    await setCore('unknown');
    await page.waitForFunction(() => document.querySelector('.usage-collector-state')?.textContent?.includes('Core status unknown'));
    assert.equal(await isLive(state), false);
    await setCore('running');
    await page.waitForFunction(() => document.querySelector('.usage-collector-state')?.textContent?.includes('Collecting Locally'));

    for (const [scenario, label] of [
      ['starting', 'Waiting for Core'],
      ['uninstalled', 'Core unavailable'],
    ]) {
      await setCore(scenario);
      await page.waitForFunction(expected => document.querySelector('.usage-collector-state')?.textContent?.includes(expected), label);
      assert.equal(await isLive(state), false, `${scenario} is never presented as live`);
    }

    await page.goto(`${base}/tests/fixtures/usage-layout.html?locale=en&core=stopped&collector=restarted`);
    const restartedState = page.locator('.usage-collector-state');
    await page.waitForFunction(() => document.querySelector('.usage-collector-state')?.textContent?.includes('Core stopped'));
    assert.equal(await isLive(restartedState), false);
    assert.match(
      await restartedState.innerText(),
      /Last record\s+Mar \d{1,2}, 2026/,
      'after a restart with the core stopped, the stored record time is shown',
    );

    await page.goto(`${base}/tests/fixtures/usage-layout.html?locale=en&core=error`);
    const errorState = page.locator('.usage-collector-state');
    await page.waitForFunction(() => document.querySelector('.usage-collector-state')?.textContent?.includes('Collection Error'));
    assert.equal(await isLive(errorState), false, 'collector error is never presented as live');

    await page.goto(`${base}/tests/fixtures/usage-layout.html?locale=zh-CN&core=stopped`);
    const translatedState = page.locator('.usage-collector-state');
    await page.waitForFunction(() => document.querySelector('.usage-collector-state')?.textContent?.includes('内核已停止'));
    assert.match(await translatedState.innerText(), /内核已停止 · 采集已暂停/);
    assert.match(await translatedState.innerText(), /最近记录/);
    assert.deepEqual(errors, []);
    console.log('PASS: transitions, stopped/unknown/starting/uninstalled/error states, zh-CN labels and collection timestamp visibility verified.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
