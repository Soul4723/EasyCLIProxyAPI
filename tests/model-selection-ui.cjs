const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { startFixtureServer, launchBrowser, openPage, selectors } = require('./helpers/apiFixture.cjs');

// Model discovery transfer (400 models): independent searches, filtered transfers, empty selection recovery, keyboard
// focus, refresh errors, selection persistence, cancel, stale responses, exclusions, alias collisions/edits, manual
// overrides, and responsive themes. Drives the real ApiProviderForm (fixture: tests/fixtures/model-selection.tsx).
(async () => {
  const { server, base } = await startFixtureServer(['tests/fixtures/model-selection.html']);
  let browser;
  try {
    browser = await launchBrowser();
    const { page, errors } = await openPage(browser, base, { width: 1280, height: 820 });
    page.setDefaultNavigationTimeout(30000);
    const dialog = page.getByRole('dialog', { name: /^Select Models/ });
    const left = dialog.getByRole('region', { name: 'Unselected Models', exact: true });
    const right = dialog.getByRole('region', { name: 'Selected Models', exact: true });
    const rows = panel => panel.locator('.ec-api-transfer__row');
    const search = panel => panel.getByRole('searchbox');
    const clearSearch = panel => panel.getByRole('button', { name: 'Clear', exact: true });
    const fetchModels = () => page.getByRole('button', { name: 'Fetch Models', exact: true });
    const save = () => page.getByRole('button', { name: 'Save', exact: true });
    const ready = () => page.waitForFunction(() => {
      const refresh = document.querySelector('.ec-api-transfer__summary button');
      return refresh && !refresh.disabled;
    });
    const counts = async (unselected, selected) => {
      assert.equal(Number(await left.locator('.ec-api-transfer__count').innerText()), unselected);
      assert.equal(Number(await right.locator('.ec-api-transfer__count').innerText()), selected);
    };
    const open = async (scenario) => {
      await page.goto(`${base}/tests/fixtures/model-selection.html?scenario=${scenario}`, { waitUntil: 'domcontentloaded' });
      await fetchModels().click();
      await ready();
    };

    await open('saved');
    await counts(399, 2);
    await search(right).fill('FOCUS');
    assert.equal(await rows(right).count(), 1, 'Search matches saved aliases, ignoring case');
    await right.getByRole('button', { name: 'Remove Results', exact: true }).click();
    assert.equal(await rows(right).count(), 0);
    await clearSearch(right).click();
    await counts(400, 1);
    await search(left).fill(' GPT-00 ');
    assert.equal(await rows(left).count(), 9);
    await left.getByRole('button', { name: 'Add Results', exact: true }).click();
    assert.equal(await rows(left).count(), 0);
    assert.equal(await rows(right).count(), 10, 'A filter on one side does not filter the other side');
    await search(right).fill('gpt-00');
    await right.getByRole('button', { name: 'Remove Results', exact: true }).click();
    await clearSearch(right).click();
    await clearSearch(left).click();
    await counts(400, 1);

    await right.getByRole('button', { name: 'Remove All', exact: true }).click();
    await counts(401, 0);
    assert.equal(await dialog.getByRole('button', { name: 'Apply Selection (0)', exact: true }).isDisabled(), true);
    await left.getByRole('button', { name: 'Add gpt-001', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await left.getByRole('button', { name: 'Add gpt-002', exact: true }).evaluate(el => el === document.activeElement), true);
    await counts(400, 1);
    await page.evaluate(() => { window.fixtureCatalog.push({ name: 'new-on-refresh' }); });
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await ready();
    await counts(401, 1);
    assert.equal(await left.getByRole('button', { name: 'Add new-on-refresh', exact: true }).count(), 1);

    await search(left).fill('no-such-model');
    await page.evaluate(() => { window.fixtureFailFetch = true; });
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await ready();
    assert.match(await dialog.getByRole('alert').innerText(), /Fixture discovery failed/);
    assert.equal(await rows(right).count(), 1, 'Failed refresh keeps selected models');
    await clearSearch(left).click();
    await counts(401, 1);
    await page.evaluate(() => { window.fixtureFailFetch = false; });
    await dialog.getByRole('button', { name: 'Apply Selection (1)', exact: true }).click();
    await save().click();
    const saved = await page.evaluate(() => window.fixtureSaved);
    assert.deepEqual(saved.models, [{ name: 'gpt-001', alias: 'Focus' }]);
    assert.ok(saved.excludedModelsText.includes('gpt-002'));

    await fetchModels().click();
    await ready();
    await right.getByRole('button', { name: 'Remove All', exact: true }).click();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await fetchModels().click();
    await ready();
    assert.equal(await rows(right).count(), 1, 'Cancelling discards pending selection edits');
    await dialog.getByRole('button', { name: 'Apply Selection (1)', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.getByRole('button', { name: 'Close dialog', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(await fetchModels().evaluate(el => el === document.activeElement), true);

    await page.evaluate(() => { window.fixtureHoldNext = true; });
    await fetchModels().click();
    await page.waitForFunction(() => window.fixturePending.length === 1);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('textbox', { name: 'Base URL', exact: true }).fill('https://new.example.test');
    await page.evaluate(() => { window.fixtureCatalog = [{ name: 'fresh-model' }]; });
    await fetchModels().click();
    await ready();
    await counts(1, 1);
    await page.evaluate(async () => {
      window.fixturePending.shift()();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await counts(1, 1);
    assert.equal(await left.getByRole('button', { name: 'Add fresh-model', exact: true }).count(), 1, 'Cancelled response cannot replace the current list');

    await open('excluded');
    await counts(240, 160);
    await open('new');
    await counts(0, 400);
    await right.getByRole('button', { name: 'Remove All', exact: true }).click();
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await ready();
    await counts(400, 0);
    await left.getByRole('button', { name: 'Add All', exact: true }).click();
    await counts(0, 400);

    await open('alias-saved');
    await counts(2, 1);
    await dialog.getByRole('button', { name: 'Apply Selection (1)', exact: true }).click();
    await save().click();
    const mapped = await page.evaluate(() => window.fixtureSaved);
    assert.deepEqual(mapped.models, [{ name: 'dsv4.1', alias: 'dsv4' }]);
    assert.deepEqual(mapped.excludedModelsText.split('\n'), ['manual-model', 'legacy-*', 'other']);
    await fetchModels().click();
    await ready();
    await counts(2, 1);
    await dialog.getByRole('button', { name: 'Apply Selection (1)', exact: true }).click();
    await save().click();
    assert.deepEqual(await page.evaluate(() => window.fixtureSaved), mapped, 'Reapplying must not reintroduce the alias exclusion');

    await open('alias-new');
    await right.getByRole('button', { name: 'Remove dsv4', exact: true }).click();
    await right.getByRole('button', { name: 'Remove other', exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply Selection (1)', exact: true }).click();
    // Advanced settings are collapsed by default; open them to edit the exclusion rules.
    await page.locator(selectors.advancedSummary).press('Enter');
    const exclusions = page.getByRole('textbox', { name: /Excluded Models/ });
    const aliasInput = page.locator(selectors.modelEntryInputs).nth(1);
    const expectExclusions = async (extra) => assert.deepEqual((await exclusions.inputValue()).split('\n'), ['manual-model', 'legacy-*', ...extra]);
    await expectExclusions(['dsv4', 'other']);
    await aliasInput.fill(' DSV4 ');
    await expectExclusions(['other']);
    await save().click();
    assert.deepEqual((await page.evaluate(() => window.fixtureSaved)).excludedModelsText.split('\n'), ['manual-model', 'legacy-*', 'other']);
    await aliasInput.fill('other');
    await expectExclusions(['dsv4']);
    await aliasInput.fill('');
    await aliasInput.pressSequentially('dsv4.1');
    await expectExclusions(['dsv4', 'other']);

    await page.evaluate(() => { window.fixtureCatalog = [{ name: 'new-upstream' }]; });
    await fetchModels().click();
    await ready();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await aliasInput.fill('dsv4');
    await expectExclusions(['other']);
    await aliasInput.fill('dsv4.1');
    await expectExclusions(['dsv4', 'other']);

    const addModel = page.getByRole('button', { name: 'Add Custom Model', exact: true });
    await addModel.press('Enter');
    const added = page.locator('.ec-api-model__row').last();
    await added.locator('input').nth(0).fill('custom-upstream');
    await added.locator('input').nth(1).fill('dsv4');
    await expectExclusions(['other']);
    await added.getByRole('button', { name: 'Remove model', exact: true }).press('Enter');
    await expectExclusions(['dsv4', 'other']);

    await page.locator('.ec-api-model__row').getByRole('button', { name: 'Remove model', exact: true }).press('Enter');
    await expectExclusions(['dsv4', 'other']);
    await addModel.press('Enter');
    await page.locator(selectors.modelEntryInputs).nth(0).fill('dsv4.1');
    await expectExclusions(['dsv4', 'other']);

    const manualRules = 'dsv4\nother\nmanual-model\ndsv*';
    await exclusions.fill(manualRules);
    await aliasInput.fill('other');
    await save().click();
    assert.equal((await page.evaluate(() => window.fixtureSaved)).excludedModelsText, manualRules, 'Manual exclusions remain authoritative after editing aliases');
    assert.deepEqual(errors, []);

    const shots = path.join(os.tmpdir(), 'model-selection-qa');
    mkdirSync(shots, { recursive: true });
    for (const [locale, theme, width, height] of [['zh-CN', 'light', 1280, 820], ['en', 'dark', 1280, 820], ['ja', 'light', 390, 740]]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/tests/fixtures/model-selection.html?locale=${locale}&theme=${theme}`);
      await page.getByRole('button', { name: /^(Fetch Models|获取模型|モデルを取得)/ }).click();
      await ready();
      const popup = page.getByRole('dialog').last();
      const rect = await popup.boundingBox();
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height);
      assert.equal(await popup.evaluate(el => el.scrollWidth > el.clientWidth), false, 'Dialog must not overflow horizontally');
      assert.equal(await popup.locator('.ec-dialog__body').evaluate(el => el.scrollWidth > el.clientWidth), false, 'Dialog body must not overflow horizontally');
      for (const panel of await popup.locator('.ec-api-transfer__panel').all()) {
        assert.equal(await panel.evaluate(el => el.scrollWidth > el.clientWidth), false, 'Panel must not overflow horizontally');
      }
      await page.screenshot({ path: path.join(shots, `model-selection-${locale}-${theme}.png`) });
    }
    console.log('PASS: 400 models, independent searches, filtered transfers, empty selection recovery, keyboard focus, refresh errors, selection persistence, cancel, stale responses, exclusions, alias collisions, alias edits, manual overrides, save, and responsive themes');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
