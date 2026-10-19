// Agents navigation state. AGENT_TEST_URL, when set, reuses an existing dev server: AGENT_TEST_URL=http://127.0.0.1:5391 node tests/ui/agents/agent-navigation-ui.cjs
//
// Behaviour changes vs. the old two-pane Agents page:
// - The detail tab is part of the URL (`#/agents?client=<id>&tab=`), so it is no longer remembered per client:
//   opening a client from the grid always lands on Setup. (Dropped: "each agent remembers its own tab".)
// - There is no compact/`embedded` entry point any more (dropped: full-vs-compact isolation, `remount(embedded)`).
// - The Codex sessions list is its own sub-page (`#/agents/sessions`, 50 rows per page) instead of a Codex-only tab.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('../../helpers/ui-harness.cjs');
const assert = require('node:assert/strict');


runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const tab = name => page.getByRole('tab', { name, exact: true });
    const button = name => page.getByRole('button', { name, exact: true });
    const card = id => page.locator(`ul.ag-grid a.ag-card[data-client="${id}"]`);
    const hash = () => page.evaluate(() => location.hash);
    const hashParams = async () => new URLSearchParams((await hash()).split('?')[1] || '');
    const active = async name => {
      await page.waitForFunction(name => Array.from(document.querySelectorAll('.ag-detail [role=tab]'))
        .some(el => el.textContent === name && el.getAttribute('aria-selected') === 'true'), name);
      assert.equal(await page.locator('.ag-detail [role=tab][aria-selected=true]').count(), 1);
    };
    const detailReady = () => page.waitForFunction(() => document.querySelector('.ag-detail')
      && window.fixtureCalls.some(call => call.cmd === 'get_agent_models'));
    const open = async query => {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&locale=en&${query}`, { waitUntil: 'domcontentloaded' });
      await detailReady();
    };
    const remount = async () => {
      await page.evaluate(() => window.fixtureRemount());
      await page.locator('.ec-sec-agents').waitFor();
    };
    // Open a client the way a user does: back to the grid (from a detail or the sessions page), then its card.
    const goClient = async id => {
      const back = page.getByRole('link', { name: /All clients/ });
      if (await back.count()) await back.click();
      else if (!(await card(id).count())) await tab('Clients').click();
      await card(id).click();
      await page.waitForFunction(id => new URLSearchParams(location.hash.split('?')[1] || '').get('client') === id, id);
      await detailReady();
    };
    const sessionsReady = () => page.getByRole('checkbox', { name: /^Select session / }).first().waitFor();
    const sessionIds = () => page.getByRole('checkbox', { name: /^Select session / })
      .evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label').replace('Select session ', '')));
    const sessionPage = async (first, last, total) => {
      await sessionsReady();
      await page.getByText(`${first}–${last} of ${total}`, { exact: true }).waitFor();
    };
    const openSessions = async () => {
      // Codex's detail page links to the sessions sub-page; from elsewhere use the section tab.
      const link = page.getByRole('link', { name: /^Sessions/ });
      if (await link.count()) await link.click();
      else await tab('Codex sessions').click();
      await page.waitForFunction(() => location.hash === '#/agents/sessions');
    };
    const noOverflow = async label => assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${label}: no horizontal overflow`);
    const backupNotice = page.getByText('Current files on disk saved as a manual backup. Unsaved form changes were not included.', { exact: true });
    const pending = page.getByText('Changes to apply', { exact: true });

    // Every agent remembers its own draft and feedback while navigating grid ↔ detail, and across remounts.
    for (const width of [1280, 540]) {
      await page.setViewportSize({ width, height: 900 });
      await open('client=codex');
      await active('Setup');
      await page.locator('.agent-model-trigger').click();
      await page.getByRole('option', { name: 'gpt-two' }).click();
      await button('How to choose').click();
      await tab('Backups').click();
      assert.equal((await hashParams()).get('tab'), 'backups', 'the tab is part of the route');
      await active('Backups');
      await button('Create backup').first().click();
      await backupNotice.waitFor();
      await goClient('opencode');
      await active('Setup');
      assert.equal(await backupNotice.count(), 0, "another client does not show Codex's feedback");
      assert.equal(await page.getByRole('link', { name: /^Sessions/ }).count(), 0, 'sessions link is Codex-only');
      assert.equal((await hashParams()).get('tab'), null);
      await tab('Manage').click();
      await active('Manage');
      await goClient('pi');
      await active('Setup');
      await goClient('codex');
      await active('Setup');
      await backupNotice.waitFor();
      await pending.waitFor();
      assert.equal(await page.locator('.agent-model-trigger strong').textContent(), 'gpt-two', 'the draft model is kept');
      assert.equal(await page.locator('.ag-help-toggle').getAttribute('aria-expanded'), 'true', 'help stays open');
      await remount();
      await active('Setup');
      await backupNotice.waitFor();
      await pending.waitFor();
      await tab('Manage').click();
      await active('Manage');
      await tab('Manage').press('Home');
      await active('Setup');
      assert.equal(await tab('Setup').evaluate(el => el === document.activeElement), true, 'Home moves focus to the first tab');
      assert.equal((await hashParams()).get('tab'), null);
      assert.equal(await page.locator('.agent-model-trigger strong').textContent(), 'gpt-two');
      await goClient('opencode');
      await tab('Manage').click();
      await goClient('codex');
      await active('Setup');
      await noOverflow(`${width}px detail`);
    }

    // A failed apply keeps its error and the pending draft on that client only.
    await page.setViewportSize({ width: 1280, height: 900 });
    await open('fail-apply&client=codex');
    await page.locator('.agent-model-trigger').click();
    await page.getByRole('option', { name: 'gpt-two' }).click();
    await button('Update Configuration').click();
    await page.getByText(/模拟配置写入失败/).waitFor();
    await goClient('opencode');
    assert.equal(await page.getByText(/模拟配置写入失败/).count(), 0);
    await goClient('codex');
    await page.getByText(/模拟配置写入失败/).waitFor();
    await pending.waitFor();

    // The sessions sub-page keeps its page and selection while other clients are opened.
    await open('client=codex');
    await openSessions();
    await sessionsReady();
    await sessionPage(1, 50, 61);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await sessionPage(51, 61, 61);
    const selectedSession = page.getByRole('checkbox', { name: 'Select session session-51', exact: true });
    await selectedSession.check();
    await goClient('opencode');
    await active('Setup');
    assert.equal(await page.getByRole('link', { name: /^Sessions/ }).count(), 0);
    await goClient('codex');
    await openSessions();
    await sessionPage(51, 61, 61);
    assert.ok(await selectedSession.isChecked(), 'the selection is restored');
    await remount();
    await sessionPage(51, 61, 61);
    assert.ok(await selectedSession.isChecked());
    await noOverflow('sessions');

    // A failed reload leaves the remembered page and selection available for a retry.
    await tab('Clients').click();
    await page.evaluate(() => { window.fixtureFailSessionLoad = true; });
    await tab('Codex sessions').click();
    await page.getByText('Could not read Codex sessions', { exact: true }).waitFor();
    assert.match(await page.getByRole('alert').textContent(), /模拟会话读取失败/);
    await page.evaluate(() => { window.fixtureFailSessionLoad = false; });
    await page.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
    await sessionPage(51, 61, 61);
    assert.ok(await selectedSession.isChecked(), 'retry keeps the selection');
    assert.equal(await page.getByText(/模拟会话读取失败/).count(), 0);

    // Reload actual data on return: drop missing selections, back up from an empty page.
    await tab('Clients').click();
    await page.evaluate(() => { window.fixtureSessionIds = window.fixtureSessionIds.filter(id => id !== 'session-51'); });
    await tab('Codex sessions').click();
    await sessionPage(51, 60, 60);
    assert.equal(await page.locator('input.ses-check:checked').count(), 0, 'missing sessions leave the selection');
    assert.equal(await selectedSession.count(), 0);
    await tab('Clients').click();
    await page.evaluate(() => { window.fixtureSessionIds = window.fixtureSessionIds.slice(0, 10); });
    await tab('Codex sessions').click();
    await sessionsReady();
    assert.equal((await sessionIds()).length, 10, 'an empty page falls back to the last page with data');
    assert.equal(await page.getByRole('button', { name: 'Next page' }).count(), 0, 'one page needs no pager');
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.cmd === 'list_codex_sessions').pop().args.request.offset), 0);

    // A response from the previous visit must not restore stale data or overwrite its cache.
    await tab('Clients').click();
    await page.evaluate(() => { window.fixtureDeferSessionLoad = true; });
    await tab('Codex sessions').click();
    await page.waitForFunction(() => !!window.fixtureFinishSessionLoad);
    await goClient('opencode');
    await page.evaluate(() => { window.fixtureSessionIds = ['session-new']; });
    await goClient('codex');
    await openSessions();
    await sessionsReady();
    await page.evaluate(() => window.fixtureFinishSessionLoad());
    await page.waitForFunction(() => document.querySelector('input.ses-check[aria-label="Select session session-new"]'));
    assert.deepEqual(await sessionIds(), ['session-new']);
    await remount();
    await sessionsReady();
    assert.deepEqual(await sessionIds(), ['session-new']);

    // A real runtime must wait for its first status. No provider (tested above)
    // is Local, but a pending provider must never mount local session commands.
    for (const mode of ['local', 'remote']) {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?sessions&locale=en&runtime=${mode}`);
      await page.waitForFunction(() => typeof window.fixtureResolveCoreStatus === 'function');
      await page.locator('.ec-sec-agents').waitFor();
      assert.equal(await page.locator('.ses-page').count(), 0);
      assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.cmd === 'list_codex_sessions').length), 0,
        'pending runtime must not read local sessions');
      await page.evaluate(() => window.fixtureResolveCoreStatus());
      if (mode === 'local') {
        await sessionsReady();
        assert.equal(await hash(), '#/agents/sessions');
      } else {
        await page.waitForFunction(() => location.hash === '#/agents');
        await card('codex').waitFor();
        assert.equal(await tab('Codex sessions').count(), 0);
        await card('codex').click();
        await detailReady();
        assert.equal(await page.getByRole('link', { name: /^Sessions/ }).count(), 0);
        assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.cmd === 'list_codex_sessions').length), 0,
          'Remote runtime must not read local sessions');
      }
    }

    assert.deepEqual(errors, []);
    console.log('PASS: per-client drafts and feedback, route-driven tabs, help state, remounts, keyboard tab navigation, narrow layout, session pagination/selection restore, failed reload retry, stale response handling, pending runtime session gating and Remote redirect');
  } finally { await browser.close(); }
}, { url: process.env.AGENT_TEST_URL });
