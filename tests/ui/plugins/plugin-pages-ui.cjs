// Plugin pages in the application shell: sidebar group (order, drag, keyboard, collapse, rail/drawer, locked) and the
// `#/plugin/<id>` webview route (layout, overlays, reload, failure/retry, core stop). Run:
//   PLAYWRIGHT_MODULE=<path> node tests/ui/plugins/plugin-pages-ui.cjs
const assert = require('node:assert/strict');
const { runUiTest, openApp, invoke } = require('../../helpers/shell.cjs');

const HINT = 'Please start the core service on Home first';
const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const entries = (page) => page.locator('#ec-plugin-pages a.ec-plugin-entry, #ec-plugin-pages button.ec-plugin-entry');
const toggle = (page) => page.locator('button.ec-plugin-toggle');
const routes = (page) => entries(page).evaluateAll((items) => items.map((item) => item.dataset.pluginRoute));
const settleLayout = (page, value) => page.waitForFunction((expected) =>
  document.querySelector('.ec-plugin-group')?.getAttribute('data-plugin-layout') === expected, value);

runUiTest('plugin pages', async ({ base, newPage }) => {
  const page = await newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const result = matchMedia(query);
      if (query.startsWith('(resolution:')) window.__resolutionQuery = result;
      return result;
    };
  });
  await openApp(page, base, { path: '/overview' });
  await entries(page).first().waitFor();
  await settleLayout(page, 'expanded');

  // --- group structure: below the secondary nav (Agents, Plugins, Settings)
  assert.equal(await entries(page).count(), 2);
  assert.equal(await toggle(page).getAttribute('aria-expanded'), 'true');
  assert.equal(await toggle(page).getAttribute('aria-controls'), 'ec-plugin-pages');
  assert.equal(await toggle(page).getAttribute('aria-label'), 'Plugin pages');
  assert.equal(await page.locator('#ec-plugin-pages').getAttribute('role'), 'group');
  assert.deepEqual(await routes(page), ['/plugin-pages/request-inspector/0', '/plugin-pages/request-inspector/1']);
  assert.deepEqual(await entries(page).evaluateAll((items) => items.map((item) => item.textContent.trim())), ['Inspector status', 'Sampled requests']);
  const order = await page.locator('.ec-nav').evaluate((nav) => [...nav.querySelectorAll('.ec-nav-item')].map((item) => item.dataset.nav || 'plugin'));
  assert.deepEqual(order.slice(-5), ['agents', 'plugins', 'settings', 'plugin', 'plugin']);
  assert.match(await entries(page).first().getAttribute('href'), /^#\/plugin\/request-inspector$/);
  assert.match(await entries(page).nth(1).getAttribute('href'), /^#\/plugin\/request-inspector\?menu=1$/);

  // --- drag reorder (pointer), no scrollbar growth, persisted across reload
  const original = await routes(page);
  const nav = page.locator('.ec-nav');
  await page.locator('.ec-plugin-row').first().hover();
  const start = await page.locator('.ec-plugin-drag').first().boundingBox();
  const target = await page.locator('.ec-plugin-drag').nth(1).boundingBox();
  const scrollBefore = await nav.evaluate((el) => ({ w: el.scrollWidth, h: el.scrollHeight }));
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 100, start.y + 140, { steps: 8 });
  assert.deepEqual(await nav.evaluate((el) => ({ w: el.scrollWidth, h: el.scrollHeight })), scrollBefore, 'dragging outside the list must not create scrollbars');
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2 + 4, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction((route) => document.querySelector('.ec-plugin-entry')?.getAttribute('data-plugin-route') === route, original[1]);
  assert.equal(await page.locator('section.ec-plugin-page').count(), 0, 'reordering must not open a page');
  await page.reload();
  await entries(page).first().waitFor();
  assert.equal((await routes(page))[0], original[1], 'order survives reload and backend refresh');

  // --- keyboard reorder (Space, ArrowDown, Space)
  await page.locator('.ec-plugin-drag').first().focus();
  await page.keyboard.press('Space');
  await page.locator('.ec-plugin-row.is-dragging').waitFor();
  await frames(page);
  await page.keyboard.press('ArrowDown');
  await frames(page);
  await page.keyboard.press('Space');
  await page.waitForFunction((route) => document.querySelector('.ec-plugin-entry')?.getAttribute('data-plugin-route') === route, original[0]);

  // --- route page: header + host fills the main area; the native view covers it
  const hole = page.locator('[data-mock-plugin-webview]');
  const pluginPage = page.locator('section.ec-plugin-page');
  const aligned = async () => {
    try {
      await page.waitForFunction(() => {
        const placeholder = document.querySelector('[data-mock-plugin-webview]');
        const host = document.querySelector('[data-testid=plugin-host]');
        if (!placeholder || !host || placeholder.hidden) return false;
        const a = placeholder.getBoundingClientRect();
        const b = host.getBoundingClientRect();
        return [a.left - b.left, a.top - b.top, a.width - b.width, a.height - b.height].every((delta) => Math.abs(delta) <= 1);
      });
    } catch (error) {
      const geometry = await page.evaluate(() => {
        const placeholder = document.querySelector('[data-mock-plugin-webview]');
        const host = document.querySelector('[data-testid=plugin-host]');
        const rect = (element) => {
          if (!element) return null;
          const { x, y, width, height, left, top, right, bottom } = element.getBoundingClientRect();
          return { x, y, width, height, left, top, right, bottom };
        };
        return { hidden: placeholder?.hidden, placeholderStyle: placeholder?.getAttribute('style'), placeholder: rect(placeholder), host: rect(host), viewport: { width: innerWidth, height: innerHeight } };
      });
      throw new Error(`${error.message}; plugin webview geometry: ${JSON.stringify(geometry)}`);
    }
  };
  const hidden = () => page.waitForFunction(() => document.querySelector('[data-mock-plugin-webview]')?.hidden === true);
  const resize = async (size) => { await page.setViewportSize(size); await frames(page); };
  await entries(page).first().click();
  await pluginPage.waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/plugin/request-inspector');
  assert.equal(await pluginPage.locator('h1.ec-page-title').textContent(), 'Inspector status');
  assert.equal(await entries(page).first().getAttribute('aria-current'), 'page');
  await aligned();
  assert.equal(await hole.getAttribute('data-mock-url'), 'http://127.0.0.1:8317/v0/resource/plugins/request-inspector/status');
  assert.deepEqual(JSON.parse(await hole.getAttribute('data-mock-labels')), { back: 'Back', reload: 'Reload', openExternal: 'Open in browser', move: 'Move controls' });
  assert.equal(await page.locator('[data-testid=plugin-host]').evaluate((el) => Math.round(el.getBoundingClientRect().bottom)), 900, 'plugin page fills the main height');

  // --- moving between monitors can change DPI without changing the CSS rectangle
  await page.evaluate(() => {
    window.__boundsUpdates = 0;
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args, options) => {
      if (command === 'set_plugin_webview_bounds') window.__boundsUpdates++;
      return invoke(command, args, options);
    };
  });
  for (const event of ['resize', 'resolution', 'resolution']) {
    const previous = await page.evaluate(() => window.__boundsUpdates);
    await page.evaluate((name) => {
      if (name === 'resize') window.dispatchEvent(new Event('resize'));
      else window.__resolutionQuery.dispatchEvent(new Event('change'));
    }, event);
    if (event === 'resize') {
      await frames(page);
      assert.equal(await page.evaluate(() => window.__boundsUpdates), previous, 'unchanged CSS bounds do not send an IPC on resize');
    } else {
      await page.waitForFunction((count) => window.__boundsUpdates > count, previous);
    }
    await aligned();
  }
  console.log('unchanged CSS bounds are skipped on resize and re-applied for DPI changes');

  // --- overlays hide the native view; closing restores it
  for (const [label, open, close] of [
    ['appearance menu', () => page.locator('button[aria-haspopup=dialog]').first().click(), () => page.keyboard.press('Escape')],
    ['alert dialog',
      () => page.evaluate(() => { const dialog = document.createElement('div'); dialog.setAttribute('role', 'alertdialog'); dialog.id = 'fixture-dialog'; dialog.textContent = 'Confirm'; document.body.append(dialog); }),
      () => page.evaluate(() => document.getElementById('fixture-dialog').remove())],
  ]) {
    await open();
    await hidden();
    await close();
    await aligned();
    console.log(`overlay ok: ${label}`);
  }

  // --- layout follows resize across full / rail / drawer widths
  for (const size of [{ width: 1280, height: 520 }, { width: 1280, height: 900 }, { width: 1000, height: 800 }, { width: 600, height: 700 }]) {
    await resize(size);
    await aligned();
  }
  const narrow = await hole.boundingBox();
  assert.equal(narrow.x, 0, 'drawer layout: the host uses the full width');
  await resize({ width: 1280, height: 900 });
  await aligned();

  // --- clicking the active entry reloads
  await entries(page).first().click();
  await page.waitForFunction(() => document.querySelector('[data-mock-plugin-webview]')?.dataset.mockReloads === '1');
  await aligned();

  // --- slow reload finishing under an overlay stays hidden; failed show reports and retries
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__;
    const original = internals.invoke;
    window.__showGate = null;
    window.__failNextShow = false;
    internals.invoke = (command, args, options) => {
      if (command !== 'show_plugin_webview') return original(command, args, options);
      if (window.__failNextShow) { window.__failNextShow = false; return original(command, { ...args, menuIndex: 99 }, options); }
      const gate = window.__showGate;
      const result = original(command, args, options);
      return gate ? result.then((value) => gate.then(() => value)) : result;
    };
    window.__showGate = new Promise((resolve) => { window.__openShowGate = resolve; });
  });
  await entries(page).first().click();
  await page.locator('.ec-plugin-status').waitFor();
  await page.locator('button[aria-haspopup=dialog]').first().click();
  await hidden();
  await page.evaluate(() => { window.__showGate = null; window.__openShowGate(); });
  await page.locator('.ec-plugin-status').waitFor({ state: 'detached' });
  assert.equal(await hole.evaluate((element) => element.hidden), true, 'a slow reload that finishes under an overlay stays hidden');
  await page.keyboard.press('Escape');
  await aligned();
  await page.evaluate(() => { window.__failNextShow = true; });
  await entries(page).first().click();
  await pluginPage.locator('.ec-plugin-error[role=alert]').waitFor();
  await hidden();
  await pluginPage.getByRole('button', { name: 'Retry' }).click();
  await aligned();
  assert.equal(await pluginPage.getByRole('alert').count(), 0);

  // --- the other menu of the same plugin; unknown plugin falls back to Plugins
  await entries(page).nth(1).click();
  await page.waitForFunction(() => document.querySelector('[data-mock-plugin-webview]')?.dataset.mockUrl?.endsWith('/samples'));
  assert.equal(await page.evaluate(() => location.hash), '#/plugin/request-inspector?menu=1');
  assert.equal(await pluginPage.locator('h1').textContent(), 'Sampled requests');
  await aligned();
  await page.evaluate(() => { window.location.hash = '#/plugin/no-such-plugin'; });
  await page.waitForFunction(() => location.hash === '#/plugins');
  await hidden();
  // legacy app:navigate routes map to the shell path
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: '/plugin-pages/request-inspector/0' })));
  await page.waitForFunction(() => location.hash === '#/plugin/request-inspector');
  await aligned();

  // --- collapse / expand: manual choice holds until the auto result or the count changes
  await toggle(page).click();
  assert.equal(await toggle(page).getAttribute('aria-expanded'), 'false');
  assert.equal(await entries(page).count(), 0);
  assert.equal(await toggle(page).getAttribute('data-active-child'), 'true', 'a collapsed group shows the active child page');
  await page.waitForTimeout(200);
  assert.equal(await entries(page).count(), 0, 'manual collapse holds while the auto result is unchanged');
  await toggle(page).click();
  assert.equal(await entries(page).count(), 2);

  // --- core stopped: entries locked, route leaves the page, native view hidden
  await invoke(page, 'stop_core_process');
  await page.waitForFunction(() => location.hash === '#/overview');
  await hidden();
  const locked = page.locator('#ec-plugin-pages button.ec-plugin-entry.is-locked');
  await locked.first().waitFor();
  assert.equal(await locked.count(), 2);
  for (let index = 0; index < 2; index += 1) {
    assert.equal(await locked.nth(index).isDisabled(), true);
    assert.equal(await locked.nth(index).getAttribute('title'), HINT);
    assert.equal(await locked.nth(index).locator('.ec-nav-lock').count(), 1);
  }
  assert.equal(await toggle(page).isEnabled(), true);
  assert.deepEqual(page.errors, []);
  await page.context().close();

  // --- many pages auto-collapse by height; manual expand shows all
  const many = await newPage({ viewport: { width: 1280, height: 700 } });
  await openApp(many, base, { path: '/overview', query: 'mockPluginPages=12' });
  await toggle(many).waitFor();
  await settleLayout(many, 'collapsed');
  assert.equal(await entries(many).count(), 0);
  await toggle(many).click();
  assert.equal(await entries(many).count(), 14);
  assert.deepEqual(many.errors, []);
  await many.context().close();

  // --- icon rail: entries are icon-only with names, no header or grips; drawer: full labels
  const rail = await newPage({ viewport: { width: 1000, height: 800 } });
  await openApp(rail, base, { path: '/overview' });
  await entries(rail).first().waitFor();
  assert.equal(await entries(rail).count(), 2);
  assert.equal(await toggle(rail).isVisible(), false);
  assert.equal(await rail.locator('.ec-plugin-drag').first().isVisible(), false);
  assert.equal(await entries(rail).first().getAttribute('aria-label'), 'Inspector status');
  assert.ok(await entries(rail).first().getAttribute('title'));
  await rail.context().close();

  const drawer = await newPage({ viewport: { width: 600, height: 800 } });
  await openApp(drawer, base, { path: '/overview' });
  await drawer.locator('.ec-page-menu').click();
  await entries(drawer).first().waitFor();
  await drawer.waitForTimeout(400);
  assert.equal(await toggle(drawer).isVisible(), true);
  assert.equal(await entries(drawer).first().isVisible(), true);
  await entries(drawer).first().click();
  await drawer.locator('section.ec-plugin-page').waitFor();
  assert.equal(await drawer.locator('.ec-sidebar.is-open').count(), 0, 'choosing a plugin page closes the drawer');
  assert.deepEqual(drawer.errors, []);
  assert.deepEqual(drawer.externalRequests, []);
  await drawer.context().close();
  console.log('PASS: plugin pages group (order, drag, keyboard, collapse, rail, drawer, locked) and webview route (layout, overlays, reload, retry, stop).');
});
