// Appearance controls in Settings → App (the same AppearanceControls the sidebar menu embeds): Ember Dark / Light / System,
// "More themes", Comfortable / Compact density, instant apply without the save bar, state shared with the app menu,
// legible controls in both appearances and a usable layout at 1280 and 680 wide.
// node tests/ui/ui-kit/theme-controls-ui.cjs (needs PLAYWRIGHT_MODULE; starts its own vite).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { launchBrowser, runUi } = require('../../helpers/ui-harness.cjs');
const {
  EMBER, openApp, openAppMenu, closeAppMenu, themeState, colorsOf, contrastRatio, horizontalOverflow, settle, waitForCoreStatus,
} = require('../../helpers/shell.cjs');

const IGNORED = [/favicon/i, /Failed to load resource: the server responded with a status of 404/];

runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
  try {
    const open = async (viewport) => {
      const context = await browser.newContext({ viewport, colorScheme: 'dark', reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.errors = [];
      page.on('pageerror', (error) => page.errors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error' && !IGNORED.some((pattern) => pattern.test(message.text()))) page.errors.push(message.text());
      });
      await page.addInitScript(() => { try { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); } catch { /* ignore */ } });
      await openApp(page, base, { path: '/settings/app' });
      await waitForCoreStatus(page);
      return page;
    };

    for (const width of [1280, 680]) {
      const page = await open({ width, height: 900 });
      const content = page.locator('.ec-set-content');
      const appearance = content.locator('.ec-appearance');
      await appearance.waitFor();
      const savebar = page.getByRole('region', { name: 'Unsaved changes' });
      const radio = (name) => appearance.getByRole('radio', { name });

      // Initial state: Ember Dark + Comfortable, both pressed.
      assert.equal(await radio('Ember Dark').getAttribute('aria-checked'), 'true');
      assert.equal(await radio('Comfortable').getAttribute('aria-checked'), 'true');
      assert.equal((await themeState(page)).appBg, EMBER.dark.bg);

      // Light applies to the whole shell at once.
      await radio('Ember Light').click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      assert.equal(await radio('Ember Light').getAttribute('aria-checked'), 'true');
      assert.equal((await themeState(page)).appBg, EMBER.light.bg);
      assert.equal(await page.locator('.ec-sidebar').evaluate((element) => getComputedStyle(element).backgroundColor), EMBER.light.sidebar);
      assert.equal(await savebar.count(), 0, 'appearance never opens the save bar');

      // System follows the OS appearance.
      await radio('System').click();
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      assert.equal(await radio('System').getAttribute('aria-checked'), 'true');

      // More themes: four restored themes plus the browser mock's custom theme, one pressed at a time, shared with the app menu.
      const cards = appearance.locator('.ec-theme-card');
      await appearance.locator('.ec-theme-card[data-theme-id="harbor-dark"]').waitFor();
      assert.equal(await cards.count(), 5);
      await cards.filter({ hasText: 'Graphite' }).click();
      await page.waitForFunction(() => document.documentElement.dataset.themeId === 'graphite-dark');
      assert.equal(await appearance.locator('.ec-theme-card[aria-pressed="true"]').count(), 1);
      assert.equal(await radio('Ember Dark').getAttribute('aria-checked'), 'false', 'a restored theme unchecks the Ember radios');
      const popover = await openAppMenu(page);
      assert.equal(await popover.locator('.ec-theme-card[data-theme-id="graphite-dark"]').getAttribute('aria-pressed'), 'true', 'app menu shows the same selection');
      await closeAppMenu(page);
      await radio('Ember Dark').click();
      await page.waitForFunction(() => document.documentElement.dataset.themeId === 'dark');
      assert.equal(await appearance.locator('.ec-theme-card[aria-pressed="true"]').count(), 0);
      assert.equal((await themeState(page)).appBg, EMBER.dark.bg);

      // Density: compact shrinks the row/control tokens; comfortable restores them.
      const token = (name) => page.evaluate((property) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(property)), name);
      const comfortable = await token('--ec-row-h');
      await radio('Compact').click();
      await page.waitForFunction(() => document.documentElement.dataset.density === 'compact');
      assert.ok(await token('--ec-row-h') < comfortable, 'compact rows are shorter');
      await radio('Comfortable').click();
      await page.waitForFunction(() => document.documentElement.dataset.density === 'comfortable');
      assert.equal(await token('--ec-row-h'), comfortable);

      // Legibility of the controls themselves in both appearances.
      for (const which of ['Ember Dark', 'Ember Light']) {
        await radio(which).click();
        await settle(page);
        for (const locator of [radio(which), radio(which === 'Ember Dark' ? 'Ember Light' : 'Ember Dark'), cards.first().locator('.ec-theme-name'), appearance.locator('.ec-popover-heading, h3, [class*=heading]').first()]) {
          const { fg, bg } = await colorsOf(locator);
          assert.ok(contrastRatio(fg, bg) >= 3, `${which}@${width}: control text contrast ${contrastRatio(fg, bg).toFixed(2)} (${fg} on ${bg})`);
        }
      }
      assert.deepEqual(await horizontalOverflow(page), [], `${width}: no page-level horizontal overflow`);
      assert.deepEqual(page.errors, [], `${width}: no console errors`);
      await page.context().close();
    }
    console.log('Theme controls UI passed: Settings → App Dark/Light/System, More themes, density, app-menu parity at 1280 and 680.');
  } finally {
    await browser.close();
  }
});
