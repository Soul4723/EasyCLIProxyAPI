// Codex Manage rows against the core runtime: Remote keeps the provider switch working but drops the local-disk
// session sync, and a stopped core shows a calm state in the approval-model row instead of a request failure.
// AGENT_TEST_URL, when set, reuses an existing dev server.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('../../helpers/ui-harness.cjs');
const assert = require('node:assert/strict');
runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const calls = (cmd) => page.evaluate((name) => window.fixtureCalls.filter(c => c.cmd === name), cmd);
    const open = async (query) => {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&client=codex&tab=manage&locale=en&${query}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.fixtureResolveCoreStatus === 'function');
      await page.locator('[data-row="codex-provider"]').waitFor();
    };
    const resolveStatus = () => page.evaluate(() => window.fixtureResolveCoreStatus());
    const toggle = () => page.getByRole('switch', { name: 'Use the openai provider identity', exact: true });
    const dialog = () => page.getByRole('dialog');

    // Remote: the switch is a normal client-config write; the session sync row is Local-only.
    await open('runtime=remote');
    await resolveStatus();
    await page.waitForFunction(() => !document.querySelector('[data-row="codex-provider"] [role="switch"]')?.disabled);
    await toggle().click();
    await dialog().getByText(/stored on the machine where Codex runs/).waitFor();
    assert.equal(await dialog().getByRole('checkbox').count(), 0, 'Remote has no session sync option');
    await dialog().getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-row="codex-provider"] [role="switch"]').getAttribute('aria-checked') === 'true');
    assert.equal((await calls('set_codex_openai_provider')).length, 1);
    assert.equal(typeof (await calls('set_codex_openai_provider'))[0]?.args?.expectedRevision, 'number');
    assert.equal((await calls('repair_codex_session_metadata')).length, 0, 'Remote never touches local session files');

    // Local keeps the option.
    await open('runtime=local');
    await resolveStatus();
    await page.waitForFunction(() => !document.querySelector('[data-row="codex-provider"] [role="switch"]')?.disabled);
    await toggle().click();
    await dialog().getByRole('checkbox', { name: 'Also sync conversations', exact: true }).waitFor({ state: 'attached' });
    await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();

    // A stopped core is a state, not a failure: no catalog request, no raw error, and nothing to save.
    await open('runtime=local&core-stopped');
    await resolveStatus();
    const row = page.locator('[data-row="codex-approval-model"]');
    await row.getByText('Core is not running', { exact: true }).waitFor();
    assert.equal(await row.getByText(/Failed to request client model list/).count(), 0);
    assert.equal(await row.getByRole('button', { name: 'Save approval model', exact: true }).isDisabled(), true);
    // The status resolves after the row mounted, so it may have asked once before the core was known stopped.
    const before = (await calls('get_codex_model_catalog_editor')).length;
    await page.waitForTimeout(300);
    assert.equal((await calls('get_codex_model_catalog_editor')).length, before);

    assert.deepEqual(errors, []);
    console.log('Codex controls runtime UI checks passed');
  } finally { await browser.close(); }
});
