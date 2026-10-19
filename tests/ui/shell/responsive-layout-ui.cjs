const assert = require('node:assert/strict');
const { runUiTest, openApp, sidebarModeFor, BREAKPOINTS, horizontalOverflow } = require('../../helpers/shell.cjs');

runUiTest('responsive shell layout', async ({ base, newPage }) => {
  assert.equal(BREAKPOINTS.rail, 1100);
  assert.equal(BREAKPOINTS.drawer, 720);
  const cases = [
    { width: 1280, mode: 'full' },
    { width: 1101, mode: 'full' },
    { width: 1100, mode: 'rail' },
    { width: 721, mode: 'rail' },
    { width: 720, mode: 'drawer' },
    { width: 640, mode: 'drawer' },
  ];

  for (const { width, mode } of cases) {
    const page = await newPage({ viewport: { width, height: 600 } });
    await openApp(page, base, { path: '/overview' });
    assert.equal(sidebarModeFor(width), mode);
    assert.equal(await page.locator('.ec-app').getAttribute('data-page'), 'overview');
    assert.deepEqual(await horizontalOverflow(page), [], `${width}px shell has no page-level horizontal overflow`);

    const sidebar = page.locator('.ec-sidebar');
    if (mode === 'full') {
      assert.equal(await page.locator('.ec-brand-name').isVisible(), true, `${width}px keeps brand text`);
      assert.equal(await page.locator('.ec-nav-label').first().isVisible(), true, `${width}px keeps nav labels`);
    } else if (mode === 'rail') {
      assert.equal(await page.locator('.ec-brand-name').isVisible(), false, `${width}px collapses brand text`);
      assert.equal(await page.locator('.ec-nav-label').first().isVisible(), false, `${width}px hides visual nav labels`);
      assert.ok(await page.locator('.ec-nav-item[data-nav="overview"]').getAttribute('aria-label'),
        'rail navigation retains accessible labels');
      assert.equal(await sidebar.isVisible(), true);
    } else {
      assert.equal(await page.locator('.ec-page-menu').isVisible(), true, `${width}px shows the menu button`);
      assert.equal(await sidebar.isVisible(), false, 'the mobile drawer starts off-canvas');
      await page.locator('.ec-page-menu').click();
      await page.locator('.ec-sidebar.is-open').waitFor();
      assert.equal(await sidebar.isVisible(), true, 'the hamburger opens the drawer');
      await page.keyboard.press('Escape');
      await page.locator('.ec-sidebar.is-open').waitFor({ state: 'detached' });
      assert.equal(await sidebar.isVisible(), false, 'Escape closes the drawer');
    }
    assert.deepEqual(page.errors, [], `${width}px shell has no runtime errors`);
    await page.context().close();
  }
  console.log('PASS: full sidebar, <=1100px icon rail, <=720px drawer, accessible rail labels and no horizontal shell overflow.');
});
