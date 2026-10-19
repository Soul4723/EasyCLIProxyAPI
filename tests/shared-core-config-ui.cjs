// Cross-page ownership: real mounted consumers share reads and save publications.
const assert = require('node:assert/strict');
const { runUiTest, openApp, setPrivacy } = require('./helpers/shell.cjs');
runUiTest('shared-core-config', async ({ base, newPage }) => {
  const page = await newPage();
  await openApp(page, base, { path: '/overview', mock: 'running' });
  await page.getByTestId('ov-key').waitFor();
  await page.evaluate(async () => {
    const { coreConfigSource } = await import('/src/services/coreConfig.ts');
    await coreConfigSource.load();
    window.__configReads = 0;
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args, options) => {
      if (command === 'get_core_config_settings') window.__configReads++;
      return original(command, args, options);
    };
  });
  const navigate = async path => { await page.evaluate(path => { location.hash = path; }, path); };
  await navigate('/usage/data');
  await page.getByText('Redis queue retention', { exact: false }).first().waitFor();
  await navigate('/usage/routing');
  await page.locator('.rt-policy').waitFor();
  await navigate('/settings/routing');
  const strategy = page.getByRole('radiogroup', { name: 'Routing Strategy' });
  await strategy.waitFor();
  assert.equal(await page.evaluate(() => window.__configReads), 0, 'navigation reuses the Overview cache');
  await strategy.getByRole('radio', { name: 'Fill First', exact: true }).click();
  await page.waitForFunction(async () => (await import('/src/services/coreConfig.ts')).coreConfigSource.getSnapshot().data.routingStrategy === 'fill-first');
  await navigate('/usage/routing');
  await page.locator('.rt-policy').getByText(/Fill.first/i).waitFor();
  // Allow the throttled disk-change invalidation; one event must not cause per-consumer fetches.
  await page.waitForTimeout(1200);
  assert.ok(await page.evaluate(() => window.__configReads) <= 1, 'save causes at most one shared reload');
  await navigate('/settings/logs');
  await page.getByLabel('Usage queue retention (seconds)').fill('123');
  await page.getByRole('region', { name: 'Unsaved changes' }).getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Saved', { exact: true }).waitFor();
  await navigate('/usage/data');
  await page.getByText(/123 s/).waitFor();
  await navigate('/settings/access');
  await page.getByTestId('api-key-row').first().getByRole('button', { name: /Edit authentication key 1/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Authentication Key', { exact: true }).fill('sk-shared-config-fixture');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  // Deny every subsequent read: Overview must display the returned save value, not fetch it itself.
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args, options) => {
      if (command === 'get_core_config_settings') return Promise.reject(new Error('background read unavailable'));
      return invoke(command, args, options);
    };
  });
  await navigate('/overview');
  await setPrivacy(page, false);
  assert.equal(await page.getByTestId('ov-key').innerText(), 'sk-…ture');
  await page.evaluate(async () => {
    const { coreConfigSource } = await import('/src/services/coreConfig.ts');
    await coreConfigSource.refresh();
    if (coreConfigSource.getSnapshot().error !== 'background read unavailable') throw new Error('expected background failure');
  });
  await navigate('/settings/access');
  await page.getByTestId('api-key-row').first().waitFor();
  // AccessTab already gives both closed dialogs the key `closed`; keep that unrelated warning visible.
  const unrelatedDialogWarning = 'console.error: Encountered two children with the same key, `%s`. Keys should be unique so that components maintain their identity across updates. Non-unique keys may cause children to be duplicated and/or omitted — the behavior is unsupported and could change in a future version. closed';
  assert.deepEqual(page.errors.filter(error => error !== unrelatedDialogWarning), []);
  console.log('PASS: shared core config — cached navigation, shared routing/retention/key saves, bounded reloads, stale settings retained.');
});
