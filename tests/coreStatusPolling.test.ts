import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { startCoreStatusPolling } from '../src/services/coreStatusPolling';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let restore = () => {};
afterEach(() => restore());
function fixture(refresh: () => Promise<boolean>) {
  let active = true;
  let id = 0;
  const timers = new Map<number, { tick: () => void; delay: number }>();
  const set = spyOn(globalThis, 'setTimeout').mockImplementation(((tick: () => void, delay: number) => {
    timers.set(++id, { tick, delay });
    return id;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((key: number) => { timers.delete(key); }) as typeof clearTimeout);
  restore = () => { set.mockRestore(); clear.mockRestore(); };
  const listeners = new Set<() => void>();
  const stop = startCoreStatusPolling({ active: () => active, subscribe: listener => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } }, refresh);
  return {
    timers, stop,
    delay: () => [...timers.values()][0]?.delay,
    activity(value: boolean) { active = value; listeners.forEach(listener => listener()); },
    async tick() {
      const [key, timer] = [...timers.entries()][0];
      timers.delete(key); timer.tick(); await flush();
    },
  };
}

describe('core status polling', () => {
  it('backs off unreachable targets, caps at one minute, and resets after success', async () => {
    let reachable = false;
    const f = fixture(async () => reachable);
    await flush();
    expect(f.delay()).toBe(20_000);
    await f.tick(); expect(f.delay()).toBe(40_000);
    await f.tick(); expect(f.delay()).toBe(60_000);
    await f.tick(); expect(f.delay()).toBe(60_000);
    reachable = true;
    await f.tick(); expect(f.delay()).toBe(10_000);
    f.stop(); expect(f.timers.size).toBe(0);
  });

  it('pauses while hidden, probes on resume, and never overlaps a slow request', async () => {
    let calls = 0;
    let resolve!: (reachable: boolean) => void;
    const f = fixture(() => { calls++; return new Promise<boolean>(done => { resolve = done; }); });
    expect(calls).toBe(1);
    expect(f.timers.size).toBe(0);
    f.activity(false); f.activity(true);
    expect(calls).toBe(1);
    resolve(true); await flush();
    expect(f.delay()).toBe(0);
    await f.tick(); expect(calls).toBe(2);
    f.activity(false);
    resolve(false); await flush();
    expect(f.timers.size).toBe(0);
    f.activity(true); expect(calls).toBe(3);
    f.stop(); resolve(true); await flush();
    expect(f.timers.size).toBe(0);
  });
});
