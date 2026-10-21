// Usage: node scripts/channel.mjs main|beta|dev
// Writes the git-ignored src-tauri/tauri.channel.conf.json overlay (and recoloured icons) for
// `tauri build --config src-tauri/tauri.channel.conf.json`. Main writes an empty overlay.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = join(root, 'src-tauri');
const overlayPath = join(tauriDir, 'tauri.channel.conf.json');

// Recoloured source PNGs preserve the original icon; tauri icon generates platform formats.
const channels = { dev: 'DEV', beta: 'BETA' };

const name = process.argv[2];
if (name !== 'main' && !channels[name]) {
  console.error('Usage: node scripts/channel.mjs main|beta|dev');
  process.exit(1);
}

function writeOverlay() {
  if (name === 'main') return {};
  const label = channels[name];
  const base = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const productName = `${base.productName} [${label}]`;

  const iconDir = join(tauriDir, 'icons', 'channel', name);
  rmSync(iconDir, { recursive: true, force: true });
  mkdirSync(iconDir, { recursive: true });
  const sourcePath = join(tauriDir, 'icons', `${name}.png`);
  const result = spawnSync('bun', ['tauri', 'icon', sourcePath, '-o', iconDir], {
    cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error('bun tauri icon failed');

  // JSON merge replaces arrays wholesale, so copy every window attribute and change only the title.
  return {
    productName,
    identifier: name === 'dev' ? `${base.identifier}.dev` : `${base.identifier}.beta`,
    app: { windows: base.app.windows.map((window) => ({ ...window, title: productName })) },
    bundle: { icon: base.bundle.icon.map((icon) => icon.replace(/^icons\//, `icons/channel/${name}/`)) },
  };
}

writeFileSync(overlayPath, `${JSON.stringify(writeOverlay(), null, 2)}\n`);
console.log(`Wrote ${overlayPath} for ${name}`);
