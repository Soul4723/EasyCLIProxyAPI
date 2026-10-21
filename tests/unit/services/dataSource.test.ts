import { describe, expect, spyOn, test } from 'bun:test';
import { createDataSource } from '../../../src/services/dataSource';
import { initializeWindowActivity } from '../../../src/services/windowActivity';

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

test('resume freshness uses the last successful refresh, including silent reloads', async () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = Object.assign(new EventTarget(), { hidden: false });
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  await initializeWindowActivity();
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
    now = 1_501;
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
    await source.load();
    expect(calls).toBe(3);
    now = 1_502;
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
    await source.load();
    expect(calls).toBe(4);
  } finally {
    off(); clock.mockRestore();
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else Reflect.deleteProperty(globalThis, 'document');
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

test('hidden background work pauses but awaited action refresh/load reads stay fresh', async () => {
  const { windowActivity } = await import('../../../src/services/windowActivity');
  let active = false;
  const transitions = new Set<() => void>();
  const activity = spyOn(windowActivity, 'active').mockImplementation(() => active);
  const subscription = spyOn(windowActivity, 'subscribe').mockImplementation(listener => {
    transitions.add(listener); return () => { transitions.delete(listener); };
  });
  let reads = 0;
  let fail = false;
  const source = createDataSource({ pollMs: 10, load: async () => {
    reads++;
    if (fail) throw new Error('action read failed');
    return reads;
  } });
  const off = source.subscribe(() => {});
  try {
    source.invalidate();
    await pause(25);
    expect(reads).toBe(0);
    await source.refresh();
    expect(source.getSnapshot().data).toBe(1);
    source.invalidate();
    await source.load();
    expect(source.getSnapshot().data).toBe(2);
    fail = true;
    await source.refresh();
    expect(source.getSnapshot().error).toBe('action read failed');
    expect(source.getSnapshot().data).toBe(2);
    await pause(25);
    expect(reads).toBe(3); // Explicit reads did not restart hidden polling.
    fail = false;
    active = true; transitions.forEach(listener => listener());
    await source.load();
    expect(source.getSnapshot().data).toBe(4);
  } finally { off(); activity.mockRestore(); subscription.mockRestore(); }
});

test('an action read queued behind a hidden automatic read awaits its fresh result', async () => {
  const { windowActivity } = await import('../../../src/services/windowActivity');
  let active = true;
  const transitions = new Set<() => void>();
  const activity = spyOn(windowActivity, 'active').mockImplementation(() => active);
  const subscription = spyOn(windowActivity, 'subscribe').mockImplementation(listener => {
    transitions.add(listener); return () => { transitions.delete(listener); };
  });
  const first = deferred<number>();
  let reads = 0;
  const source = createDataSource({ load: () => ++reads === 1 ? first.promise : Promise.resolve(reads) });
  const off = source.subscribe(() => {});
  try {
    active = false; transitions.forEach(listener => listener());
    const action = source.load();
    first.resolve(1);
    await action;
    expect(reads).toBe(2);
    expect(source.getSnapshot().data).toBe(2);
    source.reset();
    const pending = source.refresh();
    await pending;
    expect(source.getSnapshot().data).toBe(3);
  } finally { off(); activity.mockRestore(); subscription.mockRestore(); }
});

test('component-owned queries retain explicit resume ownership', async () => {
  const { windowActivity } = await import('../../../src/services/windowActivity');
  let active = true;
  const transitions = new Set<() => void>();
  const activity = spyOn(windowActivity, 'active').mockImplementation(() => active);
  const subscription = spyOn(windowActivity, 'subscribe').mockImplementation(listener => {
    transitions.add(listener); return () => { transitions.delete(listener); };
  });
  let reads = 0;
  const source = createDataSource({ focusMs: Infinity, load: async () => ++reads });
  const off = source.subscribe(() => {});
  try {
    await source.load();
    active = false; transitions.forEach(listener => listener());
    active = true; transitions.forEach(listener => listener());
    await source.load();
    expect(reads).toBe(1); // Usage's owner invalidates the query once on resume.
    await source.refresh();
    expect(reads).toBe(2);
  } finally { off(); activity.mockRestore(); subscription.mockRestore(); }
});

test('active stale-focus refreshes coalesce and stop after unsubscribe', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const win = new EventTarget();
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
  let now = 1_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  let reads = 0;
  const source = createDataSource({ focusMs: 1_000, load: async () => ++reads });
  const off = source.subscribe(() => {});
  try {
    await source.load();
    win.dispatchEvent(new Event('focus'));
    expect(reads).toBe(1);
    now = 2_001;
    for (let i = 0; i < 20; i++) win.dispatchEvent(new Event('focus'));
    await source.load();
    expect(reads).toBe(2);
    off(); now = 4_000;
    win.dispatchEvent(new Event('focus'));
    expect(reads).toBe(2);
  } finally {
    off(); clock.mockRestore();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
