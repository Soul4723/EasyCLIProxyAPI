// Agents "changes to apply" state. AGENT_TEST_URL, when set, reuses an existing dev server: AGENT_TEST_URL=http://127.0.0.1:5391 node tests/ui/agents/agent-pending-ui.cjs
//
// Differences vs. the old page: the pending marker lives in the Setup tab's save bar, so it is asserted after returning to
// Setup (it is not rendered on Backups/Manage); there is no compact `embedded` mode and no client list/switcher
// (other clients are opened from the grid).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('../../helpers/ui-harness.cjs');
const assert = require('node:assert/strict');


runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const pending = page.getByText('Changes to apply', { exact: true });
    const expectPending = async expected => {
      await pending.waitFor({ state: expected ? 'visible' : 'detached' });
      assert.equal(await page.getByText('Unsaved', { exact: true }).count(), 0);
    };
    const ready = () => page.waitForFunction(() => {
      const bar = document.querySelector('.ag-detail .ag-savebar');
      return bar && !bar.textContent.includes('Reading configuration') && !document.querySelector('.ag-setup[aria-busy]')
        && window.fixtureCalls.some(call => call.cmd === 'get_agent_models');
    });
    const open = async query => {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&locale=en&${query}`);
      await ready();
    };
    const tab = name => page.getByRole('tab', { name, exact: true });
    const backups = () => tab('Backups').click();
    const setup = () => tab('Setup').click();
    const goClient = async id => {
      await page.getByRole('link', { name: /All clients/ }).click();
      await page.locator(`ul.ag-grid a.ag-card[data-client="${id}"]`).click();
      await ready();
    };
    const selectModel = async (model, index = 0) => {
      await setup();
      await page.locator('.agent-model-trigger').nth(index).click();
      await page.getByRole('option').filter({ has: page.getByText(model, { exact: true }) }).click();
    };
    const apply = async () => {
      await setup();
      await page.getByRole('button', { name: /^(Update Configuration|Connect in One Click|Apply Configuration Changes)$/ }).click();
      await page.getByText(/^(Configuration updated\.|Configuration is already up to date\.)$/).waitFor();
      await expectPending(false);
    };
    const rescan = async () => {
      const before = await page.evaluate(() => window.fixtureCalls.filter(call => call.cmd === 'refresh_agent_config_statuses').length);
      await page.getByRole('button', { name: 'Rescan', exact: true }).click();
      await page.waitForFunction(n => window.fixtureCalls.filter(call => call.cmd === 'refresh_agent_config_statuses').length > n, before);
      await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Rescan')?.disabled);
    };

    // Initial detection, missing mappings and refreshes do not count as user edits.
    for (const query of ['', 'fresh', 'state=needs-update', 'state=invalid', 'client=claude-desktop']) {
      await open(query);
      await expectPending(false);
      await rescan();
      await ready();
      await expectPending(false);
    }

    // Model edits, reversions, backups, apply and component remounts.
    for (const query of ['fresh', 'client=pi']) {
      await open(query);
      const original = await page.locator('.agent-model-trigger strong').first().textContent();
      const changed = original === 'gpt-one' ? 'gpt-two' : 'gpt-one';
      await selectModel(changed); await expectPending(true);
      await selectModel(original); await expectPending(false);
      await selectModel(changed); await expectPending(true);
      if (!query.includes('client=pi')) {
        await backups();
        await page.getByRole('button', { name: 'Create backup', exact: true }).first().click();
        await page.getByText('Current files on disk saved as a manual backup. Unsaved form changes were not included.', { exact: true }).waitFor();
      }
      await setup(); await expectPending(true);
      await page.evaluate(() => window.fixtureRemount());
      await page.locator('.ec-sec-agents').waitFor();
      await setup();
      await ready(); await expectPending(true);
      await apply();
      await selectModel(original); await expectPending(true);
      await selectModel(changed); await expectPending(false);
    }

    // Independent client drafts and authentication changes.
    await open('');
    await selectModel('gpt-two'); await expectPending(true);
    await goClient('opencode'); await expectPending(false);
    await goClient('codex'); await expectPending(true);
    await selectModel('gpt-one'); await expectPending(false);
    await page.getByRole('radio', { name: 'OAuth configuration mode' }).click();
    await expectPending(true);
    await selectModel('gpt-two');
    await page.getByRole('radio', { name: 'API key', exact: true }).click();
    await expectPending(true);
    await selectModel('gpt-one'); await expectPending(false);

    // Claude role mappings and runtime settings are real form edits, too.
    await open('client=claude-code');
    // The fixture starts with no role mappings (an unset role cannot be picked again, and Apply needs all four roles),
    // so applying a full mapping gives a baseline to revert to.
    for (const role of [0, 1, 2, 3]) { await selectModel('gpt-two', role); await expectPending(true); }
    await apply();
    await selectModel('gpt-one', 0); await expectPending(true);
    await selectModel('gpt-two', 0); await expectPending(false);
    const context = page.getByRole('switch', { name: 'Opus 1M', exact: true });
    await context.click(); await expectPending(true);
    await context.click(); await expectPending(false);
    await page.getByRole('button', { name: 'Context and auto-compaction (advanced)' }).click();
    const maxWindow = page.getByRole('spinbutton', { name: 'Auto-compact window' });
    await maxWindow.fill('300000');
    await expectPending(true);
    await maxWindow.fill('200000');
    await expectPending(false);
    const compact = page.getByRole('switch', { name: 'Disable auto-compaction', exact: true });
    await compact.click(); await expectPending(true);
    await compact.click(); await expectPending(false);
    await selectModel('gpt-one', 1); await expectPending(true); await apply();

    // A failed write must retain the pending edit; a successful retry clears it.
    await open('fail-apply');
    await selectModel('gpt-two');
    await page.getByRole('button', { name: 'Update Configuration', exact: true }).click();
    await page.getByText(/模拟配置写入失败/).waitFor();
    await expectPending(true);
    await apply();

    // Applying a template or restoring a backup replaces the draft baseline.
    for (const restore of [false, true]) {
      await open('');
      await backups();
      await page.getByRole('button', { name: 'Create backup', exact: true }).first().click();
      await page.getByText(/saved as a manual backup/).waitFor();
      await selectModel('gpt-two'); await expectPending(true);
      await backups();
      if (restore) {
        await page.getByRole('button', { name: 'Restore', exact: true }).first().click();
        await page.getByRole('button', { name: 'Confirm Restore', exact: true }).click();
        await page.getByRole('dialog').waitFor({ state: 'detached' });
      } else {
        await tab('Manage').click();
        await page.getByRole('button', { name: 'Apply ezcpa template', exact: true }).click();
        await page.getByRole('button', { name: 'Confirm Overwrite', exact: true }).click();
        await page.getByRole('button', { name: 'Confirm Overwrite', exact: true }).waitFor({ state: 'detached' });
      }
      await setup();
      await expectPending(false);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: initial detection, edits/reverts, refresh, per-client drafts, remount, OAuth, Claude settings, Pi, backup, apply/failure, template and restore pending states');
  } finally {
    await browser.close();
  }
}, { url: process.env.AGENT_TEST_URL });
