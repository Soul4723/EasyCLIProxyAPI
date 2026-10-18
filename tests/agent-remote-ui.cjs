// Agents in Remote mode: node tests/agent-remote-ui.cjs (needs PLAYWRIGHT_MODULE and a vite server at AGENT_TEST_URL, default :1421).
// Replaces the remote agent-flow part of the deleted remote-core-ui test: with a remote core, agent inspection, model
// listing, configuration repair/update and launch go through the CLIENT origin + client key (never the management origin or key),
// the UI sends no credential overrides, and switching back to Local returns to the local endpoint.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { openApp, setRemote, setLocal, clickNav, invoke, waitForCoreStatus } = require('./helpers/shell.cjs');

const base = process.env.AGENT_TEST_URL || 'http://127.0.0.1:1421';
const CLIENT_ORIGIN = 'http://client.example.test:8317';
const COMMANDS = ['get_agent_config_statuses', 'refresh_agent_config_statuses', 'get_agent_models', 'update_agent_config', 'launch_agent'];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));

    await openApp(page, base, { mock: 'running', path: '/agents' });
    await page.locator('a.ag-card[data-client="codex"]').waitFor();
    const origin = await setRemote(page);
    await waitForCoreStatus(page);

    // Record what the remote session sends: native client operations (with their origin) and the agent commands + args.
    await page.evaluate(async () => {
      window.clientOperations = [];
      window.clientCommands = [];
      const { listen } = await import('/node_modules/@tauri-apps/api/event.js');
      await listen('browser-mock-client-operation', event => window.clientOperations.push(event.payload));
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args, options) => {
        if (['update_agent_config', 'get_agent_models', 'launch_agent', 'get_agent_config_statuses', 'refresh_agent_config_statuses'].includes(command)) {
          window.clientCommands.push({ command, args });
        }
        return original(command, args, options);
      };
    });

    // The agent pages stay reachable in Remote (they are not gated like Easy mode).
    await clickNav(page, 'agents');
    await page.getByRole('button', { name: 'Rescan', exact: true }).click();
    await page.waitForFunction(() => window.clientOperations.some(operation => operation.command === 'refresh_agent_config_statuses'));
    // Remote clients are not yet pointed at this remote core: the card says so instead of "Connected".
    assert.equal(await page.locator('a.ag-card[data-client="codex"]').getAttribute('data-state'), 'needsUpdate', 'remote codex needs its config pointed at the client origin');

    await page.locator('a.ag-card[data-client="codex"]').click();
    await page.locator('.ag-detail').waitFor();
    await page.locator('.agent-model-trigger').click();
    await page.getByRole('option').filter({ hasText: 'claude-sonnet-4-6' }).click();
    await page.getByRole('button', { name: 'Repair Connection', exact: true }).click();
    await page.getByRole('button', { name: 'Update Configuration', exact: true }).waitFor();
    await page.locator('button[data-action="launch-app"]').click();
    await page.waitForFunction(() => window.clientOperations.some(operation => operation.command === 'launch_agent'));

    const evidence = await page.evaluate(() => ({ operations: window.clientOperations, commands: window.clientCommands }));
    assert.ok(evidence.operations.length >= 3, 'client operations were recorded');
    for (const operation of evidence.operations) assert.equal(operation.origin, CLIENT_ORIGIN, `${operation.command} must use the client origin`);
    for (const command of COMMANDS.filter(name => name !== 'get_agent_config_statuses')) {
      assert.ok(evidence.commands.some(call => call.command === command), `${command} must be reachable in Remote`);
    }
    const sent = JSON.stringify(evidence);
    for (const secret of ['fixture-management-key', 'fixture-client-key', origin]) assert.ok(!sent.includes(secret), `no ${secret} in agent command arguments`);
    for (const call of evidence.commands) {
      for (const field of ['apiKey', 'clientKey', 'managementKey', 'baseUrl', 'managementOrigin', 'clientOrigin']) {
        assert.ok(!(call.args && field in call.args), `${call.command} must not carry a ${field} override`);
      }
    }
    assert.equal(await page.locator('.ag-notice--error').count(), 0, 'no error notice after repair + launch');

    // Back to Local: agent operations return to the local endpoint.
    await setLocal(page);
    await waitForCoreStatus(page);
    // Saving the connection reloads the document (dev fenced targets), so re-attach the recorder.
    await page.evaluate(async () => {
      window.clientOperations = [];
      const { listen } = await import('/node_modules/@tauri-apps/api/event.js');
      await listen('browser-mock-client-operation', event => window.clientOperations.push(event.payload));
    });
    await invoke(page, 'refresh_agent_config_statuses', { executableOverrides: {} });
    const local = await page.evaluate(() => window.clientOperations);
    assert.ok(local.length > 0 && local.every(operation => operation.origin.startsWith('http://127.0.0.1:')), 'local mode uses the local endpoint');

    assert.deepEqual(errors, []);
    console.log('PASS: remote agent detection, model listing, repair/update and launch use only the client origin without credential overrides; local mode returns to the local endpoint.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
