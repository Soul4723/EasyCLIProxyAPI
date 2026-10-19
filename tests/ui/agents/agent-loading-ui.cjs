// Agents background loading. AGENT_TEST_URL, when set, reuses an existing dev server.
//
// The old page kept a client list next to the form; now the same cached data is checked on the client grid
// (statuses) and on the Codex detail page (statuses + model list, draft selection).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('../../helpers/ui-harness.cjs');
const assert = require('node:assert/strict');


runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.setDefaultTimeout(10000);
    await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&locale=en&grid`);
    const grid = page.locator('ul.ag-grid');
    const rescan = page.getByRole('button', { name: 'Rescan', exact: true });
    const picker = page.locator('.agent-model-trigger');
    const defer = commands => page.evaluate(commands => { window.fixtureDeferredCommands = commands; }, commands);
    const resolvePending = () => page.evaluate(() => {
      window.fixtureDeferredCommands = [];
      window.fixturePendingCommands.splice(0).forEach(item => item.resolve());
    });
    await page.waitForFunction(() => document.querySelectorAll('ul.ag-grid a.ag-card[data-state="connected"]').length === 16);
    const rows = await grid.innerText();
    assert.equal(await grid.locator('a.ag-card').count(), 16);

    // The cached statuses stay on screen and interactive while a background revalidation is pending.
    await page.evaluate(() => {
      window.fixtureDeferredCommands = ['get_agent_config_statuses'];
      window.fixtureRemount();
    });
    await page.waitForFunction(() => window.fixturePendingCommands?.length === 1);
    assert.equal(await page.locator('ul.ag-grid [aria-busy]').count(), 0, 'cached data replaces the skeleton');
    assert.equal(await grid.innerText(), rows);
    assert.equal(await rescan.isEnabled(), true);
    await resolvePending();
    await page.waitForFunction(() => window.fixturePendingCommands.length === 0);
    assert.equal(await grid.innerText(), rows);

    // A failed background refresh preserves usable data and surfaces its error with a retry.
    await page.evaluate(() => {
      window.fixtureFailedCommands = ['get_agent_config_statuses'];
      window.fixtureRemount();
    });
    const alert = page.getByRole('alert').filter({ hasText: 'Client detection failed' });
    await alert.waitFor();
    assert.match(await alert.textContent(), /模拟后台刷新失败/);
    assert.equal(await grid.innerText(), rows, 'the retained rows stay usable beside the error');
    await page.evaluate(() => { window.fixtureFailedCommands = []; });
    await alert.getByRole('button', { name: 'Retry' }).click();
    await alert.waitFor({ state: 'hidden' });
    assert.equal(await grid.innerText(), rows);

    // Explicit detection still runs, with a busy indicator and retained rows.
    await defer(['refresh_agent_config_statuses']);
    await rescan.click();
    await page.waitForFunction(() => window.fixturePendingCommands?.length === 1);
    assert.equal(await rescan.isDisabled(), true, 'Rescan is busy while detecting');
    assert.equal(await grid.innerText(), rows);
    await resolvePending();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Rescan')?.disabled);
    assert.equal(await grid.innerText(), rows);

    // Detail page: cached statuses and models are interactive during revalidation, and a draft survives it.
    await page.locator('ul.ag-grid a.ag-card[data-client="codex"]').click();
    await page.waitForFunction(() => document.querySelector('.agent-model-trigger strong')?.textContent === 'gpt-one');
    await page.evaluate(() => {
      window.fixtureDeferredCommands = ['get_agent_config_statuses', 'get_agent_models'];
      window.fixtureRemount();
    });
    await page.waitForFunction(() => window.fixturePendingCommands?.length === 2);
    assert.equal(await picker.locator('strong').textContent(), 'gpt-one', 'the cached model is shown while loading');
    assert.equal(await page.locator('.ag-detail-head h2').textContent(), 'Codex');
    assert.equal(await rescan.isEnabled(), true);
    await picker.click();
    await page.getByRole('option', { name: 'gpt-two' }).click();
    await resolvePending();
    await page.waitForFunction(() => document.querySelector('.agent-model-trigger strong')?.textContent === 'gpt-two');

    // Failed background refreshes preserve the usable draft and surface the model error.
    await page.evaluate(() => {
      window.fixtureFailedCommands = ['get_agent_config_statuses', 'get_agent_models'];
      window.fixtureRemount();
    });
    await page.getByText(/模拟后台刷新失败/).first().waitFor();
    assert.equal(await picker.locator('strong').textContent(), 'gpt-two');
    assert.equal(await page.locator('.ag-detail-head h2').textContent(), 'Codex');
    await page.evaluate(() => { window.fixtureFailedCommands = []; });
    assert.deepEqual(errors, []);
    console.log('PASS: cached page return, nonblocking revalidation, preserved selection, failed refresh and explicit detection');
  } finally { await browser.close(); }
}, { url: process.env.AGENT_TEST_URL });
