import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCargoPackageVersion } from './version.mjs';

export async function readForkBaseVersion(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  let entries;
  try {
    entries = await readdir(join(root, 'docs', 'release-notes'), { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    entries = [];
  }
  const versions = entries
    .filter((entry) => entry.isDirectory() && /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(entry.name))
    .map((entry) => entry.name.slice(1));
  versions.sort((left, right) => {
    const a = left.split('.').map(BigInt);
    const b = right.split('.').map(BigInt);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index] ? -1 : 1;
    }
    return 0;
  });
  if (versions.length) return versions[0];
  const manifest = join(root, 'src-tauri', 'Cargo.toml');
  return parseCargoPackageVersion(await readFile(manifest, 'utf8'), manifest).split(/[-+]/)[0];
}

// A queued older run must not roll a public channel backwards.
export function assertChannelAdvance(previous, next) {
  const parse = (version) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(fork|beta|dev)\.(0|[1-9]\d*)$/.exec(version);
    if (!match) throw new Error(`Invalid fork release version: ${version}`);
    return { channel: match[4], numbers: [match[1], match[2], match[3], match[5]].map(BigInt) };
  };
  const before = parse(previous.version);
  const after = parse(next.version);
  if (before.channel !== after.channel) throw new Error('Cannot mix release channels');
  for (let index = 0; index < before.numbers.length; index += 1) {
    if (after.numbers[index] > before.numbers[index]) return;
    if (after.numbers[index] < before.numbers[index]) break;
  }
  throw new Error(`Channel feed must advance: ${previous.version} -> ${next.version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === '--base-version') {
    console.log(await readForkBaseVersion());
  } else {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/fork-release.mjs --base-version | <previous-manifest> <next-manifest>');
    const manifests = await Promise.all(process.argv.slice(2).map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
    assertChannelAdvance(...manifests);
  }
}
