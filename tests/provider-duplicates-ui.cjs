const assert = require('node:assert/strict');
const { startFixtureServer, launchBrowser, openPage, selectors } = require('./helpers/apiFixture.cjs');

// #276: a second route that shares a credential and URL with an existing one must be creatable, editable after an
// external reorder, disableable, draggable and deletable without touching its sibling. Drives the real
// useApiProviders controller, ApiKeyList and ApiProviderForm (fixture: tests/fixtures/provider-duplicates.tsx).
(async () => {
  const { server, base } = await startFixtureServer(['tests/fixtures/provider-duplicates.html']);
  let browser;
  try {
    browser = await launchBrowser();
    const { page, errors } = await openPage(browser, base, { width: 1280, height: 1000 }, { consoleErrors: true });
    await page.goto(`${base}/tests/fixtures/provider-duplicates.html?brand=claude`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const rows = page.locator(selectors.row);
    const records = () => page.evaluate(() => window.providerFixture.records);
    const form = page.getByRole('dialog', { name: /^(Add|Edit) API Key/ });
    const waitForSave = () => form.waitFor({ state: 'detached' });
    const advanced = () => form.locator(selectors.advancedSummary).click();
    await rows.first().waitFor();

    await page.getByRole('button', { name: 'Add API Key', exact: true }).click();
    assert.equal(await form.getByLabel('Group Name', { exact: true }).count(), 0);
    await form.getByLabel('API Key', { exact: true }).fill('shared-test-key');
    await form.getByLabel('Base URL', { exact: true }).fill('https://claude.example.test');
    await advanced();
    await form.getByLabel('Priority', { exact: true }).fill('1');
    await form.getByLabel('Remark', { exact: true }).fill('Second route');
    await form.getByRole('button', { name: 'Add Custom Model', exact: true }).click();
    await form.locator(selectors.modelEntryInputs).nth(0).fill('upstream-b');
    await form.locator(selectors.modelEntryInputs).nth(1).fill('claude-b');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForSave();
    assert.equal((await records()).length, 2, 'A shared key and URL can have a second model/priority route');
    await rows.filter({ hasText: 'Second route' }).waitFor();
    assert.equal(await rows.count(), 2);

    await rows.filter({ hasText: 'Second route' }).getByRole('button', { name: 'Edit', exact: true }).click();
    await advanced();
    await form.getByLabel('Priority', { exact: true }).fill('2');
    await form.locator(selectors.modelEntryInputs).nth(1).fill('claude-b-edited');
    await page.evaluate(() => window.providerFixture.records.reverse());
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForSave();
    let saved = await records();
    assert.equal(saved[0].keys[0].priority, 2);
    assert.equal(saved[0].keys[0].models[0].alias, 'claude-b-edited');
    assert.equal(saved[1].priority, 10);
    assert.equal(saved[1].models[0].alias, 'claude-a');

    await rows.filter({ hasText: 'Second route' }).getByRole('switch').click();
    await page.waitForFunction(() => window.providerFixture.records[0].keys[0]['excluded-models']?.includes('*'));
    assert.equal((await records())[1]['excluded-models'], undefined);
    await rows.filter({ hasText: 'Second route' }).waitFor();
    assert.equal(await rows.filter({ hasText: 'Second route' }).getByRole('switch').getAttribute('aria-checked'), 'false');

    const handle = rows.filter({ hasText: 'Second route' }).locator('.ec-api-grip');
    await page.waitForFunction(() => [...document.querySelectorAll('.ec-api-grip')].every((button) => !button.disabled));
    await handle.focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(250);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.providerFixture.records[1].keys[0].priority === 2);
    assert.equal((await records())[0].priority, 10);

    await rows.filter({ hasText: 'Second route' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Delete', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForFunction(() => window.providerFixture.records.length === 1);
    saved = await records();
    assert.equal(saved[0].models[0].alias, 'claude-a', 'Deleting the second route preserves the first');
    assert.ok((await page.evaluate(() => window.providerFixture.writes)).every((write) => write.method === 'PUT'));
    assert.deepEqual(errors, []);
    console.log('PASS: #276 create, edit after external reorder, disable, drag, and delete preserve shared-credential sibling routes.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
