// Run against a Vite dev server: AGENT_TEST_URL=http://127.0.0.1:5391 node tests/claude-code-model-inputs-ui.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const base = process.env.AGENT_TEST_URL || 'http://127.0.0.1:1421';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${base}/tests/fixtures/agent-backups.html?client=claude-code&tab=setup&reset-selections`);
    const startup = page.getByRole('combobox', { name: '启动模型', exact: true });
    const subagent = page.getByRole('combobox', { name: '子代理', exact: true });
    const update = page.getByRole('button', { name: '更新配置', exact: true });
    const roleTrigger = role => page.locator(`.ag-claude-row[data-role=${role}] .agent-model-trigger`);
    const advancedToggle = page.getByRole('button', { name: '上下文与自动压缩（高级）' });
    const calls = () => page.evaluate(() => window.fixtureCalls);
    await startup.waitFor();

    // Startup model: pick a role alias from the suggestion list.
    await startup.click();
    await page.getByRole('option', { name: /^sonnet / }).click();
    assert.equal(await startup.inputValue(), 'sonnet');
    assert(await update.isDisabled(), 'incomplete role mapping must not be appliable');

    // Map every role (all four are required to apply); re-picking a row keeps the startup input untouched.
    for (const role of ['opus', 'sonnet', 'haiku', 'fable']) {
      await roleTrigger(role).click();
      await page.getByRole('option', { name: /^gpt-one / }).click();
    }
    await roleTrigger('opus').click();
    await page.getByRole('option', { name: /gpt-two/ }).click();
    assert.equal(await startup.inputValue(), 'sonnet');

    // Startup model + 1M switch drives the global window override in the advanced section.
    await startup.click();
    await page.getByRole('option', { name: /^gpt-two / }).click();
    await advancedToggle.click();
    const context = page.getByRole('switch', { name: '启动模型 1M', exact: true });
    const windowOverride = page.getByRole('spinbutton', { name: '自动压缩窗口', exact: true });
    await context.check();
    assert.equal(await startup.inputValue(), 'gpt-two[1m]');
    assert.equal(await windowOverride.inputValue(), '1000000');
    await context.uncheck();
    assert.equal(await windowOverride.inputValue(), '200000');
    assert.equal(await startup.inputValue(), 'gpt-two');
    await advancedToggle.click();
    assert.equal(await page.getByRole('switch', { name: /^(Opus|Sonnet|Haiku|Fable) 1M$/ }).count(), 4);

    // Custom subagent model is typed in and applied.
    await subagent.fill('custom-worker');
    await subagent.press('Enter');
    assert.equal(await subagent.inputValue(), 'custom-worker');
    await update.click();
    await page.waitForFunction(() => window.fixtureCalls.some(c => c.args?.claudeCodeModelMappings?.startupModel === 'gpt-two' && c.args?.claudeCodeModelMappings?.subagentModel === 'custom-worker'));

    // A failed model refresh keeps the unsaved draft and offers a retry.
    await subagent.fill('unsaved-worker');
    await subagent.press('Escape');
    await page.evaluate(() => { window.fixtureFailedCommands = ['get_agent_models']; });
    await roleTrigger('opus').click();
    await page.locator('.agent-model-dropdown:visible button').filter({ has: page.locator('svg.lucide-refresh-cw') }).click();
    const modelError = page.locator('.ag-claude-error');
    await modelError.waitFor();
    assert.equal(await startup.inputValue(), 'gpt-two');
    assert.equal(await subagent.inputValue(), 'unsaved-worker');
    assert.match(await roleTrigger('opus').innerText(), /gpt-two/);
    await subagent.press('Escape');
    await page.evaluate(() => { window.fixtureFailedCommands = []; });
    await modelError.getByRole('button').click();
    await modelError.waitFor({ state: 'hidden' });
    assert.equal(await subagent.inputValue(), 'unsaved-worker');

    // Default inheritance for the subagent, then a 1M role toggle.
    await startup.click();
    await page.getByRole('option', { name: /^opus / }).click();
    await subagent.click();
    await page.getByRole('option', { name: '使用默认继承行为', exact: true }).click();
    await update.click();
    await page.waitForFunction(() => window.fixtureCalls.some(c => c.args?.claudeCodeModelMappings?.startupModel === 'opus' && c.args?.claudeCodeModelMappings?.subagentModel === ''));
    await page.getByRole('switch', { name: 'Fable 1M', exact: true }).check();
    await update.click();
    await page.waitForFunction(() => window.fixtureCalls.some(c => c.args?.claudeCodeModelMappings?.fable1m === true));
    assert.ok((await calls()).some(c => c.cmd === 'update_agent_config'));

    // Responsive layout: nothing overflows its field and the page never scrolls sideways.
    for (const width of [1280, 760, 680]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: path.join(os.tmpdir(), `claude-code-models-${width}.png`), fullPage: true });
      for (const field of await page.locator('.ag-claude-target').all()) {
        assert(await field.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${width}: mapping field overflows`);
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${width}: horizontal page overflow`);
      assert(await update.isVisible());
    }
    assert.deepEqual(errors, []);
    console.log('PASS: select, custom input, defaults, connection failure/retry, draft retention and responsive layout');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
