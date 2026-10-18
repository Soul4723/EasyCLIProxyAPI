const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('./ui-harness.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    for (const locale of ['zh-CN', 'en', 'ja']) {
      for (const theme of ['light', 'dark']) {
        for (const width of [1392, 1100, 760, 480]) {
          await page.setViewportSize({ width, height: 962 });
          await page.goto(`${base}/tests/fixtures/agent-backups.html?client=claude-code&tab=setup&reset-selections&claude-alias-layout&locale=${locale}&theme=${theme}`);
          await page.locator('.ag-claude-row[data-role=sonnet] .agent-model-trigger small').waitFor();
          await page.evaluate(() => document.fonts.ready);
          const issues = await page.locator('.ag-claude-table').evaluate(table => {
            const issues = [];
            const overlaps = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
            const rows = [...table.querySelectorAll('.ag-claude-row[data-role]')];
            for (const row of rows) {
              const trigger = row.querySelector('.agent-model-trigger');
              const bounds = trigger.getBoundingClientRect();
              for (const text of trigger.querySelectorAll('strong, small')) {
                const rect = text.getBoundingClientRect();
                if (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1
                  || rect.left < bounds.left - 1 || rect.right > bounds.right + 1) {
                  issues.push(`${row.dataset.role}: model text exceeds the selector`);
                }
              }
              const next = row.nextElementSibling?.getBoundingClientRect();
              if (next && bounds.bottom > next.top + 1) issues.push(`${row.dataset.role}: selector overlaps the next row`);
              if (row.scrollWidth > row.clientWidth + 1) issues.push(`${row.dataset.role}: horizontal overflow`);
              const toggle = row.querySelector('.ag-claude-ctx').getBoundingClientRect();
              if (overlaps(bounds, toggle)) issues.push(`${row.dataset.role}: selector overlaps the context switch`);
            }
            if (rows.length !== 4) issues.push(`expected 4 role rows, got ${rows.length}`);
            return issues;
          });
          assert.deepEqual(issues, [], `${locale}/${theme}/${width}`);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${locale}/${theme}/${width}: horizontal page overflow`);
          if (locale === 'zh-CN' && theme === 'light' && [1392, 480].includes(width)) {
            await page.screenshot({ path: path.join(os.tmpdir(), `claude-code-model-layout-${width}.png`), fullPage: true });
          }
        }
      }
    }
    await page.setViewportSize({ width: 1392, height: 962 });
    await page.goto(`${base}/tests/fixtures/agent-backups.html?client=claude-code&tab=setup&reset-selections&claude-alias-layout`);
    const sonnet = page.locator('.ag-claude-row[data-role=sonnet]');
    await sonnet.locator('.agent-model-trigger small').waitFor();
    await page.getByRole('switch', { name: '使用模型别名', exact: true }).check();
    const trigger = sonnet.locator('.agent-model-trigger');
    await trigger.click();
    await page.getByRole('option', { name: /^gpt-6\.1-sol / }).click();
    assert.equal(await trigger.locator('small').count(), 0);
    await trigger.focus();
    await trigger.press('Enter');
    await sonnet.locator('.agent-model-search input').fill('high-fast');
    await page.getByRole('option', { name: /^gpt-6.1-sol-high-fast / }).click();
    assert.equal(await trigger.locator('small').innerText(), 'gpt-6.1-sol');
    await page.getByRole('switch', { name: 'Sonnet 1M', exact: true }).check();
    await page.getByRole('button', { name: '更新配置', exact: true }).click();
    await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'update_agent_config'
      && call.args.claudeCodeModelMappings.sonnet === 'gpt-6.1-sol-high-fast'
      && call.args.claudeCodeModelMappings.sonnet1m === true));
    assert.deepEqual(errors, []);
    console.log('PASS: 24 viewport/language/theme layouts, alias selection, keyboard search, context toggle and configuration update');
  } finally { await browser.close(); }
}, { url: process.env.AGENT_TEST_URL });
