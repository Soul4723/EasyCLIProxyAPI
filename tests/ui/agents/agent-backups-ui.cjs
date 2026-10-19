// AGENT_TEST_URL=http://127.0.0.1:5391 node tests/ui/agents/agent-backups-ui.cjs
// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchBrowser, runUi } = require('../../helpers/ui-harness.cjs');
const assert = require('node:assert/strict');
const os = require('node:os');
runUi(async ({ base }) => {
  const browser = await launchBrowser(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    const calls = cmd => page.evaluate(cmd => window.fixtureCalls.filter(c => c.cmd === cmd), cmd);
    const tab = name => page.getByRole('tab', { name, exact: true }).click();
    const button = name => page.getByRole('button', { name, exact: true });
    const dialog = () => page.locator('[role=dialog], [role=alertdialog]');
    const open = async query => { await page.goto(`${base}/tests/fixtures/agent-backups.html?${query}`); await page.getByRole('tab', { name: '配置', exact: true }).waitFor(); };
    const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    const backup = async () => {
      await tab('备份');
      await button('创建备份').first().click();
      await page.getByText('已手动备份当前磁盘配置，未包含未保存的表单修改。', { exact: true }).waitFor();
    };
    // Opens the restore confirmation of the newest version.
    const choose = async () => { await tab('备份'); await page.locator('[data-backup]').first().getByRole('button', { name: '恢复', exact: true }).click(); await dialog().waitFor(); };

    await open('fresh');
    await button('应用配置修改').click();
    await page.getByText('配置已更新。', { exact: true }).waitFor();
    await button('关闭配置修改').waitFor();
    assert.equal((await calls('close_codex_config_modification')).length, 0);
    assert.equal((await calls('create_agent_config_backup')).length, 0);
    await backup();
    assert.deepEqual((await calls('create_agent_config_backup'))[0].args, { client: 'codex' });
    await tab('管理');
    await button('应用 ezcpa 模板').click();
    await button('确认覆盖').waitFor();
    assert.equal(await dialog().locator('li').count(), 3);
    assert.equal((await calls('apply_agent_config_template')).length, 0);
    await button('确认覆盖').click();
    await button('确认覆盖').waitFor({ state: 'detached' });
    assert.equal((await calls('apply_agent_config_template'))[0].args.revision, 'template1');
    assert.equal((await calls('create_agent_config_backup')).length, 1);
    await choose();
    await dialog().getByText('备份时不存在；恢复时删除', { exact: true }).waitFor();
    assert.equal(await dialog().locator('.ag-bk-files li').count(), 3);
    const updateCount = (await calls('update_agent_config')).length;
    assert.equal((await calls('restore_agent_config_backup')).length, 0);
    await button('确认恢复').click();
    await dialog().waitFor({ state: 'detached' });
    assert.equal((await calls('restore_agent_config_backup'))[0].args.revision, 'rev1');
    assert.equal((await calls('update_agent_config')).length, updateCount);
    await tab('备份');
    await page.locator('[data-backup]').first().getByRole('button', { name: '删除', exact: true }).click();
    assert.equal((await calls('delete_agent_config_backup')).length, 0);
    await button('确认删除').click();
    await page.getByText('还没有备份', { exact: true }).waitFor();
    assert.equal((await calls('delete_agent_config_backup')).length, 1);
    assert.equal((await calls('restore_agent_config_backup')).length, 1);
    assert.equal((await calls('create_agent_config_backup')).length, 1);

    // Preview-only dialog does not restore.
    await backup();
    await page.locator('[data-backup]').first().getByRole('button', { name: '预览', exact: true }).click();
    await dialog().waitFor();
    assert.equal((await calls('preview_agent_config_backup')).length > 0, true);
    await dialog().getByRole('button', { name: '关闭', exact: true }).click();
    await dialog().waitFor({ state: 'detached' });
    assert.equal((await calls('restore_agent_config_backup')).length, 1);

    // Invalid state: save disabled, template enabled, corrupt backup cannot be restored but can be deleted.
    await open('state=invalid');
    assert.ok(await button('更新配置').isDisabled());
    await tab('管理');
    assert.ok(await button('应用 ezcpa 模板').isEnabled());
    await backup();
    const row = page.locator('[data-backup]').first();
    assert.ok(await row.getByRole('button', { name: '恢复', exact: true }).isDisabled());
    assert.ok(await row.getByRole('button', { name: '预览', exact: true }).isDisabled());
    assert.ok(await row.getByRole('button', { name: '删除', exact: true }).isEnabled());
    await row.getByText('备份含有无法解析的配置').waitFor();

    // Conflict: restore fails, review keeps open with the error and restore is disabled until re-preview.
    await open('conflict'); await backup(); await choose();
    await button('确认恢复').click();
    await dialog().getByText(/预览后配置或备份发生变化，请重新预览/).waitFor();
    assert.ok(await dialog().getByRole('button', { name: '恢复', exact: true }).isDisabled());

    // Layout: dialog fits a narrow window; pages do not overflow horizontally.
    await page.setViewportSize({ width: 540, height: 820 });
    assert.ok(await dialog().isVisible());
    assert.ok(await dialog().evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: `${process.env.TEMP || os.tmpdir()}/agent-backups-narrow.png`, fullPage: true });
    await dialog().getByRole('button', { name: '关闭', exact: true }).click();
    await page.setViewportSize({ width: 680, height: 820 });
    await noOverflow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await noOverflow();

    // Claude Desktop without a trusted mapping: the form is shown and the save stays disabled.
    await open('client=claude-desktop');
    await page.locator('.ag-claude-entry').nth(2).waitFor();
    assert.ok(await button('更新配置').isDisabled());

    // Pi has no backup files and no template.
    await open('client=pi');
    await button('更新配置').waitFor();
    await tab('备份');
    await page.getByText('Pi 没有可备份的配置文件', { exact: true }).waitFor();
    for (const name of ['创建备份', '恢复']) assert.equal(await button(name).count(), 0);
    await tab('管理');
    assert.equal(await button('应用 ezcpa 模板').count(), 0);
    assert.equal((await calls('list_agent_config_backups')).length, 0);
    assert.deepEqual(errors, []);
    console.log('PASS: apply/close, manual backup, no Pi backup/template controls, disk-only payload, template preview, restore/delete confirmations, corrupt backups, conflict invalidation, narrow layout, missing Desktop mapping');
  } finally { await browser.close(); }
}, { url: process.env.AGENT_TEST_URL });
