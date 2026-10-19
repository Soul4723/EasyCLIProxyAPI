// Usage section (#/usage, /requests, /routing, /prices, /data) against the browser mock.
const realAssert = require('node:assert/strict');
const {
  runUiTest, reopenApp, gotoPage, setPrivacy, setTheme, setDensity, themeState, horizontalOverflow, settle,
} = require('../../helpers/shell.cjs');

let checks = 0;
const assert = new Proxy(realAssert, {
  get: (target, key) => (typeof target[key] === 'function' ? (...args) => { checks += 1; return target[key](...args); } : target[key]),
  apply: (target, self, args) => { checks += 1; return target(...args); },
});
const ok = (value, message) => { checks += 1; realAssert.ok(value, message); };

const TABS = [['overview', '/usage'], ['requests', '/usage/requests'], ['routing', '/usage/routing'], ['prices', '/usage/prices'], ['data', '/usage/data']];

/** Records every IPC call made after this runs (browser mock invoke). */
const recordInvokes = (page) => page.evaluate(() => {
  const internals = window.__TAURI_INTERNALS__;
  if (internals.__recorded) return;
  const original = internals.invoke.bind(internals);
  internals.__recorded = [];
  internals.invoke = (cmd, args, options) => { internals.__recorded.push([cmd, JSON.stringify(args ?? null)]); return original(cmd, args, options); };
});
const recorded = (page) => page.evaluate(() => window.__TAURI_INTERNALS__.__recorded);

const rowsOf = (page) => page.locator('.usage-body tbody tr');
// Total matching rows: from the pager, or the row count when everything fits one page and no pager is shown.
const pagerTotal = async (page) => {
  const range = page.locator('.ec-pager__range');
  if (await range.count() === 0) return rowsOf(page).count();
  return Number((await range.innerText()).match(/of\s+(\d+)/)?.[1]);
};

runUiTest('usage', async ({ base, newPage }) => {
  const page = await newPage({ viewport: { width: 1440, height: 900 } });

  // ---- tab bar + deep links
  await reopenApp(page, base, { path: '/usage' });
  const tabs = page.getByRole('tab');
  await tabs.first().waitFor();
  assert.equal(await tabs.count(), 5, 'tab bar has 5 tabs');
  assert.deepEqual(await tabs.allInnerTexts(), ['Overview', 'Requests', 'Routing', 'Prices', 'Data']);
  for (const [id, path] of TABS) {
    await reopenApp(page, base, { path });
    await page.getByRole('tab', { selected: true }).waitFor();
    assert.equal(await tabs.nth(TABS.findIndex(([t]) => t === id)).getAttribute('aria-selected'), 'true', `deep link ${path} selects ${id}`);
    assert.equal(await page.locator('.usage-body').getAttribute('id'), 'usage-subtabs-panel');
  }

  // ---- Overview
  await reopenApp(page, base, { path: '/usage' });
  await page.locator('.ec-stat').first().waitFor();
  assert.equal(await page.locator('.usage-body .ec-stat').count(), 6, 'six stat tiles');
  ok(await page.locator('.usage-body .ec-area-chart').isVisible(), 'trend chart is visible');
  ok(await page.locator('.usage-body .ec-hbar__row').count() > 0, 'provider bars render');
  ok(await page.locator('.usage-body .ec-hbar .ec-provider-logo').count() > 0, 'provider bars carry provider logos');
  const cost = page.locator('.ov-mode-off');
  assert.equal(await cost.count(), 1);
  assert.equal(await cost.isDisabled(), true, 'Cost trend option is disabled');
  await recordInvokes(page);
  await page.getByRole('radio', { name: '7D' }).click();
  await settle(page);
  const calls = await recorded(page);
  const overviewCalls = calls.filter(([cmd]) => cmd === 'get_usage_overview');
  ok(overviewCalls.length > 0, 'changing the period refetches the overview');
  const before = (await recorded(page)).length;
  await page.getByRole('radio', { name: '30D' }).click();
  await settle(page);
  ok((await recorded(page)).length > before, 'another period triggers another request');
  const queries = new Set((await recorded(page)).filter(([cmd]) => cmd === 'get_usage_overview').map(([, args]) => args));
  ok(queries.size >= 2, 'the period changes the overview query');

  // ---- Requests
  await reopenApp(page, base, { path: '/usage/requests' });
  await rowsOf(page).first().waitFor();
  await page.evaluate(() => document.getElementById('browser-mock-toolbar')?.remove());
  assert.equal(await rowsOf(page).count(), 50, 'first page has 50 rows');
  const total = await pagerTotal(page);
  ok(total > 50, 'mock data spans more than one page');
  await page.locator('select[aria-label="Result"]').selectOption({ label: 'Failed' });
  await page.waitForFunction((n) => document.querySelectorAll('.usage-body tbody tr').length < n, 50);
  const failedRows = await rowsOf(page).count();
  ok(failedRows > 0 && failedRows < 50, 'result filter reduces rows');
  await page.locator('select[aria-label="Result"]').selectOption({ label: 'All results' });
  await page.waitForFunction(() => document.querySelectorAll('.usage-body tbody tr').length === 50);
  await page.locator('.ec-pager__controls button').last().click();
  await page.waitForFunction(() => /^51/.test(document.querySelector('.ec-pager__range')?.textContent ?? ''));
  assert.equal(await rowsOf(page).count(), Math.min(50, total - 50), 'second page is full or holds the remainder');
  await page.locator('.ec-pager__controls button').first().click();
  await page.waitForFunction(() => /^1/.test(document.querySelector('.ec-pager__range')?.textContent ?? ''));
  await rowsOf(page).first().click();
  const drawer = page.getByRole('dialog', { name: 'Request details' });
  await drawer.waitFor();
  ok(await drawer.isVisible(), 'row click opens the drawer');
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('dialog').count(), 0, 'Esc closes the drawer');

  await reopenApp(page, base, { path: '/usage/requests?account=mock-codex-1' });
  await rowsOf(page).first().waitFor();
  const accountTotal = await pagerTotal(page);
  ok(accountTotal > 0 && accountTotal < total, `?account= filters rows (${accountTotal} < ${total})`);
  await reopenApp(page, base, { path: '/usage/requests?provider=claude' });
  await rowsOf(page).first().waitFor();
  const providerTotal = await pagerTotal(page);
  ok(providerTotal > 0 && providerTotal < total, `?provider= filters rows (${providerTotal} < ${total})`);

  await reopenApp(page, base, { path: '/usage/requests' });
  await rowsOf(page).first().waitFor();
  const tbody = page.locator('.usage-body tbody');
  await setPrivacy(page, false);
  ok((await tbody.innerText()).includes('@example.test'), 'accounts are visible with privacy off');
  await setPrivacy(page, true);
  assert.equal((await tbody.innerText()).includes('@example.test'), false, 'privacy masks account emails');
  await setPrivacy(page, false);

  // ---- Routing
  await reopenApp(page, base, { path: '/usage/routing' });
  await page.locator('.rt-group').first().waitFor();
  ok(await page.locator('.rt-facts .rt-fact').count() >= 4, 'policy strip shows facts');
  ok(await page.locator('.rt-group').count() >= 1, 'candidate groups render');
  ok(await page.locator('.rt-cand').count() >= 1, 'candidates render');
  ok(await page.locator('.rt-event').count() >= 1, 'stream rows render');

  // ---- Prices
  await reopenApp(page, base, { path: '/usage/prices' });
  await rowsOf(page).first().waitFor();
  ok(await rowsOf(page).count() >= 1, 'price table has rows');
  await page.getByRole('button', { name: 'Add price' }).click();
  const addDialog = page.getByRole('dialog', { name: 'Add model price' });
  await addDialog.waitFor();
  ok(await addDialog.isVisible(), 'add-price dialog opens');
  await addDialog.getByRole('button', { name: 'Cancel' }).click();
  await addDialog.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('dialog').count(), 0, 'add-price dialog closes');

  // ---- Data
  await reopenApp(page, base, { path: '/usage/data' });
  await page.locator('.data-grid .ec-card').first().waitFor();
  const cards = await page.locator('.data-grid .ec-card__title').allInnerTexts();
  ok(cards.some((t) => /storage/i.test(t)) && cards.some((t) => /collector/i.test(t)), `storage + collector cards (${cards.join(', ')})`);

  // ---- empty / error mocks
  for (const [id, path] of TABS) {
    await reopenApp(page, base, { mock: 'empty', path });
    await page.locator('.usage-body').waitFor();
    await page.waitForTimeout(500);
    ok((await page.locator('.usage-body').innerText()).trim().length > 0, `mock=empty ${id} renders content`);
    await reopenApp(page, base, { mock: 'error', path });
    await page.locator('.usage-body').waitFor();
    await page.waitForTimeout(500);
    ok((await page.locator('.usage-body').innerText()).trim().length > 0, `mock=error ${id} renders content`);
  }
  await reopenApp(page, base, { mock: 'empty', path: '/usage' });
  await page.getByText('No requests in this range yet').waitFor();
  await reopenApp(page, base, { mock: 'empty', path: '/usage/requests' });
  await page.getByText('No requests yet').waitFor();
  await reopenApp(page, base, { mock: 'error', path: '/usage' });
  await page.getByRole('alert').filter({ hasText: 'Could not load usage' }).waitFor();
  await reopenApp(page, base, { mock: 'error', path: '/usage/requests' });
  await page.getByRole('alert').filter({ hasText: 'Could not load usage' }).waitFor();
  assert.deepEqual(page.errors.filter((e) => e.startsWith('pageerror')), [], 'empty/error mocks raise no page errors');

  // ---- no horizontal overflow
  for (const width of [1440, 1024, 680]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [id, path] of TABS) {
      await reopenApp(page, base, { path });
      await page.locator('.usage-body').waitFor();
      await page.waitForTimeout(400);
      assert.deepEqual(await horizontalOverflow(page), [], `${id} @${width}: no horizontal page overflow`);
    }
  }

  // ---- compact density + light theme
  await page.setViewportSize({ width: 1440, height: 900 });
  await reopenApp(page, base, { path: '/usage' });
  await setDensity(page, 'compact');
  await setTheme(page, 'light');
  const state = await themeState(page);
  assert.equal(state.density, 'compact');
  assert.equal(state.theme, 'light');
  for (const [id, path] of TABS) {
    await gotoPage(page, path);
    await page.locator('.usage-body').waitFor();
    await page.waitForTimeout(400);
    ok((await page.locator('.usage-body').innerText()).trim().length > 0, `${id} renders in compact/light`);
    assert.deepEqual(await horizontalOverflow(page), [], `${id} compact/light: no overflow`);
  }

  assert.deepEqual(page.errors, [], 'no runtime errors');
  assert.deepEqual(page.externalRequests, [], 'no external requests');
  console.log(`PASS: usage UI — ${checks} assertions.`);
});
