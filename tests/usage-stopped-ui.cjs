// Usage while the Local core is stopped: stored history stays visible, collection is labelled paused, nothing claims live.
const realAssert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runUiTest, reopenApp, invoke, settle } = require('./helpers/shell.cjs');

let checks = 0;
const assert = new Proxy(realAssert, {
  get: (target, key) => (typeof target[key] === 'function' ? (...args) => { checks += 1; return target[key](...args); } : target[key]),
});
const SHOTS = path.join(os.homedir(), '.cache', 'proxy-work', 'ui-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const chip = (page) => page.locator('.usage-collector');

runUiTest('usage-stopped', async ({ base, newPage }) => {
  const page = await newPage({ viewport: { width: 1440, height: 900 } });

  // ---- stopped core: every tab labels collection as paused and keeps history
  for (const [id, route] of [['overview', '/usage'], ['requests', '/usage/requests'], ['routing', '/usage/routing'], ['prices', '/usage/prices'], ['data', '/usage/data']]) {
    await reopenApp(page, base, { mock: 'stopped', path: route });
    await chip(page).waitFor();
    await page.waitForFunction(() => /collection paused/i.test(document.querySelector('.usage-collector')?.textContent ?? ''));
    const text = await chip(page).innerText();
    assert.match(text, /Core stopped · collection paused/, `${id}: header says collection paused (${text})`);
    assert.match(text, /last record \d{1,2}:\d{2}|last record [A-Z]/i, `${id}: header carries the last record time (${text})`);
    assert.equal(await chip(page).getAttribute('data-live'), 'false', `${id}: not styled live`);
    assert.equal(await chip(page).locator('.ec-chip__icon svg').count(), 1, `${id}: chip has an icon`);
    assert.equal(await page.locator('.usage-body').getByText(/^Live$/).count(), 0, `${id}: no "Live" label in the body`);
  }

  // history is still shown (Overview tiles, Requests rows, Routing stream)
  await reopenApp(page, base, { mock: 'stopped', path: '/usage' });
  await page.locator('.usage-body .ec-stat').first().waitFor();
  assert.ok(await page.locator('.usage-body .ec-stat').count() >= 4, 'overview still shows stat tiles');
  assert.ok(await page.locator('.usage-body .ec-hbar__row').count() > 0, 'overview still shows breakdown bars');
  await settle(page);
  await page.screenshot({ path: path.join(SHOTS, 'usage-stopped-overview.png') });

  await reopenApp(page, base, { mock: 'stopped', path: '/usage/requests' });
  await page.locator('.usage-body tbody tr').first().waitFor();
  assert.ok(await page.locator('.usage-body tbody tr').count() > 0, 'requests still lists stored rows');

  await reopenApp(page, base, { mock: 'stopped', path: '/usage/routing' });
  await page.locator('.rt-event').first().waitFor();
  const stream = page.locator('.rt-stream');
  assert.equal(await stream.getAttribute('data-live'), 'false', 'stream is not live');
  const follow = stream.getByRole('radiogroup', { name: 'Follow mode' });
  assert.deepEqual((await follow.getByRole('radio').allInnerTexts()).map((s) => s.trim()), ['Latest', 'Paused'], 'follow control reads Latest/Paused, not Live');
  assert.match(await stream.locator('.ec-card__title').first().innerText(), /^Recent requests/, 'stream title does not say Live');
  await settle(page);
  await page.screenshot({ path: path.join(SHOTS, 'usage-stopped-routing.png') });

  await reopenApp(page, base, { mock: 'stopped', path: '/usage/data' });
  await page.locator('.data-collector-head .ec-chip').waitFor();
  assert.match(await page.locator('.data-collector-head .ec-chip').innerText(), /Core stopped · collection paused/, 'Data tab collector card agrees with the header');
  await page.screenshot({ path: path.join(SHOTS, 'usage-stopped-data.png') });

  // ---- Overview page tile is labelled as stored history
  await reopenApp(page, base, { mock: 'stopped', path: '/overview' });
  await page.getByTestId('ov-usage').waitFor();
  assert.match(await page.getByTestId('ov-usage').innerText(), /Stored history · core stopped/, 'overview tile is labelled stored');
  await page.screenshot({ path: path.join(SHOTS, 'usage-stopped-home.png') });

  // ---- empty history while stopped stays an honest empty state
  await reopenApp(page, base, { mock: 'empty', path: '/usage/requests' });
  await page.getByText('No requests yet').waitFor();
  assert.equal(await chip(page).getAttribute('data-live'), 'false', 'empty: not live');

  // ---- running core: live again, then stopping flips the label without reload (shared core status, no new polling)
  await reopenApp(page, base, { mock: 'running', path: '/usage/routing' });
  await page.locator('.rt-event').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.usage-collector')?.getAttribute('data-live') === 'true');
  assert.match(await chip(page).innerText(), /Collecting locally/, 'running: collecting label');
  assert.equal(await page.locator('.rt-stream').getAttribute('data-live'), 'true');
  assert.deepEqual((await page.locator('.rt-stream').getByRole('radio').allInnerTexts()).map((s) => s.trim()), ['Live', 'Paused']);
  await page.screenshot({ path: path.join(SHOTS, 'usage-running-routing.png') });
  await invoke(page, 'stop_core_process');
  await page.waitForFunction(() => document.querySelector('.usage-collector')?.getAttribute('data-live') === 'false');
  assert.match(await chip(page).innerText(), /Core stopped · collection paused/, 'stop flips the header');
  assert.ok(await page.locator('.rt-event').count() > 0, 'history stays after stop');
  assert.equal(await page.locator('.rt-stream').getAttribute('data-live'), 'false');

  assert.deepEqual(page.errors.filter((e) => e.startsWith('pageerror')), [], 'no page errors');
  console.log(`usage-stopped: ${checks} checks`);
});
