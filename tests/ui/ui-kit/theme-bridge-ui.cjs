// Theme bridge + kit alignment UI test: node tests/ui/ui-kit/theme-bridge-ui.cjs (needs PLAYWRIGHT_MODULE; starts its own vite).
// Set SHOTS_DIR to also save screenshots.
const assert = require('node:assert/strict');
const path = require('node:path');
const { runUiTest, openApp, openAppMenu, closeAppMenu, setTheme, themeState } = require('../../helpers/shell.cjs');

const shotsDir = process.env.SHOTS_DIR;
const shot = (page, name) => (shotsDir ? page.screenshot({ path: path.join(shotsDir, `${name}.png`) }) : undefined);
const cssVar = (page, name) => page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name);
const pickCard = async (page, id) => {
  const popover = await openAppMenu(page);
  await popover.locator(`.ec-theme-card[data-theme-id="${id}"]`).click();
  await closeAppMenu(page);
};

runUiTest('theme-bridge', async ({ base, newPage }) => {
  const page = await newPage();

  // Kit: Dialog, ConfirmDialog, Checkbox in Ember dark and light.
  await openApp(page, base, { path: '/kit' });
  for (const which of ['dark', 'light']) {
    await setTheme(page, which);
    assert.equal((await themeState(page)).theme, which);
    const boxes = page.getByTestId('kit-checkboxes');
    await boxes.waitFor();
    assert.equal(await boxes.getByLabel('Indeterminate').evaluate((el) => el.indeterminate), true, 'indeterminate is set on the node');
    assert.equal(await boxes.getByLabel('Invalid').getAttribute('aria-invalid'), 'true');
    const checked = boxes.getByLabel('Checked', { exact: true });
    const before = await checked.isChecked();
    await boxes.getByText('Checked', { exact: true }).click();
    assert.equal(await checked.isChecked(), !before, 'checkbox toggles through its label');
    await boxes.getByText('Checked', { exact: true }).click();
    await boxes.scrollIntoViewIfNeeded();
    await shot(page, `kit-checkbox-${which}`);

    await page.getByRole('button', { name: 'Dialog', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Dialog' });
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    await shot(page, `kit-dialog-${which}`);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.body.style.overflow), '', 'scroll lock released after close');

    await page.getByRole('button', { name: /confirm/i }).first().click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete credential?' });
    await confirm.waitFor();
    await shot(page, `kit-confirm-${which}`);
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await confirm.waitFor({ state: 'detached' });
  }

  // Themes: each restored theme drives the --ec-* layer, so the new pages follow it.
  const seen = new Set();
  for (const [id, appearance] of [['warm-sand-light', 'light'], ['sakura-light', 'light'], ['graphite-dark', 'dark'], ['midnight-dark', 'dark']]) {
    await openApp(page, base, { path: '/overview' });
    await pickCard(page, id);
    const state = await themeState(page);
    assert.equal(state.themeId, id);
    assert.equal(state.theme, appearance);
    const accent = await cssVar(page, '--ec-accent');
    assert.ok(accent && !seen.has(accent) || id === 'midnight-dark' || id === 'graphite-dark', `${id} accent ${accent}`);
    seen.add(accent);
    assert.notEqual(state.appBg, 'rgba(0, 0, 0, 0)', 'shell is painted');
    await page.getByTestId('overview-page').waitFor();
    await shot(page, `overview-${id}`);
    await openApp(page, base, { path: '/quota' });
    await page.locator('.ec-page-header').waitFor();
    await shot(page, `quota-${id}`);
    // the app menu offers the picked theme as pressed
    const popover = await openAppMenu(page);
    assert.equal(await popover.locator(`.ec-theme-card[data-theme-id="${id}"]`).getAttribute('aria-pressed'), 'true');
    await closeAppMenu(page);
  }
  const graphiteBg = await cssVar(page, '--ec-bg');
  await setTheme(page, 'dark');
  assert.equal((await themeState(page)).themeId, 'dark');
  assert.equal(await cssVar(page, '--ec-bg'), '#291e1a', 'back on Ember: stylesheet value, inline bridge cleared');
  assert.notEqual(graphiteBg, '#291e1a');

  // Window material hooks: shell surfaces turn transparent.
  await openApp(page, base, { path: '/overview' });
  await page.evaluate(() => { document.documentElement.dataset.windowMaterial = 'mica'; });
  const clear = await page.evaluate(() => ['.ec-app', '.ec-sidebar', '.ec-main', '.ec-page-header', 'body']
    .map((selector) => [selector, getComputedStyle(document.querySelector(selector)).backgroundColor]));
  for (const [selector, color] of clear) assert.equal(color, 'rgba(0, 0, 0, 0)', `${selector} transparent under a window material`);
  await shot(page, 'window-material');
  await page.evaluate(() => { delete document.documentElement.dataset.windowMaterial; });
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.ec-app')).backgroundColor), 'rgba(0, 0, 0, 0)');

  assert.deepEqual(page.errors, []);
  console.log('PASS: kit Dialog/ConfirmDialog/Checkbox, restored themes drive --ec-*, window-material hooks.');
});
