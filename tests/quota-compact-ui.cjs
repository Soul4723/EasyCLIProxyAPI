// Mock fixtures only. Run: PLAYWRIGHT_MODULE=/path/to/playwright node tests/quota-compact-ui.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser } = require('./ui-harness.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.goto(`${base}/tests/fixtures/quota-layout.html?compact`);
    const first = page.locator('.real-quota-card').first();
    await first.waitFor();
    for (const width of [1600, 924, 560, 320, 260]) {
      await page.setViewportSize({ width: Math.max(width, 320), height: 1000 });
      await page.locator('.content').evaluate((el, width) => { el.style.width = `${width}px`; }, width);
      const details = first.locator('details');
      await details.evaluate(el => { el.open = false; });
      assert.equal(await first.locator('.quota-preview .real-quota-row').count(), 2);
      assert.equal(await first.getByText('Full quota diagnostic', { exact: false }).isVisible(), false);
      assert.equal(await details.getAttribute('open'), null);
      assert.equal(await first.locator('.quota-exhausted-summary').innerText(), 'Exhausted quota windows: 1');
      assert.equal(await first.locator('.quota-exhausted-summary').isVisible(), true);
      assert.deepEqual(await first.locator('.quota-preview .real-quota-row > div:first-child > strong').allTextContents(), ['80% remaining', '60% remaining']);
      const multiple = page.locator('.real-quota-card').nth(1);
      assert.equal(await multiple.locator('details').getAttribute('open'), null);
      assert.equal(await multiple.locator('.quota-exhausted-summary').innerText(), 'Exhausted quota windows: 2');
      assert.equal(await multiple.locator('.quota-exhausted-summary').isVisible(), true);
      // Two unknown windows alongside positive quota must not count as depleted.
      assert.equal(await page.locator('.real-quota-card').nth(2).locator('.quota-exhausted-summary').count(), 0);
      const collapsedHeight = await first.evaluate(el => el.getBoundingClientRect().height);
      await details.locator('summary').focus();
      await page.keyboard.press('Enter');
      await first.getByText('Full quota diagnostic', { exact: false }).waitFor();
      assert.equal(await details.locator('.real-quota-row').count(), 4);
      assert.match(await details.innerText(), /Unknown quota detail/);
      assert.match(await details.innerText(), /0% remaining/);
      assert.equal(await details.locator('.real-quota-track').count(), 3);
      assert.ok(await first.evaluate(el => el.getBoundingClientRect().height) > collapsedHeight + 80);
      const overflow = await page.locator('.real-quota-card').evaluateAll(cards => cards.filter(card => card.scrollWidth > card.clientWidth + 1).length);
      assert.equal(overflow, 0, `card overflow at ${width}px`);
      await details.locator('summary').focus();
      await page.keyboard.press('Space');
      assert.equal(await details.getAttribute('open'), null);
    }
    await first.getByRole('button', { name: 'Fetch or refresh quota', exact: true }).click();
    assert.equal(await page.locator('body').getAttribute('data-refreshed'), 'yes');
    const codex = page.locator('.real-quota-card').filter({ has: page.locator('strong[title="codex.json"]') });
    await codex.getByRole('button', { name: 'Reset Quota', exact: true }).click();
    assert.equal(await page.locator('body').getAttribute('data-reset'), 'yes');
    await codex.locator('summary').click();
    assert.match(await codex.innerText(), /2030/);
    assert.match(await codex.innerText(), /Priority/);
    const loading = page.locator('.real-quota-card').filter({ has: page.locator('strong[title="loading.json"]') });
    assert.equal(await loading.getAttribute('aria-busy'), 'true');
    assert.equal(await loading.getByRole('button').isDisabled(), true);
    const empty = page.locator('.real-quota-card').filter({ has: page.locator('strong[title="empty.json"]') });
    assert.match(await empty.innerText(), /No quota/);
    await page.evaluate(() => localStorage.setItem('easy-cli-proxy-api.privacy-mode', 'on'));
    await page.reload();
    await page.locator('.real-quota-card').first().waitFor();
    assert.ok(!(await page.locator('.quota-card-error').innerText()).includes('private-account@example.com'));
    assert.ok(!(await page.locator('.quota-identity').first().innerHTML()).includes('long-credential-name@example.com'));
    await page.locator('.real-quota-card').first().locator('summary').click();
    assert.ok(!(await page.locator('.quota-detail-metadata').first().innerText()).includes('long-credential-name@example.com'));
    // Real QuotaPage toggle, backed exclusively by built-in browser mock.
    await page.goto(`${base}/?mock=running&mockDelay=5`);
    await page.getByRole('button', { name: 'Quota Lookup', exact: true }).click();
    const toggle = page.getByRole('checkbox', { name: 'Compact cards' });
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), true);
    await page.locator('.quota-card-compact').first().waitFor();
    await toggle.uncheck();
    assert.equal(await page.locator('.quota-card-compact').count(), 0);
    await toggle.check();
    await page.locator('.quota-card-compact').first().waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: compact/full toggle, five widths, visible exhausted counts, keyboard details, all windows, unknown/empty/error/loading, privacy, refresh/reset. Mock fixtures only.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
