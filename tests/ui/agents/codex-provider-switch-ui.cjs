// Codex "use the openai provider identity" switch in the Manage tab, with the optional session sync.
// AGENT_TEST_URL, when set, reuses an existing dev server.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('../../helpers/ui-harness.cjs');
const assert = require('node:assert/strict');
runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const toggle = () => page.getByRole('switch', { name: '使用 openai 提供商标识', exact: true });
    const sync = () => page.getByRole('checkbox', { name: '同时同步会话', exact: true });
    // The kit hides the native input, so tick the box the way a user does: through its visible label.
    const tickSync = async () => {
      await page.getByRole('dialog').getByText('同时同步会话', { exact: true }).click();
      assert.equal(await sync().isChecked(), true);
    };
    const tab = name => page.getByRole('tab', { name, exact: true });
    const on = async () => (await toggle().getAttribute('aria-checked')) === 'true';
    const open = async (query = '') => {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&client=codex&${query}`, { waitUntil: 'domcontentloaded' });
      await tab('配置').click();
      assert.equal(await toggle().count(), 0, 'the switch lives in Manage, not in Setup');
      await tab('管理').click();
      await toggle().waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-row="codex-provider"] [role="switch"]')?.disabled);
    };
    const confirm = () => page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    const calls = () => page.evaluate(() => window.fixtureCalls);
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await open();
      await toggle().click();
      assert.equal(await sync().isChecked(), false);
      await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
      assert.equal((await calls()).filter(c => c.cmd === 'set_codex_openai_provider').length, 0);
      await toggle().click();
      await confirm();
      await page.waitForFunction(() => document.querySelector('[data-row="codex-provider"] [role="switch"]').getAttribute('aria-checked') === 'true');
      assert.equal((await calls()).filter(c => c.cmd === 'repair_codex_session_metadata').length, 0);
      await toggle().click();
      await tickSync();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await confirm();
      await page.waitForFunction(() => document.querySelector('[data-row="codex-provider"] [role="switch"]').getAttribute('aria-checked') === 'false');
      const invoked = await calls();
      const repair = invoked.findIndex(c => c.cmd === 'repair_codex_session_metadata');
      assert.ok(repair > invoked.findIndex(c => c.cmd === 'set_codex_openai_provider'));
      assert.equal(invoked[repair].args.expectedProvider, 'cpa-gui');
    }
    // The openai identity is tied to the sign-in method: Setup locks it while the identity is on.
    await open();
    await toggle().click();
    await confirm();
    await page.waitForFunction(() => document.querySelector('[data-row="codex-provider"] [role="switch"]').getAttribute('aria-checked') === 'true');
    await tab('配置').click();
    const locked = await page.locator('.ag-connection-control.is-locked').count();
    assert.equal(locked, 1, 'sign-in method is locked while the openai identity is on');

    await open('fail-provider-sync');
    await toggle().click();
    await tickSync();
    await confirm();
    await page.getByText(/提供商已切换，但会话同步失败/).waitFor();
    assert.equal(await on(), true);
    await open('fail-provider');
    await toggle().click();
    await tickSync();
    await confirm();
    await page.getByText(/CPA 未接受当前 Codex OAuth 凭证/).waitFor();
    assert.equal(await on(), false);
    assert.equal((await calls()).filter(c => c.cmd === 'repair_codex_session_metadata').length, 0);
    assert.deepEqual(errors, []);
    console.log('Codex provider switch UI checks passed');
  } finally { await browser.close(); }
});
