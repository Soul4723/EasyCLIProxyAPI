const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('./ui-harness.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdirSync } = require('node:fs');

const screenshots = path.resolve(__dirname, '..', 'output', 'playwright');
mkdirSync(screenshots, { recursive: true });

runUi(async ({ base }) => {
  let browser;
  try {
    browser = await launchBrowser(chromium, { args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    const externalRequests = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await page.goto(`${base}/tests/fixtures/agent-backups.html?sessions&locale=en`);
    await page.locator('.ses-page').waitFor();

    const calls = command => page.evaluate(name => window.fixtureCalls.filter(call => call.cmd === name).map(call => call.args), command);
    const contextReads = async () => (await calls('get_codex_session_context')).map(args => args.request.sessionId);
    const setLocale = async locale => {
      await page.evaluate(next => window.fixtureSetLocale(next), locale);
      await page.waitForFunction(next => document.documentElement.lang === next, locale);
    };
    const panel = page.getByRole('dialog');
    const messageCards = panel.locator('.ses-msg:not(.ses-msg--new)');
    const successNotice = panel.locator('.ses-notice--success');
    const saveButton = panel.getByRole('button', { name: 'Save Changes', exact: true });
    const openEditor = async () => {
      await page.getByRole('button', { name: 'Edit Context (Experimental)', exact: true }).first().click();
      await panel.locator('.ses-msg').first().waitFor();
    };
    const requestNavigation = () => page.evaluate(() => {
      window.fixtureNavigated = false;
      window.dispatchEvent(new CustomEvent('cpa-gui-navigation-request', { cancelable: true, detail: () => { window.fixtureNavigated = true; } }));
    });

    // The edit-context entry is localized (accessible name + tooltip) and a language switch needs no reload.
    for (const [locale, title] of [
      ['en', 'Edit Context (Experimental)'],
      ['zh-CN', '编辑上下文 (实验性)'],
      ['ja', 'コンテキスト編集 (実験的)'],
    ]) {
      await setLocale(locale);
      await page.getByRole('button', { name: title, exact: true }).first().waitFor();
      assert.equal(await page.getByRole('button', { name: title, exact: true }).first().getAttribute('title'), title);
    }
    await setLocale('en');

    // No preloading: listing and refreshing never read a rollout; opening the editor reads exactly the target once.
    assert.deepEqual(await contextReads(), []);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Context (Experimental)', exact: true }).first().waitFor();
    assert.deepEqual(await contextReads(), []);
    await openEditor();
    assert.equal((await contextReads()).length, 1);
    assert.equal(await panel.getByRole('button', { name: 'Toggle session metadata', exact: true }).getAttribute('aria-expanded'), 'false');
    assert.equal(await panel.getByLabel('Session Title', { exact: true }).count(), 0);
    assert.equal(await panel.locator('.ec-filters').first().locator('.ec-filters__chip').count(), 5);
    await page.screenshot({ path: path.join(screenshots, 'codex-context-collapsed.png'), fullPage: true, animations: 'disabled' });

    // Tool rows can only be removed; user rows can be edited.
    const userCard = panel.locator('.ses-msg--user').first();
    const toolCard = panel.locator('.ses-msg--tool').first();
    await userCard.waitFor();
    assert.equal(await toolCard.getByRole('button', { name: 'Edit', exact: true }).count(), 0);
    assert.equal(await userCard.getByRole('button', { name: 'Edit', exact: true }).count(), 1);

    // An unsaved edit survives the discard prompt (Keep editing), the close button and a language switch.
    await userCard.getByRole('button', { name: 'Edit', exact: true }).click();
    const userText = userCard.locator('textarea');
    await userText.fill('Mock persistence check');
    await requestNavigation();
    await panel.getByRole('alertdialog').waitFor();
    assert.equal(await page.evaluate(() => window.fixtureNavigated), false);
    await panel.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click();
    assert.equal(await panel.getByRole('alertdialog').count(), 0);
    assert.equal(await userText.inputValue(), 'Mock persistence check');
    await page.keyboard.press('Escape');
    await panel.getByRole('alertdialog').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await panel.getByRole('alertdialog').count(), 0);
    assert.equal(await userText.inputValue(), 'Mock persistence check');
    await setLocale('zh-CN');
    assert.equal(await userText.inputValue(), 'Mock persistence check');
    await setLocale('en');
    assert.equal(await userText.inputValue(), 'Mock persistence check');
    await saveButton.click();
    await successNotice.waitFor();

    // Close and reopen: the saved text is read back from the (stateful) rollout.
    await page.locator('.ec-side-panel__actions button').last().click();
    await panel.waitFor({ state: 'hidden' });
    await openEditor();
    await panel.locator('.ses-msg--user', { hasText: 'Mock persistence check' }).waitFor();

    // Metadata is hidden by default; the raw JSONL is never edited inline.
    assert.equal(await panel.locator('textarea.raw-jsonl-textarea, textarea[aria-label*="JSONL"]').count(), 0);
    await panel.getByRole('button', { name: 'Toggle session metadata', exact: true }).click();
    const sessionId = (await page.evaluate(() => window.fixtureSessionIds))[0];
    assert.ok((await contextReads()).every(id => id === sessionId));
    assert.equal(await panel.locator('.ec-side-panel__subtitle').getByText(sessionId, { exact: false }).count() > 0, true);

    // Open the rollout in the local app: success, failure notice, then blocked while there are unsaved edits.
    const openRaw = panel.getByRole('button', { name: 'Open rollout file', exact: true });
    await openRaw.click();
    await page.waitForFunction(() => window.fixtureCalls.filter(call => call.cmd === 'open_codex_session_rollout').length === 1);
    assert.deepEqual(await calls('open_codex_session_rollout'), [{ request: { sessionId } }]);
    await page.evaluate(() => { window.fixtureFailRolloutOpen = true; });
    await openRaw.click();
    await panel.locator('.ses-notice--error', { hasText: 'No default application is configured' }).waitFor();
    assert.equal(await openRaw.isEnabled(), true);
    await page.evaluate(() => { window.fixtureFailRolloutOpen = false; });
    assert.equal(await saveButton.isEnabled(), false);
    await panel.getByLabel('Session Title', { exact: true }).fill('Structured metadata title');
    assert.equal(await openRaw.isEnabled(), false);
    await saveButton.click();
    await successNotice.waitFor();
    assert.equal(await openRaw.isEnabled(), true);

    // Removing a tool record is staged, then Ctrl+S saves it.
    await panel.locator('.ses-msg--tool').first().getByRole('button', { name: 'Remove Message', exact: true }).click();
    assert.equal(await panel.locator('.ses-msg--tool.ses-msg--deleted').count(), 1);
    await page.keyboard.press('Control+s');
    await successNotice.waitFor();
    assert.equal(await panel.locator('.ses-msg--tool').count(), 0);

    // An unstaged draft in the add-message box blocks closing and can still be saved.
    await panel.getByRole('button', { name: 'Add Message', exact: true }).click();
    await panel.getByLabel('Message Text', { exact: true }).fill('Unstaged draft can be saved');
    await page.locator('.ec-side-panel__actions button').last().click();
    await panel.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click();
    await page.keyboard.press('Control+s');
    await successNotice.waitFor();
    await panel.locator('.ses-msg--user', { hasText: 'Unstaged draft can be saved' }).waitFor();

    // A session can be emptied and then receive a new message.
    for (const message of await messageCards.all()) {
      await message.getByRole('button', { name: 'Remove Message', exact: true }).click();
    }
    await saveButton.click();
    await successNotice.waitFor();
    assert.equal(await messageCards.count(), 0);
    await panel.getByRole('button', { name: 'Add Message', exact: true }).click();
    await panel.getByLabel('Message Text', { exact: true }).fill('Add to an empty session');
    await saveButton.click();
    await successNotice.waitFor();
    await panel.locator('.ses-msg--user', { hasText: 'Add to an empty session' }).waitFor();

    // Both themes render an opaque editor surface; the editor never overflows horizontally.
    const surfaces = {};
    for (const theme of ['dark', 'light']) {
      await page.evaluate(next => { document.documentElement.dataset.theme = next; }, theme);
      surfaces[theme] = await panel.locator('.ses-msg').first().evaluate(card => getComputedStyle(card).backgroundColor);
      assert.ok(!/rgba\(.*, 0\)$/.test(surfaces[theme]) && surfaces[theme] !== 'transparent', `${theme} message surface must be opaque`);
      await page.screenshot({ path: path.join(screenshots, `codex-session-context-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
    assert.notEqual(surfaces.dark, surfaces.light);
    for (const width of [900, 640]) {
      await page.setViewportSize({ width, height: 1100 });
      const fits = await panel.evaluate(editor => {
        const body = editor.querySelector('.ec-side-panel__body');
        return editor.scrollWidth <= editor.clientWidth && body.scrollWidth <= body.clientWidth;
      });
      assert.ok(fits, `Context editor overflows at ${width}px`);
    }
    await page.setViewportSize({ width: 1600, height: 1100 });

    // Navigating away with unsaved edits asks first; Discard lets the navigation proceed.
    await panel.getByLabel('Session Title', { exact: true }).fill('Discarded title');
    await requestNavigation();
    await panel.getByRole('alertdialog').getByRole('button', { name: 'Discard', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixtureNavigated), true);
    // The fixture has no shell to unmount the page, so close the still-dirty editor and discard again.
    await page.locator('.ec-side-panel__actions button').last().click();
    await panel.getByRole('alertdialog').getByRole('button', { name: 'Discard', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });

    // Big transcripts: every card is complete (header/body not clipped) at both widths for every role filter,
    // and the last card can be scrolled to.
    await page.evaluate(() => { window.fixtureSessionMessageCount = 43; });
    await openEditor();
    for (const count of [43, 1000]) {
      await page.evaluate(next => { window.fixtureSessionMessageCount = next; }, count);
      await panel.getByRole('button', { name: 'Reload', exact: true }).click();
      await page.waitForFunction(next => document.querySelectorAll('.ec-side-panel .ses-msg').length === next, count);
      for (const width of [1600, 640]) {
        await page.setViewportSize({ width, height: 800 });
        for (const [index, role] of ['all', 'user', 'assistant', 'reasoning', 'tool'].entries()) {
          await panel.locator('.ec-filters').first().locator('.ec-filters__chip').nth(index).click();
          const clipped = await panel.locator('.ses-msg').evaluateAll(cards => cards.filter(card => {
            const bottom = card.getBoundingClientRect().bottom;
            return ['.ses-msg-head', '.ses-msg-body'].some(selector =>
              card.querySelector(selector).getBoundingClientRect().bottom > bottom + 0.5);
          }).length);
          assert.equal(clipped, 0, `Clipped ${role} cards with ${count} messages at ${width}px`);
        }
      }
      await panel.locator('.ec-filters').first().locator('.ec-filters__chip').first().click();
      const lastCardFits = await panel.locator('.ses-msg').last().evaluate(async last => {
        const body = document.querySelector('.ec-side-panel__body');
        body.scrollTop = body.scrollHeight;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const bounds = body.getBoundingClientRect();
        const rect = last.getBoundingClientRect();
        return rect.top >= bounds.top && rect.top < bounds.bottom;
      });
      assert.ok(lastCardFits, 'The last message must be reachable by scrolling');
    }
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await setLocale('zh-CN');
    await panel.locator('.ec-filters').first().locator('.ec-filters__chip').nth(2).click();
    await page.screenshot({ path: path.join(screenshots, 'codex-context-many-messages-fixed.png'), animations: 'disabled' });

    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    console.log('PASS: No context preloading; one target read on entry; collapsed metadata; saves, draft guards, themes and unclipped 43/1000-message lists.');
  } finally { await browser?.close(); }
}, { url: process.env.AGENT_TEST_URL });
