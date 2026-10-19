// Theme switching through the shell's appearance menu (AppMenu): Ember Dark / Light / System, "More themes",
// persistence across reloads, keyboard behaviour, localized menu at the shell breakpoints and legible text in both
// Ember appearances. Runs against the browser mock: node tests/ui/ui-kit/theme-ui.cjs (needs PLAYWRIGHT_MODULE; starts its own vite).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { launchBrowser, runUi } = require('../../helpers/ui-harness.cjs');
const {
  EMBER, LANGUAGE_LABELS, openApp, gotoPage, setTheme, setLanguage, openAppMenu, closeAppMenu, appMenuTrigger, openDrawerIfNeeded,
  themeState, STORAGE, colorsOf, contrastRatio, horizontalOverflow, isReachable, settle, waitForCoreStatus,
} = require('../../helpers/shell.cjs');

const IGNORED = [/favicon/i, /Failed to load resource: the server responded with a status of 404/];

runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
  try {
    const open = async (viewport = { width: 1280, height: 800 }, colorScheme = 'dark', locale = 'en') => {
      const context = await browser.newContext({ viewport, colorScheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.errors = [];
      page.on('pageerror', (error) => page.errors.push(`pageerror: ${error}`));
      page.on('console', (message) => {
        if (message.type() === 'error' && !IGNORED.some((pattern) => pattern.test(message.text()))) page.errors.push(`console.error: ${message.text()}`);
      });
      await page.addInitScript((value) => {
        try {
          if (sessionStorage.getItem('__seeded')) return;
          sessionStorage.setItem('__seeded', '1');
          localStorage.setItem('easy-cli-proxy-api.locale', value);
        } catch { /* opaque origin */ }
      }, locale);
      await openApp(page, base, { path: '/overview' });
      await waitForCoreStatus(page);
      return page;
    };
    const pressed = async (page, id) => {
      const popover = await openAppMenu(page);
      const value = await popover.locator(`.ec-theme-card[data-theme-id="${id}"]`).getAttribute('aria-pressed');
      await closeAppMenu(page);
      return value;
    };

    // ---- Ember Dark is the default and paints the shell ---------------------------------------------------------------------
    let page = await open();
    let state = await themeState(page);
    assert.equal(state.theme, 'dark');
    assert.equal(state.themeId, 'dark');
    assert.equal(state.appBg, EMBER.dark.bg, 'Ember Dark paints the shell');
    assert.equal(state.scheme.includes('dark'), true, 'native controls follow the appearance');

    // ---- Light applies to the new UI, persists, and survives navigation -------------------------------------------------------
    await setTheme(page, 'light');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    state = await themeState(page);
    assert.equal(state.appBg, EMBER.light.bg, 'Ember Light paints the shell');
    assert.equal(state.scheme.includes('light'), true);
    const sidebarBg = await page.locator('.ec-sidebar').evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.equal(sidebarBg, EMBER.light.sidebar, 'the sidebar follows the theme');
    assert.match(await page.evaluate((key) => localStorage.getItem(key) ?? '', STORAGE.themePaint), /light/, 'the first-paint cache records the selection');
    await gotoPage(page, '/quota');
    assert.equal((await themeState(page)).theme, 'light', 'Light persists across pages (the browser mock has no native store; reloads rely on the first-paint cache)');
    assert.equal((await themeState(page)).appBg, EMBER.light.bg);

    // ---- System follows prefers-color-scheme live; an explicit choice stops following ---------------------------------------
    await setTheme(page, 'system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await setTheme(page, 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await settle(page);
    assert.equal((await themeState(page)).theme, 'dark', 'an explicit theme ignores the system appearance');

    // ---- More themes: pick, persist, pressed state, back to Ember ----------------------------------------------------------
    let popover = await openAppMenu(page);
    assert.equal(await popover.locator('.ec-theme-card').count(), 4, 'Warm Sand, Sakura, Graphite and Midnight stay selectable');
    await popover.locator('.ec-theme-card[data-theme-id="warm-sand-light"]').click();
    await closeAppMenu(page);
    state = await themeState(page);
    assert.equal(state.themeId, 'warm-sand-light');
    assert.equal(state.theme, 'light');
    assert.notEqual(state.appBg, EMBER.light.bg, 'a restored theme repaints the Ember shell');
    assert.equal(await pressed(page, 'warm-sand-light'), 'true');
    await gotoPage(page, '/quota');
    assert.equal((await themeState(page)).themeId, 'warm-sand-light', 'a restored theme persists across pages');
    await setTheme(page, 'dark');
    assert.equal((await themeState(page)).themeId, 'dark');
    assert.equal((await themeState(page)).appBg, EMBER.dark.bg, 'the bridge is cleared when returning to Ember');
    assert.equal(await pressed(page, 'warm-sand-light'), 'false');

    // ---- keyboard: open, focus moves in, Escape closes and returns focus ----------------------------------------------------
    const trigger = appMenuTrigger(page);
    await trigger.focus();
    await page.keyboard.press('Enter');
    popover = page.getByRole('dialog', { name: 'Appearance' });
    await popover.waitFor();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    assert.ok(await popover.evaluate((element) => element.contains(document.activeElement)), 'focus moves into the menu');
    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'detached' });
    assert.ok(await trigger.evaluate((element) => element === document.activeElement), 'Escape returns focus to the trigger');
    assert.deepEqual(page.errors, []);
    await page.context().close();

    // ---- legibility: core text keeps WCAG AA contrast in both Ember appearances ---------------------------------------------
    for (const which of ['dark', 'light']) {
      page = await open({ width: 1280, height: 800 }, which);
      await setTheme(page, which);
      for (const selector of ['.ec-page-title', '.ec-nav-item[aria-current="page"]', '.ec-nav-item:not([aria-current])', '.ec-core-line']) {
        const { fg, bg } = await colorsOf(page.locator(selector).first());
        assert.ok(contrastRatio(fg, bg) >= 4.5, `${which}: ${selector} contrast ${contrastRatio(fg, bg).toFixed(2)} (${fg} on ${bg})`);
      }
      await page.context().close();
    }

    // ---- 4 locales x 4 widths: the appearance menu stays reachable, inside the viewport, with no page overflow ---------------
    for (const locale of Object.keys(LANGUAGE_LABELS)) {
      for (const width of [1280, 1000, 680, 390]) {
        page = await open({ width, height: 800 }, 'dark', locale);
        await openDrawerIfNeeded(page);
        assert.ok(await isReachable(appMenuTrigger(page)), `${locale}@${width}: appearance trigger is reachable`);
        const menu = await openAppMenu(page);
        const rect = await menu.boundingBox();
        assert.ok(rect && rect.x >= -1 && rect.x + rect.width <= width + 1 && rect.y >= -1 && rect.y + rect.height <= 800 + 1, `${locale}@${width}: menu inside the viewport`);
        await closeAppMenu(page);
        assert.deepEqual(await horizontalOverflow(page), [], `${locale}@${width}: no page-level horizontal overflow`);
        assert.deepEqual(page.errors, [], `${locale}@${width}: no console errors`);
        await page.context().close();
      }
    }
    // Language switching from the menu keeps the picked theme.
    page = await open();
    await setTheme(page, 'light');
    await setLanguage(page, 'ja');
    await page.waitForFunction(() => document.documentElement.lang === 'ja');
    assert.equal((await themeState(page)).theme, 'light', 'changing language keeps the theme');
    await page.context().close();

    console.log('Theme UI passed: Ember Dark/Light/System, More themes, persistence, keyboard, contrast, 4 locales at 4 widths.');
  } finally {
    await browser.close();
  }
});
