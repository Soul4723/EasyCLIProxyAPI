#!/usr/bin/env node
// CI-only adaptation of the established real Tauri/WebKitGTK observer.
// No mock bridge: all assertions use the app webview and production IPC handlers.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { headlessSession } from './dev-observe/headless.mjs';
import { createHash, randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
if (args.includes('--help')) {
  console.log('node scripts/dev-observe.mjs --mode local|remote [--management-origin URL --client-origin URL --management-key-file path --client-key-file path] [--strace] [--display :N] [--revision SHA] [--core /path/to/cli-proxy-api (Local only)] [--core-config /path/to/config.example.yaml] [--name local-before] [--out directory] [--no-build] [--binary path] [--restart-check]');
  process.exit(0);
}
if (process.env.GITHUB_ACTIONS !== 'true') throw Error('This real-app harness runs only on disposable GitHub Actions runners');
const realHome = os.homedir();
process.umask(0o077);
const cache = path.resolve(process.env.EASYCLI_OBSERVE_CACHE || path.join(process.env.XDG_CACHE_HOME || path.join(realHome, '.cache'), 'easycli-observe'));
const target = process.env.CARGO_TARGET_DIR || path.join(realHome, '.cache/easycli-target');
const name = option('--name', `${option('--mode', 'local')}-${Date.now()}`);
if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw Error('Invalid sandbox name');
const sandbox = path.join(cache, 'sandbox', name);
const out = path.resolve(option('--out', path.join(cache, 'measure', name)));
const mode = option('--mode', 'local');
if (!['local', 'remote'].includes(mode)) throw Error('--mode must be local or remote');
const core = option('--core');
if (mode === 'local' && (!core || !fs.statSync(core).isFile())) throw Error('--core must be a test core binary');
const coreConfig = option('--core-config', core && path.join(path.dirname(core), 'config.example.yaml'));
if (mode === 'local' && !fs.existsSync(coreConfig)) throw Error('--core-config must name the core distribution config.example.yaml');
const route = '/';
const run = (cmd, argv, options = {}) => {
  const result = spawnSync(cmd, argv, { cwd: root, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw Error(`${cmd} failed: ${result.error || result.status}`);
};
if (!args.includes('--no-build')) run('bun', ['run', 'tauri', 'build', '--debug', '--no-bundle'], { env: { ...process.env, CARGO_TARGET_DIR: target } });
if (!process.env.EASYCLI_OBSERVE_SESSION) {
  process.exitCode = await headlessSession({ args, out, cache, name, binary: option('--binary', path.join(target, 'debug/cpa-gui')), display: option('--display') });
} else {
  // Refuse reuse rather than risk adopting an old process/config or overwriting evidence.
  fs.mkdirSync(path.dirname(sandbox), { recursive: true });
  fs.mkdirSync(sandbox, { recursive: false });
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'cpa-core'));
  fs.copyFileSync(option('--binary', path.join(target, 'debug/cpa-gui')), path.join(sandbox, 'cpa-gui'));
  fs.chmodSync(path.join(sandbox, 'cpa-gui'), 0o700);
  if (mode === 'local') {
    fs.copyFileSync(core, path.join(sandbox, 'cpa-core/cli-proxy-api'));
    fs.chmodSync(path.join(sandbox, 'cpa-core/cli-proxy-api'), 0o700);
    fs.copyFileSync(coreConfig, path.join(sandbox, 'cpa-core/config.example.yaml'));
    fs.mkdirSync(path.join(sandbox, 'auth'));
    const versionInfo = spawnSync(path.join(sandbox, 'cpa-core/cli-proxy-api'), ['-h'], { env: { ...process.env, HOME: sandbox }, encoding: 'utf8', timeout: 10000 });
    const coreVersion = `${versionInfo.stdout || ''} ${versionInfo.stderr || ''}`.match(/CLIProxyAPI Version: ([0-9][^,\s]*)/);
    if (coreVersion) fs.writeFileSync(path.join(sandbox, 'cpa-core/cpa-gui-meta.json'), JSON.stringify({ version: coreVersion[1], assetName: path.basename(core), installedAtUnix: Math.floor(Date.now() / 1000) }));
  }
  // Only test settings. A distinct, free loopback port avoids other local cores.
  const net = await import('node:net');
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = randomInt(49152, 65536);
    const probe = net.createServer();
    const available = await new Promise((resolve, reject) => {
      probe.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
      probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (available) { port = candidate; break; }
  }
  if (!port) throw Error('No free random high loopback port');
  const readKey = (flag, env) => option(flag) ? fs.readFileSync(option(flag), 'utf8').trim() : (process.env[env] || '').trim();
  const managementKey = mode === 'remote' ? readKey('--management-key-file', 'EASYCLI_OBSERVE_MANAGEMENT_KEY') : process.env.CPA_TEST_MANAGEMENT_KEY;
  if (!managementKey) throw Error('Test management key is required');
  const clientKey = mode === 'remote' ? readKey('--client-key-file', 'EASYCLI_OBSERVE_CLIENT_KEY') : '';
  const origin = flag => {
    const value = option(flag);
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error(`${flag} must be an HTTP(S) origin`);
    return u.origin;
  };
  let remoteConfig = '';
  if (mode === 'remote') {
    if (!managementKey) throw Error('Remote requires EASYCLI_OBSERVE_MANAGEMENT_KEY or --management-key-file');
    remoteConfig = `remote-management-origin = ${JSON.stringify(origin('--management-origin'))}\nremote-client-origin = ${JSON.stringify(origin('--client-origin'))}\nremote-management-key = ${JSON.stringify(managementKey)}\nremote-client-key = ${JSON.stringify(clientKey)}\n`;
  }
  fs.writeFileSync(path.join(sandbox, 'config.toml'), `connection-mode = "${mode}"\nport = ${port}\nhost = "127.0.0.1"\nstart-core-on-launch = true\nrun-on-startup = false\nlocale = "en"\nauth-dir = ${JSON.stringify(path.join(sandbox, 'auth'))}\nmanagement-secret-key = ${JSON.stringify(managementKey)}\n${remoteConfig}`);
  const fifo = path.join(sandbox, 'control.fifo');
  run('mkfifo', ['-m', '600', fifo]);
  const trace = path.join(out, 'ipc.log');
  if (fs.existsSync(trace)) throw Error('Trace already exists; use a fresh output directory');
  fs.writeFileSync(trace, '', { mode: 0o600 });
  const log = fs.openSync(path.join(out, 'app.log'), 'w', 0o600);
  const appEnv = { ...process.env };
  // Custom client roots must not override the isolated HOME/XDG directories.
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME', 'KIMI_CODE_HOME', 'GROK_HOME', 'PI_CODING_AGENT_DIR', 'DSH_HOME', 'HERMES_HOME', 'WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR', 'MINIMAX_DATA_DIR']) delete appEnv[key];
  Object.assign(appEnv, { HOME: sandbox, XDG_CONFIG_HOME: path.join(sandbox, '.config'), XDG_DATA_HOME: path.join(sandbox, '.local/share'), XDG_CACHE_HOME: path.join(sandbox, '.cache'), CPA_GUI_IPC_TRACE: trace, CPA_GUI_DEV_CONTROL: fifo, CPA_GUI_START_ROUTE: route });
  for (const key of ['EASYCLI_OBSERVE_MANAGEMENT_KEY', 'EASYCLI_OBSERVE_CLIENT_KEY']) delete appEnv[key];
  const appBinary = path.join(sandbox, 'cpa-gui');
  const app = spawn(args.includes('--strace') ? 'strace' : appBinary, args.includes('--strace') ? ['-f', '-ttt', '-e', 'trace=connect', '-o', path.join(out, 'connect.trace'), appBinary] : [], { cwd: sandbox, detached: true, stdio: ['ignore', log, log], env: appEnv });
  fs.closeSync(log);
  fs.writeFileSync(path.join(out, '.processes.json'), JSON.stringify({ driver: process.pid, app: app.pid }));
  let exited = false;
  let startupError;
  app.on('exit', () => { exited = true; });
  app.on('error', error => { startupError = error; exited = true; });
  const interrupt = new AbortController();
  const sleep = ms => delay(ms, undefined, { signal: interrupt.signal });
  const lines = () => fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean);
  // Nonblocking FIFO open means a failed startup cannot hang the driver forever.
  const send = js => { const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); try { fs.writeSync(fd, `${js}\n`); } finally { fs.closeSync(fd); } };
  const report = text => `window.__TAURI_INTERNALS__.invoke('dev_report',{text:${JSON.stringify(text)}})`;
  const waitReport = async (prefix, timeout = 30000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const found = lines().findLast(line => line.startsWith(`REPORT ${prefix}`));
      if (found) return found.slice(7);
      if (exited) throw startupError || Error('App exited; see app.log');
      await sleep(250);
    }
    throw Error(`No report: ${prefix}`);
  };
  const cleanup = async () => {
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await delay(1500);
    // Also kill descendants (WebKit/core) that outlive the GUI's signal exit.
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    if (!exited) await new Promise(resolve => app.once('exit', resolve));
    const coreLog = path.join(sandbox, 'cpa-core/core-start-output.log');
    if (fs.existsSync(coreLog)) fs.copyFileSync(coreLog, path.join(out, 'core.log'));
    fs.rmSync(fifo, { force: true });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupt.abort(); });
  try {
    await sleep(10000);
    send(report('READY'));
    await waitReport('READY');
    fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify({ commit: option('--revision') || process.env.GITHUB_SHA || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim() || 'unknown', sandbox, mode, port, started: new Date().toISOString(), core, binarySha256: createHash('sha256').update(fs.readFileSync(appBinary)).digest('hex') }, null, 2));
    // Invoke the real embedded webview and production IPC handlers, not mock HTTP.
    let probe = 0;
    const call = async (command, args = {}, timeout = 5000) => {
      const prefix = `CALL ${++probe} ${command} `;
      send(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)}).then(value=>window.__TAURI_INTERNALS__.invoke('dev_report',{text:${JSON.stringify(prefix)}+JSON.stringify({value})})).catch(error=>window.__TAURI_INTERNALS__.invoke('dev_report',{text:${JSON.stringify(prefix)}+JSON.stringify({error:String(error)})}));`);
      const response = JSON.parse((await waitReport(prefix, timeout)).slice(prefix.length));
      if ('error' in response) throw Error(`${command}: ${response.error}`);
      return response.value;
    };
    const ready = async (deadline, previousPid) => {
      while (Date.now() < deadline) {
        const status = await call('get_core_status', {}, Math.min(1500, Math.max(1, deadline - Date.now())));
        if (status.running && status.ready && status.connectionMode === mode &&
            (mode === 'remote' ? !status.managed : status.managed && status.processId && status.processId !== previousPid)) return status;
        await sleep(200);
      }
      throw Error(`Core did not become ready in ${mode} mode before deadline`);
    };
    const emit = async text => { send(report(text)); await waitReport(text); };
    // No start command: this must prove the app's launch-time auto-start path.
    const status = await ready(Date.now() + 30000);
    await emit('CORE ' + JSON.stringify(status));
    const managementRead = async which => {
      await emit(`RESTART_CHECK management read ${which} restart started`);
      // Main's process-wide LazyLock client is intentionally reused by both reads.
      await call('management_request', {request: {method: 'GET', path: '/credentials', timeoutMs: 5000}});
      await emit(`RESTART_CHECK management read ${which} restart succeeded`);
    };
    if (mode === 'remote') {
      await call('management_request', {request: {method: 'GET', path: '/config', timeoutMs: 5000}});
      await emit('REMOTE authenticated management read succeeded');
    }
    if (mode === 'local' && args.includes('--restart-check')) {
      await managementRead('before');
      const started = Date.now();
      await call('restart_core_process');
      await emit('RESTART_CHECK restart command succeeded');
      const restarted = await ready(started + 10000, status.processId);
      if (Date.now() - started > 10000) throw Error('Restart readiness exceeded 10000ms');
      await emit(`RESTART_CHECK ready after ${Date.now() - started}ms`);
      await emit('RESTART_CORE ' + JSON.stringify(restarted));
      await managementRead('after');
    }
    console.log(`PASS real-core ${mode}${args.includes('--restart-check') ? ' restart' : ' auto-start/connect'}`);
  } finally {
    await cleanup();
    console.log('Stopped GUI process group (including app-owned core and WebKit).');
  }
}
