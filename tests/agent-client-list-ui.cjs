// Agents client grid. Run Vite, then: AGENT_TEST_URL=http://127.0.0.1:1421 node tests/agent-client-list-ui.cjs
// PLAYWRIGHT_MODULE can target an existing local Playwright install.
//
// Dropped with the old Agents page (no equivalent in the AgentsSection): the "Manage clients" dialog (visibility
// checkboxes, draft/cancel/Escape, empty-selection guard, focus trap/return, "restore automatic"), the persisted
// `cpa-gui.agent-visible-clients.v1` list, and the client pagination (previous/next page). Every client is now on the
// grid and "Not installed" is a filter instead.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const base = process.env.AGENT_TEST_URL || 'http://127.0.0.1:1421';
const screenshots = path.join(os.tmpdir(), 'easycliproxy-agent-clients');
// Catalogue order (agentDefinitions in src/sections/agents/model.ts).
const allClients = {
  'claude-code': 'Claude Code', 'claude-desktop': 'Claude Desktop', codex: 'Codex', 'deepseek-harness': 'DeepSeek Harness',
  opencode: 'OpenCode', omp: 'Oh My Pi', pi: 'Pi', 'grok-build': 'Grok Build', 'copilot-cli': 'Copilot CLI',
  'vscode-copilot': 'VSCode Copilot', 'antigravity-cli': 'Antigravity CLI', workbuddy: 'WorkBuddy', zcode: 'ZCode',
  'kimi-code': 'Kimi Code', openclaw: 'OpenClaw', hermes: 'Hermes Agent',
};
const allIds = Object.keys(allClients);

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    fs.mkdirSync(screenshots, { recursive: true });

    const cards = () => page.locator('ul.ag-grid a.ag-card');
    const card = id => page.locator(`ul.ag-grid a.ag-card[data-client="${id}"]`);
    const chip = label => page.getByRole('group', { name: /^(筛选客户端|Filter clients)$/ })
      .getByRole('button', { name: new RegExp(`^${label}\\s*\\d*$`) });
    const search = () => page.getByRole('searchbox', { name: /^(搜索客户端|Search clients)$/ });
    const states = async () => Object.fromEntries(await cards().evaluateAll(nodes => nodes.map(n => [n.dataset.client, n.dataset.state])));
    const ready = () => page.waitForFunction(() => window.fixtureCalls?.some(call => call.cmd === 'get_agent_config_statuses')
      && document.querySelectorAll('ul.ag-grid a.ag-card').length > 0
      && !document.querySelector('ul.ag-grid a.ag-card[data-state="detecting"]'));
    const open = async (extra = '', hash = '') => {
      const locale = /(^|&)locale=/.test(extra) ? '' : 'locale=en&';
      await page.goto(`${base}/tests/fixtures/agent-backups.html?grid&${locale}${extra}${hash}`, { waitUntil: 'domcontentloaded' });
      if (hash) await page.waitForFunction(() => window.fixtureCalls?.some(call => call.cmd === 'get_agent_config_statuses'));
      else await ready();
      await page.evaluate(() => document.fonts.ready);
    };
    const count = async label => Number(((await chip(label).textContent()) || '').replace(/\D/g, ''));
    const assertCounts = async (expected, label) => {
      assert.deepEqual({ all: await count('All'), connected: await count('Connected'), detected: await count('Detected'),
        notInstalled: await count('Not installed') }, expected, `${label}: filter counts`);
    };
    const assertNoHorizontalOverflow = async label => {
      const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(metrics.scrollWidth <= metrics.width + 1, `${label}: the page must fit the viewport`);
    };

    // Default fixture: every one of the 16 clients is on the grid, in the catalogue order, all connected.
    await open();
    assert.deepEqual(await cards().evaluateAll(nodes => nodes.map(n => n.dataset.client)), allIds, 'all 16 clients on the grid');
    for (const [id, name] of Object.entries(allClients)) {
      assert.equal(await card(id).locator('strong').textContent(), name, `${id} shows its name`);
    }
    assert.deepEqual(new Set(Object.values(await states())), new Set(['connected']));
    await assertCounts({ all: 16, connected: 16, detected: 16, notInstalled: 0 }, 'default');
    assert.equal(await chip('All').getAttribute('aria-pressed'), 'true', 'All is the initial filter');
    assert.equal(await card('codex').getAttribute('aria-label'), 'Codex — Connected');

    // mixed-clients: three connected + Pi (extension installed), Claude Desktop config-only, the rest not installed.
    await open('mixed-clients');
    const mixed = await states();
    for (const id of ['claude-code', 'codex', 'opencode', 'pi']) assert.equal(mixed[id], 'connected', `${id} connected`);
    assert.equal(mixed['claude-desktop'], 'notConfigured', 'config-only Claude Desktop is detected but not configured');
    for (const id of allIds.filter(id => !['claude-code', 'codex', 'opencode', 'claude-desktop', 'pi'].includes(id))) {
      assert.equal(mixed[id], 'notInstalled', `${id} not installed`);
    }
    await assertCounts({ all: 16, connected: 4, detected: 5, notInstalled: 11 }, 'mixed-clients');
    assert.equal(await card('claude-code').locator('.ag-card-chips').textContent(), 'Connected');
    assert.equal(await card('claude-desktop').locator('.ag-card-chips').textContent(), 'Not configured');
    assert.equal(await card('hermes').locator('.ag-card-chips').textContent(), 'Not installed');
    assert.equal(await card('hermes').getAttribute('aria-label'), 'Hermes Agent — Not installed');

    // Filter chips narrow the grid and mark the active chip.
    await chip('Connected').click();
    assert.equal(await chip('Connected').getAttribute('aria-pressed'), 'true');
    assert.equal(await chip('All').getAttribute('aria-pressed'), 'false');
    assert.deepEqual((await cards().evaluateAll(nodes => nodes.map(n => n.dataset.client))).sort(), ['claude-code', 'codex', 'opencode']);
    await chip('Detected').click();
    assert.equal(await cards().count(), 5);
    assert.ok(await card('claude-desktop').count() && await card('pi').count(), 'detected includes config-only and plugin-only clients');
    await chip('Not installed').click();
    assert.equal(await cards().count(), 11);
    assert.equal(await card('codex').count(), 0);
    await chip('All').click();
    assert.equal(await cards().count(), 16);

    // Search is a case-insensitive name match that combines with the active filter.
    await search().fill('herMES');
    assert.deepEqual(await cards().evaluateAll(nodes => nodes.map(n => n.dataset.client)), ['hermes'], 'search reaches uninstalled clients');
    await search().fill('claude');
    assert.deepEqual(await cards().evaluateAll(nodes => nodes.map(n => n.dataset.client)), ['claude-code', 'claude-desktop']);
    await chip('Connected').click();
    assert.deepEqual(await cards().evaluateAll(nodes => nodes.map(n => n.dataset.client)), ['claude-code'], 'search combines with the filter');
    await search().fill('no-such-client');
    assert.equal(await cards().count(), 0);
    await page.getByText('No matching clients', { exact: true }).waitFor();
    await search().fill('');
    await chip('All').click();
    assert.equal(await cards().count(), 16);

    // not-installed (clean machine): nothing is detected, every card is "not installed", the full catalogue is still listed.
    await open('not-installed&no-plugin&fresh');
    assert.equal(await cards().count(), 16);
    assert.deepEqual(new Set(Object.values(await states())), new Set(['notInstalled']));
    await assertCounts({ all: 16, connected: 0, detected: 0, notInstalled: 16 }, 'not-installed');
    await chip('Connected').click();
    await page.getByText('No matching clients', { exact: true }).waitFor();
    assert.equal(await cards().count(), 0);

    // config-only: a client with only a config file counts as detected, even though the binary is missing.
    await open('not-installed&no-plugin&fresh&config-only=hermes');
    assert.equal((await states()).hermes, 'notConfigured', 'config-only client is detected (not "not installed")');
    await assertCounts({ all: 16, connected: 0, detected: 1, notInstalled: 15 }, 'config-only');
    await chip('Detected').click();
    assert.deepEqual(await cards().evaluateAll(nodes => nodes.map(n => n.dataset.client)), ['hermes']);

    // Clicking a card opens that client's detail; the back link returns to the grid.
    await open('mixed-clients');
    await card('opencode').click();
    await page.waitForFunction(() => location.hash.startsWith('#/agents?') && new URLSearchParams(location.hash.split('?')[1]).get('client') === 'opencode');
    await page.getByRole('tab', { name: /^Setup$/ }).waitFor();
    assert.equal(await cards().count(), 0, 'the grid is replaced by the detail');
    assert.equal(await page.getByRole('heading', { name: 'OpenCode' }).count() >= 1 || await page.getByText('OpenCode', { exact: true }).count() >= 1, true);
    await page.getByRole('link', { name: /All clients/ }).click();
    await page.waitForFunction(() => location.hash === '#/agents');
    await ready();
    assert.equal(await cards().count(), 16, 'back link restores the full grid');
    // A not-installed client still opens its detail.
    await card('hermes').click();
    await page.getByRole('tab', { name: /^Setup$/ }).waitFor();
    await page.getByRole('link', { name: /All clients/ }).waitFor();

    // Direct deep link to a detail, and an unknown client id → not-found state with a way back.
    await open('mixed-clients', '#/agents?client=claude-code&tab=backups');
    await page.getByRole('tab', { name: /^Backups$/ }).waitFor();
    assert.equal(await page.getByRole('tab', { name: /^Backups$/ }).getAttribute('aria-selected'), 'true');
    await open('mixed-clients', '#/agents?client=no-such-client');
    await page.getByText('Client not found', { exact: true }).waitFor();
    assert.equal(await cards().count(), 0);
    assert.equal(await page.getByRole('tab', { name: /^Setup$/ }).count(), 0, 'no detail tabs for an unknown client');
    await page.getByRole('button', { name: 'All clients', exact: true }).click();
    await page.waitForFunction(() => location.hash === '#/agents');
    await ready();
    assert.equal(await cards().count(), 16, 'not-found state links back to the grid');

    // Detection failure: error state with a message, retry succeeds and fills the grid.
    await page.goto(`${base}/tests/fixtures/agent-backups.html?grid&locale=en&mixed-clients&fail-detection`, { waitUntil: 'domcontentloaded' });
    const alert = page.getByRole('alert').filter({ hasText: 'Client detection failed' });
    await alert.waitFor();
    assert.match(await alert.textContent(), /模拟客户端检测失败/, 'the detection error message is shown');
    assert.equal(await cards().evaluateAll(nodes => nodes.every(n => n.dataset.state === 'detecting')), true,
      'without statuses no client claims a state');
    await alert.getByRole('button', { name: /^Retry$/ }).click();
    await ready();
    await alert.waitFor({ state: 'hidden' });
    assert.equal(await cards().count(), 16);
    assert.equal((await states()).codex, 'connected', 'retry loads the statuses');
    // The header Rescan button re-runs detection too.
    const detections = () => page.evaluate(() => window.fixtureCalls.filter(c => c.cmd === 'refresh_agent_config_statuses').length);
    const before = await detections();
    await page.getByRole('button', { name: 'Rescan', exact: true }).click();
    await page.waitForFunction(n => window.fixtureCalls.filter(c => c.cmd === 'refresh_agent_config_statuses').length > n, before);

    // Browsing the grid never writes config or launches a client.
    assert.equal(await page.evaluate(() => window.fixtureCalls.some(call =>
      /^(update_agent_config|set_agent_config_enabled|launch_agent)$/.test(call.cmd))), false,
      'listing and navigation must not write config or launch a client');

    // Layout: no horizontal overflow on desktop and narrow windows, in zh-CN light and English dark.
    for (const [width, height] of [[1280, 900], [680, 900]]) {
      for (const english of [false, true]) {
        await page.setViewportSize({ width, height });
        await open(`mixed-clients&${english ? 'theme=dark' : 'locale=zh-CN'}`);
        const label = `${width}px ${english ? 'dark-en' : 'light-zh'}`;
        await assertNoHorizontalOverflow(label);
        assert.equal(await cards().count(), 16, `${label}: all clients reachable`);
        for (const control of [search(), page.getByRole('button', { name: english ? 'Rescan' : '重新检测', exact: true })]) {
          assert.equal(await control.isVisible(), true, `${label}: controls visible`);
          assert.equal(await control.isEnabled(), true, `${label}: controls enabled`);
        }
        await card('codex').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(screenshots, `grid-${width}-${english ? 'dark-en' : 'light-zh'}.png`), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: 16-client grid, state chips (mixed/not-installed/config-only), filter counts, search, detail navigation, not-found, detection failure retry, narrow layouts, dark English');
    console.log(`Screenshots: ${screenshots}`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
