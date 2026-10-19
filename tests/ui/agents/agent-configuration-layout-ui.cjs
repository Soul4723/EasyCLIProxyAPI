// Agents section: layout robustness + the apply/update feedback flow.
// AGENT_TEST_URL, when set, reuses an existing dev server: AGENT_TEST_URL=http://127.0.0.1:5391 node tests/ui/agents/agent-configuration-layout-ui.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('../../helpers/ui-harness.cjs');
const assert = require('node:assert/strict');

const clients = ['codex', 'claude-desktop', 'deepseek-harness', 'zcode'];
const tabs = [['setup', '配置'], ['backups', '备份'], ['manage', '管理']];
const viewports = [
  { width: 1280, height: 900 },
  { width: 900, height: 700 },
  { width: 680, height: 900 },
  { width: 360, height: 941 },
];

runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));

    const open = async query => {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&${query}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForFunction(() => window.fixtureCalls?.some(call => call.cmd === 'get_agent_config_statuses'));
      await page.evaluate(() => document.fonts.ready);
    };

    // No sideways page scroll and no visible control pushed outside the viewport.
    const assertFits = async label => {
      const metrics = await page.evaluate(() => {
        const visible = node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
        };
        const outside = Array.from(document.querySelectorAll('button, input, select, textarea, [role="tab"], a[href]'))
          .filter(visible)
          .map(node => ({ node, rect: node.getBoundingClientRect() }))
          .filter(({ rect }) => rect.left < -1 || rect.right > window.innerWidth + 1)
          .map(({ node }) => node.getAttribute('aria-label') || node.textContent.trim().slice(0, 40) || node.tagName);
        return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, outside };
      });
      assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${label}: the page must not scroll horizontally`);
      assert.deepEqual(metrics.outside, [], `${label}: every visible control must stay inside the viewport`);
    };

    // 1. Detail pages: every tab of representative clients fits at desktop, tablet and phone widths.
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const client of clients) {
        for (const [tab, tabName] of tabs) {
          const label = `${viewport.width}x${viewport.height}/${client}/${tab}`;
          await open(`client=${client}&tab=${tab}`);
          const tablist = page.getByRole('tablist', { name: '客户端设置', exact: true });
          await tablist.waitFor();
          assert.equal(await tablist.getByRole('tab', { name: tabName, exact: true }).getAttribute('aria-selected'), 'true', `${label}: tab selected`);
          assert.equal(await tablist.getByRole('tab').count(), 3, `${label}: three detail tabs`);
          if (tab === 'setup') {
            const apply = page.getByRole('group', { name: '应用配置', exact: true }).getByRole('button').last();
            await apply.waitFor();
            assert.ok(await apply.isVisible(), `${label}: the apply button is visible`);
          }
          await assertFits(label);
        }
      }
    }

    // 2. Client grid: every client has a card and long applied-model names truncate on one line.
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await open('grid');
      await page.locator('ul.ag-grid a.ag-card').first().waitFor();
      const label = `${viewport.width}x${viewport.height}/grid`;
      assert.equal(await page.locator('ul.ag-grid a.ag-card').count(), 16, `${label}: one card per supported client`);
      await assertFits(label);
      const longModel = 'gemini-3.8-flash-high-with-a-long-client-status-for-layout-verification';
      await page.evaluate(model => { window.fixtureClientStatusesOverride = { zcode: { appliedModel: model, currentModel: model } }; }, longModel);
      await page.getByRole('button', { name: '重新检测', exact: true }).click();
      const modelLine = page.locator('a.ag-card[data-client=zcode] .ag-card-model');
      await page.waitForFunction(model => document.querySelector('a.ag-card[data-client=zcode] .ag-card-model')?.title === model, longModel);
      const flow = await modelLine.locator('span').evaluate(node => ({
        overflows: node.scrollWidth > node.clientWidth + 1,
        height: node.getBoundingClientRect().height,
        whiteSpace: getComputedStyle(node).whiteSpace,
        textOverflow: getComputedStyle(node).textOverflow,
      }));
      assert.equal(flow.overflows, true, `${label}: the long model fixture must exercise truncation`);
      assert.equal(flow.whiteSpace, 'nowrap', `${label}: the applied model stays on one line`);
      assert.equal(flow.textOverflow, 'ellipsis', `${label}: the truncated model shows an ellipsis`);
      assert.ok(flow.height < 30, `${label}: the applied model text occupies a single line`);
      await assertFits(`${label}/long-model`);
    }

    // 3. Codex sessions page: rows render, the loaded list is reachable and nothing overflows sideways.
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await open('sessions');
      const label = `${viewport.width}x${viewport.height}/sessions`;
      const rows = page.locator('table tbody tr');
      await page.getByText('session-1', { exact: true }).first().waitFor();
      assert.equal(await rows.count(), 50, `${label}: the first page of sessions renders`);
      const last = page.getByText('session-50', { exact: true }).first();
      await last.scrollIntoViewIfNeeded();
      assert.ok(await last.isVisible(), `${label}: scrolling reveals the last loaded session`);
      await assertFits(label);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => { window.fixtureFailSessionLoad = true; });
    await open('sessions');
    await page.getByRole('alert').filter({ hasText: '模拟会话读取失败' }).waitFor();
    await assertFits('sessions/load-error');
    await page.addInitScript(() => { window.fixtureFailSessionLoad = false; });

    // 4. Pending, failure and success feedback must not shift the controls or break the layout.
    for (const viewport of [{ width: 1280, height: 941 }, { width: 680, height: 900 }]) {
      await page.setViewportSize(viewport);
      await open('client=codex&tab=setup&fail-apply');
      const label = `${viewport.width}x${viewport.height}/codex/dynamic-state`;
      const saveBar = page.getByRole('group', { name: '应用配置', exact: true });
      const save = page.getByRole('button', { name: '更新配置', exact: true });
      const geometry = () => page.evaluate(() => {
        const nodes = [document.querySelector('.ag-savebar'), document.querySelector('.ag-savebar .ec-btn--primary'), document.querySelector('.ag-detail-id')];
        return nodes.map(node => {
          const rect = node.getBoundingClientRect();
          return [rect.x + scrollX, rect.y + scrollY, rect.width, rect.height];
        });
      });
      await save.waitFor();
      const original = await geometry();
      await page.locator('.agent-model-trigger').click();
      await page.getByRole('option', { name: 'gpt-two' }).click();
      await saveBar.getByText('待应用', { exact: true }).waitFor();
      await assertFits(`${label}/pending`);
      if (viewport.width >= 900) {
        assert.deepEqual(await geometry(), original, `${label}: pending feedback must not shift the controls`);
      } else {
        // Stacked save bar (narrow): the pending line may add a row, but the bar must stay on screen.
        const bar = await saveBar.boundingBox();
        assert.ok(bar.y >= 0 && bar.y + bar.height <= viewport.height + 1, `${label}: the save bar stays in the viewport`);
      }
      await save.click();
      const failure = page.getByRole('alert').filter({ hasText: /模拟配置写入失败/ });
      await failure.waitFor();
      await assertFits(`${label}/failure`);
      await failure.getByRole('button', { name: '关闭', exact: true }).click();
      await failure.waitFor({ state: 'detached' });
      await save.click();
      // The fixture reports the second write as unchanged (the first one failed before changing anything).
      await page.getByRole('status').filter({ hasText: '配置已是最新，无需写入。' }).waitFor();
      assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.cmd === 'update_agent_config').length), 2,
        `${label}: the retry reached the backend after the failed write`);
      await assertFits(`${label}/success`);
    }

    // 5. Codex connection method: API key <-> OAuth is a pending edit that is sent with the apply.
    await page.setViewportSize({ width: 1280, height: 900 });
    await open('client=codex&tab=setup');
    const method = page.getByRole('radiogroup', { name: '接入方式', exact: true });
    const apiKey = method.getByRole('radio', { name: 'API 密钥', exact: true });
    const oauth = method.getByRole('radio', { name: 'OAuth 登录方式', exact: true });
    await method.waitFor();
    assert.equal(await apiKey.getAttribute('aria-checked'), 'true');
    await oauth.click();
    await page.getByRole('group', { name: '应用配置', exact: true }).getByText('待应用', { exact: true }).waitFor();
    assert.equal(await oauth.getAttribute('aria-checked'), 'true');
    await page.getByRole('button', { name: '更新配置', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '配置已更新。' }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.cmd === 'update_agent_config').at(-1).args.oauthConfiguration), true);
    // Without a Codex login, switching to OAuth is refused with a dialog and the selection stays on API key.
    await open('client=codex&tab=setup');
    await page.evaluate(() => { window.fixtureOauthLoggedIn = false; });
    await oauth.click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await apiKey.getAttribute('aria-checked'), 'true');
    await assertFits('codex/oauth-login-required');

    assert.deepEqual(errors, []);
    console.log('PASS: detail tabs, grid, sessions and apply feedback fit 1280/900/680/360px; pending/failure/success flow, long-model truncation and Codex auth method behave.');
  } finally {
    await browser.close();
  }
}, { url: process.env.AGENT_TEST_URL });
