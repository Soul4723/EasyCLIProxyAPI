// Usage's refresh contract: bounded invalidations, shared analysis and stale-data errors.
const assert = require('node:assert/strict');
const path = require('node:path');
const { runUiTest, reopenApp, emitEvent } = require('../../helpers/shell.cjs');

const installProbe = (page) => page.evaluate(() => {
  const original = window.__TAURI_INTERNALS__.invoke;
  const probe = { calls: [], fail: '', hold: '', pending: [] };
  window.__usageProbe = probe;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command.startsWith('get_usage_')) probe.calls.push({ command, args });
    if (command === probe.fail) throw new Error('Refresh unavailable');
    const held = command === probe.hold;
    if (held) probe.hold = '';
    const value = await original(command, args);
    if (held) return new Promise(resolve => probe.pending.push(() => resolve({ ...value, items: value.items.map(row => ({ ...row, model: 'late-obsolete' })) })));
    return value;
  };
});
const calls = (page, command) => page.evaluate(name => window.__usageProbe.calls.filter(call => call.command === name), command);
const reset = (page) => page.evaluate(() => { window.__usageProbe.calls = []; });
const settled = (page) => page.waitForTimeout(100);

runUiTest('usage-refresh', async ({ base, newPage }) => {
  const page = await newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => console.error(error));
  await reopenApp(page, base, { path: '/usage' });
  await page.locator('.ov .ec-area-chart').waitFor();
  await page.clock.install();
  await installProbe(page);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settled(page);
  assert.equal((await calls(page, 'get_usage_analysis')).length, 1, 'options and Overview share identical analysis');
  const initialEnd = (await calls(page, 'get_usage_overview'))[0].args.query.end;
  // Freeze while emitting the burst: RPC time must not consume the 2s window
  // before the 1999ms boundary assertion. The clock resumes below.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await reset(page);
  for (let i = 0; i < 40; i++) await emitEvent(page, 'usage-records-updated');
  await page.clock.fastForward(1999);
  assert.equal((await calls(page, 'get_usage_overview')).length, 0, 'event burst waits for trailing window');
  await page.clock.fastForward(1);
  await settled(page);
  assert.equal((await calls(page, 'get_usage_overview')).length, 1, 'one refresh for forty events');
  assert.equal((await calls(page, 'get_usage_analysis')).length, 1, 'analysis stays shared after events');
  assert.equal((await calls(page, 'get_usage_overview'))[0].args.query.end, initialEnd, 'records do not move the time window');
  await reset(page);
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('focus')); });
  await settled(page);
  assert.equal((await calls(page, 'get_usage_overview')).length, 0, 'recent focus does not refetch');
  await page.clock.fastForward(31_000);
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('focus')); });
  await settled(page);
  assert.equal((await calls(page, 'get_usage_overview')).length, 1, 'stale focus refreshes only once');

  // A filter change and a manual refresh each establish fresh records;
  // the shared focus owner must not issue another query immediately afterward.
  await page.clock.fastForward(31_000);
  await page.getByRole('radio', { name: '7D', exact: true }).click();
  await settled(page);
  await reset(page);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await settled(page);
  assert.equal((await calls(page, 'get_usage_overview')).length, 0, 'filter change makes recent focus fresh');
  await page.clock.fastForward(31_000);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settled(page);
  await reset(page);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await settled(page);
  assert.equal((await calls(page, 'get_usage_overview')).length, 0, 'manual refresh makes recent focus fresh');

  await page.clock.resume();

  // Refresh failure must leave each chart/table on screen, with a visible error.
  const tabs = [
    ['/usage', 'get_usage_overview', '.ov .ec-area-chart'],
    ['/usage/requests', 'get_usage_events', '.req-table tbody tr'],
    ['/usage/routing', 'get_usage_events', '.rt-events .rt-event'],
    ['/usage/prices', 'get_usage_pricing', '.prices-table tbody tr'],
    ['/usage/data', 'get_usage_storage_settings', '.data-stats'],
  ];
  for (const [route, command, content] of tabs) {
    await reopenApp(page, base, { path: route });
    await page.locator(content).first().waitFor();
    await installProbe(page);
    await page.screenshot({ path: path.join('output', 'usage-refresh', `${route.split('/').pop()}-before.png`), fullPage: true });
    await page.evaluate(name => { window.__usageProbe.fail = name; }, command);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('.usage-body .ec-empty--error').first().waitFor();
    assert.ok(await page.locator(content).first().isVisible(), `${route} keeps last good data after refresh failure`);
    assert.equal(await page.locator('.usage-body .ec-skeleton').count(), 0, `${route} refresh does not show skeletons`);
    await page.screenshot({ path: path.join('output', 'usage-refresh', `${route.split('/').pop()}-error.png`), fullPage: true });
  }

  await reopenApp(page, base, { path: '/usage/requests' });
  await page.locator('.req-table tbody tr').first().waitFor();
  await installProbe(page);
  await page.evaluate(() => { window.__usageProbe.hold = 'get_usage_events'; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => window.__usageProbe.pending.length === 1);
  const result = page.getByRole('combobox', { name: 'Result', exact: true });
  await result.selectOption('success');
  await settled(page);
  await page.evaluate(() => window.__usageProbe.pending.splice(0).forEach(release => release()));
  await settled(page);
  assert.equal(await page.getByText('late-obsolete', { exact: true }).count(), 0, 'late response cannot overwrite newer filter query');

  // Stopped local history stays available, but all Usage timers stop.
  for (const mock of ['stopped', 'error']) {
    await reopenApp(page, base, { mock, path: '/usage' });
    await page.locator('.usage-body').waitFor();
    await installProbe(page);
    await page.clock.fastForward(120_000);
    await settled(page);
    assert.equal((await page.evaluate(() => window.__usageProbe.calls)).length, 0, `${mock}: no Usage polling`);
  }
  console.log('PASS: Usage refresh contract (sharing, event bursts, focus, stale errors across five tabs, late responses, stopped/error idle).');
});
