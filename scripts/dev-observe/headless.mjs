import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const completed = child => new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
const stop = async child => {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await sleep(500);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
};

// D-Bus services can daemonize out of the driver group. Match only this run's
// private runtime directory, never process names or a shared desktop session.
async function stopSession(runtime) {
  const owned = pid => {
    try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`XDG_RUNTIME_DIR=${runtime}`); }
    catch { return false; }
  };
  const pids = fs.readdirSync('/proc').filter(pid => /^\d+$/.test(pid) && owned(pid));
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const pid of pids) { try { if (owned(pid)) process.kill(Number(pid), signal); } catch {} }
    await sleep(500);
  }
  // Portal/GVfs FUSE helpers can leave disconnected mounts after their bus exits.
  const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map(line => line.split(' ')[4])
    .filter(Boolean).map(value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))))
    .filter(value => value.startsWith(`${runtime}/`)).sort((a, b) => b.length - a.length);
  for (const mount of mounts) {
    const result = spawnSync('fusermount3', ['-u', '-z', mount], { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) throw Error(`Cannot unmount private runtime mount ${mount}: ${result.stderr || result.error}`);
  }
}

// Own the display and bus; never use or capture an existing desktop display.
export async function headlessSession({ args, out, cache, name, binary, display }) {
  if (!display) {
    const first = randomInt(100, 500);
    display = Array.from({ length: 400 }, (_, i) => `:${100 + (first - 100 + i) % 400}`).find(d => !fs.existsSync(`/tmp/.X${d.slice(1)}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${d.slice(1)}`));
    if (!display) throw Error('No unused virtual display available');
  }
  if (display && (!/^:[1-9][0-9]*$/.test(display) || fs.existsSync(`/tmp/.X${display.slice(1)}-lock`) || fs.existsSync(`/tmp/.X11-unix/X${display.slice(1)}`))) {
    throw Error('--display must be an unused X display other than :0');
  }
  if (fs.existsSync(out)) throw Error('Output directory already exists; choose a fresh --out or --name');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const home = path.join(out, 'session-home');
  const runtime = path.join(out, 'runtime');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(runtime, { mode: 0o700 });
  const log = fs.openSync(path.join(out, 'xvfb.log'), 'w', 0o600);
  let xvfb;
  let driver;
  let interrupted = false;
  const processes = () => {
    try { return JSON.parse(fs.readFileSync(path.join(out, '.processes.json'), 'utf8')); }
    catch { return {}; }
  };
  const interrupt = () => {
    interrupted = true;
    // Signal the Node driver, not dbus-run-session: keep its bus alive for cleanup.
    const pid = processes().driver;
    try { if (pid) process.kill(pid, 'SIGTERM'); else if (driver?.pid) process.kill(-driver.pid, 'SIGTERM'); } catch {}
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { detached: true, stdio: ['ignore', log, log] });
    const xDone = completed(xvfb);
    xDone.catch(() => {});
    const ownsDisplay = () => {
      try { return Number(fs.readFileSync(`/tmp/.X${display.slice(1)}-lock`, 'utf8').trim()) === xvfb.pid && fs.existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); }
      catch { return false; }
    };
    for (let i = 0; i < 100; i++) {
      if (interrupted) throw Error('Interrupted');
      if (xvfb.exitCode !== null) throw Error('Xvfb exited; see xvfb.log');
      if (ownsDisplay()) break;
      await sleep(100);
    }
    if (!ownsDisplay()) throw Error('Xvfb did not become ready');
    const env = { ...process.env, DISPLAY: display, GDK_BACKEND: 'x11', LIBGL_ALWAYS_SOFTWARE: '1', HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'), XDG_RUNTIME_DIR: runtime,
      EASYCLI_OBSERVE_SESSION: '1', EASYCLI_OBSERVE_CACHE: cache };
    for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'DBUS_SESSION_BUS_PID', 'WAYLAND_DISPLAY', 'XAUTHORITY']) delete env[key];
    const script = fileURLToPath(new URL('../dev-observe.mjs', import.meta.url));
    driver = spawn('dbus-run-session', ['--', process.execPath, script, ...args, '--name', name, '--no-build', '--out', out, '--binary', path.resolve(binary)], { env, detached: true, stdio: 'inherit' });
    // App has a separate process group, cleaned by the driver before it exits.
    const driverDone = completed(driver);
    const result = await Promise.race([driverDone, xDone.then(() => { throw Error('Xvfb stopped during measurement'); })]);
    return interrupted ? 1 : result;
  } finally {
    // Give the measurement driver's finally block time to stop its app group.
    if (driver && driver.exitCode === null) {
      interrupt();
      await Promise.race([completed(driver), sleep(5000)]);
    }
    await stop({ pid: processes().app });
    await stop(driver);
    await stop(xvfb);
    await stopSession(runtime);
    fs.closeSync(log);
    fs.rmSync(path.join(out, '.processes.json'), { force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
