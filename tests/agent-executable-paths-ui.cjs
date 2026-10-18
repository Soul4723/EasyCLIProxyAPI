// AGENT_TEST_URL=http://127.0.0.1:5391 node tests/agent-executable-paths-ui.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('./ui-harness.cjs');
const assert = require('node:assert/strict');

runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    for (const client of ['codex', 'opencode', 'deepseek-harness', 'claude-desktop', 'zcode', 'workbuddy']) {
      const dual = ['codex', 'opencode', 'deepseek-harness'].includes(client);
      // The fixture normally exposes only Harness Web; enable its desktop target for this transport check.
      if (client === 'deepseek-harness') {
        await page.addInitScript(() => { window.fixtureClientStatusesOverride = { 'deepseek-harness': { launchTargets: [{ id: 'app', label: 'APP', detail: 'desktop' }] } }; });
      }
      await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&client=${client}&tab=manage`);
      await page.getByRole('tab', { name: '管理', exact: true }).waitFor();
      // Desktop (or single) program row is `path-app` for dual clients, `path` otherwise.
      const desktopRow = page.locator(dual ? '[data-row="path-app"]' : '[data-row="path"]');
      const cliRow = page.locator('[data-row="path"]');
      const desktopPath = `C:/Custom Apps/${client}/Desktop.exe`;
      await page.evaluate(path => { window.fixtureSelectedProgram = path; }, desktopPath);
      await desktopRow.getByRole('button', { name: '选择…', exact: true }).click();
      await desktopRow.getByText(desktopPath, { exact: true }).waitFor();
      if (dual) {
        const cliPath = `C:/Custom CLI/${client}.cmd`;
        await page.evaluate(path => { window.fixtureSelectedProgram = path; }, cliPath);
        await cliRow.getByRole('button', { name: '选择…', exact: true }).click();
        await cliRow.getByText(cliPath, { exact: true }).waitFor();
      }
      await page.reload();
      await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'get_agent_models'));
      const detection = await page.evaluate(() => window.fixtureCalls.find(call => call.cmd === 'get_agent_config_statuses').args.executableOverrides);
      assert.equal(detection[dual ? `${client}:app` : client], desktopPath);
      if (dual) assert.equal(detection[client], `C:/Custom CLI/${client}.cmd`);
      const launch = (dual ? page.getByRole('button', { name: '启动 App', exact: true })
        : page.locator('.ag-run').getByRole('button', { name: /^启动 / }).first());
      await launch.waitFor();
      await launch.click();
      await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'launch_agent'));
      const args = await page.evaluate(() => window.fixtureCalls.find(call => call.cmd === 'launch_agent').args);
      assert.equal(args.target, 'app');
      assert.equal(args[dual ? 'desktopExecutablePath' : 'executablePath'], desktopPath);
      if (client !== 'deepseek-harness') {
        await page.getByRole('button', { name: '重启 App', exact: true }).click();
        await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'restart_agent_app'));
        const restart = await page.evaluate(() => window.fixtureCalls.find(call => call.cmd === 'restart_agent_app').args);
        assert.deepEqual(restart, { client, executablePath: desktopPath });
      }
      await desktopRow.getByRole('button', { name: '清除', exact: true }).click();
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cpa-gui.agent-executable-paths.v1')));
      assert.equal(saved[dual ? `${client}:app` : client], undefined);
      if (dual) assert.equal(saved[client], `C:/Custom CLI/${client}.cmd`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    }
    assert.deepEqual(errors, []);
    console.log('PASS: six desktop clients, independent CLI paths, persistence, launch, restart and clear');
  } finally {
    await browser.close();
  }
}, { url: process.env.AGENT_TEST_URL });
