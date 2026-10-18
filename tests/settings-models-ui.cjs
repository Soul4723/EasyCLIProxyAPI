// Settings → Models UI test (browser mock): aliases (instant), sensitive words (draft + save bar), template groups
// (lazy, own save), dirty reporting. Run: PLAYWRIGHT_MODULE=<path> node tests/settings-models-ui.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openApp } = require('./helpers/shell.cjs');

(async () => {
  let server;
  let browser;
  const runtimeErrors = [];
  try {
    const { createServer } = await import('vite');
    const react = (await import('@vitejs/plugin-react')).default;
    server = await createServer({
      configFile: false,
      root: path.resolve(__dirname, '..'),
      plugins: [react()],
      optimizeDeps: { entries: ['index.html'] },
      logLevel: 'error',
      server: { host: '127.0.0.1', port: Number(process.env.MODELS_TEST_PORT || 5391), strictPort: false },
    });
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true, args: ['--no-proxy-server'] });

    for (const viewport of [{ width: 1280, height: 860 }, { width: 680, height: 860 }]) {
      const label = `${viewport.width}px`;
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(10000);
      page.on('pageerror', (error) => runtimeErrors.push(`${label}: ${error}`));
      await page.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
      await openApp(page, base, { path: '/settings/models' });
      await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
      await page.locator('.ec-models-tab').waitFor();
      const expectDot = async (count, message) => {
        try {
          await page.waitForFunction((n) => document.querySelectorAll('[data-settings-tab="models"] .ec-set-nav-dot').length === n, count, { timeout: 3000 });
        } catch {
          assert.fail(`${label}: ${message ?? 'dirty dot'} (expected ${count})`);
        }
      };
      const noOverflow = async (name) => {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `${label}: ${name} overflows horizontally by ${overflow}px`);
      };

      // ── Aliases (instant) ─────────────────────────────────────────────
      const table = page.locator('.ec-models-table table');
      await table.waitFor();
      assert.equal(await table.locator('tbody tr').count(), 1);
      assert.match(await table.innerText(), /codex-high/);
      assert.equal(await page.locator('.ec-models-panel .ec-chip', { hasText: 'No restart' }).count(), 1, 'aliases show the instant effect chip');
      await noOverflow('aliases');

      await page.getByRole('button', { name: 'Create Alias' }).first().click();
      const dialog = page.locator('[role=dialog], [role=alertdialog]');
      await dialog.waitFor();
      await expectDot(0, 'an untouched editor is not dirty');
      await dialog.getByRole('button', { name: 'Create Alias' }).click(); // nothing selected
      assert.match(await dialog.getByRole('alert').innerText(), /Select an original model/);
      await dialog.getByRole('combobox').click();
      await page.getByRole('option', { name: /claude-sonnet-4-6/ }).click();
      await dialog.getByRole('radio', { name: 'Low' }).click();
      await page.waitForFunction(() => document.querySelector('.ec-models-editor input[id$="-alias"]')?.value === 'claude-sonnet-4-6-low');
      await dialog.getByRole('switch').click();
      await page.waitForFunction(() => document.querySelector('.ec-models-editor input[id$="-alias"]')?.value === 'claude-sonnet-4-6-low-fast');
      await dialog.getByRole('switch').click();
      await page.waitForFunction(() => document.querySelector('.ec-models-editor input[id$="-alias"]')?.value === 'claude-sonnet-4-6-low');
      await expectDot(1, 'an editor with choices reports the Models tab dirty');
      await dialog.locator('input[id$="-alias"]').fill('bad alias');
      await dialog.getByRole('button', { name: 'Create Alias' }).click();
      assert.match(await dialog.getByRole('alert').innerText(), /invalid/i);
      await dialog.locator('input[id$="-alias"]').fill('sonnet-low');
      await dialog.getByRole('button', { name: 'Create Alias' }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await table.locator('tbody tr').count(), 2);
      assert.match(await page.locator('.ec-models-banner.is-ok').innerText(), /sonnet-low/);
      await expectDot(0, 'saved alias leaves nothing dirty');

      // Escape closes the editor; the picker closes first.
      await page.getByRole('button', { name: 'Create Alias' }).first().click();
      await dialog.waitFor();
      await dialog.getByRole('combobox').click();
      await page.getByRole('listbox').waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('listbox').count(), 0);
      assert.equal(await dialog.count(), 1, 'first Escape only closes the picker');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });

      // Edit (codex-high has effort + a Fast twin in the mock)
      await table.locator('tbody tr', { hasText: 'codex-high' }).getByRole('button', { name: 'Edit' }).click();
      await dialog.waitFor();
      assert.equal(await dialog.locator('input[id$="-alias"]').inputValue(), 'codex-high');
      assert.equal(await dialog.locator('input[role="combobox"]').inputValue(), 'gpt-5.2-codex');
      await dialog.locator('input[id$="-alias"]').fill('codex-renamed');
      await expectDot(1);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.match(await table.innerText(), /codex-renamed/);

      // Delete (confirm first)
      await table.locator('tbody tr', { hasText: 'sonnet-low' }).getByRole('button', { name: /Delete/ }).click();
      const confirm = page.locator('[role=dialog], [role=alertdialog]');
      await confirm.waitFor();
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      const rowsBefore = await table.locator('tbody tr').count();
      await table.locator('tbody tr', { hasText: 'sonnet-low' }).getByRole('button', { name: /Delete/ }).click();
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
      await confirm.waitFor({ state: 'detached' });
      assert.equal(await table.locator('tbody tr').count(), rowsBefore - 1);
      assert.equal(await table.locator('tbody tr', { hasText: 'sonnet-low' }).count(), 0);

      // ── Sensitive words (draft + save bar) ────────────────────────────
      await page.getByRole('radio', { name: /Sensitive words/ }).click();
      const antigravity = page.getByRole('textbox', { name: 'Antigravity Add' });
      await antigravity.waitFor();
      assert.equal(await page.locator('.ec-models-word input').count(), 3);
      await antigravity.fill('ui-test-word');
      await expectDot(1, 'a pending composer word is an unsaved change');
      await page.getByRole('button', { name: 'Add Antigravity' }).click();
      assert.match(await page.locator('.ec-set-savebar').innerText(), /1 unsaved/);
      assert.equal(await page.locator('.ec-models-word input').count(), 4);
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      assert.equal(await page.locator('.ec-models-word input').count(), 3);
      assert.equal(await page.locator('.ec-set-savebar').count(), 0);
      await expectDot(0);
      await antigravity.fill('persisted-word');
      await antigravity.press('Enter');
      await page.getByRole('textbox', { name: 'Devin 1' }).fill('private-repository-2');
      assert.match(await page.locator('.ec-set-savebar').innerText(), /2 unsaved/);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.locator('.ec-set-savebar', { hasText: 'Saved' }).waitFor();
      await expectDot(0);
      await page.getByRole('button', { name: 'Delete Antigravity 3' }).click();
      await expectDot(1);
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      assert.equal(await page.locator('.ec-models-word input').count(), 4);
      await noOverflow('sensitive words');

      // Drafts survive switching the in-tab view
      await page.getByRole('textbox', { name: 'Devin Add' }).fill('kept-draft');
      await page.getByRole('radio', { name: 'Aliases' }).click();
      await page.getByRole('radio', { name: /Sensitive words/ }).click();
      assert.equal(await page.getByRole('textbox', { name: 'Devin Add' }).inputValue(), 'kept-draft');
      await page.getByRole('button', { name: 'Discard', exact: true }).click();

      // ── Template groups (lazy, collapsible, own save) ─────────────────
      await page.getByRole('radio', { name: /Request/ }).click();
      const heads = page.locator('.ec-models-collapsible-head');
      assert.equal(await heads.count(), 2);
      assert.equal(await page.locator('.template-config-section').count(), 0, 'template groups are not mounted until expanded');
      await heads.nth(0).click();
      await page.locator('.template-config-card').first().waitFor();
      assert.equal(await heads.nth(0).getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('.template-config-section').count(), 1, 'only the expanded block mounts');
      await page.locator('.template-config-card input[type="checkbox"]').first().evaluate((input) => input.click());
      await page.locator('.ec-models-collapsible-head .ec-chip', { hasText: 'Unsaved' }).waitFor();
      await expectDot(1, 'template drafts report the Models tab dirty');
      await page.locator('.template-config-card', { has: page.locator('.template-config-field-dirty') }).getByRole('button', { name: /Save settings/ }).click();
      await page.locator('.template-config-action-status-saved').first().waitFor();
      await page.locator('.ec-models-collapsible-head .ec-chip', { hasText: 'Unsaved' }).waitFor({ state: 'detached' });
      await expectDot(0);
      await heads.nth(1).click();
      await page.locator('.ec-models-collapsible').nth(1).locator('.template-config-card').first().waitFor();
      assert.equal(await page.locator('.template-config-section').count(), 2);
      await noOverflow('request defaults');

      // Upstream moved the plugin settings template to the Plugins page: no Extensions view here.
      assert.equal(await page.getByRole('radio', { name: 'Extensions' }).count(), 0);
      await page.close();
    }

    // Other languages render the tab.
    for (const [locale, text] of [['zh-CN', '模型别名'], ['ja', 'エイリアス']]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      page.on('pageerror', (error) => runtimeErrors.push(`${locale}: ${error}`));
      await page.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
      await page.addInitScript((value) => localStorage.setItem('easy-cli-proxy-api.locale', value), locale);
      await openApp(page, base, { path: '/settings/models' });
      await page.locator('.ec-models-views').getByText(text).first().waitFor();
      await page.close();
    }

    assert.deepEqual(runtimeErrors, []);
    console.log('PASS: settings models tab — instant aliases (create/edit/delete/validation/escape), sensitive-word draft + save bar, lazy template groups, dirty reporting, 1280/680 px, zh-CN/ja.');
  } finally {
    await browser?.close();
    await server?.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
