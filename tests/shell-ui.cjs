// Shell contract: routing, gating, navigation guard, privacy eye, footer core line, keyboard order, drawer, kit gallery.
const assert = require('node:assert/strict');
const h = require('./helpers/shell.cjs');

const TITLES = { overview: 'Overview', providers: 'Providers', quota: 'Quota', usage: 'Usage', agents: 'Agents', plugins: 'Plugins', settings: 'Settings' };
const ACTIVE = '.ec-nav a[aria-current="page"]';
const activeNav = (page) => page.locator(ACTIVE).evaluateAll((items) => items.map((item) => item.dataset.nav));

h.runUiTest('shell', async ({ base, newPage, gaps }) => {
  const open = async (options = {}, pageOptions = {}) => {
    const page = await newPage(pageOptions);
    await h.openApp(page, base, options);
    await h.waitForCoreStatus(page);
    return page;
  };
  const noErrors = (page, label) => assert.deepEqual(page.errors, [], `${label}: console/page errors`);

  // ---------------------------------------------------------------- deep links
  console.log('deep links');
  const multipleH1 = new Set();
  const deepLinks = [
    ['/overview', 'overview', null], ['/providers', 'providers', 'overview'], ['/providers/all', 'providers', 'all'],
    ['/providers/exclusions', 'providers', 'exclusions'], ['/quota', 'quota', null], ['/usage', 'usage', null], ['/agents', 'agents', null],
    ['/plugins', 'plugins', null], ['/settings', 'settings', 'general'], ['/settings/updates', 'settings', 'updates'],
    // unknown sub-pages fall back to the section's default sub-page and keep the URL as typed
    ['/providers/nonsense', 'providers', 'overview'], ['/usage/unknown-tab', 'usage', null],
  ];
  for (const [route, id, sub] of deepLinks) {
    const page = await open({ path: route });
    assert.equal(await h.currentRoute(page), route, `${route}: URL is not rewritten`);
    assert.equal(await page.locator('.ec-app').getAttribute('data-page'), id, `${route}: data-page`);
    assert.equal(await h.pageTitle(page), TITLES[id], `${route}: header title`);
    assert.deepEqual(await activeNav(page), [id], `${route}: exactly one nav item is current`);
    assert.equal(await page.locator('.ec-page-header h1').count(), 1, `${route}: one header h1`);
    if (await page.locator('main h1').count() !== 1) multipleH1.add(id);
    assert.equal(await page.locator('.ec-sidebar').count(), 1, `${route}: sidebar present`);
    assert.equal(await page.locator('main#main.ec-main').count(), 1, `${route}: main landmark`);
    if (sub) {
      const selected = await page.getByRole('tab', { selected: true }).count() ? page.getByRole('tab', { selected: true }).first() : null;
      assert.ok(selected, `${route}: sub-page tab is selected`);
      const expectedIndex = { overview: 0, all: 1, exclusions: 2, general: 0, updates: 1 }[sub];
      assert.equal(await page.locator('.ec-page-header').getByRole('tab').evaluateAll((tabs) => tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')), expectedIndex, `${route}: active sub-page tab`);
    }
    noErrors(page, route);
    await page.context().close();
  }

  h.knownGap(gaps, `pages with a second <h1> inside the body (legacy bodies): ${[...multipleH1].join(', ')}`, multipleH1.size === 0);

  // Dev-only reference gallery and bare Easy mode are routable but not in the nav.
  {
    const page = await open({ path: '/kit' });
    assert.equal(await page.locator('.ec-app').getAttribute('data-page'), 'kit');
    assert.deepEqual(await activeNav(page), [], '/kit is not in the nav');
    assert.equal(await page.locator('.ec-nav-item[data-nav="kit"]').count(), 0);
    const easy = await open({ path: '/easy' });
    assert.equal(await easy.locator('.ec-app').getAttribute('data-page'), 'easy');
    assert.equal(await easy.locator('.ec-app--bare').count(), 1, 'Easy mode is a bare full-screen page');
    assert.equal(await easy.locator('.ec-sidebar').count(), 0, 'Easy mode has no sidebar');
    assert.equal(await easy.locator('.ec-nav-item[data-nav="easy"]').count(), 0);
    noErrors(easy, '/easy');
  }

  // Empty / root hash lands on the default page without adding a history entry for the empty one.
  for (const hash of ['', '#/', '#']) {
    const page = await newPage();
    await page.goto(`${base}/?mock=running${hash}`);
    await page.locator('.ec-app').waitFor();
    await page.waitForFunction(() => location.hash === '#/overview');
    assert.deepEqual(await activeNav(page), ['overview'], `"${hash}" redirects to the overview`);
    assert.equal(await h.pageTitle(page), 'Overview');
  }

  // Query strings are preserved by deep links and normalised for the route.
  {
    const page = await open({ path: '/usage?range=7d&model=gpt-5' });
    assert.equal(await h.currentRoute(page), '/usage?range=7d&model=gpt-5');
    assert.deepEqual(await activeNav(page), ['usage']);
  }

  // --------------------------------------------------------- nav + aria-current
  console.log('nav aria-current');
  {
    const page = await open();
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    assert.equal(await nav.count(), 1, 'one named navigation landmark');
    assert.deepEqual(await page.locator('.ec-nav .ec-nav-item').evaluateAll((items) => items.map((item) => item.dataset.nav)), h.NAV_ORDER, 'nav order');
    assert.equal(await page.locator('.ec-nav-sep[role="separator"]').count(), 1, 'one divider between main and secondary groups');
    assert.deepEqual(await page.locator('.ec-nav > *').evaluateAll((items) => items.map((item) => item.classList.contains('ec-nav-sep') ? '|' : item.dataset.nav)),
      ['overview', 'providers', 'quota', 'usage', '|', 'agents', 'plugins', 'settings'], 'main group, divider, secondary group');
    for (const [id, title] of Object.entries(TITLES)) {
      const link = page.locator(`.ec-nav a[data-nav="${id}"]`);
      assert.equal(await link.getAttribute('aria-label'), title, `${id}: accessible name`);
      assert.equal(await link.getAttribute('href'), `#/${id}`, `${id}: href is the route hash`);
      await h.clickNav(page, id);
      await page.waitForFunction((route) => location.hash.startsWith(`#/${route}`), id);
      assert.deepEqual(await activeNav(page), [id], `${id}: aria-current follows the click`);
      assert.equal(await h.pageTitle(page), title, `${id}: title follows the click`);
      assert.equal(await page.locator('.ec-nav-item.is-active').count(), 1, `${id}: one active style`);
    }
    // Sub tabs keep the section current and write the sub into the hash.
    await h.gotoPage(page, '/providers');
    await page.getByRole('tab').nth(1).click();
    await page.waitForFunction(() => location.hash === '#/providers/all');
    assert.deepEqual(await activeNav(page), ['providers']);
    await page.getByRole('tab').nth(0).click();
    await page.waitForFunction(() => location.hash === '#/providers', null, { timeout: 5000 });
    // Brand and the footer core line both go to the overview.
    await page.locator('.ec-brand').click();
    await page.waitForFunction(() => location.hash === '#/overview');
    await h.gotoPage(page, '/quota');
    await h.coreLine(page).click();
    await page.waitForFunction(() => location.hash === '#/overview');
    noErrors(page, 'nav');
  }

  // ------------------------------------------------------------------- 404 page
  console.log('404');
  {
    const page = await open({ path: '/definitely-not-a-page' });
    assert.equal(await h.pageTitle(page), 'Page not found');
    assert.equal(await page.locator('h1').count(), 1);
    assert.deepEqual(await activeNav(page), [], 'no nav item is current on an unknown route');
    assert.equal(await page.locator('.ec-sidebar').count(), 1, 'the shell stays around the 404');
    assert.equal(await h.currentRoute(page), '/definitely-not-a-page', 'the URL is kept (not redirected)');
    await page.getByRole('link', { name: 'Back to Overview' }).click();
    await page.waitForFunction(() => location.hash === '#/overview');
    assert.deepEqual(await activeNav(page), ['overview']);
    // 404 from in-app navigation and recovery with the sidebar
    await h.gotoPage(page, '/nope/at/all');
    assert.equal(await h.pageTitle(page), 'Page not found');
    await h.clickNav(page, 'usage');
    assert.equal(await h.pageTitle(page), 'Usage');
    noErrors(page, '404');
  }

  // ------------------------------------------------------- app:navigate events
  console.log('app:navigate');
  {
    const page = await open();
    const send = (detail) => page.evaluate((value) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: value })), detail);
    const expectations = [
      ['api', '/providers'], ['oauth', '/providers'], ['quota', '/quota'], ['agents', '/agents'],
      ['usage-records', '/usage'], ['plugins', '/plugins'], ['config', '/settings'], ['versions', '/settings/updates'],
      ['home', '/overview'], ['/providers/api?q=1', '/providers/api?q=1'],
      ['usage', '/usage'], ['settings', '/settings'], // new route ids work too
    ];
    for (const [detail, expected] of expectations) {
      await send(detail);
      await page.waitForFunction((value) => location.hash === `#${value}`, expected);
      assert.equal(await h.currentRoute(page), expected, `app:navigate "${detail}"`);
    }
    // 'easy' (legacy id) opens the bare Easy mode page in local mode
    await send('easy');
    await page.waitForFunction(() => location.hash === '#/easy');
    assert.equal(await page.locator('.ec-app--bare').count(), 1);
    await send('home');
    await page.waitForFunction(() => location.hash === '#/overview');
    // Unknown ids and malformed details are ignored (no hash change, no error)
    for (const detail of ['definitely-unknown', '', 123, null, { id: 'quota' }]) {
      await send(detail);
      await page.waitForTimeout(50);
      assert.equal(await h.currentRoute(page), '/overview', `app:navigate ${JSON.stringify(detail)} is ignored`);
    }
    noErrors(page, 'app:navigate');
  }

  // ------------------------------------------- cancelable navigation guard event
  console.log('navigation guard');
  {
    const page = await open({ path: '/quota' });
    await page.evaluate(() => {
      window.guard = { cancel: true, events: 0, pending: [] };
      window.addEventListener('cpa-gui-navigation-request', (event) => {
        window.guard.events += 1;
        if (!window.guard.cancel) return;
        window.guard.pending.push(event.detail);
        event.preventDefault();
      });
    });
    const guard = () => page.evaluate(() => ({ cancel: window.guard.cancel, events: window.guard.events, pending: window.guard.pending.length }));
    const expectStay = async (label, route = '/quota', id = 'quota') => {
      await page.waitForTimeout(80);
      assert.equal(await h.currentRoute(page), route, `${label}: hash stays`);
      assert.deepEqual(await activeNav(page), [id], `${label}: nav stays`);
      assert.equal(await h.pageTitle(page), TITLES[id], `${label}: page stays`);
    };

    // 1) a link click is guarded: the event carries a callback; cancelling keeps hash + page
    await page.locator('.ec-nav a[data-nav="usage"]').click();
    await expectStay('link click');
    assert.equal((await guard()).pending, 1, 'the guard received a continuation callback');
    // 2) programmatic app:navigate is guarded
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'api' })));
    await expectStay('app:navigate');
    // 3) sub tab navigation is guarded
    await h.waitForCoreStatus(page);
    // 4) typed hash / back-forward: the browser already changed the URL, the router must restore it
    await page.evaluate(() => { location.hash = '#/usage'; });
    await expectStay('typed hash');
    await page.evaluate(() => { location.hash = '#/nonsense'; });
    await expectStay('typed unknown hash');
    // 5) the guard can resume the navigation later ("discard changes" -> continue)
    const eventsBefore = (await guard()).events;
    await page.locator('.ec-nav a[data-nav="agents"]').click();
    await expectStay('pending click');
    await page.evaluate(() => { window.guard.cancel = false; window.guard.pending.at(-1)(); });
    await page.waitForFunction(() => location.hash === '#/agents');
    assert.deepEqual(await activeNav(page), ['agents'], 'resumed navigation lands on the target');
    assert.ok((await guard()).events > eventsBefore, 'guard events were fired');
    // 6) with the guard not cancelling every route works again
    await h.clickNav(page, 'usage');
    await page.waitForFunction(() => location.hash === '#/usage');
    await h.gotoPage(page, '/plugins');
    await page.waitForFunction(() => location.hash === '#/plugins');
    // 7) guard cancels back/forward and restores the URL
    await page.evaluate(() => { window.guard.cancel = true; window.guard.pending.length = 0; });
    await page.goBack();
    await page.waitForTimeout(150);
    assert.equal(await h.currentRoute(page), '/plugins', 'back is cancelled by the guard');
    assert.equal(await h.pageTitle(page), 'Plugins');
    // 8) resuming a cancelled back navigation actually navigates (typed/back hash continuation)
    await page.evaluate(() => { const pending = window.guard.pending.at(-1); window.guard.cancel = false; pending(); });
    await page.waitForFunction(() => location.hash === '#/usage');
    assert.deepEqual(await activeNav(page), ['usage'], 'resumed back navigation lands on its target');
    assert.equal(await h.pageTitle(page), 'Usage');
    // ... and a resumed typed hash too
    await page.evaluate(() => { window.guard.cancel = true; window.guard.pending.length = 0; location.hash = '#/agents'; });
    await expectStay('typed hash (2)', '/usage', 'usage');
    await page.evaluate(() => { window.guard.cancel = false; window.guard.pending.at(-1)(); });
    await page.waitForFunction(() => location.hash === '#/agents');
    assert.deepEqual(await activeNav(page), ['agents']);
    // the guard is asked only once per navigation (no loops)
    const settled = (await guard()).events;
    await page.waitForTimeout(150);
    assert.equal((await guard()).events, settled, 'no guard re-dispatch after resuming');
    noErrors(page, 'guard');
  }

  // --------------------------------------------------------------- back/forward
  console.log('back / forward');
  {
    const page = await open();
    await h.clickNav(page, 'providers');
    await h.clickNav(page, 'quota');
    await h.clickNav(page, 'usage');
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/quota');
    assert.deepEqual(await activeNav(page), ['quota']);
    assert.equal(await h.pageTitle(page), 'Quota');
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/providers');
    assert.deepEqual(await activeNav(page), ['providers']);
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/overview');
    assert.deepEqual(await activeNav(page), ['overview']);
    await page.goForward();
    await page.waitForFunction(() => location.hash === '#/providers');
    await page.goForward();
    await page.goForward();
    await page.waitForFunction(() => location.hash === '#/usage');
    assert.deepEqual(await activeNav(page), ['usage']);
    // a sub tab is a history entry too
    await h.gotoPage(page, '/settings');
    await page.getByRole('tab').nth(1).click();
    await page.waitForFunction(() => location.hash === '#/settings/updates');
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/settings');
    assert.equal(await page.locator('.ec-page-header').getByRole('tab').evaluateAll((tabs) => tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')), 0);
    // the same route does not add history entries
    const length = await page.evaluate(() => history.length);
    await h.clickNav(page, 'settings');
    await h.clickNav(page, 'settings');
    assert.equal(await page.evaluate(() => history.length), length, 're-selecting the current page is a no-op');
    noErrors(page, 'history');
  }

  // ------------------------------------------------------ gating (core stopped)
  console.log('gating');
  const LOCKED = ['providers', 'quota', 'plugins'];
  for (const mock of ['stopped', 'empty']) {
    const page = await open({ mock });
    assert.equal(await h.coreLineKind(page), mock === 'stopped' ? 'stopped' : 'notInstalled', `${mock}: footer line`);
    for (const id of h.NAV_ORDER) {
      const item = page.locator(`.ec-nav [data-nav="${id}"]`);
      if (LOCKED.includes(id)) {
        assert.equal(await item.evaluate((element) => element.tagName), 'BUTTON', `${mock}/${id}: locked pages are buttons`);
        assert.equal(await item.isDisabled(), true, `${mock}/${id}: disabled`);
        assert.ok((await item.getAttribute('class')).includes('is-locked'));
        assert.equal(await item.getAttribute('aria-current'), null);
        assert.equal(await item.getAttribute('href'), null);
        assert.ok(await item.getAttribute('title'), `${mock}/${id}: explains why it is locked`);
        assert.equal(await item.getAttribute('aria-label'), TITLES[id], `${mock}/${id}: keeps its name`);
        assert.equal(await item.locator('.ec-nav-lock').count(), 1, `${mock}/${id}: lock icon`);
      } else {
        assert.equal(await item.evaluate((element) => element.tagName), 'A', `${mock}/${id}: available pages stay links`);
        assert.equal(await item.locator('.ec-nav-lock').count(), 0);
      }
    }
    // Clicking a locked item does nothing.
    await page.locator('.ec-nav [data-nav="quota"]').click({ force: true });
    await page.waitForTimeout(80);
    assert.equal(await h.currentRoute(page), '/overview', `${mock}: locked click is inert`);
    // Always-available pages open.
    for (const id of h.ALWAYS_AVAILABLE) {
      await h.clickNav(page, id);
      await page.waitForFunction((route) => location.hash.startsWith(`#/${route}`), id);
      assert.equal(await h.pageTitle(page), TITLES[id]);
    }
    noErrors(page, `${mock} nav`);
    await page.context().close();

    // Deep links to gated pages redirect to the overview (replace: no history entry for the gated URL).
    for (const route of ['/providers', '/providers/oauth', '/quota', '/plugins']) {
      const link = await newPage();
      await link.goto('about:blank');
      await h.openApp(link, base, { mock, path: route });
      await link.waitForFunction(() => location.hash === '#/overview');
      assert.deepEqual(await activeNav(link), ['overview'], `${mock}${route}: lands on the overview`);
      assert.equal(await h.pageTitle(link), 'Overview');
      await link.goBack();
      assert.equal(link.url(), 'about:blank', `${mock}${route}: the gated URL was replaced, not pushed`);
      noErrors(link, `${mock}${route}`);
      await link.context().close();
    }
    // In-app navigation to a gated page bounces back too (app:navigate from legacy code).
    const bounce = await open({ mock, path: '/usage' });
    await bounce.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'api' })));
    await bounce.waitForFunction(() => location.hash === '#/overview');
    await bounce.evaluate(() => { location.hash = '#/quota'; });
    await bounce.waitForFunction(() => location.hash === '#/overview');
    noErrors(bounce, `${mock} bounce`);
  }
  // Locked items are skipped by the keyboard (disabled buttons).
  {
    const page = await open({ mock: 'stopped' });
    await page.locator('.ec-brand').focus();
    const visited = [];
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('Tab');
      visited.push(await page.evaluate(() => document.activeElement?.dataset?.nav ?? document.activeElement?.className));
    }
    for (const id of LOCKED) assert.ok(!visited.includes(id), `locked ${id} is not tabbable`);
  }
  // Deep link waits for the first status instead of bouncing (slow backend), then redirects when the core is stopped.
  {
    const page = await newPage();
    await h.openApp(page, base, { mock: 'stopped', path: '/quota', query: 'mockDelay=700' });
    await page.waitForTimeout(250);
    assert.equal(await h.currentRoute(page), '/quota', 'no redirect before the core status is known');
    assert.equal(await h.pageTitle(page), 'Quota', 'header shown while waiting');
    await page.waitForFunction(() => location.hash === '#/overview', null, { timeout: 8000 });
  }
  // Live transitions: starting the core unlocks, stopping a gated page leaves it.
  {
    const page = await open({ mock: 'stopped' });
    await h.invoke(page, 'start_core_process');
    await h.waitForCoreLine(page, 'running');
    for (const id of h.NAV_ORDER) assert.equal(await page.locator(`.ec-nav a[data-nav="${id}"]`).count(), 1, `${id}: unlocked after start`);
    await h.clickNav(page, 'quota');
    assert.equal(await h.pageTitle(page), 'Quota');
    await h.invoke(page, 'stop_core_process');
    await h.waitForCoreLine(page, 'stopped');
    await page.waitForFunction(() => location.hash === '#/overview');
    assert.equal(await page.locator('.ec-nav button.is-locked').count(), LOCKED.length);
    noErrors(page, 'live gating');
  }
  // Remote mode: Easy mode is local-only, the reason is exposed to assistive tech.
  {
    const page = await open();
    assert.equal(await page.locator('#remote-navigation-reason').count(), 0, 'no remote reason in local mode');
    await h.setRemote(page);
    await h.waitForCoreLine(page, 'remote');
    assert.equal(await page.locator('#remote-navigation-reason').count(), 1);
    assert.match(await page.locator('#remote-navigation-reason').innerText(), /Local mode/);
    assert.equal(await page.locator('#remote-navigation-reason').evaluate((element) => element.className.includes('ec-sr-only')), true, 'visually hidden');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'easy' })));
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.ec-app--bare').count(), 0, 'Easy mode never opens in remote mode');
    assert.equal(await h.currentRoute(page), '/overview');
    await page.evaluate(() => { location.hash = '#/easy'; });
    await page.waitForFunction(() => location.hash === '#/overview');
    // all nav stays usable in remote mode when the remote core is reachable
    assert.equal(await page.locator('.ec-nav button.is-locked').count(), 0);
    const down = await newPage();
    await h.openApp(down, base, { mock: 'running', path: '/usage' });
    await h.waitForCoreStatus(down);
    await h.setRemote(down, { offline: true });
    await h.waitForCoreLine(down, 'remoteDown');
    assert.equal(await down.locator('.ec-nav button.is-locked').count(), LOCKED.length, 'unreachable remote locks like a stopped core');
    noErrors(page, 'remote');
  }

  // ---------------------------------------------------------------- privacy eye
  console.log('privacy');
  {
    const page = await open({ path: '/overview' });
    const eye = page.getByTestId('privacy-toggle');
    assert.equal(await eye.getAttribute('aria-pressed'), 'false');
    const offLabel = await eye.getAttribute('aria-label');
    await eye.click();
    assert.equal(await eye.getAttribute('aria-pressed'), 'true');
    assert.notEqual(await eye.getAttribute('aria-label'), offLabel, 'the label names the opposite action');
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), h.STORAGE.privacy), 'on', 'persisted to storage');
    // shared by every page header and kept across navigation
    for (const route of ['/providers', '/quota', '/usage', '/agents', '/plugins', '/settings']) {
      await h.gotoPage(page, route);
      await h.waitForCoreStatus(page);
      assert.equal(await page.getByTestId('privacy-toggle').getAttribute('aria-pressed'), 'true', `${route}: eye state is shared`);
    }
    // survives a reload
    await h.reopenApp(page, base, { path: '/overview' });
    assert.equal(await page.getByTestId('privacy-toggle').getAttribute('aria-pressed'), 'true', 'eye state survives reload');
    // keyboard operable
    await page.getByTestId('privacy-toggle').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.getByTestId('privacy-toggle').getAttribute('aria-pressed'), 'false');
    await page.keyboard.press('Space');
    assert.equal(await page.getByTestId('privacy-toggle').getAttribute('aria-pressed'), 'true');

    // The kit gallery masks identifiers when privacy is on.
    await h.setPrivacy(page, false);
    await h.gotoPage(page, '/kit');
    await page.locator('.ec-masked').first().waitFor();
    const raw = ['maya.ortiz@example.dev', 'noor.haddad@example.com', 'dev.amara@example.org'];
    const shown = () => page.locator('.ec-masked').evaluateAll((nodes) => nodes.map((node) => ({ text: node.textContent, title: node.title, hidden: node.classList.contains('ec-masked--hidden'), label: node.getAttribute('aria-label') })));
    let masked = await shown();
    assert.ok(masked.length >= 4, 'the kit shows masked values');
    assert.ok(masked.every((entry) => !entry.hidden && entry.label === null), 'privacy off: nothing masked');
    assert.ok(raw.every((value) => masked.some((entry) => entry.text.includes(value))), 'privacy off: raw values shown');
    await h.setPrivacy(page, true);
    masked = await shown();
    assert.ok(masked.every((entry) => entry.hidden), 'privacy on: every sample is masked');
    assert.ok(masked.every((entry) => raw.every((value) => !entry.text.includes(value) && !entry.title.includes(value))), 'privacy on: raw values are in neither text nor title');
    assert.ok(masked.every((entry) => entry.label && entry.label === entry.title), 'privacy on: aria-label and title say "hidden"');
    assert.ok(!(await page.locator('.ec-main').innerText()).includes('maya.ortiz@example.dev'), 'the page text no longer contains the identifier');
    await h.setPrivacy(page, false);
    masked = await shown();
    assert.ok(masked.every((entry) => !entry.hidden), 'privacy off again restores values');
    // pressing the eye while on the kit page and reloading keeps it masked
    await h.setPrivacy(page, true);
    await h.reopenApp(page, base, { path: '/kit' });
    await page.locator('.ec-masked').first().waitFor();
    assert.ok((await shown()).every((entry) => entry.hidden), 'masked after reload');
    noErrors(page, 'privacy');
  }

  // ------------------------------------------------------------ footer core line
  console.log('footer core line');
  {
    const page = await open();
    const text = () => h.coreLine(page).innerText();
    const chip = () => page.locator('.ec-sidebar .ec-mode-chip').innerText();
    const dot = () => h.coreLine(page).locator('.ec-core-dot').getAttribute('class');
    assert.equal(await h.coreLineKind(page), 'running');
    assert.equal(await text(), 'Core running · :8317', 'local port from the GUI settings');
    assert.equal(await chip(), 'Local');
    assert.match(await dot(), /ec-core-dot--ok/);
    assert.equal(await h.coreLine(page).getAttribute('href'), '#/overview');
    assert.equal(await h.coreLine(page).getAttribute('title'), 'Open runtime status on Overview');

    await emitCore(page, { running: false, ready: false, starting: true });
    await h.waitForCoreLine(page, 'starting');
    assert.equal(await text(), 'Core starting…');
    assert.match(await dot(), /ec-core-dot--warn/);
    assert.equal(await page.locator('.ec-nav button.is-locked').count(), LOCKED.length, 'starting core still locks gated pages');

    await h.invoke(page, 'stop_core_process');
    await h.waitForCoreLine(page, 'stopped');
    assert.equal(await text(), 'Core stopped');
    assert.match(await dot(), /ec-core-dot--muted/);

    await emitCore(page, { installed: false, running: false, ready: false });
    await h.waitForCoreLine(page, 'notInstalled');
    assert.equal(await text(), 'Core not installed');

    await h.invoke(page, 'start_core_process').catch(() => {}); // not installed: rejects in the mock
    await emitCore(page, { installed: true, running: true, ready: true });
    await h.waitForCoreLine(page, 'running');
    await h.invoke(page, 'stop_core_process');
    await h.setRemote(page, { host: 'core.example.test:8317' });
    await h.waitForCoreLine(page, 'remote');
    assert.ok((await text()).includes('core.example.test:8317'), 'remote: the host is shown');
    assert.ok(!/offline|unreachable/i.test(await text()), 'remote: reachable text');
    assert.equal(await chip(), 'Remote');
    assert.match(await dot(), /ec-core-dot--ok/);
    assert.equal(await page.locator('.ec-mode-chip .ec-chip, .ec-mode-chip [class*="chip"]').first().evaluate((element) => /info/.test(element.className)), true, 'remote chip uses the info tone');

    await h.setRemote(page, { host: 'core.example.test:8317', offline: true });
    await h.waitForCoreLine(page, 'remoteDown');
    assert.match(await text(), /unreachable/i);
    assert.ok((await text()).includes('offline.core.example.test:8317'), 'remoteDown: the host is shown');
    assert.match(await dot(), /ec-core-dot--warn/);

    await h.setRemote(page, { key: 'wrong-key' });
    await h.waitForCoreLine(page, 'remoteDown');
    await h.setLocal(page);
    await h.waitForCoreLine(page, 'stopped');
    assert.equal(await chip(), 'Local');
    assert.equal(await page.locator('#remote-navigation-reason').count(), 0);
    noErrors(page, 'core line');

    // Localized, never raw keys
    for (const [locale, running] of [['zh-CN', '核心运行中'], ['zh-TW', null], ['ja', 'コア稼働中'], ['en', 'Core running']]) {
      const localized = await open({}, { locale });
      const value = await h.coreLine(localized).innerText();
      assert.ok(!/shell\./.test(value), `${locale}: no raw keys in the footer (${value})`);
      if (running) assert.ok(value.includes(running), `${locale}: "${value}" includes ${running}`);
      assert.ok(value.includes(':8317'), `${locale}: port shown`);
      await localized.context().close();
    }
  }

  // ------------------------------------------------- keyboard focus order (sidebar)
  console.log('keyboard order');
  {
    const describeFocus = (page) => page.evaluate(() => {
      const element = document.activeElement;
      if (!element) return 'none';
      if (element.dataset.nav) return `nav:${element.dataset.nav}`;
      if (element.classList.contains('ec-brand')) return 'brand';
      if (element.classList.contains('ec-core-line')) return 'core-line';
      if (element.getAttribute('aria-haspopup') === 'dialog') return 'appearance';
      if (element.closest('.ec-page-header')) return 'header';
      return element.closest('main') ? 'main' : (element.tagName.toLowerCase());
    });
    const tabThrough = async (page, count, key = 'Tab') => {
      const order = [await describeFocus(page)];
      for (let index = 1; index < count; index += 1) { await page.keyboard.press(key); order.push(await describeFocus(page)); }
      return order;
    };
    const navIds = h.NAV_ORDER.map((id) => `nav:${id}`);

    // full sidebar: brand -> appearance (brand row) -> nav -> core line -> page
    const full = await open({ path: '/overview' }, { viewport: { width: 1280, height: 800 } });
    await full.locator('.ec-brand').focus();
    assert.deepEqual(await tabThrough(full, 2 + navIds.length + 2), ['brand', 'appearance', ...navIds, 'core-line', 'header'], 'full sidebar tab order');
    assert.deepEqual((await tabThrough(full, 3, 'Shift+Tab')).slice(1), ['core-line', 'nav:settings'], 'Shift+Tab walks back');
    // focus ring is visible on keyboard focus
    await full.locator('.ec-nav a[data-nav="quota"]').focus();
    await full.keyboard.press('Tab'); await full.keyboard.press('Shift+Tab');
    const ring = await full.locator('.ec-nav a[data-nav="quota"]').evaluate((element) => ({ visible: element.matches(':focus-visible'), width: getComputedStyle(element).outlineWidth, style: getComputedStyle(element).outlineStyle }));
    assert.deepEqual(ring, { visible: true, width: '2px', style: 'solid' }, 'nav items show the focus ring');
    // Enter activates, the page title follows
    await full.locator('.ec-nav a[data-nav="usage"]').focus();
    await full.keyboard.press('Enter');
    await full.waitForFunction(() => location.hash === '#/usage');
    assert.deepEqual(await activeNav(full), ['usage']);

    // icon rail (<=1100px): the appearance button moves from the brand row to the footer, after the core line
    const rail = await open({ path: '/overview' }, { viewport: { width: 1000, height: 700 } });
    await rail.locator('.ec-brand').focus();
    assert.deepEqual(await tabThrough(rail, 1 + navIds.length + 2), ['brand', ...navIds, 'core-line', 'appearance'], 'icon-rail tab order');
    for (const id of h.NAV_ORDER) {
      assert.ok(await rail.locator(`.ec-nav a[data-nav="${id}"]`).getAttribute('title'), `${id}: rail tooltip`);
    }

    // stopped: locked entries are skipped
    const stopped = await open({ mock: 'stopped', path: '/overview' });
    await stopped.locator('.ec-brand').focus();
    assert.deepEqual(await tabThrough(stopped, 2 + 4 + 1), ['brand', 'appearance', 'nav:overview', 'nav:usage', 'nav:agents', 'nav:settings', 'core-line'], 'locked items are not tab stops');
    await full.context().close(); await rail.context().close(); await stopped.context().close();
  }

  // -------------------------------------------------------------- drawer at 680px
  console.log('drawer');
  {
    const page = await open({ path: '/quota' }, { viewport: { width: 680, height: 800 } });
    const sidebar = page.locator('.ec-sidebar');
    const hamburger = page.locator('.ec-page-menu');
    const offscreen = async () => (await h.box(sidebar)).x + (await h.box(sidebar)).width <= 1;
    assert.equal(await hamburger.isVisible(), true, 'hamburger is visible <=720px');
    assert.equal(await hamburger.getAttribute('aria-label'), 'Open menu');
    assert.equal(await offscreen(), true, 'sidebar starts off-canvas');
    const main = await h.box(page.locator('.ec-main'));
    assert.equal(main.x, 0, 'main takes the full width');
    assert.equal(main.width, 680);
    assert.equal(await page.locator('.ec-drawer-scrim').count(), 0, 'no scrim while closed');
    assert.deepEqual(await h.horizontalOverflow(page), []);

    // open -> Esc closes
    await hamburger.click();
    await page.locator('.ec-sidebar.is-open').waitFor();
    await page.waitForFunction(() => document.querySelector('.ec-sidebar').getBoundingClientRect().left >= -1);
    const drawer = await h.box(sidebar);
    assert.equal(Math.round(drawer.width), 260, 'drawer is 260px wide');
    assert.equal(drawer.x, 0);
    assert.equal(drawer.height, 800, 'drawer is full height');
    assert.equal(await page.locator('.ec-drawer-scrim').count(), 1, 'scrim is shown');
    for (const id of h.NAV_ORDER) assert.equal(await h.isReachable(page.locator(`.ec-nav [data-nav="${id}"]`)), true, `${id}: reachable in the drawer`);
    assert.equal(await h.isReachable(h.coreLine(page)), true, 'core line reachable in the drawer');
    assert.equal(await h.isReachable(h.appMenuTrigger(page)), true, 'appearance menu reachable in the drawer');
    assert.equal(await sidebar.evaluate((element) => getComputedStyle(element).zIndex > 60 || Number(getComputedStyle(element).zIndex) > 60), true, 'drawer is above the scrim');
    await page.keyboard.press('Escape');
    await page.locator('.ec-sidebar.is-open').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('.ec-sidebar').getBoundingClientRect().right <= 1);
    assert.equal(await page.locator('.ec-drawer-scrim').count(), 0);
    assert.equal(await h.currentRoute(page), '/quota', 'Esc does not navigate');

    // scrim click closes; link click navigates and closes
    await hamburger.click();
    await page.locator('.ec-drawer-scrim').click({ position: { x: 600, y: 400 } });
    await page.locator('.ec-sidebar.is-open').waitFor({ state: 'detached' });
    await hamburger.click();
    await page.locator('.ec-nav a[data-nav="usage"]').click();
    await page.waitForFunction(() => location.hash === '#/usage');
    await page.locator('.ec-sidebar.is-open').waitFor({ state: 'detached' });
    assert.equal(await h.pageTitle(page), 'Usage');
    // navigating by other means (back) also closes
    await hamburger.click();
    await page.locator('.ec-sidebar.is-open').waitFor();
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/quota');
    await page.locator('.ec-sidebar.is-open').waitFor({ state: 'detached' });
    // Esc with the appearance popover open: the popover takes it first
    await h.openAppMenu(page);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    // the appearance popover works from the drawer and stays in the viewport
    const popover = await h.openAppMenu(page);
    const popoverBox = await h.box(popover);
    assert.ok(popoverBox.x >= 0 && popoverBox.x + popoverBox.width <= 680 && popoverBox.y >= 0 && popoverBox.y + popoverBox.height <= 800, 'popover inside the viewport');
    await page.keyboard.press('Escape');
    // growing past 720px with the drawer open turns it back into the docked sidebar
    await h.openDrawerIfNeeded(page);
    await page.setViewportSize({ width: 900, height: 800 });
    await page.waitForFunction(() => document.querySelector('.ec-sidebar').getBoundingClientRect().left >= 0 && document.querySelector('.ec-sidebar').getBoundingClientRect().width < 100);
    assert.equal(await hamburger.isVisible(), false, 'hamburger hides above 720px');
    noErrors(page, 'drawer');

    // keyboard: tab order inside the open drawer is brand, appearance, nav
    await page.setViewportSize({ width: 680, height: 800 });
    await h.openDrawerIfNeeded(page);
    await page.locator('.ec-brand').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-haspopup')), 'dialog');
    await page.keyboard.press('Escape');
    await page.locator('.ec-sidebar.is-open').waitFor({ state: 'detached' });
    assert.equal(await sidebar.evaluate((element) => getComputedStyle(element).visibility === 'hidden' || element.inert), true, 'closed drawer is not keyboard-focusable');
    assert.equal(await hamburger.getAttribute('aria-expanded'), 'false');
    assert.equal(await hamburger.evaluate((element) => element === document.activeElement), true, 'Escape restores menu focus');
    await hamburger.click();
    await page.locator('.ec-sidebar.is-open').waitFor();
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.ec-sidebar'))), true, 'opening drawer moves focus into it');
    assert.equal(await hamburger.getAttribute('aria-expanded'), 'true');
    assert.equal(await hamburger.getAttribute('aria-controls'), await sidebar.getAttribute('id'));
    await page.context().close();
  }

  // --------------------------------------------------- kit gallery: dark/light/compact
  console.log('kit gallery');
  {
    const page = await open({ path: '/kit' });
    await page.locator('.ec-kit, [class*="ec-kit"]').first().waitFor();
    const combos = [['dark', 'comfortable'], ['light', 'comfortable'], ['dark', 'compact'], ['light', 'compact']];
    for (const [theme, density] of combos) {
      await h.setTheme(page, theme);
      await h.setDensity(page, density);
      const state = await h.themeState(page);
      assert.equal(state.theme, theme);
      assert.equal(state.density, density);
      assert.equal(state.appBg, h.EMBER[theme].bg, `${theme}/${density}: app background`);
      await page.locator('.ec-main').evaluate(async (main) => {
        // Scroll through the whole gallery so every lazy/section render path runs.
        for (let top = 0; top <= main.scrollHeight; top += main.clientHeight * 0.8) { main.scrollTop = top; await new Promise((resolve) => requestAnimationFrame(resolve)); }
        main.scrollTop = 0;
      });
      assert.deepEqual(await h.horizontalOverflow(page), [], `kit ${theme}/${density}: no horizontal page overflow`);
      assert.ok(await page.locator('[class*="ec-kit"] section, .ec-kit-section, section').count() >= 8, `kit ${theme}/${density}: sections render`);
      assert.equal(await page.locator('h1').count(), 1, `kit ${theme}/${density}: single h1`);
      assert.deepEqual(page.errors, [], `kit ${theme}/${density}: no console errors`);
    }
    // kit remains stable at a narrow width in both themes
    for (const theme of ['dark', 'light']) {
      await h.setTheme(page, theme);
      await page.setViewportSize({ width: 600, height: 800 });
      await h.settle(page);
      assert.deepEqual(await h.horizontalOverflow(page), [], `kit ${theme} 600px: no horizontal page overflow`);
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    assert.deepEqual(page.errors, [], 'kit: no console errors across themes/densities');
  }

  console.log('PASS: shell routing, nav state, 404, app:navigate, guard, history, gating, privacy, core line, keyboard order, drawer, kit.');
});

/** Publishes a partial core status (the mock's get_core_status shape) to the app's `core-status-changed` listener. */
async function emitCore(page, patch) {
  const status = await h.invoke(page, 'get_core_status');
  await h.emitEvent(page, 'core-status-changed', { ...status, ...patch });
}
