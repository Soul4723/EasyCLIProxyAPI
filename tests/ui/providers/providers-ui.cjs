// Providers page contract: provider cards, provider detail, Add menu, sign-in dialog, deep link, All credentials, exclusions, narrow width.
const assert = require('node:assert/strict');
const h = require('../../helpers/shell.cjs');

h.runUiTest('providers', async ({ base, newPage }) => {
  const open = async (path, pageOptions = {}) => {
    const page = await newPage(pageOptions);
    await h.openApp(page, base, { path });
    await h.waitForCoreStatus(page);
    return page;
  };
  const noErrors = (page, label) => assert.deepEqual(page.errors, [], `${label}: console/page errors`);

  // ---------------------------------------------------------------- overview: provider cards
  console.log('overview');
  let page = await open('/providers');
  await page.locator('.pv-card').first().waitFor();
  assert.equal(await h.pageTitle(page), 'Providers');
  assert.deepEqual(await page.locator('.ec-page-header').getByRole('tab').allTextContents().then((t) => t.map((s) => s.replace(/\d+$/, '').trim())), ['Providers', 'All credentials', 'Model exclusions']);
  assert.ok(await page.locator('.pv-card').count() >= 11, 'one card per provider brand');
  for (const brand of ['codex', 'claude', 'gemini', 'deepseek']) assert.equal(await page.locator(`.pv-card[data-brand=${brand}]`).count(), 1, `${brand} card`);
  const codexText = await page.locator('.pv-card[data-brand=codex]').innerText();
  assert.ok(Number(codexText.match(/(\d+)\s+accounts/)?.[1]) >= 5, `codex card shows its accounts: ${codexText}`);
  assert.match(codexText, /1\s+key\b/);
  noErrors(page, 'overview');

  // ---------------------------------------------------------------- detail
  console.log('detail');
  await page.locator('.pv-card[data-brand=codex] a.pv-card__link').click();
  await page.waitForFunction(() => window.location.hash.startsWith('#/providers?p=codex'));
  await page.getByRole('link', { name: 'All providers' }).waitFor();
  await page.getByText('exhausted@example.test').first().waitFor();
  await page.getByText('Codex Direct').first().waitFor();

  // privacy masks identities, provider names stay
  await h.setPrivacy(page, true);
  assert.equal(await page.getByText('exhausted@example.test').count(), 0, 'identity masked');
  assert.ok(await page.getByRole('heading', { name: 'Codex' }).count() > 0, 'provider name stays visible');
  await h.setPrivacy(page, false);
  await page.getByText('exhausted@example.test').first().waitFor();
  noErrors(page, 'detail');

  // ---------------------------------------------------------------- add menu + sign-in dialog
  console.log('add menu');
  await h.gotoPage(page, '/providers');
  await page.locator('.pv-card').first().waitFor();
  await page.getByTestId('providers-add').click();
  const menu = page.getByRole('dialog', { name: 'Add' });
  await menu.getByRole('button', { name: 'Codex', exact: true }).first().waitFor();
  await menu.getByRole('button', { name: 'Import credential files' }).waitFor();
  await menu.getByRole('button', { name: 'Codex', exact: true }).first().click();
  const signIn = page.getByRole('dialog', { name: 'Sign in to Codex' });
  await signIn.getByRole('button', { name: 'Open in browser' }).waitFor();
  await page.keyboard.press('Escape');
  await signIn.waitFor({ state: 'detached' });
  noErrors(page, 'add menu');
  await page.context().close();

  // ---------------------------------------------------------------- deep link from Overview / Quota
  console.log('deep link');
  page = await open('/providers?cred=claude-expired.json');
  const panel = page.getByRole('dialog').filter({ hasText: 'expired@example.test' });
  await panel.waitFor();
  await panel.getByRole('button', { name: 'Sign in again' }).waitFor();
  noErrors(page, 'deep link');
  await page.context().close();

  // ---------------------------------------------------------------- all credentials
  console.log('all credentials');
  page = await open('/providers/all');
  await page.locator('table tbody tr').first().waitFor();
  await page.getByRole('button', { name: /^Problems/ }).click();
  assert.equal(await page.locator('table tbody tr').count(), 2, 'problems bucket');
  await page.getByRole('button', { name: /^All \d+$/ }).last().click();
  await page.getByRole('searchbox').first().fill('codex');
  await page.waitForTimeout(300);
  const names = await page.locator('table tbody tr').allInnerTexts();
  assert.ok(names.length > 0 && names.every((text) => /codex/i.test(text)), 'search narrows to codex rows');
  await page.getByRole('button', { name: 'Batch management' }).click();
  const batch = page.getByRole('dialog', { name: 'Batch management' });
  await batch.waitFor();
  const batchChecks = batch.locator('input[type=checkbox]');
  assert.ok(await batchChecks.count() > 0, 'batch management shows the currently filtered credentials');
  await batch.locator('label.ec-checkbox').first().click();
  assert.equal(await batchChecks.first().isChecked(), true);
  assert.equal(await batch.getByRole('button', { name: 'Refresh credentials', exact: true }).isEnabled(), true);
  assert.equal(await batch.getByRole('button', { name: 'Enable', exact: true }).isEnabled(), true);
  assert.equal(await batch.getByRole('button', { name: 'Disable', exact: true }).isEnabled(), true);
  assert.equal(await batch.getByRole('button', { name: 'Delete', exact: true }).isEnabled(), true);
  await batch.getByRole('button', { name: 'Refresh credentials', exact: true }).click();
  await batch.getByRole('status').waitFor();
  assert.match(await batch.getByRole('status').innerText(), /0 failed/);
  await batch.getByRole('button', { name: 'Close', exact: true }).click();
  noErrors(page, 'all credentials');
  await page.context().close();

  // ---------------------------------------------------------------- exclusions
  console.log('exclusions');
  page = await open('/providers/exclusions');
  await page.getByText('claude-legacy-*').first().waitFor();
  noErrors(page, 'exclusions');
  await page.context().close();

  // ---------------------------------------------------------------- narrow width
  console.log('narrow');
  for (const path of ['/providers', '/providers/all', '/providers?p=codex', '/providers/exclusions']) {
    page = await open(path, { viewport: { width: 680, height: 900 } });
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${path}: horizontal overflow ${overflow}px at 680`);
    noErrors(page, path);
    await page.context().close();
  }
  console.log('providers-ui: ok');
});
