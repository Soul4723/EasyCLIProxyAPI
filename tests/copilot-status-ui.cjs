const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('./ui-harness.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const screenshots = path.resolve(__dirname, '..', 'output', 'playwright');
mkdirSync(screenshots, { recursive: true });

runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium);
  try {
    for (const pluginInstalled of [false, true]) {
      const page = await browser.newPage();
      await page.addInitScript(installed => {
        window.fixtureClientStatusesOverride = { 'vscode-copilot': {
          installed: true, version: '1.141.0', appVersion: '1.141.0', cliVersion: null,
          pluginInstalled: installed, pluginVersion: installed ? '0.40.2' : null,
        } };
      }, pluginInstalled);
      await page.goto(`${base}/tests/fixtures/agent-backups.html?client=vscode-copilot`);
      await page.getByText('Copilot 配置时需要一个临时窗口，完成后会自动关闭。', { exact: true }).waitFor();
      assert.equal(await page.getByText('一次性配置：操作说明与排查指令', { exact: true }).count(), 0);
      const plugin = page.getByTestId('copilot-plugin-status');
      await plugin.waitFor();
      assert.equal(await plugin.locator('strong').textContent(), pluginInstalled ? '0.40.2' : '未安装');
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('1.141.0'));
      assert.ok(bodyText.includes('已检测到客户端'));
      const launchButton = page.getByRole('button', { name: '启动 vscode-copilot', exact: true });
      assert.equal(await launchButton.isEnabled(), true);
      await launchButton.click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      const confirm = dialog.getByRole('button', { name: '启动 VSCode Copilot', exact: true });
      assert.equal(await confirm.isDisabled(), true);
      assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.cmd === 'launch_agent').length), 0);
      const directory = 'E:\\项目 files\\Copilot workspace';
      await page.evaluate(value => { window.fixtureSelectedProgram = value; }, directory);
      await dialog.locator('.ag-dir-pick').click();
      await confirm.click();
      await dialog.waitFor({ state: 'hidden' });
      const launch = await page.evaluate(() => window.fixtureCalls.find(call => call.cmd === 'launch_agent'));
      assert.equal(launch.args.client, 'vscode-copilot');
      assert.equal(launch.args.target, 'app');
      assert.equal(launch.args.workingDirectory, directory);
      await launchButton.click();
      await dialog.waitFor();
      assert.equal(await dialog.locator('.ag-dir-pick .ag-dir-path').textContent(), directory);
      assert.equal(await dialog.locator('.ag-dir-chip').count(), 1);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.cmd === 'launch_agent').length), 1);
      if (pluginInstalled) await page.screenshot({ path: path.join(screenshots, 'vscode-copilot-launch.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      if (pluginInstalled) await page.screenshot({ path: path.join(screenshots, 'vscode-copilot-setup-mobile.png'), fullPage: true });
      await page.close();
    }
    console.log('PASS: VS Code status, startup directory, remembered history and cancellation');
  } finally { await browser.close(); }
}, { url: process.env.AGENT_TEST_URL });
