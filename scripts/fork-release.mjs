import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/fork-release.mjs <previous-manifest> <next-manifest>');
  const manifests = await Promise.all(process.argv.slice(2).map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
  assertChannelAdvance(...manifests);
}
