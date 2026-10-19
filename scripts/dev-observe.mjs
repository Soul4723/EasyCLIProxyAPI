#!/usr/bin/env node
// Real embedded Tauri/WebKitGTK measurement on a disposable Linux host.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { headlessSession } from './dev-observe/headless.mjs';
import { writeReport } from './dev-observe/report.mjs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
if (args.includes('--help')) {
  console.log('node scripts/dev-observe.mjs --mode local|remote [--management-origin URL --client-origin URL --management-key-file path --client-key-file path] [--strace] [--display :N] [--revision SHA] [--core /path/to/cli-proxy-api (Local only)] [--core-config /path/to/config.example.yaml] [--name local-before] [--out directory] [--no-build] [--binary path] [--routes /overview,/usage/requests] [--settle 10] [--seconds 60] [--actions]');
  process.exit(0);
}
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
const seconds = Number(option('--seconds', '60'));
const settle = Number(option('--settle', '10'));
if (!(Number.isFinite(seconds) && Number.isFinite(settle) && seconds > 0 && settle >= 0)) throw Error('Invalid duration');
const routes = option('--routes', '/overview,/providers,/providers/all,/providers/exclusions,/quota,/usage,/usage/requests,/usage/routing,/usage/prices,/usage/data,/plugins,/agents,/agents/sessions,/settings/connection,/settings/access,/settings/routing,/settings/network,/settings/models,/settings/logs,/settings/app,/settings/updates,/easy').split(',');
if (new Set(routes).size !== routes.length || routes.some(route => !/^\/[a-z0-9/-]*$/.test(route))) throw Error('--routes must contain unique simple hash-router paths');
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
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const readKey = (flag, env) => option(flag) ? fs.readFileSync(option(flag), 'utf8').trim() : (process.env[env] || '').trim();
  const managementKey = mode === 'remote' ? readKey('--management-key-file', 'EASYCLI_OBSERVE_MANAGEMENT_KEY') : '';
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
  fs.writeFileSync(path.join(sandbox, 'config.toml'), `connection-mode = "${mode}"\nport = ${port}\nhost = "127.0.0.1"\nstart-core-on-launch = false\nrun-on-startup = false\nlocale = "en"\nauth-dir = ${JSON.stringify(path.join(sandbox, 'auth'))}\n${remoteConfig}`);
  const fifo = path.join(sandbox, 'control.fifo');
  run('mkfifo', ['-m', '600', fifo]);
  const trace = path.join(out, 'ipc.log');
  if (fs.existsSync(trace)) throw Error('Trace already exists; use a fresh output directory');
  fs.writeFileSync(trace, '', { mode: 0o600 });
  const log = fs.openSync(path.join(out, 'app.log'), 'w', 0o600);
  const appEnv = { ...process.env };
  // Custom client roots must not override the isolated HOME/XDG directories.
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME', 'KIMI_CODE_HOME', 'GROK_HOME', 'PI_CODING_AGENT_DIR', 'DSH_HOME', 'HERMES_HOME', 'WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR', 'MINIMAX_DATA_DIR']) delete appEnv[key];
  Object.assign(appEnv, { HOME: sandbox, XDG_CONFIG_HOME: path.join(sandbox, '.config'), XDG_DATA_HOME: path.join(sandbox, '.local/share'), XDG_CACHE_HOME: path.join(sandbox, '.cache'), CPA_GUI_IPC_TRACE: trace, CPA_GUI_DEV_CONTROL: fifo, CPA_GUI_START_ROUTE: routes[0] });
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
  const counts = list => {
    const commands = {};
    for (const line of list) {
      if (!/^\d+ /.test(line)) continue;
      const key = line.split(' ').slice(1).join(' ');
      commands[key] = (commands[key] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(commands).sort((a, b) => b[1] - a[1]));
  };
  const results = [];
  const cleanup = async () => {
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await delay(1500);
    // Also kill descendants (WebKit/core) that outlive the GUI's signal exit.
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    if (!exited) await new Promise(resolve => app.once('exit', resolve));
    fs.rmSync(fifo, { force: true });
  };
  let interrupted = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; interrupt.abort(); });
  try {
    await sleep(10000);
    send(report('READY'));
    await waitReport('READY');
    fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify({ commit: option('--revision') || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim() || 'unknown', sandbox, mode, port, routes, seconds, settle, started: new Date().toISOString(), core, binarySha256: createHash('sha256').update(fs.readFileSync(appBinary)).digest('hex') }, null, 2));
    let actionId = 0;
    const invoke = async command => {
      const label = `ACTION ${++actionId} ${command}`;
      const start = lines().length;
      send(`window.__TAURI_INTERNALS__.invoke('${command}').then(s=>${report(`${label} OK`)}).catch(e=>${report(`${label} ERROR`)});`);
      const result = await waitReport(label);
      if (result.endsWith('ERROR')) throw Error(result);
      await sleep(5000);
      const burst = lines().slice(start);
      fs.writeFileSync(path.join(out, `action-${actionId}-${command}.log`), burst.join('\n') + '\n');
      console.log(result, counts(burst));
    };
    if (mode === 'local') await invoke('start_core_process');
    send(`window.__TAURI_INTERNALS__.invoke('get_core_status').then(s=>window.__TAURI_INTERNALS__.invoke('dev_report',{text:'CORE '+JSON.stringify(s)}));`);
    const status = JSON.parse((await waitReport('CORE ')).slice(5));
    if (!status.running || !status.ready) throw Error('Core not ready; see ipc.log CORE report');
    if (mode === 'local' && args.includes('--actions')) {
      await invoke('stop_core_process');
      await invoke('start_core_process');
      await invoke('restart_core_process');
      const start = lines().length;
      send(`document.querySelector('[data-testid="privacy-toggle"]').click(); ${report('PRIVACY toggled')};`);
      await waitReport('PRIVACY');
      await sleep(3000);
      send(`document.querySelector('[data-testid="privacy-toggle"]').click(); location.hash='/settings/logs'; ${report('SETTINGS logs opened')};`);
      await waitReport('SETTINGS');
      await sleep(5000);
      fs.writeFileSync(path.join(out, 'action-privacy-settings.log'), lines().slice(start).join('\n') + '\n');
    }
    for (const route of routes) {
      if (interrupted) throw Error('Interrupted');
      const slug = route.slice(1).replaceAll('/', '-') || 'overview';
      send(`location.hash=${JSON.stringify(route)};`);
      await sleep(settle * 1000);
      // Host-clock window survives full document reloads. Sample cumulative observer
      // counts each second; counts on destroyed documents are lower bounds.
      send(`globalThis.__cpaDevObserver?.observer.disconnect();globalThis.__cpaDevObserver=undefined;${report(`BEGIN ${route}`)};`);
      await waitReport(`BEGIN ${route}`);
      const started = performance.now();
      const sample = () => send(`(()=>{let s=globalThis.__cpaDevObserver;if(!s){s={n:0};s.observer=new MutationObserver(ms=>s.n+=ms.length);s.observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});globalThis.__cpaDevObserver=s;}window.__TAURI_INTERNALS__.invoke('dev_report',{text:'OBS ${route} origin='+performance.timeOrigin+' mutations='+s.n+' actual='+location.hash});})();`);
      sample();
      while (performance.now() - started < seconds * 1000) {
        await sleep(Math.min(1000, seconds * 1000 - (performance.now() - started)));
        if (interrupted) throw Error('Interrupted');
        if (exited) throw startupError || Error('App exited; see app.log');
        sample();
      }
      send(report(`END ${route}`));
      await waitReport(`END ${route}`, 5000);
      const all = lines();
      const beginIndex = all.findIndex(line => line === `REPORT BEGIN ${route}`);
      const endIndex = all.findIndex(line => line === `REPORT END ${route}`);
      const windowLines = all.slice(beginIndex + 1, endIndex);
      const commands = counts(windowLines);
      const total = Object.values(commands).reduce((a, b) => a + b, 0);
      fs.writeFileSync(path.join(out, `${slug}.log`), windowLines.join('\n') + '\n');
      send(`window.__TAURI_INTERNALS__.invoke('dev_report',{text:'SHOT ${route} width='+innerWidth+' height='+innerHeight+' scale='+devicePixelRatio});`);
      const shot = await waitReport(`SHOT ${route}`);
      const [, width, height, scale] = shot.match(/width=(\d+) height=(\d+) scale=([\d.]+)/).map(Number);
      const xwd = path.join(out, `${slug}.xwd`);
      const png = path.join(out, `${slug}.png`);
      run('xwd', ['-root', '-silent', '-out', xwd], { timeout: 15000 });
      run('convert', [xwd, png], { timeout: 15000 });
      const size = spawnSync('identify', ['-format', '%w %h', png], { encoding: 'utf8', timeout: 5000 });
      const [w, h] = size.stdout?.trim().split(' ').map(Number) || [];
      if (size.status !== 0 || w < width * scale || h < height * scale) throw Error(`Screenshot too small for ${route}`);
      const observations = all.slice(beginIndex + 1, endIndex).filter(l => l.startsWith(`REPORT OBS ${route} `));
      const documents = new Map();
      for (const line of observations) {
        const match = line.match(/origin=([\d.]+) mutations=(\d+) actual=(.*)/);
        if (match) documents.set(match[1], { mutations: Number(match[2]), route: match[3] });
      }
      const row = { route, total, callsPerMinute: total * 60 / seconds, commands, mutations: [...documents.values()].reduce((n,d) => n+d.mutations, 0), documents: documents.size, mutationCountIsLowerBound: documents.size > 1, actualRoutes: [...new Set([...documents.values()].map(d => d.route))] };
      results.push(row);
      writeReport(out, results, seconds, mode);
      console.log(JSON.stringify(row));
    }
  } finally {
    await cleanup();
    if (results.length) writeReport(out, results, seconds, mode);
    console.log('Stopped GUI process group (including app-owned core and WebKit).');
  }
}
