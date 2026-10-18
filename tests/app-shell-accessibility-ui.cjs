const assert = require('node:assert/strict');
const { runUiTest, openApp, gotoPage } = require('./helpers/shell.cjs');

runUiTest('app shell accessibility', async ({ base, newPage }) => {
  const page = await newPage();
  await openApp(page, base, { path: '/overview' });

  assert.equal(await page.getByRole('main').count(), 1, 'the app has exactly one main landmark');
  assert.equal(await page.locator('#main.ec-main').count(), 1);
  assert.equal(await page.locator('.ec-sidebar').count(), 1, 'the app has one sidebar landmark');
  assert.equal(await page.locator('.ec-nav[aria-label]').count(), 1, 'navigation has an accessible name');
  assert.equal(await page.locator('.ec-brand[aria-label], .ec-brand[title]').count(), 1, 'the brand link has a text alternative');
  assert.equal(await page.locator('.ec-page-header h1.ec-page-title').count(), 1, 'the page has a labelled level-one heading');
  assert.equal(await page.locator('.ec-nav-item[data-nav="overview"][aria-current="page"]').count(), 1);
  assert.equal(await page.getByTestId('privacy-toggle').getAttribute('aria-label').then(Boolean), true,
    'the privacy icon button has an accessible name');
  assert.equal(await page.getByTestId('privacy-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('.ec-core-line[aria-label], .ec-core-line[title]').count(), 1,
    'the core status link has an accessible name');

  await gotoPage(page, '/usage');
  await page.locator('.ec-page-header h1.ec-page-title').waitFor();
  assert.equal(await page.getByRole('main').count(), 1, 'legacy page wrappers do not add main landmarks');
  const tabs = page.getByRole('tab');
  assert.ok(await tabs.count() >= 1, 'usage sub-navigation exposes tabs');
  assert.deepEqual(await tabs.evaluateAll(items => items.map(item => item.getAttribute('aria-controls'))
    .filter(id => !id || !document.getElementById(id))), [], 'every tab controls an existing panel');
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true', 'tabs support keyboard selection');
  await page.getByTestId('privacy-toggle').click();
  assert.equal(await page.getByTestId('privacy-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByTestId('privacy-toggle').getAttribute('aria-label').then(Boolean), true);

  assert.deepEqual(page.errors, [], 'shell accessibility interactions do not raise runtime errors');
  assert.deepEqual(page.externalRequests, [], 'the test does not require external resources');
  console.log('PASS: shell landmarks, named controls, navigation state, tab relationships and privacy toggle.');
});
