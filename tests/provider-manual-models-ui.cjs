const assert = require('node:assert/strict');
const { startFixtureServer, launchBrowser, openPage, selectors } = require('./helpers/apiFixture.cjs');

// DeepSeek needs a manual model before it can be saved, a config can be created without any discovery request, and a
// failed discovery while editing never blocks saving the manual models (fixture: tests/fixtures/provider-manual-models.tsx).
(async () => {
  const { server, base } = await startFixtureServer(['tests/fixtures/provider-manual-models.html']);
  let browser;
  try {
    browser = await launchBrowser();
    const { page, errors } = await openPage(browser, base, { width: 1280, height: 800 });
    await page.goto(`${base}/tests/fixtures/provider-manual-models.html?brand=deepseek`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add API Key', exact: true }).first().click(); // toolbar button (the empty state repeats it)
    const form = page.getByRole('dialog', { name: /^Add API Key/ });
    await form.getByLabel('API Key', { exact: true }).fill('test-manual-key');
    await form.getByLabel('Base URL', { exact: true }).fill('https://relay.example.test');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await form.getByText('Add at least one model manually or select one from the model list', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.providerFixture.writes.length), 0);
    await form.getByRole('button', { name: 'Add Custom Model', exact: true }).click();
    await form.getByRole('textbox', { name: 'Model name, for example gpt-4o', exact: true }).fill('custom-model');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await form.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.providerFixture.discoveryCalls), 0);
    assert.equal(await page.evaluate(() => window.providerFixture.records.at(-1).keys[0].models[0].name), 'custom-model');
    await page.locator(selectors.row).getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: /^Edit API Key/ });
    await edit.getByLabel('Base URL', { exact: true }).fill('https://another-relay.example.test');
    await edit.getByLabel('API Key', { exact: true }).fill('test-updated-key');
    await edit.getByRole('button', { name: 'Fetch Models', exact: true }).click();
    const models = page.getByRole('dialog', { name: /^Select Models/ });
    await models.getByText(/Model listing disabled/).waitFor();
    await page.keyboard.press('Escape');
    await models.waitFor({ state: 'detached' });
    const calls = await page.evaluate(() => window.providerFixture.discoveryCalls);
    assert.ok(calls > 0);
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await edit.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.providerFixture.discoveryCalls), calls);
    const saved = await page.evaluate(() => window.providerFixture.records.at(-1));
    assert.equal(saved.keys[0].models[0].name, 'custom-model');
    assert.equal(saved['base-url'], 'https://another-relay.example.test');
    assert.deepEqual(errors, []);
    console.log('PASS: manual provider models: create without discovery, empty validation, edit after failed discovery.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
