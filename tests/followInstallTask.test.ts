import { describe, expect, test } from 'bun:test';
import { followInstallTask, type CoreInstallTask } from '../src/services/coreVersions';

const task = (running: boolean, phase = running ? 'Downloading' : 'Installation complete'): CoreInstallTask => ({
  running, cancellable: running, phase, downloaded: 0, total: null, percent: null, message: null, result: null,
});

describe('following an install this page did not start', () => {
  test('polls an observed install until it finishes, then stops', async () => {
    const replies = [task(true), task(true), task(false)];
    const seen: string[] = [];
    let fetches = 0;
    await followInstallTask(async () => { fetches += 1; return replies.shift() ?? task(false, 'extra'); },
      (next) => seen.push(`${next.running}:${next.phase}`), () => true, 1, async () => {});
    expect(seen).toEqual(['true:Downloading', 'true:Downloading', 'false:Installation complete']);
    expect(fetches).toBe(3);
  });

  test('keeps polling through a failed request and stops when the page goes away or starts its own install', async () => {
    let calls = 0;
    let active = true;
    const seen: boolean[] = [];
    await followInstallTask(async () => {
      calls += 1;
      if (calls === 1) throw new Error('host busy');
      if (calls === 3) active = false;
      return task(true);
    }, (next) => seen.push(next.running), () => active, 1, async () => {});
    expect(calls).toBe(3);
    expect(seen).toEqual([true]);
  });
});
