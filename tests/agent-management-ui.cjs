// Run a Vite dev server for the worktree, then:
// AGENT_TEST_URL=http://127.0.0.1:5391 node tests/agent-management-ui.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const base = process.env.AGENT_TEST_URL || 'http://127.0.0.1:1421';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const screenshots = path.join(os.tmpdir(), 'cpa-agent-ui-review');
  fs.mkdirSync(screenshots, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const open = async query => {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&${query}`);
      await page.getByRole('tab', { name: /^(配置|Setup)$/ }).waitFor();
      await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'get_agent_models')
        && !document.querySelector('.ag-detail [aria-busy="true"]'));
    };
    const tab = name => page.getByRole('tab', { name, exact: true });
    const button = name => page.getByRole('button', { name, exact: true });
    const dialog = () => page.getByRole('dialog');
    const run = () => page.locator('.ag-run');
    const calls = cmd => page.evaluate(cmd => window.fixtureCalls.filter(call => call.cmd === cmd), cmd);
    const pending = () => page.getByText('待应用', { exact: true }).waitFor();
    const trigger = () => page.locator('.agent-model-trigger');
    const overflows = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

    // Codex: tab-scoped controls, preserved draft, runtime actions blocked while a restart is in flight.
    await open('defer-restart');
    assert.equal(await button('创建备份').count(), 0);
    assert.equal(await button('应用 ezcpa 模板').count(), 0);
    assert.ok(await button('模型列表设置').isVisible());
    for (const name of ['重启 CLI 服务', '启动 CLI', '启动 App', '重启 App']) assert.ok(await run().getByRole('button', { name, exact: true }).isVisible(), name);
    assert.ok(await page.getByRole('link', { name: /会话/ }).isVisible());
    await trigger().click();
    await page.getByRole('option', { name: 'gpt-two' }).click();
    await pending();
    await button('重启 App').click();
    await page.waitForFunction(() => !!window.fixtureFinishRestart);
    assert.ok(await button('启动 CLI').isDisabled());
    assert.ok(await trigger().isDisabled());
    await page.evaluate(() => window.fixtureFinishRestart());
    await run().getByRole('button', { name: '重启 App', exact: true }).waitFor();
    await pending();
    assert.deepEqual((await calls('restart_agent_app')).map(call => call.args), [{ client: 'codex', executablePath: null }]);
    assert.equal((await calls('update_agent_config')).length, 0);

    await tab('管理').click();
    assert.equal(await button('更新配置').count(), 0);
    assert.equal(await button('模型列表设置').count(), 0);
    for (const name of ['应用 ezcpa 模板', '清空配置']) assert.ok(await button(name).isVisible(), name);
    await tab('备份').click();
    assert.ok(await button('创建备份').first().isVisible());
    await tab('管理').click();
    await tab('管理').press('ArrowLeft');
    await tab('备份').press('ArrowLeft');
    assert.equal(await tab('配置').getAttribute('aria-selected'), 'true');
    assert.equal(await tab('配置').evaluate(el => el === document.activeElement), true);
    assert.equal(await trigger().locator('strong').textContent(), 'gpt-two');
    await pending();
    await button('更新配置').click();
    await page.waitForFunction(() => window.fixtureCalls.filter(call => call.cmd === 'update_agent_config').length === 1);
    assert.equal((await calls('update_agent_config'))[0].args.model, 'gpt-two');
    await tab('管理').click();
    await page.getByRole('link', { name: '全部客户端' }).click();
    await page.locator('a.ag-card[data-client="opencode"]').click();
    assert.equal(await tab('配置').getAttribute('aria-selected'), 'true');

    // Desktop restarts and disabled states.
    for (const client of ['claude-desktop', 'zcode', 'workbuddy', 'opencode']) {
      await open(`client=${client}&app-only`);
      assert.ok(await button('重启 App').isEnabled());
      await button('重启 App').click();
      await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'restart_agent_app'));
      assert.deepEqual((await calls('restart_agent_app'))[0].args, { client, executablePath: null });
      if (client === 'opencode') assert.ok(await button('启动 CLI').isDisabled());
    }
    await open('not-installed');
    assert.ok(await button('启动 App').isDisabled());
    assert.ok(await button('重启 App').isDisabled());
    for (const client of ['workbuddy', 'openclaw']) {
      await open(`client=${client}&config-only=${client}&fresh`);
      assert.ok(await trigger().isEnabled());
      assert.ok(await button('一键接入').isEnabled());
      assert.ok(await run().getByRole('button').first().isDisabled());
      await button('一键接入').click();
      await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'update_agent_config'));
      assert.deepEqual((await calls('update_agent_config'))[0].args.client, client);
    }
    await open('client=kimi-code');
    assert.equal(await button('重启 App').count(), 0);

    // Clear integration (every client that supports it): confirm, cancel, apply.
    for (const client of ['claude-code', 'claude-desktop', 'opencode', 'openclaw', 'hermes', 'deepseek-harness', 'zcode', 'workbuddy', 'antigravity-cli', 'kimi-code', 'grok-build', 'omp']) {
      await open(`client=${client}`);
      assert.ok(await button('关闭配置修改').isEnabled());
      await tab('管理').click();
      assert.ok(await button('清除接入').isEnabled());
      await button('清除接入').click();
      assert.match(await dialog().innerText(), /保留其他设置/);
      await dialog().getByRole('button', { name: '取消', exact: true }).click();
      await dialog().waitFor({ state: 'detached' });
      assert.equal((await calls('set_agent_config_enabled')).length, 0);
      await button('清除接入').click();
      await button('确认清除接入').click();
      await dialog().waitFor({ state: 'detached' });
      assert.deepEqual((await calls('set_agent_config_enabled')).map(call => call.args), [{
        client, model: '', enabled: false, forceRestore: false,
        claudeCodeModelMappings: null, claudeDesktopModelMappings: null,
        executableOverrides: {},
      }]);
      assert.equal((await calls('clear_codex_config')).length, 0);
      await tab('配置').click();
      assert.equal(await button('关闭配置修改').count(), 0);
      assert.ok(await button('一键接入').isVisible());
    }
    await open('client=claude-code&state=needs-update');
    assert.ok(await button('关闭配置修改').isEnabled());
    await open('client=claude-code&no-core&defer-clear');
    await button('关闭配置修改').click();
    await page.waitForFunction(() => !!window.fixtureFinishClear);
    assert.ok(await button('关闭配置修改').isDisabled());
    await page.evaluate(() => window.fixtureFinishClear());
    await button('关闭配置修改').waitFor({ state: 'detached' });
    await page.getByText('已清除 CPA 接入，请重启 Claude Code。', { exact: true }).waitFor();
    await open('client=claude-code&fail-clear');
    await tab('管理').click();
    await button('清除接入').click();
    await button('确认清除接入').click();
    await dialog().getByText(/模拟清除失败/).waitFor();
    assert.ok(await dialog().isVisible());
    await dialog().getByRole('button', { name: '取消', exact: true }).click();

    // Pi.
    await open('client=pi&update');
    assert.equal(await button('卸载 Pi 插件').count(), 0);
    await tab('管理').click();
    assert.ok(await button('更新').isEnabled());
    assert.ok(await button('卸载').isEnabled());
    assert.equal(await button('创建备份').count(), 0);
    await open('client=pi&no-plugin');
    assert.ok(await button('安装 Pi 插件').isEnabled());
    await open('client=pi&config-only=pi&no-plugin&fresh');
    assert.ok(await button('安装 Pi 插件').isEnabled());
    assert.ok(await run().getByRole('button').first().isDisabled());
    await button('安装 Pi 插件').click();
    await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'install_pi_provider'));

    // DeepSeek Harness process controls.
    await open('client=deepseek-harness&running');
    await button('重启 Web').click();
    assert.equal((await calls('restart_deepseek_harness_process')).length, 1);
    await button('关闭 DeepSeek Harness').waitFor();
    await open('client=deepseek-harness&running&harness-mode=headless');
    assert.equal(await button('重启 Web').count(), 0);
    await open('client=deepseek-harness&running&fail-restart');
    await button('重启 Web').click();
    await page.getByText(/模拟重启失败/).waitFor();
    await button('重启 Web').waitFor({ state: 'detached' });
    assert.equal(await button('关闭 DeepSeek Harness').count(), 0);
    assert.equal((await calls('launch_agent')).length, 0);

    // Responsive layout across themes: no horizontal overflow, key controls visible and inside the viewport.
    for (const { width, height } of [{ width: 1280, height: 900 }, { width: 1280, height: 941 }, { width: 680, height: 800 }, { width: 540, height: 700 }]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      await open(`theme=${theme}&locale=en`);
      for (const [name, key] of [['Setup', 'setup'], ['Backups', 'backups'], ['Manage', 'manage']]) {
        await tab(name).click();
        const context = `${width}x${height}/${theme}/${name}`;
        assert.equal(await overflows(), false, `${context}: document overflows horizontally`);
        assert.ok(await tab(name).isVisible(), context);
        const key$ = { setup: '.ag-savebar button', backups: '[data-action="create-backup"]', manage: '[data-row="clear"] button' }[key];
        const control = page.locator(key$).first();
        await control.waitFor();
        assert.ok(await control.isVisible(), `${context}: key control hidden`);
        const clipped = await page.evaluate(() => [...document.querySelectorAll('.ag-detail button')]
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1); })
          .map(el => el.textContent.trim()));
        assert.deepEqual(clipped, [], `${context}: buttons outside the viewport`);
        await page.screenshot({ path: path.join(screenshots, `${width}x${height}-${theme}-${key}.png`), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: tab navigation, preserved drafts, shared runtime actions, all desktop restarts, Pi, Harness, disabled states, keyboard, responsive themes');
    console.log('Screenshots: ' + screenshots);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
