// Shared helpers for UI tests against the cohesive shell (src/shell). DOM contract:
//   root .ec-app (bare/full-screen pages add .ec-app--bare) · sidebar aside.ec-sidebar · nav a.ec-nav-item[data-nav=<routeId>]
//   (locked pages are button.ec-nav-item.is-locked[data-nav]) · header .ec-page-header h1.ec-page-title
//   privacy eye [data-testid=privacy-toggle] (aria-pressed) · footer core line a.ec-core-line[data-core-status]
//   appearance/language popover opened by the button labelled shell.appearance (aria-haspopup=dialog)
// Routes are hash routes; OLD page ids map to new paths below so old tests can keep their intent.
const LEGACY_PATHS = {
  home: '/overview', easy: '/easy', api: '/providers/api', oauth: '/providers/oauth', quota: '/quota',
  agents: '/agents', 'usage-records': '/usage', plugins: '/plugins', config: '/settings', versions: '/settings/updates',
};
const LANGUAGE_LABELS = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', en: 'English' };

const pathFor = (pageOrPath) => (pageOrPath.startsWith('/') ? pageOrPath : LEGACY_PATHS[pageOrPath] ?? `/${pageOrPath}`);

/** Opens `base?mock=<scenario>#/path` and waits for the shell. `page` may be an old id ('usage-records') or '/usage/requests'. */
async function openApp(page, base, { mock = 'running', path = '/overview', query = '' } = {}) {
  const url = new URL(base);
  url.searchParams.set('mock', mock);
  for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value);
  url.hash = pathFor(path);
  await page.goto(url.toString(), { waitUntil: 'commit' });
  await page.locator('.ec-app').waitFor();
}

/** In-app navigation (hash change). Accepts old ids or paths. */
async function gotoPage(page, pageOrPath) {
  const target = pathFor(pageOrPath);
  await page.evaluate((hash) => { window.location.hash = hash; }, target);
  await page.waitForFunction((hash) => window.location.hash.startsWith(`#${hash.split('?')[0]}`), target);
}

/** Clicks the sidebar link for a route id (overview, providers, quota, usage, agents, plugins, settings). */
async function clickNav(page, routeId) {
  await page.locator(`.ec-nav a[data-nav="${routeId}"]`).click();
}

const currentRoute = (page) => page.evaluate(() => window.location.hash.replace(/^#/, ''));

async function setPrivacy(page, on) {
  const toggle = page.getByTestId('privacy-toggle');
  if ((await toggle.getAttribute('aria-pressed')) !== String(on)) await toggle.click();
}

/** Opens the appearance menu (theme · density · language). Returns the popover locator. */
async function openAppMenu(page) {
  const trigger = page.locator('.ec-sidebar [aria-haspopup="dialog"]:visible').first();
  await trigger.click();
  const popover = page.getByRole('dialog').filter({ has: page.getByRole('listbox') }).first();
  await popover.waitFor();
  return popover;
}

async function setLanguage(page, locale) {
  const popover = await openAppMenu(page);
  await popover.getByRole('button', { name: LANGUAGE_LABELS[locale] }).click();
  await page.keyboard.press('Escape');
}

async function setTheme(page, which) {
  const popover = await openAppMenu(page);
  await popover.getByRole('button', { name: /Ember|系统|システム|System|跟随|跟隨|深色|浅色|ダーク|ライト/ }).filter({ hasText: which === 'dark' ? /Dark|深色|ダーク/ : which === 'light' ? /Light|浅色|ライト/ : /System|跟随|跟隨|システム/ }).first().click();
  await page.keyboard.press('Escape');
}

module.exports = { LEGACY_PATHS, openApp, gotoPage, clickNav, currentRoute, setPrivacy, openAppMenu, setLanguage, setTheme };
