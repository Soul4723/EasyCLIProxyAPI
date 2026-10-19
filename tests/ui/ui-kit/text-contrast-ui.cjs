// Text contrast audit against the real app (browser mock, `?mock=running`): Overview, Quota, Usage overview + requests and
// Settings in Ember Dark and Ember Light, plus a placeholder probe. Every Ember gray text role must reach WCAG AA (4.5:1).
// node tests/ui/ui-kit/text-contrast-ui.cjs (needs PLAYWRIGHT_MODULE; starts its own vite). CONTRAST_SCREENSHOT_DIR saves screenshots.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launchBrowser, runUi } = require('../../helpers/ui-harness.cjs');
const { openApp, gotoPage, setTheme, setDensity, settle, waitForCoreStatus } = require('../../helpers/shell.cjs');

async function audit(page, scope, label) {
  const result = await page.evaluate(scope => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = value => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const flatten = (foreground, background, opacity = 1) => {
      const alpha = foreground[3] / 255 * opacity;
      return foreground.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha));
    };
    const luminance = rgb => {
      const linear = rgb.map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
    const root = getComputedStyle(document.documentElement);
    // The Ember text roles; coloured status/accent text is audited by its own tokens elsewhere.
    const grayColors = new Set(['fg', 'fg-2', 'fg-muted', 'fg-subtle']
      .map(role => rgba(root.getPropertyValue(`--ec-${role}`)).join(',')));
    const failures = [];
    let samples = 0;
    const check = (element, pseudo) => {
      if (element.closest(':disabled, [aria-disabled="true"], .locked, .disabled, .is-disabled')) return;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element, pseudo);
      if (!rect.width || !rect.height || style.visibility !== 'visible' || style.display === 'none') return;
      if (!pseudo && !Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) return;
      // Decorative empty-value marks (a lone dash or dot) carry no information.
      if (!pseudo && /^[\s—–·•-]+$/.test(element.textContent)) return;
      const foreground = rgba(style.color);
      if (!grayColors.has(foreground.join(','))) return;
      const ancestors = [];
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) ancestors.unshift(ancestor);
      let background = [255, 255, 255];
      let opacity = pseudo ? Number(style.opacity) : 1;
      for (const ancestor of ancestors) {
        const computed = getComputedStyle(ancestor);
        background = flatten(rgba(computed.backgroundColor), background);
        opacity *= Number(computed.opacity);
      }
      if (!opacity) return;
      const ratio = contrast(flatten(foreground, background, opacity), background);
      samples += 1;
      if (ratio < 4.5) failures.push({
        element: `${element.tagName}.${element.className}${pseudo || ''}`,
        text: (pseudo ? element.getAttribute('placeholder') : element.textContent).trim().slice(0, 80),
        ratio: Number(ratio.toFixed(3)), color: style.color, background,
      });
    };
    for (const element of document.querySelectorAll(`${scope}, ${scope} *`)) {
      check(element);
      if (element.matches('input[placeholder], textarea[placeholder]')) check(element, '::placeholder');
    }
    return { samples, failures };
  }, scope);
  assert.ok(result.samples > 0, `${label}: no text checked`);
  assert.deepEqual(result.failures, [], `${label}: low-contrast text`);
  console.log(`${label}: ${result.samples} text samples passed`);
}

const PAGES = [
  ['overview', '/overview', '[data-testid=overview-page]'],
  ['quota', '/quota', '.qt-card'],
  ['usage overview', '/usage', '.ec-page-body'],
  ['usage requests', '/usage/requests', '.req-table tbody tr'],
  ['settings', '/settings/connection', '.ec-set-content'],
];

runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(base + '/') || route.request().url().startsWith('data:') ? route.continue() : route.abort());
    const screenshot = async name => {
      if (!process.env.CONTRAST_SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.CONTRAST_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.CONTRAST_SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' });
    };

    await openApp(page, base, { path: '/overview' });
    await waitForCoreStatus(page);
    for (const theme of ['dark', 'light']) {
      await setTheme(page, theme);
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      for (const [label, route, ready] of PAGES) {
        await gotoPage(page, route);
        await page.locator(ready).first().waitFor();
        await settle(page);
        await audit(page, '.ec-app', `${theme} ${label}`);
        await screenshot(`${label.replace(/ /g, '-')}-${theme}`);
      }

      // Compact density keeps the same contrast (it only changes sizes).
      await setDensity(page, 'compact');
      await gotoPage(page, '/quota');
      await page.locator('.qt-card, .qt-row').first().waitFor();
      await audit(page, '.ec-app', `${theme} quota compact`);
      await setDensity(page, 'comfortable');

      // Placeholder probe: the real search field plus generic controls inside a page body.
      await gotoPage(page, '/quota');
      await page.locator('.ec-page-body input[placeholder]').first().waitFor();
      await page.evaluate(() => {
        const section = document.createElement('section');
        section.id = 'placeholder-probes';
        section.style.cssText = 'padding:16px;background:var(--ec-surface)';
        section.innerHTML = '<input placeholder="Generic input"><textarea placeholder="Generic textarea"></textarea>';
        document.querySelector('.ec-page-body').append(section);
      });
      await audit(page, '#placeholder-probes', `${theme} generic placeholders`);
      await audit(page, '.ec-page-body', `${theme} quota search placeholder`);
      for (const input of await page.locator('.ec-page-body input[placeholder], #placeholder-probes textarea').all()) {
        assert.equal(await input.evaluate(element => getComputedStyle(element, '::placeholder').opacity), '1', 'placeholders are not faded further');
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: Ember Dark/Light contrast on Overview, Quota (comfortable + compact), Usage overview/requests, Settings and placeholders.');
  } finally {
    await browser.close();
  }
});
