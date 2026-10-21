// AGENT_TEST_URL, when set, reuses an existing dev server:
// AGENT_TEST_URL=http://127.0.0.1:5391 node tests/ui/agents/agent-native-oauth-ui.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('../../helpers/ui-harness.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const restore = () => page.getByRole('button', { name: '重置登录', exact: true });
    const saveBar = () => page.getByRole('group', { name: '应用配置', exact: true }).getByRole('button');
    const update = () => saveBar().last();
    const close = () => page.getByRole('button', { name: '关闭配置修改', exact: true });
    const apply = () => page.getByRole('button', { name: '应用配置修改', exact: true });
    const tab = name => page.getByRole('tab', { name, exact: true });
    const core = () => tab('配置').click();
    const manage = () => tab('管理').click();
    const dialog = () => page.getByRole('dialog');
    const fixtureCalls = () => page.evaluate(() => window.fixtureCalls);
    const overflows = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    // Close and Update are both enabled once the apply/update call settled.
    const settled = () => page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll('.ag-savebar button')];
      return buttons.length === 2 && buttons.every(button => !button.disabled);
    });
    const restoreOfficial = async () => {
      await manage();
      assert.equal(await page.locator('#agent-clear-integration').count(), 1);
      await restore().click();
      await page.waitForFunction(() => !document.querySelector('#agent-clear-integration').disabled);
      assert.equal(await tab('管理').getAttribute('aria-selected'), 'true');
      assert.equal(await overflows(), false);
      await core();
    };
    const open = async query => {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&client=codex&${query}`, { waitUntil: 'domcontentloaded' });
      await update().waitFor();
      await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'get_agent_models')
        && !document.querySelector('.ag-detail [aria-busy="true"]'));
    };
    // The header state chip reads "Native OAuth" while Codex is signed in directly (CPA disconnected).
    const waitMode = async native => {
      await page.waitForFunction(value => {
        const meta = document.querySelector('.ag-detail-meta');
        const savebar = document.querySelector('.ag-savebar button');
        return savebar && !!meta && meta.textContent.includes('原生 OAuth') === value;
      }, native);
    };
    const assertButtonOrder = async (applied = true) => {
      const positions = await saveBar().evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width };
      }));
      assert.equal(positions.length, applied ? 2 : 1);
      if (applied) {
        const [closePosition, updatePosition] = positions;
        assert.ok(closePosition.x + closePosition.width <= updatePosition.x + 1, 'Close is left of Update');
        assert.ok(Math.abs(closePosition.y - updatePosition.y) < 1, 'Close and Update share a row');
      }
      assert.equal(await restore().count(), 0, 'Official sign-in is only available in configuration management');
      assert.equal(await page.locator('.agent-native-oauth, [role="switch"]').count(), 0, 'The old mode switch is gone');
    };
    fs.mkdirSync('misc', { recursive: true });
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await open('');
      await assertButtonOrder();
      await restoreOfficial();
      await waitMode(true);
      assert.equal(await close().count(), 0);
      assert.equal(await page.locator('.agent-model-trigger').count(), 1, 'CPA models remain selectable for reconnect');
      await assertButtonOrder(false);
      assert.match(await page.locator('.ag-detail-body').innerText(), /更新配置将重新接入 CPA/);
      const calls = await fixtureCalls();
      assert.equal(calls.filter(call => ['check_codex_oauth_login', 'update_agent_config'].includes(call.cmd)).length, 0);
      assert.equal(calls.filter(call => call.cmd === 'restore_codex_official_config').length, 1);
      await page.evaluate(() => window.fixtureRemount());
      await waitMode(true);
      assert.equal(await overflows(), false);
      await manage();
      await restore().waitFor();
      await page.evaluate(() => window.fixtureRemount());
      await restore().waitFor();
      assert.equal(await tab('管理').getAttribute('aria-selected'), 'true');
      if (width === 1280) await page.screenshot({ animations: 'disabled', path: 'misc/restore-official-full.png', fullPage: true });
      await core();
      await page.locator('.agent-model-trigger').click();
      await page.getByRole('option', { name: 'gpt-two' }).click();
      await update().click();
      await waitMode(false);
      const updated = (await fixtureCalls()).findLast(call => call.cmd === 'update_agent_config');
      assert.equal(updated.args.model, 'gpt-two');
      assert.equal(updated.args.oauthConfiguration, false);
      await restoreOfficial();
      await waitMode(true);
      await page.getByRole('radio', { name: 'OAuth 登录方式', exact: true }).click();
      await update().click();
      await waitMode(false);
      assert.equal((await fixtureCalls()).findLast(call => call.cmd === 'update_agent_config').args.oauthConfiguration, true);
    }
    await open('fresh');
    assert.equal(await update().innerText(), '应用配置修改');
    assert.equal(await close().count(), 0);
    await restoreOfficial();
    await waitMode(true);
    await update().click();
    await waitMode(false);
    await open('no-core');
    await restoreOfficial();
    await waitMode(true);
    assert.equal(await update().isDisabled(), true, 'An offline core prevents reconnect, but not Restore');
    await open('fail-native-oauth');
    await restoreOfficial();
    await page.getByRole('alert').filter({ hasText: /模拟切换失败/ }).waitFor();
    await waitMode(false);
    await restoreOfficial();
    await waitMode(true);
    await open('fail-apply');
    await restoreOfficial();
    await waitMode(true);
    await update().click();
    await page.getByRole('alert').filter({ hasText: /模拟配置写入失败/ }).waitFor();
    await waitMode(true);
    await update().click();
    await waitMode(false);

    await open('');
    await close().waitFor();
    assert.equal(await update().innerText(), '更新配置');
    await update().click();
    await page.waitForFunction(() => window.fixtureCalls.filter(call => call.cmd === 'update_agent_config').length === 1);
    await settled();
    assert.equal((await fixtureCalls()).filter(call => call.cmd === 'close_codex_config_modification').length, 0, 'Update never closes an unchanged configuration');
    await page.locator('.agent-model-trigger').click();
    await page.getByRole('option', { name: 'gpt-two' }).click();
    assert.equal(await close().isEnabled(), true, 'A model draft does not hide or disable Close');
    await close().click();
    await apply().waitFor();
    assert.equal(await close().count(), 0, 'Close is hidden after disconnect');
    assert.equal((await fixtureCalls()).filter(call => call.cmd === 'close_codex_config_modification').length, 1);
    await page.evaluate(() => window.fixtureRemount());
    await apply().waitFor();
    await apply().click();
    await settled();
    await page.getByRole('radio', { name: 'OAuth 登录方式', exact: true }).click();
    await update().click();
    await page.waitForFunction(() => window.fixtureCalls.findLast(call => call.cmd === 'update_agent_config')?.args.oauthConfiguration === true);
    await settled();
    await page.getByRole('radio', { name: 'API 密钥', exact: true }).click();
    assert.equal(await close().isEnabled(), true, 'An authentication draft keeps Close available');
    await update().click();
    await page.waitForFunction(() => window.fixtureCalls.findLast(call => call.cmd === 'update_agent_config')?.args.oauthConfiguration === false);
    await settled();

    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await open('fresh&fail-apply');
      assert.equal(await close().count(), 0, 'An unapplied configuration has no Close button');
      await assertButtonOrder(false);
      await apply().click();
      await page.getByRole('alert').filter({ hasText: /模拟配置写入失败/ }).waitFor();
      assert.equal(await close().count(), 0, 'A failed application does not reveal Close');
      await apply().click();
      await close().waitFor();
      await assertButtonOrder();
      await page.evaluate(() => window.fixtureRemount());
      await close().waitFor();
      await close().click();
      await apply().waitFor();
      assert.equal(await close().count(), 0, 'Closing hides the action again');
      assert.equal(await overflows(), false);
    }
    await open('no-core');
    await close().waitFor();
    assert.equal(await close().isDisabled(), false, 'Closing is available while CPA is offline');
    await close().click();
    await apply().waitFor();
    await open('fail-close');
    await close().click();
    await page.getByRole('alert').filter({ hasText: /模拟关闭失败/ }).waitFor();
    await close().waitFor();
    await close().click();
    await apply().waitFor();
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await open('no-oauth-login');
      const oauth = () => page.getByRole('radio', { name: 'OAuth 登录方式', exact: true });
      await oauth().click();
      await dialog().waitFor();
      assert.match(await dialog().innerText(), /管理.*重置登录/);
      assert.equal((await dialog().innerText()).includes('清空配置'), false);
      assert.equal(await page.getByRole('radio', { name: 'API 密钥', exact: true }).getAttribute('aria-checked'), 'true');
      assert.equal((await fixtureCalls()).filter(call => ['restore_codex_official_config', 'clear_codex_config', 'update_agent_config'].includes(call.cmd)).length, 0);
      await dialog().getByRole('button', { name: '前往配置管理', exact: true }).click();
      await dialog().waitFor({ state: 'detached' });
      await restore().waitFor();
      assert.equal(await tab('管理').getAttribute('aria-selected'), 'true');
      await page.waitForFunction(() => document.activeElement?.id === 'agent-clear-integration');
      assert.equal((await fixtureCalls()).filter(call => call.cmd === 'restore_codex_official_config').length, 0, 'Guidance navigates without clearing configuration');
      await restore().click();
      await page.getByRole('status').filter({ hasText: /已清除 CPA 接入/ }).waitFor();
      assert.equal((await fixtureCalls()).filter(call => call.cmd === 'clear_codex_config').length, 0, 'Clear integration never calls Clear configuration');
      await core();
      await oauth().click();
      await dialog().waitFor();
      await dialog().getByRole('button', { name: '我知道了', exact: true }).click();
      assert.equal(await tab('配置').getAttribute('aria-selected'), 'true');
      await page.evaluate(() => { window.fixtureOauthLoggedIn = true; });
      await oauth().click();
      await page.waitForFunction(() => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent.includes('OAuth'));
      assert.equal(await dialog().count(), 0, 'An existing login can select OAuth directly');
      await update().click();
      await close().waitFor();
      assert.equal((await fixtureCalls()).findLast(call => call.cmd === 'update_agent_config').args.oauthConfiguration, true);
    }
    for (const client of ['opencode', 'zcode']) {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&client=${client}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '更新配置', exact: true }).waitFor();
      assert.equal(await close().count(), 1, 'Other managed clients can also close configuration');
      assert.equal(await restore().count(), 0);
      await manage();
      assert.equal(await page.getByRole('button', { name: '清除接入', exact: true }).count(), 1, 'Other clients can clear CPA integration in management');
      assert.equal(await page.locator('#agent-clear-integration').count(), 0, 'The official Codex login action remains Codex-only');
    }

    assert.deepEqual(errors, []);
    console.log('PASS: Reset sign-in in management, missing-login guidance and navigation, login then OAuth reconnect, independent Close/Update, failures, and the layout at 1280/360px.');
  } finally { await browser.close(); }
}, { url: process.env.AGENT_TEST_URL });
