// Providers → credentials: list, filters, sorting, pagination, side panel fields/save, toggle, delete, remote mode,
// privacy and the model-exclusions overview. Rewritten for the section UI (src/sections/providers/creds).
// Run: PLAYWRIGHT_MODULE=… node tests/ui/providers/auth-file-list-ui.cjs   (UI_BASE=http://127.0.0.1:PORT/ reuses a running dev server)
const assert = require('node:assert/strict');
const { startApp, launch, openCreds, openExclusions, requestsOf, rowOf } = require('../../helpers/creds.cjs');

const statusOf = async (page, text) => (await rowOf(page, text).locator('.ec-pill__text').first().innerText()).trim();
const rowCount = (page) => page.locator('tr.ec-table__row').count();
const names = (page) => page.locator('tr.ec-table__row .ec-cred-identity__secondary').allInnerTexts();
const panel = (page) => page.locator('.ec-side-panel');
const chip = (page, group, label) => page.getByRole('group', { name: group }).getByRole('button', { name: new RegExp(`^${label}\\b`) });

(async () => {
  const app = await startApp();
  const browser = await launch();
  try {
    // ---- the mixed fixture: every status the list can show ------------------------------------------------------------------
    let { page, errors } = await openCreds(browser, app.base, { creds: 'states' });
    assert.equal(await rowCount(page), 10);
    assert.equal(await statusOf(page, 'expired-token@'), 'Expired');
    assert.equal(await statusOf(page, 'cooling@'), 'Cooldown');
    assert.equal(await statusOf(page, 'wide-cooldown@'), 'Cooldown');
    assert.equal(await statusOf(page, 'disabled@'), 'Disabled');
    assert.equal(await statusOf(page, 'rejected@'), 'Error');
    assert.equal(await statusOf(page, 'primary-account'), 'Available');
    assert.match(await rowOf(page, 'cooling@').locator('.ec-cred-status__time').innerText(), /^\d+m( \d+s)?$/, 'cooldown shows a live countdown');
    assert.equal(await rowOf(page, 'gemini-runtime').getByText('Runtime', { exact: true }).count(), 1);
    assert.equal(await rowOf(page, 'gemini-runtime').getByRole('switch').count(), 0, 'no account switch in the list; Quota owns enable/disable');
    await rowOf(page, 'gemini-runtime').getByRole('button', { name: /^Actions:/ }).click();
    assert.equal(await page.getByRole('button', { name: 'Disable', exact: true }).isDisabled(), true, 'runtime credentials cannot be toggled');
    await page.keyboard.press('Escape');
    assert.equal(await rowOf(page, 'gemini-runtime').locator('.ec-cred-link').count(), 0, 'no Quota link where quota is unsupported');
    assert.equal(await rowOf(page, 'cooling@').locator('.ec-cred-link').getAttribute('href'), '#/quota?cred=codex-cooling_example_test.json');
    assert.equal(await rowOf(page, 'primary-account').locator('.ec-cred-req__fail').innerText(), '12');

    // Default order is the routing order: priority first, then file name.
    const order = await names(page);
    assert.ok(order.slice(0, 3).every((name) => /primary|expired|team/.test(name)), `priority-5 credentials first: ${order}`);

    // ---- filters ---------------------------------------------------------------------------------------------------------
    assert.equal(await chip(page, 'All Providers', 'Codex').innerText().then((text) => text.replace(/\s+/g, ' ')), 'Codex 3');
    await chip(page, 'All Providers', 'Codex').click();
    assert.equal(await rowCount(page), 3);
    assert.equal(await chip(page, 'All Statuses', 'Problems').innerText().then((text) => /1\s*$/.test(text)), false, 'problem count follows the provider filter (2 codex cooldowns)');
    await chip(page, 'All Statuses', 'Problems').click();
    assert.equal(await rowCount(page), 2, 'codex problems = two cooldowns');
    await chip(page, 'All Providers', 'All').click();
    assert.equal(await rowCount(page), 4, 'problems across providers: 2 cooldown + expired + error');
    await chip(page, 'All Statuses', 'Disabled').click();
    assert.equal(await rowCount(page), 1);
    await chip(page, 'All Statuses', 'All').click();
    await page.getByPlaceholder('Search by file name, account, or provider').fill('KIMI');
    assert.equal(await rowCount(page), 1);
    await page.getByPlaceholder('Search by file name, account, or provider').fill('no-such-credential');
    assert.equal(await page.getByText('No matching authentication files').count(), 1, 'filtered-empty state');
    await page.getByPlaceholder('Search by file name, account, or provider').fill('');
    assert.equal(await rowCount(page), 10);

    // ---- sorting ---------------------------------------------------------------------------------------------------------
    await page.getByRole('button', { name: /Sort by Priority/i }).click();
    const ascending = await rowOf(page, '').locator('.ec-chip').filter({ hasText: /^P\d+$/ }).allInnerTexts();
    assert.equal(ascending[0], 'P0');
    await page.getByRole('button', { name: /Sort by Priority/i }).click();
    assert.equal((await rowOf(page, '').locator('.ec-chip').filter({ hasText: /^P\d+$/ }).allInnerTexts())[0], 'P5');

    // ---- side panel: every field of the former settings/models dialogs is reachable ---------------------------------------------
    await rowOf(page, 'primary-account').click();
    await panel(page).waitFor();
    for (const label of ['Priority', 'Scheduling weight', 'Prefix', 'Proxy URL', 'Disable exponential cooling', 'WebSockets', 'Note']) {
      assert.equal(await panel(page).getByText(label, { exact: true }).first().isVisible(), true, `codex panel has ${label}`);
    }
    assert.equal(await panel(page).getByPlaceholder('Search model names').isVisible(), true, 'models checklist with search');
    assert.equal(await panel(page).getByRole('button', { name: 'Exclude All' }).isVisible(), true);
    assert.equal(await panel(page).getByLabel('Exclusion rules (one per line)').isVisible(), true, 'excluded-model rules textarea');
    assert.equal(await panel(page).locator('[data-section=cooldown]').isVisible(), true);
    await panel(page).locator('[data-section=advanced] > summary').click();
    assert.equal(await panel(page).getByRole('button', { name: 'Add model' }).isVisible(), true, 'aliases');
    assert.equal(await panel(page).getByRole('button', { name: 'Add header' }).isVisible(), true, 'custom headers');
    assert.equal(await panel(page).getByText('Credential timezone').isVisible(), true);
    assert.equal(await panel(page).getByText('Claude compatibility').count(), 0, 'Claude block only for Claude credentials');
    // Save stays disabled until something changes; editing priority patches only that field.
    const save = panel(page).getByRole('button', { name: 'Save', exact: true });
    assert.equal(await save.isDisabled(), true);
    await panel(page).locator('[data-section=routing] input').first().fill('9');
    assert.equal(await save.isEnabled(), true);
    await panel(page).getByRole('button', { name: 'Discard changes' }).click();
    assert.equal(await panel(page).locator('[data-section=routing] input').first().inputValue(), '5', 'discard restores the stored value');
    await panel(page).locator('[data-section=routing] input').first().fill('9');
    await panel(page).getByLabel('Exclusion rules (one per line)').fill('gpt-image-*');
    await save.click();
    await page.locator('.ec-cred-toast--success').waitFor();
    const patches = await requestsOf(page, 'PATCH', '/credentials/fields');
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].body, { name: 'codex-primary-account-with-a-very-long-name-for-layout_example_test.json', priority: 9, excluded_models: ['gpt-image-*'] }, 'only changed fields are sent');
    assert.equal(await save.isDisabled(), true, 'saved state is clean again');
    // Closing with unsaved edits asks first.
    await panel(page).locator('[data-section=routing] input').first().fill('1');
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog', { name: 'Discard unsaved changes?' }).waitFor();
    await page.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await panel(page).isVisible(), true);
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog', { name: 'Discard unsaved changes?' }).getByRole('button', { name: 'Discard changes' }).click();
    await panel(page).waitFor({ state: 'detached' });

    // Claude credential: Claude block + aliases, and the panel reached from the row menu jumps to the models section.
    await page.locator('button[aria-label*="claude-disabled"]').click();
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    await panel(page).waitFor();
    assert.equal(await panel(page).getByText('Excluded models').first().isVisible(), true);
    await panel(page).locator('[data-section=advanced] > summary').click();
    assert.equal(await panel(page).getByText('Claude compatibility').isVisible(), true);
    assert.equal(await panel(page).getByText('Request cloaking').isVisible(), true);
    await page.keyboard.press('Escape');
    await panel(page).waitFor({ state: 'detached' });

    // Runtime credential: read-only models, no settings form, no footer.
    await rowOf(page, 'gemini-runtime').click();
    await panel(page).waitFor();
    assert.equal(await panel(page).getByText('Runtime credentials cannot persist settings.').isVisible(), true);
    assert.equal(await panel(page).locator('[data-section=routing]').count(), 0);
    assert.equal(await panel(page).getByRole('button', { name: 'Save', exact: true }).count(), 0);
    assert.equal(await panel(page).getByRole('checkbox').count(), 0, 'supported models are listed but not editable');
    await page.keyboard.press('Escape');

    // ---- enable/disable lives in Quota: the list and panel only link there ---------------------------------------------------
    await page.locator('.ec-cred-toast').getByRole('button', { name: 'Close' }).click();
    assert.equal(await page.getByRole('switch').count(), 0, 'no account switches in the credential list');
    await rowOf(page, 'personal@').getByRole('button', { name: /^Actions:/ }).click();
    assert.equal(await page.getByRole('button', { name: 'Disable', exact: true }).count(), 0, 'quota-managed rows have no enable action');
    await page.keyboard.press('Escape');
    await rowOf(page, 'personal@').click();
    const manage = panel(page).locator('.ec-cred-manage');
    assert.match(await manage.innerText(), /^Enabled\s*·\s*Manage in Quota/);
    assert.equal(await manage.locator('a').getAttribute('href'), '#/quota?cred=kimi-personal_example_test.json');
    assert.equal(await panel(page).getByRole('switch').count(), 0, 'no enable switch in the panel');
    await page.keyboard.press('Escape');
    assert.equal((await requestsOf(page, 'PATCH', '/credentials/status')).length, 0);

    // ---- delete: confirmation, request, runtime guard ---------------------------------------------------------------------
    await page.locator('button[aria-label*="xai-api-paid"]').click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete' });
    assert.ok((await confirm.innerText()).includes('xai-api-paid_example_test.json'));
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    assert.equal((await requestsOf(page, 'DELETE', '/credentials')).length, 0, 'cancel leaves the backend untouched');
    await page.locator('button[aria-label*="xai-api-paid"]').click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Delete' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForFunction(() => !document.body.textContent.includes('api-paid@example.test'));
    assert.deepEqual((await requestsOf(page, 'DELETE', '/credentials')).map((item) => item.query), [{ name: 'xai-api-paid_example_test.json' }]);
    assert.equal(await rowCount(page), 9);
    await page.locator('button[aria-haspopup=menu][aria-label*="gemini-runtime"]').click();
    assert.equal(await page.getByRole('button', { name: 'Runtime credentials cannot be deleted' }).isDisabled(), true, 'runtime delete is disabled with its reason');
    await page.keyboard.press('Escape');
    // ---- import: several JSON files at once, partial failure reported in one toast ---------------------------------------------------
    await page.locator('.ec-cred-toast').getByRole('button', { name: 'Close' }).click().catch(() => {});
    await page.getByTestId('creds-import-input').setInputFiles([
      { name: 'kimi-new_example_test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ provider: 'kimi', email: 'new@example.test' })) },
      { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('not json') },
    ]);
    const toast = page.locator('.ec-cred-toast--error');
    await toast.waitFor();
    const toastText = await toast.innerText();
    assert.ok(toastText.includes('Uploaded 1') && toastText.includes('1 files failed to upload') && toastText.includes('broken.json'), toastText);
    assert.equal(await rowOf(page, 'kimi-new_example_test.json').count(), 1, 'the valid file shows up in the list');
    assert.deepEqual(errors, []);
    await page.close();

    // ---- 40 credentials: pagination and page size ------------------------------------------------------------------------
    ({ page, errors } = await openCreds(browser, app.base, { creds: 'forty' }));
    assert.equal(await rowCount(page), 10);
    assert.match(await page.locator('.ec-pager__range').innerText(), /1.10.*40/);
    await page.getByRole('button', { name: 'Next page' }).click();
    assert.match(await page.locator('.ec-pager__range').innerText(), /11.20.*40/);
    await page.locator('.ec-pager__select').selectOption('50');
    assert.equal(await rowCount(page), 40, 'page size 50 shows every credential');
    await page.locator('.ec-pager__select').selectOption('10');
    await page.getByPlaceholder('Search by file name, account, or provider').fill('account-0');
    assert.match(await page.locator('.ec-pager__range').innerText(), /1.9.*9/, 'search resets to the first page');
    assert.deepEqual(errors, []);
    await page.close();

    // ---- deep link: file name or auth index selects the credential, brings its page into view, highlights the row ------------------------
    ({ page, errors } = await openCreds(browser, app.base, { creds: 'forty' }));
    await page.evaluate(() => { window.location.hash = '/providers?preview=creds&cred=mock-xai-account-37'; });
    await panel(page).waitFor();
    assert.ok((await panel(page).innerText()).includes('xai-account-37_example_test.json'), 'auth index resolved to the file');
    assert.equal(await page.locator('tr.ec-table__row--selected').count(), 1, 'the selected row is on the visible page and highlighted');
    assert.equal(await page.locator('tr.ec-table__row--selected').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.location.hash = '/providers?preview=creds&cred=codex-account-09_example_test.json'; });
    await page.waitForFunction(() => document.querySelector('.ec-side-panel')?.textContent.includes('codex-account-09_example_test.json'));
    assert.equal(await page.locator('tr.ec-table__row--selected').count(), 1, 'file name resolved too');
    // Expired and failing credentials get a prominent "Sign in again" action for their provider; healthy ones do not.
    await page.keyboard.press('Escape');
    await page.getByPlaceholder('Search by file name, account, or provider').fill('account-19');
    await rowOf(page, 'account-19@').click();
    await panel(page).getByRole('button', { name: 'Sign in again' }).click();
    assert.equal(await page.getByTestId('resignin').textContent(), 'antigravity');
    await page.keyboard.press('Escape');
    await rowOf(page, 'account-19@').waitFor();
    await page.getByPlaceholder('Search by file name, account, or provider').fill('account-01@');
    await rowOf(page, 'account-01@').click();
    assert.equal(await panel(page).getByRole('button', { name: 'Sign in again' }).count(), 0, 'no re-sign-in for a healthy credential');
    assert.deepEqual(errors, []);
    await page.close();

    // ---- 1 credential and the empty / failing states -----------------------------------------------------------------------
    ({ page, errors } = await openCreds(browser, app.base, { creds: 'one' }));
    assert.equal(await rowCount(page), 1);
    await page.close();
    ({ page } = await openCreds(browser, app.base, { creds: 'none' }));
    assert.equal(await page.getByText('No authentication files').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Import' }).count() >= 2, true, 'empty state offers an import action');
    await page.close();
    ({ page } = await openCreds(browser, app.base, { creds: 'fail' }));
    assert.equal(await page.getByRole('alert').getByText('Browser Mock credentials unavailable').count(), 1);
    await page.getByRole('button', { name: 'Retry' }).click();
    await page.close();

    // ---- remote core: opening the folder is disabled with its reason ------------------------------------------------------------
    ({ page } = await openCreds(browser, app.base, { creds: 'states', remote: true }));
    const folder = page.getByRole('button', { name: 'Open Folder' });
    assert.equal(await folder.isDisabled(), true);
    assert.match(await folder.locator('xpath=..').getAttribute('title'), /remote host/);
    assert.equal(await page.getByRole('button', { name: 'Import' }).first().isEnabled(), true, 'import still works against a remote core');
    await page.close();

    // ---- privacy: identities and file names that embed them are masked, requests keep the raw name ------------------------------
    ({ page } = await openCreds(browser, app.base, { creds: 'states', privacy: true }));
    const text = await page.locator('table').innerText();
    assert.ok(!text.includes('cooling@example.test') && !text.includes('codex-cooling_example_test'), 'identity and file name masked');
    assert.ok(text.includes('***@'), 'masked identity shape');
    await page.locator('tr.ec-table__row').nth(5).click();
    await panel(page).waitFor();
    assert.ok(!(await panel(page).innerText()).includes('example.test'), 'panel masks identity and name');
    await page.close();

    // ---- model exclusions overview -----------------------------------------------------------------------------------------------
    ({ page, errors } = await openCreds(browser, app.base, { creds: 'states' }));
    await openExclusions(page);
    const card = (provider) => page.locator('article', { hasText: provider }).first();
    await card('Claude').waitFor();
    assert.ok((await card('Claude').innerText()).includes('claude-legacy-*'), 'existing provider rule shown as a chip');
    assert.ok((await card('Codex').innerText()).includes('No models excluded'));
    assert.ok((await card('Codex').innerText()).includes('Accounts: 3'));
    await card('Codex').getByRole('button', { name: 'Edit' }).click();
    const editor = page.getByRole('dialog', { name: 'OAuth Credential Model Exclusions' });
    await editor.waitFor();
    await editor.getByRole('checkbox').first().check();
    const rules = await editor.getByLabel('Exclusion rules (one per line)').inputValue();
    assert.equal(rules, 'claude-sonnet-4-6');
    await editor.getByRole('button', { name: /Save \(1 rules\)/ }).click();
    await editor.waitFor({ state: 'detached' });
    assert.deepEqual((await requestsOf(page, 'PUT', '/config/oauth/excluded-models')).map((item) => item.body), [{ claude: ['claude-legacy-*'], codex: ['claude-sonnet-4-6'], gemini: [] }]);
    assert.ok((await card('Codex').innerText()).includes('claude-sonnet-4-6'), 'chip appears after saving');
    assert.deepEqual(errors, []);
    await page.close();

    // ---- layout: no horizontal overflow in either theme and at the three widths --------------------------------------------------
    for (const theme of ['dark', 'light']) {
      for (const width of [1440, 1024, 680]) {
        ({ page } = await openCreds(browser, app.base, { creds: 'states', width, theme }));
        const overflow = await page.evaluate(() => {
          const wrap = document.querySelector('.ec-table-wrap');
          return { wrap: wrap.scrollWidth - wrap.clientWidth, page: document.documentElement.scrollWidth - innerWidth };
        });
        assert.ok(overflow.wrap <= 1 && overflow.page <= 1, `${theme} ${width}: ${JSON.stringify(overflow)}`);
        await page.close();
      }
    }
    console.log('PASS: status mapping, filters + problems bucket, sorting, pagination, side-panel fields/save/discard, toggle, delete, empty/error states, remote mode, privacy, model exclusions, layout.');
  } finally {
    await browser.close();
    await app.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
