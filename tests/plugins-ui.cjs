const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Plugins section (#/plugins · #/plugins/store · #/plugins/settings) against the fake-IPC fixture tests/fixtures/plugins.html.
(async () => {
  const base = process.env.AGENT_TEST_URL || 'http://127.0.0.1:1421';
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    const open = async (query = '') => {
      await page.goto(`${base}/tests/fixtures/plugins.html?${query}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { level: 1 }).waitFor();
    };
    const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Installed rows (ul.pl-list > li) and store cards (ul.pl-grid > li) are found by their title.
    const row = title => page.locator('ul.pl-list > li').filter({ has: page.locator('strong').filter({ hasText: new RegExp(`^${escapeRe(title)}$`) }) });
    const rows = () => page.locator('ul.pl-list > li');
    const card = title => page.locator('ul.pl-grid > li').filter({ has: page.locator('strong').filter({ hasText: new RegExp(`^${escapeRe(title)}$`) }) });
    const cards = () => page.locator('ul.pl-grid > li');
    const tab = name => page.getByRole('tab', { name });
    const dialog = () => page.getByRole('dialog');
    const installs = () => page.evaluate(() => window.pluginsFixture.installs);
    const requests = () => page.evaluate(() => window.pluginsFixture.requests);
    const commands = () => page.evaluate(() => window.pluginsFixture.commands);
    const chip = name => page.getByRole('group', { name: 'Filter plugins' }).getByRole('button', { name });
    const refresh = () => page.getByRole('button', { name: 'Refresh', exact: true });
    const sourceFilter = page.getByRole('combobox', { name: 'Store source', exact: true });
    const noMatches = () => page.getByText('No matching plugins', { exact: true });
    const searchbox = () => page.getByRole('searchbox');
    const noOverflow = async () => assert.equal(await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth + 1), true, 'Plugin page must fit the viewport');
    const idle = async () => { await page.waitForFunction(() => !document.querySelector('button[aria-label="Refresh"]')?.disabled); };

    // ---- Installed tab: configured-only and unloaded states, counts --------------------------------------------
    await open();
    await row('Sample provider').getByRole('button', { name: 'Configure · Sample provider', exact: true }).waitFor();
    assert.equal(await rows().count(), 4);
    assert.equal(await tab('Installed 3').getAttribute('aria-selected'), 'true', 'default sub-page is the installed list');
    await chip('Local 3').waitFor();
    await page.getByText('1 active', { exact: true }).waitFor();
    await row('kiro').getByText('Plugin file not found', { exact: true }).waitFor();
    await row('Unloaded provider').getByText('Not loaded', { exact: true }).waitFor();
    assert.equal(await page.getByText('Waiting to load', { exact: true }).count(), 0);
    assert.equal(await row('kiro').getByRole('button', { name: 'Sign in', exact: true }).count(), 0);
    assert.equal(await row('kiro').getByRole('button', { name: 'Uninstall · kiro', exact: true }).count(), 0, 'config-only rows offer configuration removal, not uninstall');
    assert.equal(await row('kiro').getByRole('button', { name: 'Remove configuration · kiro', exact: true }).count(), 1);
    assert.equal(await row('kiro').getByRole('switch').count(), 0, 'a missing plugin file cannot be toggled');
    assert.equal(await row('Unloaded provider').getByRole('button', { name: 'Find in store', exact: true }).count(), 0);
    await row('Unloaded provider').getByRole('button', { name: 'Open logs', exact: true }).click();
    assert.equal((await commands()).some(call => call.command === 'open_core_logs_directory'), true);
    await noOverflow();

    // ---- Search: filtering, empty state, clearing ---------------------------------------------------------------
    const searchInput = searchbox();
    await searchInput.fill('qoder');
    await noMatches().waitFor();
    assert.equal(await rows().count(), 0);
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    assert.equal(await searchInput.inputValue(), '');
    assert.equal(await rows().count(), 4, 'clearing restores the unfiltered list');
    await searchInput.fill('qoder');
    await searchInput.press('Escape');
    assert.equal(await searchInput.inputValue(), '', 'Escape clears the search');
    assert.equal(await rows().count(), 4);

    // ---- Store choice survives ordinary tab navigation; the "Find in store" shortcut must clear it --------------
    await tab(/^Store/).click();
    await sourceFilter.selectOption('community');
    await tab(/^Installed/).click();
    await row('kiro').getByRole('button', { name: 'Find in store', exact: true }).click();
    await card('Kiro').getByRole('button', { name: 'Install', exact: true }).waitFor();
    assert.equal(await tab(/^Store/).getAttribute('aria-selected'), 'true');
    assert.equal(await searchbox().inputValue(), 'kiro');
    assert.equal(await sourceFilter.inputValue(), '');
    assert.equal(await cards().count(), 1);
    await tab(/^Installed/).click();
    await row('kiro').getByRole('button', { name: 'Remove configuration · kiro', exact: true }).click();
    await dialog().getByRole('button', { name: 'Remove configuration', exact: true }).click();
    await row('kiro').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => Object.hasOwn(window.pluginsFixture.settings.configs, 'kiro')), false);
    assert.equal((await requests()).some(request => request.method === 'DELETE' && request.path === '/plugins/kiro'), true);
    await tab('Installed 3').waitFor();
    assert.equal(await page.getByText('Restart the core to fully apply this change.', { exact: true }).count(), 0);

    // ---- Sign-in dialog and plugin resource page ------------------------------------------------------------------
    assert.equal(await row('Dormant provider').getByRole('button', { name: 'Sign in', exact: true }).count(), 0);
    await row('Sample provider').getByRole('button', { name: 'Sign in', exact: true }).click();
    await dialog().getByLabel('Sign-in URL', { exact: true }).waitFor();
    assert.equal((await commands()).some(call => call.command === 'start_oauth_login' && call.args.provider === 'sample-sso' && call.args.pluginProvider === true), true);
    await page.keyboard.press('Escape');
    await dialog().waitFor({ state: 'detached' });

    await row('Sample provider').getByRole('button', { name: 'Usage dashboard' }).click();
    const resourceFrame = page.locator('iframe[title="Usage dashboard"]');
    await page.frameLocator('iframe[title="Usage dashboard"]').getByRole('heading', { name: 'Sample resource preview' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.pluginsFixture.resourceRequests), [{ pluginId: 'sample..plugin', menuIndex: 2 }]);
    assert.equal(await resourceFrame.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal((await resourceFrame.getAttribute('src')).includes('token'), false);
    await page.getByRole('button', { name: 'Back to plugins' }).click();
    await resourceFrame.waitFor({ state: 'detached' });

    // ---- Global switch and per-plugin switch ----------------------------------------------------------------------
    const globalSwitch = page.getByRole('switch', { name: 'Enable plugins', exact: true });
    assert.equal(await globalSwitch.getAttribute('aria-checked'), 'true');
    await globalSwitch.click();
    await page.getByText('Plugins are globally disabled.', { exact: false }).waitFor();
    assert.equal(await globalSwitch.getAttribute('aria-checked'), 'false');
    await row('Sample provider').getByText('Globally disabled', { exact: true }).waitFor();
    assert.equal(await row('Sample provider').getByRole('button', { name: 'Usage dashboard' }).count(), 0);
    assert.equal(await row('Sample provider').getByRole('button', { name: 'Sign in', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.pluginsFixture.settings.configs['sample..plugin'].untouched.retained), true);
    await globalSwitch.click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Enable plugins"]').getAttribute('aria-checked') === 'true');
    await row('Sample provider').getByRole('switch', { name: 'Disable · Sample provider', exact: true }).click();
    await row('Sample provider').getByRole('switch', { name: 'Enable · Sample provider', exact: true }).waitFor();
    assert.equal((await requests()).some(request =>
      request.method === 'PUT' && request.path === '/config/plugins/configs/sample%2E%2Eplugin/enabled' && request.body === false), true);
    await row('Sample provider').getByRole('switch', { name: 'Enable · Sample provider', exact: true }).click();
    await row('Sample provider').getByRole('switch', { name: 'Disable · Sample provider', exact: true }).waitFor();
    await searchbox().fill('does-not-exist');
    await noMatches().waitFor();
    await searchbox().fill('');

    // ---- Store tab: sources, errors, combined filters, refresh --------------------------------------------------------
    await tab(/^Store/).click();
    // The store search ("kiro", set by "Find in store") is kept per tab, so it is still applied here.
    assert.equal(await searchbox().inputValue(), 'kiro');
    await searchbox().fill('');
    await card('Community analytics').getByRole('button', { name: 'Install', exact: true }).waitFor();
    const sourceErrors = page.locator('.pl-source-errors');
    await sourceErrors.getByText('Offline source', { exact: true }).waitFor();
    await sourceErrors.getByText('Fixture registry unavailable', { exact: true }).waitFor();
    assert.equal(await card('Private provider').getByRole('button', { name: 'Store authentication required' }).isDisabled(), true);
    assert.equal(await sourceFilter.inputValue(), '');
    assert.equal(await sourceFilter.locator('option').count(), 8, 'Empty and failed configured sources remain selectable');
    assert.equal(await sourceFilter.locator('option[value="community"]').innerText(), 'Community (community)');
    assert.equal(await sourceFilter.locator('option[value="https://url-only.example.test/plugins.json"]').innerText(), 'Community (https://url-only.example.test/plugins.json)');
    await sourceFilter.selectOption('community');
    assert.equal(await cards().count(), 1);
    await searchbox().fill('sample');
    await noMatches().waitFor();
    await searchbox().fill('analytics');
    assert.equal(await cards().count(), 1);
    await searchbox().fill('');
    await chip(/^Installed/).click();
    assert.equal(await chip(/^Installed/).getAttribute('aria-pressed'), 'true');
    await noMatches().waitFor();
    await sourceFilter.selectOption('official');
    assert.equal(await cards().count(), 1);
    await chip(/^Updates/).click();
    assert.equal(await cards().count(), 1);
    await searchbox().fill('kiro');
    await noMatches().waitFor();
    await searchbox().fill('sample');
    assert.equal(await cards().count(), 1, 'Source, search and update status combine');
    await tab(/^Settings/).click();
    await page.getByLabel('Plugin directory', { exact: true }).waitFor();
    await tab(/^Store/).click();
    assert.equal(await sourceFilter.inputValue(), 'official');
    await refresh().click();
    await idle();
    assert.equal(await sourceFilter.inputValue(), 'official');
    assert.equal(await searchbox().inputValue(), 'sample', 'search and status chip also survive tab changes and refresh');
    assert.equal(await chip(/^Updates/).getAttribute('aria-pressed'), 'true');
    await searchbox().fill('');
    await chip(/^All/).click();
    await sourceFilter.selectOption('https://url-only.example.test/plugins.json');
    await card('URL-only provider').waitFor();
    assert.equal(await cards().count(), 1);
    await sourceFilter.selectOption('offline');
    await noMatches().waitFor();
    await sourceErrors.getByText('Fixture registry unavailable', { exact: true }).waitFor();
    await sourceFilter.selectOption('empty');
    await noMatches().waitFor();
    await page.evaluate(() => { window.pluginsFixture.failNextStore = true; });
    await refresh().click();
    await page.getByRole('alert').filter({ hasText: 'Fixture store temporarily unavailable' }).waitFor();
    assert.equal(await sourceFilter.inputValue(), 'empty', 'Failed refresh preserves source choice');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await noMatches().waitFor();
    assert.equal(await sourceFilter.inputValue(), 'empty');
    await page.evaluate(() => { window.pluginsFixture.sources = window.pluginsFixture.sources.filter(source => source.id !== 'empty'); });
    await refresh().click();
    await page.waitForFunction(() => document.querySelector('select.pl-select').value === '');
    await card('Community analytics').waitFor();
    await chip(/^Updates/).click();
    assert.equal(await cards().count(), 1);
    await chip(/^All/).click();

    // ---- Install dialog: third-party gate, version validation, in-flight lock ------------------------------------------
    await card('Community analytics').getByRole('button', { name: 'Install', exact: true }).click();
    // The label also wraps a "Releases" button, so the input is addressed through its label element.
    const versionField = () => dialog().locator('label', { hasText: 'Version tag (blank for latest)' }).locator('input');
    await versionField().fill('../unsafe');
    assert.equal(await dialog().getByRole('button', { name: 'Install', exact: true }).count(), 0, 'third-party plugins need the review step first');
    await dialog().getByRole('button', { name: 'Understood, review source', exact: true }).click();
    const confirmField = () => dialog().locator('label', { hasText: /^Type the following to confirm installation/ }).locator('input');
    const token = await dialog().locator('.pl-token').innerText();
    assert.ok(token.length > 0, 'the typed token is shown next to the field');
    await confirmField().fill(token);
    assert.equal(await dialog().getByRole('button', { name: 'Install', exact: true }).isDisabled(), true, 'an invalid version tag blocks installation');
    await versionField().fill('v1.2.3');
    await confirmField().fill('wrong');
    assert.equal(await dialog().getByRole('button', { name: 'Install', exact: true }).isDisabled(), true, 'the typed confirmation must match');
    await confirmField().fill(token);
    await page.evaluate(() => { window.pluginsFixture.holdInstall = true; });
    await dialog().getByRole('button', { name: 'Install', exact: true }).click();
    await page.waitForFunction(() => window.pluginsFixture.installs.length === 1);
    await page.keyboard.press('Escape');
    assert.equal(await dialog().count(), 1, 'In-flight installation keeps the dialog open');
    assert.equal(await dialog().getByRole('button', { name: 'Close dialog', exact: true }).count(), 0, 'no close button while installing');
    assert.equal(await dialog().getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
    assert.deepEqual((await installs())[0].query, { source: 'community', version: 'v1.2.3' });
    await page.evaluate(() => { window.pluginsFixture.holdInstall = false; window.pluginsFixture.releaseInstall(); });
    await dialog().waitFor({ state: 'detached' });
    await page.getByText('Restart the core to fully apply this change.', { exact: true }).waitFor();

    // ---- Official update with retry, direct artifacts ------------------------------------------------------------------
    await card('Sample provider').getByRole('button', { name: 'Update', exact: true }).click();
    await versionField().fill('v2.0.0');
    await page.evaluate(() => { window.pluginsFixture.failNextInstall = true; });
    await dialog().getByRole('button', { name: 'Update', exact: true }).click();
    await dialog().getByRole('alert').filter({ hasText: 'Fixture installation failed' }).waitFor();
    await dialog().getByRole('button', { name: 'Update', exact: true }).click();
    await dialog().waitFor({ state: 'detached' });
    assert.equal((await installs()).length, 3, 'Official install retries without a third-party gate');
    await card('Direct artifact').getByRole('button', { name: 'Install', exact: true }).click();
    assert.equal(await dialog().locator('label', { hasText: 'Version tag' }).count(), 0, 'Direct artifacts do not accept GitHub tags');
    await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog().waitFor({ state: 'detached' });

    // ---- Settings tab ------------------------------------------------------------------------------------------------
    await tab(/^Settings/).click();
    assert.equal(new URL(page.url()).hash, '#/plugins/settings');
    const directory = page.getByLabel('Plugin directory', { exact: true });
    const addSource = page.getByLabel('Add source', { exact: true });
    const auth = page.getByLabel('Store authentication rules', { exact: true });
    const save = page.getByRole('button', { name: 'Save', exact: true });
    await directory.fill('custom-plugins');
    await addSource.fill('javascript:alert(1)');
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Enter a valid HTTP(S) URL.' }).waitFor();
    await auth.fill('not json');
    await save.click();
    await page.getByRole('alert').filter({ hasText: 'Enter a directory, valid HTTP(S) source URLs' }).waitFor();
    assert.equal(await page.evaluate(() => window.pluginsFixture.settings.dir), 'plugins', 'invalid input writes nothing');
    await addSource.fill('https://registry.example.test/plugins.json');
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'That source is already listed.' }).waitFor();
    await addSource.fill('https://another.example.test/registry.json');
    await addSource.press('Enter');
    await page.getByRole('button', { name: 'Remove source', exact: true }).nth(1).waitFor();
    await auth.fill('[{"host":"another.example.test","token-env":"PLUGIN_TEST_TOKEN"}]');
    await save.click();
    await page.waitForFunction(() => window.pluginsFixture.settings.dir === 'custom-plugins');
    assert.deepEqual(await page.evaluate(() => window.pluginsFixture.settings['store-sources']),
      ['https://registry.example.test/plugins.json', 'https://another.example.test/registry.json']);
    assert.deepEqual(await page.evaluate(() => window.pluginsFixture.settings['store-auth']),
      [{ host: 'another.example.test', 'token-env': 'PLUGIN_TEST_TOKEN' }]);
    assert.equal(await page.evaluate(() => window.pluginsFixture.settings['auth-revision']), 9);
    assert.equal(await page.evaluate(() => window.pluginsFixture.settings.configs['sample..plugin'].untouched.retained), true);
    await page.getByText('Saved', { exact: true }).waitFor();

    // ---- Local install, development guide, store source details ----------------------------------------------------------
    await tab(/^Installed/).click();
    await page.evaluate(() => { window.pluginsFixture.dialogFile = 'C:\\Downloads\\sample-plugin.dll'; });
    const localInstall = page.getByRole('button', { name: 'Install local plugin', exact: true });
    await localInstall.click();
    await dialog().getByText('sample-plugin.dll', { exact: true }).waitFor();
    await dialog().getByText(/Only install plugins you trust/).waitFor();
    await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await commands()).some(call => call.command === 'install_local_plugin'), false, 'cancelling the trust confirmation installs nothing');
    const pickerCall = (await commands()).find(call => call.command === 'plugin:dialog|open');
    assert.deepEqual(pickerCall.args.options.filters[0].extensions, ['dll', 'so', 'dylib'], 'the picker is limited to plugin libraries');
    await localInstall.click();
    await dialog().getByRole('button', { name: 'Install', exact: true }).click();
    await page.waitForFunction(() => window.pluginsFixture.commands.some(call => call.command === 'install_local_plugin'));
    assert.equal((await commands()).find(call => call.command === 'install_local_plugin').args.source, 'C:\\Downloads\\sample-plugin.dll');
    await page.getByText(/File installed\. Configure and enable it/).waitFor();
    await page.getByRole('button', { name: 'Restart core', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Development guide', exact: true }).click();
    await page.waitForFunction(() => window.pluginsFixture.commands.some(call => call.command === 'open_external_url' && /plugin\/development/.test(call.args.url)));
    await tab(/^Store/).click();
    await card('Community analytics').getByText('Additional store', { exact: true }).waitFor();
    await card('Kiro').getByText('Official store', { exact: true }).waitFor();
    await card('Kiro').getByText(/router-for-me\/kiro/).waitFor();
    await sourceFilter.waitFor();
    await tab(/^Installed/).click();

    // ---- Uninstall and list refresh errors -------------------------------------------------------------------------------
    await tab(/^Installed/).click();
    await row('Dormant provider').getByRole('button', { name: 'Uninstall · Dormant provider' }).click();
    await dialog().getByRole('button', { name: 'Uninstall', exact: true }).click();
    await row('Dormant provider').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => Object.hasOwn(window.pluginsFixture.settings.configs, 'dormant')), false);
    await idle();
    await page.evaluate(() => { window.pluginsFixture.failNextList = true; });
    await refresh().click();
    await page.getByRole('alert').filter({ hasText: 'Fixture list temporarily unavailable' }).waitFor();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Fixture list temporarily unavailable' }).waitFor({ state: 'detached' });

    // ---- Responsive: English / Chinese at four widths ----------------------------------------------------------------------
    for (const locale of ['en', 'zh-CN']) {
      for (const width of [375, 640, 1070, 1368]) {
        await page.setViewportSize({ width, height: 800 });
        await open(`locale=${locale}&theme=${locale === 'en' ? 'light' : 'dark'}`);
        await rows().first().waitFor();
        await tab(locale === 'en' ? /^Installed/ : /^已安装/).waitFor();
        await row('kiro').getByText(locale === 'en' ? 'Plugin file not found' : '未找到插件文件', { exact: true }).waitFor();
        await row('Unloaded provider').getByText(locale === 'en' ? 'Not loaded' : '未加载', { exact: true }).waitFor();
        await tab(locale === 'en' ? 'Installed 3' : '已安装 3').waitFor();
        await noOverflow();
        if (process.env.PLUGIN_SCREENSHOT_DIR) {
          fs.mkdirSync(process.env.PLUGIN_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.PLUGIN_SCREENSHOT_DIR, `plugins-local-${locale}-${width}.png`), fullPage: true });
        }
        await page.getByRole('tab').nth(1).click();
        await card('Community analytics').waitFor();
        await noOverflow();
        if (process.env.PLUGIN_SCREENSHOT_DIR) {
          await page.screenshot({ path: path.join(process.env.PLUGIN_SCREENSHOT_DIR, `plugins-${locale}-${width}.png`), fullPage: true });
        }
        await card('Community analytics').getByRole('button', { name: locale === 'en' ? 'Install' : '安装', exact: true }).click();
        await dialog().waitFor();
        // Exercise wrapping and scrolling with metadata longer than a typical registry entry.
        await dialog().locator('h2').evaluate(el => { el.textContent += ' · model-fallback-router-compatibility'; });
        await page.setViewportSize({ width, height: 480 });
        const layout = await dialog().evaluate(el => {
          const bounds = el.getBoundingClientRect();
          const title = el.querySelector('h2').getBoundingClientRect();
          const buttons = [...el.querySelectorAll('button')].map(button => button.getBoundingClientRect());
          return {
            fits: bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth && el.scrollWidth <= el.clientWidth + 1,
            titleVisible: title.top >= bounds.top - 1 && title.bottom <= bounds.bottom + 1,
            actionsVisible: buttons.every(button => button.top >= 0 && button.bottom <= innerHeight + 1),
          };
        });
        assert.deepEqual(layout, { fits: true, titleVisible: true, actionsVisible: true }, 'Dialog must fit the viewport without overflow');
        const footerButton = dialog().getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true });
        await footerButton.scrollIntoViewIfNeeded();
        assert.equal(await footerButton.isVisible(), true);
        await noOverflow();
        if (process.env.PLUGIN_SCREENSHOT_DIR) {
          await page.screenshot({ path: path.join(process.env.PLUGIN_SCREENSHOT_DIR, `plugins-install-${locale}-${width}.png`) });
        }
        await page.keyboard.press('Escape');
        await dialog().waitFor({ state: 'detached' });
      }
    }
    // ---- Localised, bounded store-source selector ------------------------------------------------------------------------------
    for (const [locale, label, allStores] of [
      ['en', 'Store source', 'All stores'], ['zh-CN', '商店来源', '全部商店'],
      ['zh-TW', '商店來源', '全部商店'], ['ja', 'ストアのソース', 'すべてのストア'],
    ]) {
      for (const width of [375, 700, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await open(`locale=${locale}&sub=store`);
        const select = page.getByRole('combobox', { name: label, exact: true });
        await select.locator('option[value="long"]').waitFor({ state: 'attached' });
        assert.equal(await select.locator('option').first().innerText(), allStores);
        await select.selectOption('long');
        const bounds = await select.boundingBox();
        assert.ok(bounds.width <= 200 && bounds.x + bounds.width <= width, `Long source selector must remain bounded (${locale} ${width}: ${JSON.stringify(bounds)})`);
        await noOverflow();
        if (process.env.PLUGIN_SCREENSHOT_DIR) {
          await page.screenshot({ path: path.join(process.env.PLUGIN_SCREENSHOT_DIR, `plugins-source-${locale}-${width}.png`), fullPage: true });
        }
      }
    }
    // ---- Unsupported cores -------------------------------------------------------------------------------------------------------
    await page.setViewportSize({ width: 1280, height: 900 });
    await open('unsupported');
    await page.getByText('This core does not support plugins', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Open updates', exact: true }).waitFor();
    assert.equal(await page.getByRole('switch', { name: 'Enable plugins' }).count(), 0, 'no plugin controls on an unsupported core');
    assert.equal(await page.evaluate(() => window.pluginsFixture.requests.length), 0, 'Unsupported cores do not receive plugin mutations or list requests');
    assert.deepEqual(errors, []);
    console.log('Plugin UI passed: configured-only and unloaded states, installed counts, store lookup, configuration removal, resources, global/instance switches, combined source/search/status filters, empty/offline stores, refresh retention/reset, localized bounded source selectors, install dialog with third-party review gate, versions, retry, settings, uninstall, unsupported cores, responsive English/Chinese.');
  } finally {
    await browser?.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
