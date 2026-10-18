const assert = require('node:assert/strict');
const { startFixtureServer, launchBrowser, openPage, selectors } = require('./helpers/apiFixture.cjs');

// Provider health: the per-config dialog checks models one by one or all together and feeds the row's status pill; "check
// all" probes every enabled config of the scope once (first configured model, else a discovered one), reports failures
// with their error, skips disabled configs, and "Details" opens the per-model dialog (fixture: tests/fixtures/api-health.tsx).
(async () => {
  const { server, base } = await startFixtureServer(['tests/fixtures/api-health.html']);
  let browser;
  try {
    browser = await launchBrowser();
    const { page, errors } = await openPage(browser, base, { width: 1280, height: 900 }, { consoleErrors: true });
    await page.goto(`${base}/tests/fixtures/api-health.html?brand=claude`, { waitUntil: 'domcontentloaded' });
    const rows = page.locator(selectors.row);
    await rows.nth(1).waitFor();
    const okRow = rows.filter({ hasText: 'Claude ok' });
    const brokenRow = rows.filter({ hasText: 'Claude broken' });
    const probes = () => page.evaluate(() => window.healthFixture.probes);

    // Single config: model list = configured models, check one then all.
    await okRow.getByRole('button', { name: 'Health Check', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /^Model Health Check/ });
    await dialog.getByText('claude-b', { exact: true }).waitFor();
    assert.equal(await dialog.locator('.ec-api-health__row').count(), 2);
    assert.equal(await dialog.getByText('Not checked').count(), 2);
    await dialog.locator('.ec-api-health__row', { hasText: 'claude-a' }).getByRole('button', { name: 'Check', exact: true }).click();
    await dialog.locator('.ec-api-health__row', { hasText: 'claude-a' }).getByText(/Healthy · TTFT 120 ms/).waitFor();
    assert.equal(await dialog.getByText('Not checked').count(), 1, 'Only the checked model changes');
    await dialog.getByRole('button', { name: 'Check All Models', exact: true }).click();
    await dialog.getByText('Checked 2/2 · Healthy 2 · Failed 0').waitFor();
    assert.equal((await probes()).length, 3);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await okRow.getByText('Healthy', { exact: true }).waitFor();

    // Broken config: failure text and a failed pill on the row.
    await brokenRow.getByRole('button', { name: 'Health Check', exact: true }).click();
    await dialog.getByRole('button', { name: 'Check All Models', exact: true }).click();
    await dialog.getByText(/HTTP 502 upstream connect error/).waitFor();
    await dialog.getByText('Checked 1/1 · Healthy 0 · Failed 1').waitFor();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await brokenRow.getByText('Failed', { exact: true }).waitFor();
    assert.equal(await okRow.getByText('Failed', { exact: true }).count(), 0, 'One config failing does not mark its sibling');

    // Check all for the scope: one probe per enabled config, failure reported, details open the per-model dialog.
    const before = (await probes()).length;
    await page.getByRole('button', { name: 'Check all', exact: true }).click();
    const bulk = page.getByRole('dialog', { name: 'Check all keys', exact: true });
    await bulk.getByText('Healthy 1 · Failed 1 · Skipped 0').waitFor();
    assert.equal((await probes()).length - before, 2, 'Check all sends exactly one probe per config');
    assert.ok((await probes()).slice(before).some(probe => probe.model === 'claude-a' || probe.model === 'claude-b'), 'Uses a configured model');
    await bulk.locator('.ec-api-health__row', { hasText: 'Claude broken' }).getByText(/HTTP 502/).waitFor();
    await bulk.locator('.ec-api-health__row', { hasText: 'Claude broken' }).getByRole('button', { name: 'Details', exact: true }).click();
    await bulk.waitFor({ state: 'detached' });
    await page.getByRole('dialog', { name: /^Model Health Check/ }).getByText('claude-c', { exact: true }).waitFor();
    await page.keyboard.press('Escape');

    // Codex: no configured model → one discovery request supplies the probe model; the disabled sibling is skipped.
    await page.getByRole('group', { name: 'Brand' }).getByRole('button', { name: /^Codex/ }).click();
    await rows.filter({ hasText: 'Codex ok' }).waitFor();
    const discoveriesBefore = await page.evaluate(() => window.healthFixture.discoveries);
    await page.getByRole('button', { name: 'Check all', exact: true }).click();
    const codexBulk = page.getByRole('dialog', { name: 'Check all keys', exact: true });
    await codexBulk.getByText('Healthy 1 · Failed 0 · Skipped 0').waitFor();
    assert.equal(await codexBulk.locator('.ec-api-health__row').count(), 1, 'Disabled configs are not checked');
    assert.ok(await page.evaluate(() => window.healthFixture.discoveries) > discoveriesBefore);
    assert.ok((await probes()).at(-1).model === 'discovered-model');
    await codexBulk.getByRole('button', { name: 'Close', exact: true }).click();
    assert.deepEqual(errors, []);
    console.log('PASS: provider health: per-model check, check all models, row status pills, check-all scope with discovery, failures and skipped configs.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
