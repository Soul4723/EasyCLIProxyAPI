import { describe, expect, spyOn, test } from 'bun:test';
import { createDataSource } from '../src/services/dataSource';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('shared data source', () => {
  test('coalesces requests during flight into exactly one follow-up', async () => {
    const first = deferred<number>();
    let calls = 0;
    const source = createDataSource({ load: () => ++calls === 1 ? first.promise : Promise.resolve(calls) });
    const pending = source.refresh();
    source.refresh(); source.invalidate(); source.refresh();
    expect(calls).toBe(1);
    first.resolve(1);
    await pending;
    expect(calls).toBe(2);
    expect(source.getSnapshot().data).toBe(2);
  });
  test('keeps last good data and timestamp on failure; background loading is false', async () => {
    let fail = false;
    const source = createDataSource({ load: async () => { if (fail) throw new Error('offline'); return 42; } });
    await source.refresh();
    const timestamp = source.getSnapshot().updatedAt;
    fail = true;
    const pending = source.refresh();
    expect(source.getSnapshot().loading).toBe(false);
    await pending;
    expect(source.getSnapshot()).toEqual({ data: 42, error: 'offline', updatedAt: timestamp, loading: false });
  });
  test('reset drops late results from the old generation', async () => {
    const old = deferred<number>();
    const source = createDataSource({ load: () => old.promise });
    const pending = source.refresh();
    source.reset(); old.resolve(7); await pending;
    expect(source.getSnapshot().data).toBeUndefined();
    expect(source.getSnapshot().updatedAt).toBe(0);
  });
  test('one event subscription per source, async lifetime shared by readers', async () => {
    let starts = 0; let stops = 0;
    const source = createDataSource({ load: async () => 1, subscribeEvents: () => { starts++; return () => { stops++; }; } });
    const off1 = source.subscribe(() => {}); const off2 = source.subscribe(() => {});
    await source.load();
    expect(starts).toBe(1); off1(); expect(stops).toBe(0); off2(); expect(stops).toBe(1);
  });
  test('failure polling doubles up to a cap and success resets it; unsubscribing stops polling', async () => {
    let fail = true;
    const times: number[] = [];
    const source = createDataSource({ pollMs: 30, maxPollMs: 120, load: async () => {
      times.push(Date.now()); if (fail) throw new Error('offline'); return 1;
    } });
    const off = source.subscribe(() => {});
    await pause(285);
    expect(times.length).toBe(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(55);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(110);
    fail = false;
    await source.refresh();
    const before = times.length;
    await pause(45);
    expect(times.length).toBe(before + 1);
    off(); const stopped = times.length;
    await pause(70); expect(times.length).toBe(stopped);
  });
});

describe('stable source snapshots', () => {
  test('unchanged reloads and event mutations preserve snapshot and data identity', async () => {
    const source = createDataSource({ load: async () => ({ nested: { value: 1 }, list: [1, null, 'x'] }) });
    await source.refresh();
    const previous = source.getSnapshot();
    let publications = 0;
    const off = source.subscribe(() => { publications++; });
    try {
      await source.refresh();
      source.mutate(() => ({ list: [1, null, 'x'], nested: { value: 1 } }));
      expect(publications).toBe(0);
      expect(source.getSnapshot()).toBe(previous);
      expect(source.getSnapshot().data).toBe(previous.data);
    } finally { off(); }
  });
  test('changed data publishes once without a background loading flip', async () => {
    let value = 1;
    const source = createDataSource({ load: async () => ({ value }) });
    await source.refresh();
    let publications = 0;
    const off = source.subscribe(() => { publications++; });
    try {
      value = 2;
      await source.refresh();
      expect(publications).toBe(1);
      expect(source.getSnapshot().data).toEqual({ value: 2 });
    } finally { off(); }
  });
  test('error after data publishes once and recovery reuses the last good data', async () => {
    let fail = false;
    const source = createDataSource({ load: async () => { if (fail) throw new Error('offline'); return { value: 1 }; } });
    await source.refresh();
    const previous = source.getSnapshot();
    let publications = 0;
    const off = source.subscribe(() => { publications++; });
    try {
      fail = true;
      await source.refresh();
      expect(publications).toBe(1);
      expect(source.getSnapshot().data).toBe(previous.data);
      expect(source.getSnapshot().updatedAt).toBe(previous.updatedAt);
      await source.refresh();
      expect(publications).toBe(1);
      fail = false;
      await source.refresh();
      expect(publications).toBe(2);
      expect(source.getSnapshot().error).toBeNull();
      expect(source.getSnapshot().data).toBe(previous.data);
    } finally { off(); }
  });
});

test('focus staleness uses the last successful refresh, including silent reloads', async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const focusTarget = new EventTarget();
  Object.defineProperty(globalThis, 'window', { value: focusTarget, configurable: true });
  let now = 1_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  let calls = 0;
  const source = createDataSource({ focusMs: 1_000, load: async () => { calls++; return { value: 1 }; } });
  const off = source.subscribe(() => {});
  try {
    await source.load();
    const previous = source.getSnapshot();
    now = 1_500;
    await source.refresh();
    expect(source.getSnapshot()).toBe(previous);
    now = 2_001;
    focusTarget.dispatchEvent(new Event('focus'));
    await source.load();
    expect(calls).toBe(2);
    now = 2_501;
    focusTarget.dispatchEvent(new Event('focus'));
    await source.load();
    expect(calls).toBe(3);
  } finally {
    off(); clock.mockRestore();
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('event coalescing uses one fixed trailing window; explicit refresh bypasses it', async () => {
  let event!: () => void;
  let reads = 0;
  const source = createDataSource({
    eventDelayMs: 30,
    subscribeEvents: invalidate => { event = invalidate; return () => {}; },
    load: async () => ++reads,
  });
  const off = source.subscribe(() => {});
  try {
    await source.load();
    for (let n = 0; n < 40; n++) event();
    await pause(15);
    expect(reads).toBe(1);
    event(); // does not restart the window
    await pause(25);
    expect(reads).toBe(2);
    event();
    await source.refresh();
    expect(reads).toBe(3);
    await pause(45);
    expect(reads).toBe(3); // refresh consumed the pending event invalidation
  } finally { off(); }
});
