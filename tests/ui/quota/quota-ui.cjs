const assert = require('node:assert/strict');
const h = require('../../helpers/shell.cjs');

h.runUiTest('quota-ui', async ({ base, newPage }) => {
  const open = async (options = {}, pageOptions = {}) => {
    const page = await newPage(pageOptions);
    await h.openApp(page, base, { path: '/quota', ...options });
    await h.waitForCoreStatus(page);
    await page.locator('.ec-sec-quota .qt-card, .ec-sec-quota .qt-group, .ec-sec-quota .qt-empty, .ec-sec-quota .ec-empty').first().waitFor();
    return page;
  };
  const noErrors = (page, label) => assert.deepEqual(page.errors, [], `${label}: console/page errors`);
  const cards = (page) => page.locator('.ec-sec-quota .qt-card');
  const groups = (page) => page.locator('.ec-sec-quota .qt-group');
  const dialogNamed = (page, name) => page.getByRole('dialog', { name, exact: true });
  const panel = (page) => dialogNamed(page, 'Account details');
  const pick = (page, label) => page.locator('[role=radio]', { hasText: label });
  const card = (page, text) => page.locator('.ec-sec-quota .qt-card', { hasText: text }).first();

  // 1. Providers view (default)
  console.log('providers view');
  {
    const page = await open();
    await groups(page).first().waitFor();
    const order = await groups(page).evaluateAll((els) => els.map((el) => el.dataset.provider));
    assert.deepEqual(order, ['claude', 'codex', 'antigravity', 'xai', 'kimi', 'devin'], 'provider group order');

    const headers = await groups(page).evaluateAll((els) => els.map((el) => el.querySelector('.qt-group__big')?.textContent.trim() ?? ''));
    for (const text of headers) assert.match(text, /^(—|\d+\s*%)$/, `group header % left: "${text}"`);

    const chips = page.locator('.ec-sec-quota .ec-filters__chip');
    const chipCounts = await chips.evaluateAll((els) => els.map((el) => Number(el.querySelector('.ec-filters__count')?.textContent)));
    const [allCount, ...rest] = chipCounts;
    assert.equal(rest.reduce((sum, value) => sum + value, 0), allCount, 'filter chip counts sum to All');
    noErrors(page, 'providers view');

    console.log('provider chip filter');
    await chips.filter({ hasText: /codex/i }).first().click();
    await page.waitForFunction(() => document.querySelectorAll('.ec-sec-quota .qt-group').length === 1);
    assert.equal(await groups(page).first().getAttribute('data-provider'), 'codex', 'codex chip leaves only codex group');
    await chips.first().click();
    await page.waitForFunction((count) => document.querySelectorAll('.ec-sec-quota .qt-group').length === count, headers.length);

    console.log('search');
    const search = page.locator('.ec-sec-quota .ec-search__input');
    await search.fill('exhausted');
    await page.waitForFunction(() => document.querySelectorAll('.ec-sec-quota .qt-card').length <= 1);
    assert.equal(await cards(page).count(), 1, 'search "exhausted" leaves one card');

    console.log('no-match and clear filters');
    await search.fill('zz-no-such-account-zz');
    await page.getByText('No matching accounts', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.ec-sec-quota .qt-group').length > 0);
    assert.equal(await search.inputValue(), '', 'clear filters resets search');
    assert.equal(await groups(page).count(), headers.length, 'clear filters restores the providers view');
    noErrors(page, 'providers view filters');
    await page.close();
  }

  // 2. Grid and timeline views
  console.log('grid view');
  {
    const page = await open();
    await pick(page, 'Grid').click();
    await page.waitForFunction(() => document.querySelectorAll('.ec-sec-quota .qt-group').length === 0 && document.querySelectorAll('.ec-sec-quota .qt-card').length > 0);
    assert.equal(await cards(page).count(), 15, 'grid renders 15 cards');
    noErrors(page, 'grid view');

    console.log('timeline view');
    await pick(page, 'Timeline').click();
    await page.locator('.ec-sec-quota .qt-tl__row:not(.qt-tl__row--axis)').first().waitFor();
    assert.equal(await page.locator('.ec-sec-quota .qt-tl__row:not(.qt-tl__row--axis)').count(), 15, 'timeline renders 15 rows');

    console.log('timeline range');
    await pick(page, 'Next 7d').click();
    assert.equal(await pick(page, 'Next 7d').getAttribute('aria-checked'), 'true', 'Next 7d selected');
    assert.equal(await pick(page, 'Next 5h').getAttribute('aria-checked'), 'false', 'Next 5h deselected');
    await pick(page, 'Next 5h').click();
    assert.equal(await pick(page, 'Next 5h').getAttribute('aria-checked'), 'true', 'Next 5h selected again');
    noErrors(page, 'timeline view');
    await page.close();
  }

  // 3. Detail panel
  console.log('detail panel');
  {
    const page = await open();
    const identity = page.locator('.ec-sec-quota .qt-identity').first();
    await identity.click();
    const dialog = panel(page);
    await dialog.waitFor();
    assert.ok(await dialog.locator('.qt-big').count() > 0, 'panel shows .qt-big windows');

    const providersLink = dialog.locator('a.qt-link[href*="#/providers"]');
    assert.match(await providersLink.getAttribute('href'), /cred=/, 'credential link carries cred=');
    const usageLink = dialog.locator('a.qt-link[href*="#/usage/requests"]');
    assert.match(await usageLink.getAttribute('href'), /account=/, 'request link carries account=');

    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' }).catch(() => dialog.waitFor({ state: 'hidden' }));
    assert.equal(await panel(page).count(), 0, 'Escape closes the panel');
    const focusedClass = await page.evaluate(() => document.activeElement?.className ?? '');
    assert.match(focusedClass, /qt-identity/, 'focus returns to the identity button');
    noErrors(page, 'detail panel');
    await page.close();
  }

  // 4. Lighting
  console.log('lighting');
  {
    const page = await open();
    const preview = card(page, 'preview-claude');
    await preview.waitFor();
    await preview.locator('.qt-light button').click();
    const lighting = dialogNamed(page, 'Lighting');
    await lighting.waitFor();
    for (const label of ['Off', 'After reset', 'Schedule']) {
      assert.ok(await pick(lighting, label).count() === 1, `lighting mode "${label}" present`);
    }
    await pick(lighting, 'After reset').click();
    await pick(lighting, '5h').click();
    await lighting.getByRole('button', { name: 'Save', exact: true }).click();
    await lighting.waitFor({ state: 'detached' }).catch(() => lighting.waitFor({ state: 'hidden' }));
    await card(page, 'preview-claude').locator('.qt-card__foot', { hasText: 'After 5h reset' }).waitFor();
    assert.ok(await card(page, 'preview-claude').locator('.qt-light--lit').count() === 1, 'lit card shows .qt-light--lit');

    console.log('lighting off');
    await card(page, 'preview-claude').locator('.qt-light button').click();
    await dialogNamed(page, 'Lighting').waitFor();
    await pick(dialogNamed(page, 'Lighting'), 'Off').click();
    await dialogNamed(page, 'Lighting').getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => {
      const cardEl = [...document.querySelectorAll('.ec-sec-quota .qt-card')].find((el) => el.textContent.includes('preview-claude'));
      return cardEl && !cardEl.querySelector('.qt-light--lit');
    });
    noErrors(page, 'lighting');

    console.log('kimi lighting disabled');
    const kimi = page.locator('.ec-sec-quota .qt-group[data-provider=kimi] .qt-card').first().locator('.qt-light button');
    assert.equal(await kimi.isDisabled(), true, 'kimi lighting button disabled');
    assert.equal(await kimi.getAttribute('title'), 'Lighting is not supported for this provider yet', 'kimi lighting reason title');
    await page.close();
  }

  // 5. Enable toggle
  console.log('enable toggle');
  {
    const page = await open();
    await card(page, 'preview-claude').locator('.qt-identity').click();
    const dialog = panel(page);
    await dialog.waitFor();
    const pill = dialog.locator('.qt-panel__status .ec-pill');
    const original = (await pill.textContent()).trim();
    const toggle = dialog.locator('.qt-block--row').getByRole('switch', { name: 'Enabled', exact: true });
    await toggle.click();
    await dialog.locator('.qt-panel__status .ec-pill', { hasText: 'Disabled' }).waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'toggle off after click');
    await toggle.click();
    await page.waitForFunction((text) => {
      const el = document.querySelector('[role=dialog] .qt-panel__status .ec-pill');
      return el && el.textContent.trim() === text;
    }, original);
    assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'toggle back on');
    noErrors(page, 'enable toggle');
    await page.close();
  }

  // 6. Banked reset
  console.log('banked reset');
  {
    const page = await open();
    const codex = page.locator('.ec-sec-quota .qt-card', { has: page.locator('.qt-banked') }).filter({ hasText: /codex/i }).first();
    await codex.waitFor();
    const badge = codex.locator('.qt-banked');
    assert.equal((await badge.locator('.ec-num').textContent()).trim(), '2', 'banked count starts at 2');
    await badge.click();
    const confirm = page.getByRole('dialog').filter({ has: page.locator('.qt-confirm') });
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
    await page.waitForFunction(() => {
      const el = [...document.querySelectorAll('.ec-sec-quota .qt-card')].find((c) => /codex/i.test(c.textContent) && c.querySelector('.qt-banked'));
      return el && el.querySelector('.qt-banked .ec-num')?.textContent.trim() === '1';
    });
    noErrors(page, 'banked reset');
    await page.close();
  }

  // 7. Cooldown
  console.log('cooldown');
  {
    const page = await open();
    const cooling = page.locator('.ec-sec-quota .qt-card[data-status=cooldown]').first();
    await cooling.waitFor();
    await cooling.locator('.qt-identity').click();
    const dialog = panel(page);
    await dialog.waitFor();
    assert.match((await dialog.locator('.qt-panel__status .ec-pill').textContent()).trim(), /Cooldown/, 'panel shows Cooldown');
    await dialog.getByRole('button', { name: 'Clear cooldown', exact: true }).click();
    const confirm = page.getByRole('dialog').filter({ has: page.locator('.qt-confirm') });
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Clear cooldown', exact: true }).click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[role=dialog] .qt-panel__status .ec-pill');
      return el && !/Cooldown/.test(el.textContent);
    });
    noErrors(page, 'cooldown');
    await page.close();
  }

  // 8. Privacy
  console.log('privacy');
  {
    const page = await open();
    await h.setPrivacy(page, true);
    const leaks = await page.locator('.ec-sec-quota').evaluate((root) => {
      const pattern = /example\.(test|com)/;
      return [root, ...root.querySelectorAll('*')].filter((el) => pattern.test(el.textContent ?? '') && el.children.length === 0);
    });
    assert.equal(leaks.length, 0, 'privacy on: no example.test/example.com text in .ec-sec-quota');
    await h.setPrivacy(page, false);
    await page.waitForFunction(() => /example\.test/.test(document.querySelector('.ec-sec-quota')?.textContent ?? ''));
    noErrors(page, 'privacy');
    await page.close();
  }

  // 9. Density
  console.log('density');
  {
    const page = await open({}, { storage: { 'easy-cli-proxy-api.density': 'compact' } });
    await page.locator('.ec-sec-quota .qt-row:not(.qt-row--head)').first().waitFor();
    assert.equal(await cards(page).count(), 0, 'compact density renders rows, not cards');
    const meters = await page.locator('.ec-sec-quota .qt-row:not(.qt-row--head)').evaluateAll((rows) => rows.map((row) => row.querySelectorAll('.qt-rowmeter').length));
    for (const count of meters) assert.equal(count, 2, 'each compact row has two .qt-rowmeter');

    console.log('layout toggle');
    await page.getByRole('button', { name: 'Card layout', exact: true }).click();
    await page.locator('.ec-sec-quota .qt-card').first().waitFor();
    assert.equal(await page.locator('.ec-sec-quota .qt-rows').count(), 0, 'layout toggle back to cards');
    noErrors(page, 'density');
    await page.close();
  }

  // 10. Responsive
  console.log('responsive');
  for (const width of [1440, 1024, 680]) {
    const page = await open({}, { viewport: { width, height: 900 } });
    await page.locator('.ec-sec-quota .qt-group, .ec-sec-quota .qt-card').first().waitFor();
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('main#main');
      return main.scrollWidth <= main.clientWidth + 1;
    });
    assert.equal(overflow, true, `${width}px: main has no horizontal overflow`);
    assert.deepEqual(await h.horizontalOverflow(page), [], `${width}px: no overflowing nodes`);
    if (width === 680) {
      assert.ok(await cards(page).count() > 0, '680px: renders cards');
      assert.equal(await page.locator('.ec-sec-quota .qt-row').count(), 0, '680px: no compact rows');
    }
    noErrors(page, `responsive ${width}`);
    await page.close();
  }

  console.log('responsive 40 accounts');
  {
    const page = await open({ query: 'quotaAccounts=40' }, { viewport: { width: 1440, height: 900 } });
    await cards(page).nth(39).waitFor();
    assert.equal(await cards(page).count(), 40, '40 accounts rendered');
    const groupBoxes = await groups(page).evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width };
    }));
    for (const box of groupBoxes) {
      assert.ok(Math.abs(box.width - groupBoxes[0].width) <= 1, 'every group has the same width');
      assert.ok(Math.abs(box.left - groupBoxes[0].left) <= 1, 'every group has the same left edge');
    }
    const boxes = await cards(page).evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x1: r.left, y1: r.top, x2: r.right, y2: r.bottom };
    }));
    const overlaps = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        const hgt = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        if (w > 1 && hgt > 1) overlaps.push([i, j]);
      }
    }
    assert.deepEqual(overlaps, [], 'no overlapping cards');
    noErrors(page, '40 accounts');
    await page.close();
  }

  // 11. Empty
  console.log('empty');
  {
    const page = await open({ query: 'quotaAccounts=0' });
    const link = page.locator('.ec-sec-quota a[href="#/providers"]');
    await link.waitFor();
    assert.ok(await link.isVisible(), 'empty state links to providers');
    await link.click();
    await page.waitForFunction(() => location.hash.startsWith('#/providers'));
    noErrors(page, 'empty');
    await page.close();
  }

  // 12. Light theme
  console.log('light theme');
  {
    const page = await open();
    await h.setTheme(page, 'light');
    await groups(page).first().waitFor();
    assert.ok(await cards(page).count() > 0 || await groups(page).count() > 0, 'light theme renders the quota list');
    noErrors(page, 'light theme');
    await page.close();
  }

  console.log('quota-ui passed');
});
