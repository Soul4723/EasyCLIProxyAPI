// Codex remote compaction switch in the Manage tab; it is read-only while the openai provider identity is on.
// AGENT_TEST_URL, when set, reuses an existing dev server.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('../../helpers/ui-harness.cjs');
const assert = require('node:assert/strict');
runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    const toggle = () => page.getByRole('switch', { name: '远程压缩（实验性）', exact: true });
    const tab = name => page.getByRole('tab', { name, exact: true });
    const checked = async () => (await toggle().getAttribute('aria-checked')) === 'true';
    const settled = () => page.waitForFunction(() => !document.querySelector('[data-row="codex-remote-compaction"] [role="switch"]').disabled);
    const open = async (query = '') => {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&client=codex&${query}`);
      await tab('配置').click();
      assert.equal(await toggle().count(), 0);
      await tab('管理').click();
      await toggle().waitFor();
    };
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await open();
      assert.equal(await checked(), false);
      await toggle().click();
      await page.waitForFunction(() => document.querySelector('[data-row="codex-remote-compaction"] [role="switch"]').getAttribute('aria-checked') === 'true');
      await settled();
      await tab('配置').click();
      await tab('管理').click();
      assert.equal(await checked(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await toggle().click();
      await page.waitForFunction(() => document.querySelector('[data-row="codex-remote-compaction"] [role="switch"]').getAttribute('aria-checked') === 'false');
      await settled();
      const calls = await page.evaluate(() => window.fixtureCalls.filter(c => c.cmd === 'set_codex_remote_compaction'));
      assert.deepEqual(calls.map(c => c.args.enabled), [true, false]);
      await page.getByRole('switch', { name: '使用 openai 提供商标识', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-row="codex-remote-compaction"] [role="switch"]').disabled);
      assert.equal(await checked(), true, 'the openai identity already enables remote compaction');
    }
    // The approval-model row sits beside it; nothing to save until the selection changes.
    await open();
    await page.locator('[data-row="codex-approval-model"]').waitFor();
    assert.equal(await page.locator('[data-row="codex-approval-model"] button', { hasText: '保存审批模型' }).isDisabled(), true);
    await open('fail-compaction');
    await toggle().click();
    await page.getByText(/Compaction save failed/).waitFor();
    assert.equal(await checked(), false);
    console.log('Codex remote compaction UI checks passed');
  } finally { await browser.close(); }
});
