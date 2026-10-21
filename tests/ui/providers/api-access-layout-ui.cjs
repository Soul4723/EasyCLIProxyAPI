const assert = require('node:assert/strict');
const { startFixtureServer, launchBrowser, openPage, selectors } = require('../../helpers/apiFixture.cjs');

// Dense API-key rows (long names, long URLs, long remarks, mixed enabled/priority/model states) must keep their
// effective metadata, remarks and every action reachable without overlap or horizontal overflow, in two locales, both
// themes, both densities and compact rows. Drives the real ApiKeyList (fixture: tests/fixtures/provider-groups.tsx?layout=dense).
const widths = [1440, 1266, 980, 854, 640, 390];
const locales = ['zh-CN', 'en'];
const variants = [
  { theme: 'dark', density: 'comfortable', compact: false },
  { theme: 'light', density: 'compact', compact: true },
];

(async () => {
  const { server, base } = await startFixtureServer(['tests/fixtures/provider-groups.html']);
  let browser;
  try {
    browser = await launchBrowser();
    const errors = [];

    for (const variant of variants) for (const locale of locales) for (const width of widths) {
      const label = `${locale} ${variant.theme}/${variant.density}${variant.compact ? '/compact-rows' : ''} ${width}x600`;
      const { page, errors: pageErrors } = await openPage(browser, base, { width, height: 600 });
      await page.goto(`${base}/tests/fixtures/provider-groups.html?layout=dense&locale=${locale}&theme=${variant.theme}&density=${variant.density}${variant.compact ? '&compact=1' : ''}`, { waitUntil: 'domcontentloaded' });
      const rows = page.locator(selectors.row);
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=api-key-row]').length === 8);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });

      // Brand filter chips: every brand stays reachable (the row scrolls horizontally instead of clipping).
      const chips = await page.getByRole('group', { name: 'Brand' }).evaluate(group => {
        const rect = group.getBoundingClientRect();
        const buttons = [...group.querySelectorAll('button')];
        return { count: buttons.length, inside: rect.right <= innerWidth + 1, scrollable: group.scrollWidth >= group.clientWidth };
      });
      assert.equal(chips.count, 8, `${label}: every brand filter remains available`);
      assert.equal(chips.inside, true, `${label}: brand filters stay inside the window`);

      const overflow = await page.evaluate(() => [document.documentElement, document.body, document.querySelector('main')]
        .filter(element => element.scrollWidth > element.clientWidth + 1)
        .map(element => element.className || element.tagName));
      assert.deepEqual(overflow, [], `${label}: dense API content must not overflow the page horizontally`);

      const groups = await page.evaluate(() => window.groupFixture.groups);
      let rowIndex = 0;
      for (const group of groups) for (const key of group.keys) {
        const effective = { ...group, ...Object.fromEntries(Object.entries(key).filter(([, value]) => value !== null)) };
        const row = rows.nth(rowIndex++);
        assert.equal(await row.count(), 1, `${label}: each API key has its own row`);
        const meta = row.locator('.ec-api-row__meta');
        assert.equal(await meta.isVisible(), true, `${label} ${group.name}: metadata stays visible`);
        const metaText = await meta.innerText();
        const expectedModels = locale === 'en' ? (effective.models.length === 1 ? '1 model' : `${effective.models.length} models`) : `模型 ${effective.models.length} 个`;
        if (effective.models.length) assert.ok(metaText.includes(expectedModels), `${label} ${group.name}: effective model count is preserved`);
        const priorityLabel = locale === 'en' ? 'Priority' : '优先级';
        if (effective.priority === null) assert.ok(!metaText.includes(priorityLabel), `${label}: inherited priority is not displayed as zero`);
        else assert.ok(metaText.includes(`${priorityLabel} ${effective.priority}`), `${label} ${group.name}: effective priority, including zero, is preserved`);
        assert.equal(await row.getByRole('switch').getAttribute('aria-checked'), String(!effective['excluded-models']?.includes('*')), `${label}: each key shows its own effective enabled state`);
        assert.ok(!metaText.includes(locale === 'en' ? 'keys total' : '个密钥'), `${label}: individual rows do not show group key counts`);
        assert.equal(await row.locator('.ec-api-row__url').getAttribute('title'), group['base-url'], `${label}: full URL remains available`);
        const remark = row.locator('.ec-api-row__name');
        assert.equal(await remark.getAttribute('title'), await remark.innerText(), `${label}: the full remark remains available when shortened`);
        assert.ok((await remark.innerText()).length > 0, `${label}: the remark is shown as the row title`);

        const layout = await row.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const main = element.querySelector('.ec-api-row__main').getBoundingClientRect();
          const actions = element.querySelector('.ec-api-row__actions').getBoundingClientRect();
          const metaBox = element.querySelector('.ec-api-row__meta').getBoundingClientRect();
          const controls = [...element.querySelectorAll('.ec-api-row__actions > *')];
          const rects = controls.map(control => control.getBoundingClientRect());
          const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
            && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
          return {
            mainOverlapsActions: overlap(main, actions),
            metaOverlapsActions: overlap(metaBox, actions),
            controlsContained: rects.every(rect => rect.width > 0 && rect.height > 0 && rect.left >= bounds.left - 1
              && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1),
            controlsOverlap: rects.some((rect, index) => rects.slice(index + 1).some(next => overlap(rect, next))),
          };
        });
        assert.equal(layout.mainOverlapsActions, false, `${label} ${group.name}: details and actions do not overlap`);
        assert.equal(layout.metaOverlapsActions, false, `${label} ${group.name}: status chips and actions do not overlap`);
        assert.equal(layout.controlsContained, true, `${label} ${group.name}: every action fits its own row`);
        assert.equal(layout.controlsOverlap, false, `${label} ${group.name}: action targets remain separate`);
        for (const control of await row.locator('.ec-api-row__actions > *, .ec-api-grip').all()) {
          await control.scrollIntoViewIfNeeded();
          assert.equal(await control.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return rect.top >= -1 && rect.bottom <= innerHeight + 1 && !!hit && element.contains(hit);
          }), true, `${label} ${group.name}: actions and drag handle remain reachable by scrolling`);
        }
      }

      assert.equal(await rows.locator('.ec-chip', { hasText: locale === 'en' ? 'Partial' : '部分' }).count(), 0, 'Individual keys do not display a partial group state');
      assert.deepEqual(await page.evaluate(() => window.groupFixture.writes), [], 'Layout checks must not change provider records');
      errors.push(...pageErrors.map(error => `${label}: ${error}`));
      await page.close();
    }
    assert.deepEqual(errors, [], 'Dense API layouts must not produce runtime errors');
    console.log('PASS: dense API key rows retain brand filters, effective metadata, existing remarks and reachable actions at six widths, both themes/densities and compact rows in Chinese and English.');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
