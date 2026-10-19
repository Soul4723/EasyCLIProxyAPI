// Shared helpers for UI tests against the cohesive shell (src/shell). DOM contract:
//   root .ec-app[data-page=<routeId>] (bare/full-screen pages add .ec-app--bare and have no sidebar) · main#main.ec-main
//   sidebar aside.ec-sidebar (.is-open while the <=720px drawer is open; .ec-drawer-scrim is the click-away layer)
//   nav a.ec-nav-item[data-nav=<routeId>] (aria-current=page when active; locked pages are disabled
//   button.ec-nav-item.is-locked[data-nav]) · brand a.ec-brand · header .ec-page-header h1.ec-page-title
//   hamburger button.ec-page-menu (visible <=720px only) · privacy eye [data-testid=privacy-toggle] (aria-pressed)
//   footer core line a.ec-core-line[data-core-status=running|starting|stopped|notInstalled|remote|remoteDown]
//   + .ec-mode-chip (Local/Remote) · #remote-navigation-reason (sr-only, remote mode only)
//   appearance menu: button labelled shell.appearance (aria-haspopup=dialog) opens a role=dialog popover with radiogroups
//   Theme (Dark/Light/System, in that order), Density (Comfortable/Compact, in that order) and a Language listbox.
// Routes are hash routes; OLD page ids map to new paths below so old tests can keep their intent.
// Test scaffolding: runUiTest() starts its own vite + chromium; ctx.newPage() returns a page that records
// page.errors (pageerror + console.error), page.externalRequests (blocked) and defaults to locale en.
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const LEGACY_PATHS = {
  home: '/overview', easy: '/easy', api: '/providers', oauth: '/providers', quota: '/quota',
  agents: '/agents', 'usage-records': '/usage', plugins: '/plugins', config: '/settings', versions: '/settings/updates',
};
const LANGUAGE_LABELS = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', en: 'English' };
const NAV_ORDER = ['overview', 'providers', 'quota', 'usage', 'agents', 'plugins', 'settings'];
/** Nav pages that stay usable while the core is not ready (src/navigation.ts). */
const ALWAYS_AVAILABLE = ['overview', 'usage', 'agents', 'settings'];
const STORAGE = {
  locale: 'easy-cli-proxy-api.locale',
  density: 'easy-cli-proxy-api.density',
  privacy: 'easy-cli-proxy-api.privacy-mode',
  themePaint: 'easy-cli-proxy-api.theme-paint',
  mockScenario: 'easy-cli-proxy-api.browser-mock-scenario',
};
/** Layout breakpoints of the shell (src/shell/Sidebar.css, shell.css). */
const BREAKPOINTS = { rail: 1100, drawer: 720 };

const pathFor = (pageOrPath) => (pageOrPath.startsWith('/') ? pageOrPath : LEGACY_PATHS[pageOrPath] ?? `/${pageOrPath}`);
const sidebarModeFor = (width) => (width <= BREAKPOINTS.drawer ? 'drawer' : width <= BREAKPOINTS.rail ? 'rail' : 'full');

/* ------------------------------------------------------------------ harness */

function playwright() {
  return require(process.env.PLAYWRIGHT_MODULE || 'playwright');
}

/** Starts a private vite dev server on a free port (the browser mock is dev-only). */
async function startServer() {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({
    configFile: false, root: ROOT, plugins: [react()], logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  return { base, close: () => server.close() };
}

function launchBrowser() {
  const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  return playwright().chromium.launch({ ...(channel ? { channel } : {}), headless: true, args: ['--no-proxy-server'] });
}

// Console noise that is not an app error (missing favicon from the dev server).
const IGNORED_CONSOLE = [/favicon/i, /Failed to load resource: the server responded with a status of 404/];

/**
 * Starts vite + chromium, runs `body({ base, browser, newPage, gaps })`, and always cleans up.
 * `newPage(options)` creates an isolated context: viewport 1280x800, reduced motion, locale `en` (override with
 * `locale`), external requests aborted and recorded, `page.errors` filled from pageerror + console.error.
 * Use `await body` failures for assertions; a non-zero exit code is set on any thrown error.
 */
async function runUiTest(name, body) {
  let server;
  let browser;
  const gaps = [];
  try {
    server = await startServer();
    browser = await launchBrowser();
    const base = server.base;
    const newPage = async ({ viewport = { width: 1280, height: 800 }, locale = 'en', colorScheme = 'dark', blockExternal = true,
      storage = {}, init, ...options } = {}) => {
      const context = await browser.newContext({ viewport, colorScheme, reducedMotion: 'reduce', ...options });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.errors = [];
      page.externalRequests = [];
      page.on('pageerror', (error) => page.errors.push(`pageerror: ${error}`));
      page.on('console', (message) => {
        if (message.type() !== 'error' || IGNORED_CONSOLE.some((pattern) => pattern.test(message.text()))) return;
        page.errors.push(`console.error: ${message.text()}`);
      });
      if (blockExternal) {
        await page.route('**/*', (route) => {
          const url = route.request().url();
          if (url.startsWith(`${base}/`) || url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return route.continue();
          page.externalRequests.push(url);
          return route.abort();
        });
      }
      await page.addInitScript(({ locale: value, extra }) => {
        // Seed once per tab (a reload must keep what the test changed afterwards); about:blank has no storage.
        try {
          if (sessionStorage.getItem('__seeded')) return;
          sessionStorage.setItem('__seeded', '1');
          if (value) localStorage.setItem('easy-cli-proxy-api.locale', value);
          for (const [key, item] of Object.entries(extra)) localStorage.setItem(key, item);
        } catch { /* opaque origin */ }
      }, { locale, extra: storage });
      if (init) await page.addInitScript(init);
      return page;
    };
    await body({ base, browser, newPage, gaps, name });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const gap of gaps) console.log(`KNOWN GAP: ${gap}`);
    await browser?.close();
    await server?.close();
  }
}

/** Records (does not fail on) a behaviour that is not right yet; reported at the end of the run. */
function knownGap(gaps, label, ok) {
  if (!ok) gaps.push(label);
  return ok;
}

/* -------------------------------------------------------------------- pages */

/** Opens `base?mock=<scenario>#/path` and waits for the shell. `page` may be an old id ('usage-records') or '/usage/requests'. */
async function openApp(page, base, { mock = 'running', path: target = '/overview', query = '' } = {}) {
  const url = new URL(base);
  url.searchParams.set('mock', mock);
  for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value);
  url.hash = pathFor(target);
  await page.goto(url.toString(), { waitUntil: 'commit' });
  await page.locator('.ec-app').waitFor();
}

/** Opens a full reload of the same URL hash (page.goto with only a hash change does not reload). */
async function reopenApp(page, base, options) {
  await page.goto('about:blank');
  await openApp(page, base, options);
}

/** In-app navigation (hash change). Accepts old ids or paths. */
async function gotoPage(page, pageOrPath) {
  const target = pathFor(pageOrPath);
  await page.locator('.ec-app').waitFor();
  await page.evaluate((hash) => { window.location.hash = hash; }, target);
  await page.waitForFunction((hash) => window.location.hash.startsWith(`#${hash.split('?')[0]}`)
    && document.querySelector('.ec-app')?.dataset.page === hash.split('/')[1].split('?')[0], target);
  await settle(page);
}

/** Clicks the sidebar link for a route id (overview, providers, quota, usage, agents, plugins, settings). */
async function clickNav(page, routeId) {
  await openDrawerIfNeeded(page);
  await page.locator(`.ec-nav a[data-nav="${routeId}"]`).click();
}

const currentRoute = (page) => page.evaluate(() => window.location.hash.replace(/^#/, ''));
const pageTitle = (page) => page.locator('.ec-page-title').first().innerText();

/** Waits two frames (layout + effects settled) and fonts. */
const settle = (page) => page.evaluate(async () => {
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});

/* ----------------------------------------------------------- tauri mock IPC */

/** Calls a Tauri command through the browser mock (`window.__TAURI_INTERNALS__.invoke`). */
const invoke = (page, command, args) => page.evaluate(([name, payload]) => window.__TAURI_INTERNALS__.invoke(name, payload), [command, args]);

/** Delivers a Tauri event to the app's listeners (`core-status-changed`, `windows-close-requested`, ...). */
const emitEvent = (page, event, payload = null) => page.evaluate(async ([name, value]) => {
  const { emit } = await import('/node_modules/@tauri-apps/api/event.js');
  await emit(name, value);
}, [event, payload]);

/**
 * Waits until the app has consumed the first core status. The mock answers commands in order, so once our own
 * get_core_status resolves the app's has too; two frames let React commit it.
 */
async function waitForCoreStatus(page) {
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__?.invoke));
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_core_status'));
  await settle(page);
}

const coreLine = (page) => page.locator('.ec-sidebar .ec-core-line');
async function waitForCoreLine(page, kind) {
  await page.waitForFunction((value) => document.querySelector('.ec-core-line')?.dataset.coreStatus === value, kind);
}
const coreLineKind = (page) => coreLine(page).getAttribute('data-core-status');

/** Switches the mock to a remote core (stops the GUI-managed local one first). Origins must be http(s) origins. */
async function setRemote(page, { host = 'core.example.test:8317', key = 'fixture-management-key', offline = false } = {}) {
  const managementOrigin = `http://${offline ? `offline.${host}` : host}`;
  const status = await invoke(page, 'get_core_status');
  if (status.running && status.managed) await invoke(page, 'stop_core_process');
  await invoke(page, 'save_core_connection', { connection: {
    mode: 'remote', managementOrigin, managementKey: key, clientOrigin: 'http://client.example.test:8317', clientKey: 'fixture-client-key',
  } });
  await waitForCoreStatus(page);
  return managementOrigin;
}
async function setLocal(page) {
  await invoke(page, 'save_core_connection', { connection: { mode: 'local', managementOrigin: '', managementKey: '', clientOrigin: '', clientKey: '' } });
  await waitForCoreStatus(page);
}

/* ------------------------------------------------------------ shell widgets */

async function setPrivacy(page, on) {
  const toggle = page.getByTestId('privacy-toggle').first();
  if ((await toggle.getAttribute('aria-pressed')) !== String(on)) await toggle.click();
}

/** At <=720px the sidebar is an off-canvas drawer: opens it through the header hamburger. No-op elsewhere. */
async function openDrawerIfNeeded(page) {
  if (sidebarModeFor(page.viewportSize().width) !== 'drawer') return;
  if (await page.locator('.ec-sidebar.is-open').count()) return;
  await page.locator('.ec-page-menu:visible').first().click();
  await page.locator('.ec-sidebar.is-open').waitFor();
  // Wait for the slide-in transition to land inside the viewport.
  await page.waitForFunction(() => document.querySelector('.ec-sidebar').getBoundingClientRect().left >= -1);
}

async function closeDrawer(page) {
  if (!(await page.locator('.ec-sidebar.is-open').count())) return;
  await page.keyboard.press('Escape');
  await page.locator('.ec-sidebar.is-open').waitFor({ state: 'detached' });
}

/** The appearance button that is currently visible (brand row at full/drawer, footer in the icon rail). */
const appMenuTrigger = (page) => page.locator('.ec-sidebar [aria-haspopup="dialog"]:visible').first();

/** Opens the appearance menu (theme · density · language). Returns the popover locator. */
async function openAppMenu(page) {
  await openDrawerIfNeeded(page);
  const trigger = appMenuTrigger(page);
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  const popover = page.getByRole('dialog').filter({ has: page.getByRole('listbox') }).first();
  await popover.waitFor();
  return popover;
}

const closeAppMenu = async (page) => {
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').filter({ has: page.getByRole('listbox') }).waitFor({ state: 'detached' });
};

async function setLanguage(page, locale) {
  const popover = await openAppMenu(page);
  await popover.getByRole('button', { name: LANGUAGE_LABELS[locale] }).click();
  await page.keyboard.press('Escape');
}

const THEME_INDEX = { dark: 0, light: 1, system: 2 };
const DENSITY_INDEX = { comfortable: 0, compact: 1 };

/** Picks Dark/Light/System in the appearance menu (language independent: radios are positional) and closes it. */
async function setTheme(page, which) {
  const popover = await openAppMenu(page);
  await popover.getByRole('radiogroup').nth(0).getByRole('radio').nth(THEME_INDEX[which]).click();
  await page.keyboard.press('Escape');
}

/** Picks Comfortable/Compact in the appearance menu and closes it. */
async function setDensity(page, which) {
  const popover = await openAppMenu(page);
  await popover.getByRole('radiogroup').nth(1).getByRole('radio').nth(DENSITY_INDEX[which]).click();
  await page.keyboard.press('Escape');
}

/** Documented document-level theme state: { theme, themeId, density, bg (html), appBg (.ec-app), scheme }. */
const themeState = (page) => page.evaluate(() => {
  const root = document.documentElement;
  const app = document.querySelector('.ec-app');
  return {
    theme: root.dataset.theme, themeId: root.dataset.themeId, density: root.dataset.density,
    bg: getComputedStyle(root).backgroundColor, appBg: app ? getComputedStyle(app).backgroundColor : null,
    scheme: getComputedStyle(root).colorScheme, lang: root.lang, dir: root.dir,
  };
});

/* --------------------------------------------------------------- geometry */

/** Bounding box of the first match, or null. */
const box = (locator) => locator.first().boundingBox();

/** Elements (document, body, shell, main) that overflow horizontally; [] means no page-level horizontal scroll. */
const horizontalOverflow = (page) => page.evaluate(() => {
  const nodes = [document.documentElement, document.body, document.querySelector('.ec-app'), document.querySelector('.ec-main')].filter(Boolean);
  return nodes.filter((node) => node.scrollWidth > node.clientWidth + 1)
    .map((node) => ({ element: node.className || node.tagName, client: node.clientWidth, scroll: node.scrollWidth }));
});

/** True when the element is fully inside the viewport and is the hit target at its centre. */
const isReachable = (locator) => locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1) return false;
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return !!hit && element.contains(hit);
});

/* --------------------------------------------------------------- contrast */

/** Effective text and background colours of an element as `#rrggbb` (alpha composited over ancestors). */
const colorsOf = (locator) => locator.evaluate((element) => {
  const canvas = document.createElement('canvas').getContext('2d');
  const parse = (value) => {
    canvas.fillStyle = '#000'; canvas.fillStyle = value;
    const normalized = canvas.fillStyle;
    if (normalized.startsWith('#')) return [parseInt(normalized.slice(1, 3), 16), parseInt(normalized.slice(3, 5), 16), parseInt(normalized.slice(5, 7), 16), 1];
    const parts = normalized.match(/[\d.]+/g).map(Number);
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  };
  const over = (top, under) => top.slice(0, 3).map((channel, index) => channel * top[3] + under[index] * (1 - top[3]));
  let background = [255, 255, 255];
  const stack = [];
  for (let node = element; node; node = node.parentElement) stack.push(getComputedStyle(node).backgroundColor);
  for (const value of stack.reverse()) {
    const color = parse(value);
    if (color[3] > 0) background = over(color, background);
  }
  const text = parse(getComputedStyle(element).color);
  const foreground = over(text, background);
  const hex = (rgb) => `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
  return { fg: hex(foreground), bg: hex(background) };
});

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio between two `#rrggbb` colours. */
const contrastRatio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const rgb = (hex) => `rgb(${[1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;
/** Ember palette values the tests pin (src/ui/tokens.css). */
const EMBER = {
  dark: { bg: rgb('#291e1a'), sidebar: rgb('#39281f'), fg: rgb('#fffaff'), raised: rgb('#433835') },
  light: { bg: rgb('#fbf8f5'), sidebar: rgb('#f3ece6'), fg: rgb('#2b211c'), surface: rgb('#ffffff'), raised: rgb('#f6f1ec') },
};

module.exports = {
  ROOT, LEGACY_PATHS, NAV_ORDER, ALWAYS_AVAILABLE, STORAGE, BREAKPOINTS, EMBER, LANGUAGE_LABELS,
  sidebarModeFor, runUiTest, knownGap, startServer, launchBrowser, playwright,
  openApp, reopenApp, gotoPage, clickNav, currentRoute, pageTitle, settle,
  invoke, emitEvent, waitForCoreStatus, coreLine, coreLineKind, waitForCoreLine, setRemote, setLocal,
  setPrivacy, openDrawerIfNeeded, closeDrawer, appMenuTrigger, openAppMenu, closeAppMenu, setLanguage, setTheme, setDensity, themeState,
  box, horizontalOverflow, isReachable, colorsOf, contrastRatio, rgb,
};
