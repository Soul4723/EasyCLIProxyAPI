// Providers → credentials: cooldown display and the "Clear cooldown" flow (confirmation, single auth_index POST, pending
// protection, isolated refresh, failure preservation, stale-read protection, unknown/absent snapshots, elapsed timers).
// Rewritten for the section UI (src/sections/providers/creds). Run like auth-file-list-ui.cjs.
const assert = require('node:assert/strict');
const { startApp, launch, openCreds, requestsOf, rowOf } = require('../../helpers/creds.cjs');

const panel = (page) => page.locator('.ec-side-panel');
const confirmDialog = (page) => page.getByRole('dialog', { name: 'Clear credential cooldown?' });
const status = async (page, text) => (await rowOf(page, text).locator('.ec-pill__text').first().innerText()).trim();
const open = async (page, text) => { await rowOf(page, text).click(); await panel(page).waitFor(); };
const close = async (page) => { await page.keyboard.press('Escape'); await panel(page).waitFor({ state: 'detached' }); };
const resets = (page) => requestsOf(page, 'POST', '/routing/cooldown/reset');
const COOLING = 'mock-codex-cooling';

(async () => {
  const app = await startApp();
  const browser = await launch();
  try {
    const clock = new Date('2026-10-18T04:00:00Z');
    let { page, errors } = await openCreds(browser, app.base, { creds: 'states', clock });

    // ---- what a cooldown looks like -------------------------------------------------------------------------------------------
    assert.equal(await status(page, 'cooling@'), 'Cooldown');
    assert.equal(await status(page, 'wide-cooldown@'), 'Cooldown');
    const wideBefore = await rowOf(page, 'wide-cooldown@').locator('.ec-cred-status__time').innerText();
    assert.match(wideBefore, /^[23]m|^1m|\d+s$/);
    await open(page, 'cooling@');
    const section = panel(page).locator('[data-section=cooldown]');
    const text = await section.innerText();
    for (const expected of ['2 models cooling down', 'gpt-5.2-codex', 'gpt-5.2-mini', 'Quota or rate limit', 'HTTP 429', 'Backoff level 1', 'quota exhausted']) {
      assert.ok(text.includes(expected), `cooldown section mentions "${expected}": ${text}`);
    }
    assert.equal(await section.locator('time').count(), 2, 'every record has its deadline');
    assert.equal(await section.locator('.ec-cred-cooldowns li').count(), 2);
    await close(page);
    await open(page, 'wide-cooldown@');
    const wideText = await panel(page).locator('[data-section=cooldown]').innerText();
    assert.ok(wideText.includes('Credential-wide cooldown') && wideText.includes('Entire credential') && wideText.includes('HTTP 503') && wideText.includes('Temporary upstream error'));
    await close(page);

    // The countdown advances without reloading the list.
    const reads = (await requestsOf(page, 'GET', '/credentials')).length;
    await page.clock.runFor(61_000);
    assert.notEqual(await rowOf(page, 'wide-cooldown@').locator('.ec-cred-status__time').innerText(), wideBefore, 'countdown ticks');
    assert.equal((await requestsOf(page, 'GET', '/credentials')).length, reads, 'ticking does not poll the core');

    // Inapplicable states never offer a reset: absent/unknown snapshots and credentials without an auth index.
    await rowOf(page, 'personal@').locator('button[aria-haspopup=menu]').click();
    assert.equal(await page.getByRole('button', { name: 'Clear cooldown' }).count(), 0, 'no cooldown records, no reset item');
    await page.keyboard.press('Escape');
    await open(page, 'gemini-runtime');
    assert.ok((await panel(page).locator('[data-section=cooldown]').innerText()).includes('This core did not provide cooldown details'));
    assert.equal(await panel(page).getByRole('button', { name: 'Clear cooldown' }).count(), 0);
    await close(page);

    // ---- cancel leaves the backend alone -------------------------------------------------------------------------------------
    await open(page, 'cooling@');
    await panel(page).getByRole('button', { name: 'Clear cooldown' }).click();
    await confirmDialog(page).waitFor();
    assert.ok((await confirmDialog(page).innerText()).includes('codex-cooling_example_test.json'), 'confirmation names the credential');
    assert.equal((await resets(page)).length, 0, 'opening the confirmation sends nothing');
    await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
    assert.equal((await resets(page)).length, 0);
    assert.equal(await panel(page).isVisible(), true, 'the panel (and its draft) comes back after cancelling');
    await close(page);

    // ---- failure keeps the records and allows a retry -------------------------------------------------------------------------
    await page.evaluate(() => window.__creds.failNext.push({ method: 'POST', path: '/routing/cooldown/reset', message: 'Fixture cooldown reset failed' }));
    await open(page, 'cooling@');
    await panel(page).getByRole('button', { name: 'Clear cooldown' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Clear cooldown' }).click();
    await page.getByRole('alert').getByText(/Could not clear cooldown for .*Fixture cooldown reset failed/).waitFor();
    assert.equal(await status(page, 'cooling@'), 'Cooldown', 'a rejected reset keeps the displayed state');
    assert.equal(await panel(page).locator('.ec-cred-cooldowns li').count(), 2);
    assert.equal(await panel(page).getByRole('button', { name: 'Clear cooldown' }).isEnabled(), true, 'failure allows a deliberate retry');
    await close(page);

    // ---- success: single auth_index, pending protection, isolated refresh -----------------------------------------------------
    const releaseReset = await page.evaluate(() => { window.__creds.__release = window.__creds.hold('POST', '/routing/cooldown/reset'); return true; });
    assert.equal(releaseReset, true);
    await open(page, 'cooling@');
    await panel(page).getByRole('button', { name: 'Clear cooldown' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Clear cooldown' }).click();
    const pending = panel(page).getByRole('button', { name: 'Clearing…' });
    await pending.waitFor();
    assert.equal(await pending.isDisabled(), true, 'a pending reset cannot be submitted twice');
    await pending.evaluate((button) => button.click());
    assert.equal((await resets(page)).length, 2, 'one failed + one pending request; the duplicate click sent nothing');
    assert.deepEqual((await resets(page)).map((item) => item.body), [{ auth_index: COOLING }, { auth_index: COOLING }], 'only the selected auth_index, never a model or all-scope');
    assert.equal(await panel(page).locator('.ec-cred-cooldowns li').count(), 2, 'pending request keeps the existing records');
    const siblingBefore = await rowOf(page, 'wide-cooldown@').locator('.ec-cred-status__time').innerText();
    await page.clock.runFor(5_000);
    await page.evaluate(() => window.__creds.__release());
    await page.waitForFunction(() => [...document.querySelectorAll('tr.ec-table__row')].some((row) => row.textContent.includes('cooling@') && !row.textContent.includes('wide') && row.textContent.includes('Available')));
    assert.ok((await page.locator('.ec-cred-toast--success').innerText()).includes('codex-cooling_example_test.json'), 'success names the cleared credential');
    assert.equal(await status(page, 'wide-cooldown@'), 'Cooldown', 'a sibling credential keeps its cooldown');
    assert.notEqual(await rowOf(page, 'wide-cooldown@').locator('.ec-cred-status__time').innerText(), siblingBefore, 'and its timer keeps running');
    assert.ok((await panel(page).locator('[data-section=cooldown]').innerText()).includes('No cooldown records'));
    await close(page);

    // ---- disabled credentials can still clear a stored cooldown ------------------------------------------------------------------
    await page.evaluate(() => {
      window.__creds.mapFiles = (file) => file.name.startsWith('claude-disabled')
        ? { ...file, cooldowns: [{ scope: 'credential', reason: 'quota', retry_at: new Date(Date.now() + 600000).toISOString(), remaining_seconds: 600 }] } : file;
    });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('tr.ec-table__row')].some((row) => row.textContent.includes('disabled@') && row.textContent.includes('Disabled')));
    await open(page, 'disabled@');
    assert.equal(await panel(page).getByRole('button', { name: 'Clear cooldown' }).isEnabled(), true, 'disabled + cooldown: reset stays available');
    assert.equal(await status(page, 'disabled@'), 'Disabled', 'disabled wins over cooldown in the list');
    await close(page);

    // ---- unknown (null) and elapsed snapshots --------------------------------------------------------------------------------------
    await page.evaluate(() => { window.__creds.mapFiles = (file) => (file.name.startsWith('kimi-personal') ? { ...file, cooldowns: null } : file); });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.waitForTimeout(300);
    await open(page, 'personal@');
    assert.ok((await panel(page).locator('[data-section=cooldown]').innerText()).includes('Cooldown state is unknown'));
    assert.equal(await panel(page).getByRole('button', { name: 'Clear cooldown' }).count(), 0, 'unknown state is never resettable');
    await close(page);
    await page.evaluate(() => { window.__creds.mapFiles = null; });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.waitForTimeout(300);
    const wide = await status(page, 'wide-cooldown@');
    if (wide === 'Cooldown') {
      await page.clock.runFor(4 * 60_000);
      await page.waitForFunction(() => [...document.querySelectorAll('tr.ec-table__row')].some((row) => row.textContent.includes('wide-cooldown@') && row.textContent.includes('Available')));
    }
    await open(page, 'wide-cooldown@');
    const elapsed = await panel(page).locator('[data-section=cooldown]').innerText();
    assert.ok(elapsed.includes('Elapsed · confirmation needed') && elapsed.includes('Refresh the list to confirm'), 'an elapsed timer is shown but never claimed as confirmed availability');
    assert.equal(await panel(page).getByRole('button', { name: 'Clear cooldown' }).isEnabled(), true, 'elapsed records stay explicitly resettable');
    await close(page);
    assert.deepEqual(errors, []);
    await page.close();

    // ---- a read that started before the reset cannot bring the cooldown back ---------------------------------------------------------
    ({ page, errors } = await openCreds(browser, app.base, { creds: 'states', clock }));
    await page.evaluate(() => { window.__creds.__releaseRead = window.__creds.hold('GET', '/credentials', 'after'); });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.waitForTimeout(200);
    await open(page, 'cooling@');
    await panel(page).getByRole('button', { name: 'Clear cooldown' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Clear cooldown' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('tr.ec-table__row')].some((row) => row.textContent.includes('cooling@') && !row.textContent.includes('wide') && row.textContent.includes('Available')));
    await page.evaluate(() => window.__creds.__releaseRead());
    await page.clock.runFor(1000);
    assert.equal(await status(page, 'cooling@'), 'Available', 'the stale list response is discarded');
    assert.deepEqual(errors, []);
    await page.close();

    // ---- layout of the cooldown content in both themes and at the three widths ---------------------------------------------------------
    for (const theme of ['dark', 'light']) {
      for (const width of [1440, 1024, 680]) {
        ({ page } = await openCreds(browser, app.base, { creds: 'states', width, theme }));
        await open(page, 'cooling@');
        const sizes = await panel(page).evaluate((element) => ({ panel: element.scrollWidth - element.clientWidth, list: element.querySelector('.ec-cred-cooldowns').scrollWidth - element.querySelector('.ec-cred-cooldowns').clientWidth }));
        assert.ok(sizes.panel <= 1 && sizes.list <= 1, `${theme} ${width}: ${JSON.stringify(sizes)}`);
        await page.close();
      }
    }
    console.log('PASS: cooldown records/reasons/countdown, confirm + cancel, single auth_index POST, pending duplicate protection, failure retry, isolated success refresh, disabled/runtime/unknown/absent/elapsed states, stale-read protection, layout.');
  } finally {
    await browser.close();
    await app.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
