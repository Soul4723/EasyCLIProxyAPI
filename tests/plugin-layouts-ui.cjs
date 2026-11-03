// Plugins card layouts (Even rows, Stacked, Compact) on the Local plugins and Plugin store tabs, across window sizes, aspect ratios and
// pixel densities, on the browser mock. Run with a Vite dev server at PLUGINS_TEST_BASE, or let the script start one.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// [width, height, deviceScaleFactor]: phones, tablets, laptops, desktops, ultrawide, portrait monitor and a short window.
const displays = [
  [320, 640, 2], [375, 812, 3], [414, 896, 2], [768, 1024, 2], [1024, 768, 1], [800, 600, 1.25], [1280, 800, 1.5],
  [1366, 768, 1], [1440, 900, 2], [1920, 1080, 1], [2560, 1440, 1], [3440, 1440, 1], [1080, 1920, 1], [1280, 420, 1],
];
const layouts = [['even', 'Even rows'], ['stacked', 'Stacked'], ['compact', 'Compact']];
// [tab, plugins in the browser mock]
const tabs = [['Local plugins', 1], ['Plugin store', 2]];

const openPage = async (page, base) => {
  await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
  await page.goto(`${base}/?mock=running`);
  await page.locator('.app-shell').waitFor();
  await page.locator('#browser-mock-toolbar').evaluate(element => { element.style.display = 'none'; });
  await page.locator('.nav-section button').filter({ has: page.getByText('Plugins', { exact: true }) }).first().click();
  await page.locator('.plugin-card').first().waitFor();
};

(async () => {
  let server;
  let browser;
  let base = process.env.PLUGINS_TEST_BASE;
  try {
    if (!base) {
      const { createServer } = await import('vite');
      const react = (await import('@vitejs/plugin-react')).default;
      server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
      await server.listen();
      base = `http://127.0.0.1:${server.httpServer.address().port}`;
    }
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    browser = await chromium.launch({ channel, headless: true, timeout: Number(process.env.PLAYWRIGHT_LAUNCH_TIMEOUT) || undefined, args: ['--no-proxy-server'] });
    for (const [width, height, deviceScaleFactor] of displays) {
      const display = `${width}x${height}@${deviceScaleFactor}x`;
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
      await context.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await openPage(page, base);
      // Even rows is the default, the page's look before the switch.
      assert.equal(await page.getByRole('radio', { name: 'Even rows', exact: true }).getAttribute('aria-checked'), 'true', `${display}: Even rows is the default`);
      for (const [tab, count] of tabs) {
        await page.getByRole('tab', { name: tab, exact: true }).click();
        await page.locator('.plugin-card').nth(count - 1).waitFor();
        for (const [layout, label] of layouts) {
          const context = `${display} ${tab} ${layout}`;
          await page.getByRole('radio', { name: label, exact: true }).click();
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          // On phones the app shell can be a little wider than the window (a separate shell issue), and clicking a control scrolls it
          // sideways; measure the page in place.
          await page.evaluate(() => { document.querySelector('.app-shell').scrollLeft = 0; });
          const result = await page.evaluate(() => {
            const issues = [];
            const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
            for (const node of [document.documentElement, document.body, document.querySelector('.content'), document.querySelector('.content > .page')].filter(Boolean)) {
              if (node.scrollWidth > node.clientWidth + 1) issues.push(`page scrolls sideways (${node.className || node.tagName}: ${node.scrollWidth} > ${node.clientWidth})`);
            }
            const toolbar = document.querySelector('.plugin-toolbar');
            const controls = [...toolbar.children].filter(visible);
            for (const control of controls) {
              const box = control.getBoundingClientRect();
              if (box.left < -1 || box.right > innerWidth + 1) issues.push(`toolbar ${control.className} outside the window`);
            }
            for (const button of toolbar.querySelectorAll('.plugin-toolbar-icons button')) if (!button.getAttribute('aria-label')) issues.push('toolbar icon button without a name');
            const switcher = document.querySelector('.plugin-layout-control');
            if (new Set([...switcher.querySelectorAll('button')].map(button => Math.round(button.getBoundingClientRect().top))).size !== 1) issues.push('layout switch buttons not in one row');
            const grid = document.querySelector('.plugin-grid').getBoundingClientRect();
            const cards = [...document.querySelectorAll('.plugin-card')];
            const rects = cards.map(card => card.getBoundingClientRect());
            rects.forEach((rect, index) => {
              if (rect.left < grid.left - 1 || rect.right > grid.right + 1) issues.push(`card ${index} outside the grid`);
              for (let other = index + 1; other < rects.length; other++) {
                const b = rects[other];
                if (Math.min(rect.right, b.right) - Math.max(rect.left, b.left) > 1 && Math.min(rect.bottom, b.bottom) - Math.max(rect.top, b.top) > 1) issues.push(`cards ${index} and ${other} overlap`);
              }
              for (const part of cards[index].querySelectorAll('button, .plugin-badge, h2, .plugin-chip-text')) {
                if (!visible(part)) continue;
                const box = part.getBoundingClientRect();
                if (box.left < rect.left - 1 || box.right > rect.right + 1 || box.bottom > rect.bottom + 1) issues.push(`card ${index}: ${part.className || part.tagName} spills out of the card`);
                if (part.tagName === 'BUTTON' && part.scrollWidth > part.clientWidth + 1) issues.push(`card ${index}: button "${part.textContent}" clips its label`);
              }
            });
            const glance = cards.filter(card => card.hasAttribute('data-glance'));
            glance.forEach((card, index) => {
              const toggle = card.querySelector('.plugin-glance-toggle');
              if (!toggle || !visible(toggle)) issues.push(`glance card ${index}: no visible details toggle`);
              else if (toggle.getBoundingClientRect().width > 48) issues.push(`glance card ${index}: details toggle stretches to ${Math.round(toggle.getBoundingClientRect().width)}px`);
              const name = card.querySelector('h2');
              if (name.getBoundingClientRect().height > parseFloat(getComputedStyle(name).fontSize) * 2) issues.push(`glance card ${index}: name wraps`);
              for (const hidden of card.querySelectorAll('.plugin-card-actions, .plugin-path, .plugin-card-description, .plugin-menus, .plugin-platforms')) if (visible(hidden)) issues.push(`glance card ${index}: ${hidden.className} still shown`);
            });
            const rows = new Map();
            rects.forEach(rect => rows.set(Math.round(rect.top), [...(rows.get(Math.round(rect.top)) ?? []), Math.round(rect.height)]));
            return { issues, cards: cards.length, // Controls differ in height, so rows are counted by vertical centre.
              toolbarRows: new Set(controls.map(control => { const box = control.getBoundingClientRect(); return Math.round((box.top + box.bottom) / 2 / 8); })).size,
              columns: new Set(rects.map(rect => Math.round(rect.left))).size, gridWidth: grid.width, rowHeights: [...rows.values()], glance: glance.length };
          });
          assert.deepEqual(result.issues, [], context);
          assert.equal(result.cards, count, `${context}: every mock plugin is shown`);
          // The toolbar stays on one row once the window has room for it.
          if (width >= 1024) assert.equal(result.toolbarRows, 1, `${context}: toolbar on one row`);
          if (layout === 'stacked' || layout === 'compact') {
            const [minimum, gap] = layout === 'compact' ? [260, 8] : [330, 16];
            assert.equal(result.columns, Math.min(count, Math.max(1, Math.floor((result.gridWidth + gap) / (minimum + gap)))), `${context}: column count follows the window width`);
          }
          if (layout === 'even') for (const heights of result.rowHeights) assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `${context}: every card in a row has the same height`);
          assert.equal(result.glance, layout === 'compact' ? count : 0, `${context}: only Compact shows glance cards`);
        }
        // Compact cards expand and collapse from the keyboard, and the toggle names its plugin.
        const toggle = page.locator('.plugin-glance-toggle').first();
        assert.match(await toggle.getAttribute('aria-label'), /^Show details: .+/, `${display} ${tab}: the toggle names its plugin`);
        await toggle.focus();
        await page.keyboard.press('Enter');
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true', `${display} ${tab}: Enter expands the card`);
        assert.ok(await page.locator('.plugin-card:not([data-glance]) .plugin-card-actions').isVisible(), `${display} ${tab}: the expanded card shows its actions`);
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('.plugin-card[data-glance]').count(), count, `${display} ${tab}: Enter collapses it again`);
        await page.getByRole('radio', { name: 'Even rows', exact: true }).click();
      }
      assert.deepEqual(errors, [], `${display}: no page errors`);
      await context.close();
    }

    // The chosen layout survives a reload.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); localStorage.setItem('cpa-gui.plugins-layout.v1', 'stacked'); });
    const page = await context.newPage();
    await openPage(page, base);
    assert.equal(await page.getByRole('radio', { name: 'Stacked', exact: true }).getAttribute('aria-checked'), 'true', 'a stored layout is restored');
    await context.close();
    console.log(`Plugins layouts: ${displays.length} displays x ${layouts.length} layouts x ${tabs.length} tabs passed`);
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
