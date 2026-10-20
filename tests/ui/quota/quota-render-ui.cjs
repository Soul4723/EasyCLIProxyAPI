const assert = require('node:assert/strict');
const h = require('../../helpers/shell.cjs');

// Counts committed renders of the account cards through a minimal React DevTools hook (the vite dev server
// serves the React development build, which reports every commit to it). Runs inside the page, before the app.
function installRenderCounter() {
  const counts = {};
  const debug = { commits: 0, visited: 0, memos: 0 };
  const PERFORMED_WORK = 1;
  const MEMO_COMPONENT = 14;
  const NAMES = ['AccountCard', 'AccountRow'];
  // The component function (plain, or inside React.memo) or the memo wrapper, whichever the fiber is.
  const nameOf = (fiber) => (fiber.tag === MEMO_COMPONENT ? fiber.type?.type?.name : fiber.type?.name);
  // A fiber rendered when it is new, carries PerformedWork or got new props; a subtree whose child pointer is unchanged bailed out.
  const rendered = (fiber, previous) => !previous || (fiber.flags & PERFORMED_WORK) !== 0 || fiber.memoizedProps !== previous.memoizedProps;
  const walk = (parent, seen) => {
    for (let fiber = parent.child; fiber; fiber = fiber.sibling) {
      const previous = fiber.alternate;
      const name = nameOf(fiber);
      if (NAMES.includes(name)) {
        debug.visited += 1;
        if (fiber.tag === MEMO_COMPONENT) debug.memos += 1;
        const key = fiber.memoizedProps?.account?.key;
        if (key && rendered(fiber, previous)) seen.add(key);
      }
      if (!previous || fiber.child !== previous.child) walk(fiber, seen);
    }
  };
  const noop = () => {};
  window.__qtRenders = {
    counts, debug,
    reset: () => { Object.keys(counts).forEach((key) => delete counts[key]); Object.assign(debug, { commits: 0, visited: 0, memos: 0 }); },
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
    onCommitFiberRoot(_id, root) {
      const seen = new Set();
      debug.commits += 1;
      walk(root.current, seen);
      seen.forEach((key) => { counts[key] = (counts[key] ?? 0) + 1; });
    },
    onCommitFiberUnmount: noop, onPostCommitFiberRoot: noop, onScheduleFiberRoot: noop, checkDCE: noop,
  };
}

h.runUiTest('quota-render-ui', async ({ base, newPage }) => {
  const page = await newPage({ init: installRenderCounter });
  await page.clock.install();
  await h.openApp(page, base, { path: '/quota' });
  await h.waitForCoreStatus(page);
  const cards = page.locator('.ec-sec-quota .qt-card');
  await cards.first().waitFor();

  const counts = () => page.evaluate(() => ({ ...window.__qtRenders.counts }));
  const reset = () => page.evaluate(() => window.__qtRenders.reset());
  const total = (map) => Object.values(map).reduce((sum, value) => sum + value, 0);
  // Wait for the initial fetches to land and the render count to stop moving.
  const settle = async () => {
    await page.waitForFunction(() => !document.querySelector('.ec-sec-quota .qt-card[aria-busy=true]'));
    let last = -1;
    for (;;) {
      const now = total(await counts());
      if (now === last) return;
      last = now;
      await page.waitForTimeout(400);
    }
  };
  const info = () => cards.evaluateAll((els) => els.map((el) => ({
    key: el.dataset.account, status: el.dataset.status, toggleable: Boolean(el.querySelector('[role=switch]:not([disabled]):not([aria-disabled=true])')),
  })));
  const countdowns = () => page.locator('.ec-sec-quota .ec-countdown').allTextContents();

  console.log('no-op tick');
  await settle();
  const accounts = await info();
  assert.ok(accounts.length >= 4, 'mock scenario has several accounts');
  // Cooling-down accounts derive a shrinking remaining time from the clock, so they may legitimately render.
  const steady = accounts.filter((account) => account.status !== 'cooldown');
  await reset();
  await page.clock.runFor(30_000);
  await settle();
  const afterTick = await counts();
  console.log(`  ${total(afterTick)} card renders over one 30 s tick, ${accounts.length} cards (${steady.length} without cooldown)`);
  for (const { key } of steady) assert.equal(afterTick[key] ?? 0, 0, `card ${key} did not render on a no-op tick`);

  console.log('countdown text');
  const before = await countdowns();
  assert.ok(before.length > 0, 'cards show countdowns');
  await reset();
  await page.clock.runFor(5 * 60_000);
  await settle();
  const after = await countdowns();
  assert.equal(after.length, before.length, 'same countdowns remain after five minutes');
  assert.ok(after.some((text, index) => text !== before[index]), `countdown text moved on: ${before.join(',')} -> ${after.join(',')}`);

  console.log('selection change');
  const candidate = (await info()).find((account) => account.status !== 'cooldown' && account.toggleable);
  assert.ok(candidate, 'an account whose enable switch can be used');
  const cardOf = (key) => page.locator(`.ec-sec-quota .qt-card[data-account="${key}"]`);
  await settle();
  await reset();
  await cardOf(candidate.key).locator('.qt-identity').click();
  await page.waitForFunction((key) => document.querySelector(`.ec-sec-quota .qt-card[data-account="${key}"].is-selected`), candidate.key);
  await settle();
  const afterSelect = await counts();
  console.log(`  ${total(afterSelect)} card renders after selecting ${candidate.key}: ${JSON.stringify(afterSelect)} ${JSON.stringify(await page.evaluate(() => window.__qtRenders.debug))}`);
  assert.equal(afterSelect[candidate.key], 1, 'the selected card renders once');
  assert.equal(total(afterSelect), 1, 'no other card renders when one is selected');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ec-sec-quota .qt-card.is-selected'));

  console.log('data change');
  await settle();
  await reset();
  const toggle = cardOf(candidate.key).getByRole('switch').first();
  const was = await toggle.getAttribute('aria-checked');
  await toggle.click();
  await page.waitForFunction(({ key, was }) => document.querySelector(`.ec-sec-quota .qt-card[data-account="${key}"] [role=switch]`)?.getAttribute('aria-checked') === (was === 'true' ? 'false' : 'true'),
    { key: candidate.key, was });
  await settle();
  const afterChange = await counts();
  console.log(`  was ${was}, card class "${await cardOf(candidate.key).getAttribute('class')}", renders ${JSON.stringify(afterChange)}`);
  assert.ok((afterChange[candidate.key] ?? 0) >= 1, 'the toggled card renders');
  for (const { key } of steady.filter((account) => account.key !== candidate.key)) {
    assert.equal(afterChange[key] ?? 0, 0, `card ${key} did not render when another account changed`);
  }
  assert.deepEqual(page.errors, [], 'no console/page errors');
});
