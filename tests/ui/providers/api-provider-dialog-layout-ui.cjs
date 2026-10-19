const assert = require('node:assert/strict');
const { startFixtureServer, launchBrowser, openPage, selectors } = require('../../helpers/apiFixture.cjs');

// #321: the add/edit dialog fits small windows, escapes page containment (portal + fixed layer), scrolls long forms inside
// the dialog, keeps focus inside nested dialogs, and saves edits. Drives the real ApiProviderForm through the controller
// (fixture: tests/fixtures/provider-duplicates.tsx).
(async () => {
  const { server, base } = await startFixtureServer(['tests/fixtures/provider-duplicates.html']);
  let browser;
  try {
    browser = await launchBrowser();
    const { page, errors } = await openPage(browser, base, { width: 1280, height: 800 });
    await page.goto(`${base}/tests/fixtures/provider-duplicates.html?brand=claude`, { waitUntil: 'domcontentloaded' });
    await page.locator(selectors.row).waitFor();
    await page.evaluate(() => {
      window.providerFixture.records[0].models = Array.from({ length: 30 }, (_, index) => ({ name: `model-${index}` }));
    });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator(selectors.row).getByRole('button', { name: 'Edit', exact: true }).click();
    const form = page.getByRole('dialog', { name: /^Edit API Key/ });
    assert.equal(await form.locator('.ec-api-model__row').count(), 30);
    assert.equal(await form.getByLabel('API Key', { exact: true }).count(), 1);
    assert.equal(await form.locator('.ec-api-key').count(), 0);
    assert.equal(await form.getByText(/shared settings|inherit shared|One group connects/i).count(), 0);
    assert.equal(await form.getByLabel('Group Name', { exact: true }).count(), 0);
    assert.equal(await form.getByLabel('Key for Model Discovery', { exact: true }).count(), 0);
    // Visible, single-line error and the two model actions are always on screen.
    assert.equal(await form.getByRole('button', { name: 'Fetch Models', exact: true }).isVisible(), true);
    assert.equal(await form.getByRole('button', { name: 'Check', exact: true }).isVisible(), true);

    // Older WebKit makes an inline-size query container a fixed-position containing block.
    // Explicit layout containment reproduces that behavior on current browser engines.
    await page.addStyleTag({ content: '#root, main { contain: layout; min-height: 1400px; }' });

    const assertViewportOverlay = async (locator) => {
      const bounds = await locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      const viewport = page.viewportSize();
      assert.deepEqual(bounds, { x: 0, y: 0, ...viewport }, 'dialog layer must cover the viewport independently of page containment');
    };
    const layer = page.locator('.ec-dialog-layer');
    const assertDialogControls = async (dialog) => {
      const bounds = await dialog.boundingBox();
      const viewport = page.viewportSize();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1
        && bounds.y + bounds.height <= viewport.height + 1, 'Dialog must fit inside the window');
      for (const button of ['Close dialog', 'Cancel', 'Save']) {
        const control = dialog.getByRole('button', { name: button, exact: true });
        const visible = await control.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight
            && element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        });
        assert.equal(visible, true, `${button} must remain visible and unobstructed`);
      }
      const dimensions = await dialog.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
      assert.ok(dimensions.scroll <= dimensions.client + 1, 'Dialog must not overflow horizontally');
    };

    for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 600 }, { width: 640, height: 600 }, { width: 390, height: 700 }]) {
      await page.setViewportSize(viewport);
      await assertViewportOverlay(layer.first());
      await assertDialogControls(form);
      const modelOptions = form.locator('.ec-api-model details.ec-api-disclosure').first();
      await modelOptions.locator(':scope > summary').click();
      // Exercise the real model controls with CJK text and larger font metrics: label/control tracks must never
      // overlap and the select must keep enough content height.
      for (const fontSize of [14, 24]) {
        const layout = await modelOptions.evaluate((element, size) => {
          return [...element.querySelectorAll('.ec-api-field:has(select)')].map(label => {
            const caption = label.querySelector('.ec-api-field__label');
            const select = label.querySelector('select');
            caption.style.fontSize = `${size}px`;
            caption.textContent = '启用上游兼容模式 / Upstream compatibility';
            select.options[0].textContent = '继承 / 默认';
            const style = getComputedStyle(select);
            const probe = document.createElement('span');
            probe.style.cssText = 'position: absolute; white-space: nowrap;';
            probe.style.font = style.font;
            probe.textContent = select.selectedOptions[0].textContent;
            document.body.append(probe);
            const textHeight = probe.getBoundingClientRect().height;
            probe.remove();
            return {
              overlap: caption.getBoundingClientRect().bottom > select.getBoundingClientRect().top + 1,
              contentHeight: select.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
              textHeight,
            };
          });
        }, fontSize);
        assert.ok(layout.length > 0 && layout.every(field => !field.overlap && field.contentHeight >= field.textHeight),
          `Model labels and select text must fit at ${fontSize}px in a ${viewport.width}px window: ${JSON.stringify(layout)}`);
      }
      await modelOptions.evaluate(element => element.querySelectorAll('.ec-api-field__label').forEach(caption => caption.style.removeProperty('font-size')));
      const compatibility = modelOptions.locator('select').first();
      for (const value of ['true', 'false', '']) {
        await compatibility.selectOption(value);
        assert.equal(await compatibility.inputValue(), value, 'Tri-state selection must remain usable');
      }
      await modelOptions.locator(':scope > summary').click();
      await form.getByLabel('Remark', { exact: true }).fill('Small-window edit');
      await form.locator(selectors.advancedSummary).click();
      const headers = form.getByRole('textbox', { name: /Custom Headers/ });
      await headers.fill('X-Layout-Test: reachable');
      const fieldLayout = await form.locator('.ec-api-advanced .ec-api-field--wide').evaluateAll((fields) => fields.map((field) => {
        const bounds = field.getBoundingClientRect();
        const controls = [...field.children].map((child) => child.getBoundingClientRect());
        return controls.every((control, index) => control.top >= bounds.top - 1
          && control.bottom <= bounds.bottom + 1
          && (index === 0 || control.top >= controls[index - 1].bottom - 1));
      }));
      assert.ok(fieldLayout.length > 0 && fieldLayout.every(Boolean), 'Multiline labels, controls and hints must fit their fields without overlapping');
      await form.getByRole('combobox', { name: 'Disable Cooldown', exact: true }).selectOption('false');
      await form.getByRole('combobox', { name: 'Cache User ID', exact: true }).selectOption('false');
      await assertDialogControls(form);
      const scroll = await form.locator('.ec-dialog__body').evaluate((element) => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }));
      assert.ok(scroll.top > 0 && scroll.max > 0, 'Advanced settings must be reachable by scrolling inside the dialog');
      await form.locator(selectors.advancedSummary).click();
    }

    await form.getByRole('button', { name: 'Fetch Models', exact: true }).click();
    const models = page.getByRole('dialog', { name: /^Select Models/ });
    await models.waitFor();
    await assertViewportOverlay(layer.last());
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await models.evaluate((element) => element.contains(document.activeElement)), true);
    }
    await page.keyboard.press('Escape');
    await models.waitFor({ state: 'detached' });
    assert.equal(await form.getByRole('button', { name: 'Fetch Models', exact: true }).evaluate((element) => element === document.activeElement), true);
    await assertDialogControls(form);
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await form.waitFor({ state: 'detached' });
    const record = await page.evaluate(() => window.providerFixture.records[0]);
    assert.equal(record.keys[0].headers['X-Layout-Test'], 'reachable');
    assert.equal(record.models.length, 30);
    assert.equal(record.keys[0]['disable-cooling'], false);
    assert.equal(record.keys[0].cloak['cache-user-id'], false);
    assert.equal(await page.evaluate(() => document.body.style.overflow), '');

    await page.locator(selectors.row).getByRole('button', { name: 'Edit', exact: true }).click();
    await form.locator(selectors.advancedSummary).click();
    for (const name of ['Disable Cooldown', 'Cache User ID']) {
      const control = form.getByRole('combobox', { name, exact: true });
      assert.equal(await control.inputValue(), 'false');
      await control.selectOption('');
    }
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await form.waitFor({ state: 'detached' });
    const inherited = await page.evaluate(() => window.providerFixture.records[0]);
    assert.equal(inherited.keys[0]['disable-cooling'], undefined);
    assert.equal(inherited.keys[0].cloak?.['cache-user-id'], undefined);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('group', { name: 'Brand' }).getByRole('button', { name: /^OpenAI/ }).click();
    await page.getByRole('button', { name: 'Add Service', exact: true }).first().click();
    const add = page.getByRole('dialog', { name: /^Add Service/ });
    await assertViewportOverlay(layer.first());
    await assertDialogControls(add);
    await add.locator(selectors.advancedSummary).click();
    assert.equal(await add.getByLabel('Test Model', { exact: true }).count(), 0);
    await add.getByRole('button', { name: 'Cancel', exact: true }).click();
    await add.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    console.log('PASS: #321 provider dialogs fit small windows, escape page containment, scroll long forms, preserve nested focus, and save edits.');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
