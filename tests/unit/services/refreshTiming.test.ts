import { expect, spyOn, test } from 'bun:test';
import { startStaleFocusRefresh, startVisibleInterval, subscribeFixedWindowEvent } from '../../../src/services/refreshTiming';
import type { listen } from '../../../src/services/platform';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function fakeIntervals() {
  let nextId = 0;
  let created = 0;
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  const set = spyOn(globalThis, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
    const id = ++nextId;
    created++;
    if (typeof callback === 'function') intervals.set(id, { callback: callback as () => void, delay: delay ?? 0 });
    return id as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(((id: ReturnType<typeof setInterval>) => {
    intervals.delete(id as number);
  }) as typeof clearInterval);
  return {
    active: () => [...intervals.values()],
    created: () => created,
    tick() { [...intervals.values()].forEach(({ callback }) => callback()); },
    restore() { set.mockRestore(); clear.mockRestore(); },
  };
}

function browser() {
  const descriptors = ['window', 'document'].map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false });
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  return { win, doc, restore() {
    ['window', 'document'].forEach((key, i) => {
      if (descriptors[i]) Object.defineProperty(globalThis, key, descriptors[i]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  } };
}

test('continuous events cannot postpone the fixed window; stop cancels pending work', async () => {
  let emit!: () => void;
  let stops = 0;
  const subscribe: typeof listen = async (_event, handler) => {
    emit = () => handler({} as never);
    return () => { stops++; };
  };
  let calls = 0;
  const subscription = subscribeFixedWindowEvent('records', 40, () => { calls++; }, () => {}, subscribe);
  try {
    await pause(0);
    emit();
    const stream = setInterval(() => emit(), 5);
    try { await pause(65); } finally { clearInterval(stream); }
    expect(calls).toBeGreaterThan(0); // even though events kept arriving
    emit();
    expect(subscription.pending()).toBe(true);
    subscription.stop();
    const stoppedAt = calls;
    await pause(50);
    expect(calls).toBe(stoppedAt);
    expect(stops).toBe(1);
  } finally { subscription.stop(); }
});

test('late event subscription is disposed after unmount and cannot schedule work', async () => {
  let connected!: (stop: () => void) => void;
  let emit!: () => void;
  let stopped = false;
  const subscribe: typeof listen = (_event, handler) => {
    emit = () => handler({} as never);
    return new Promise(resolve => { connected = resolve; });
  };
  let calls = 0;
  const subscription = subscribeFixedWindowEvent('records', 5, () => { calls++; }, () => {}, subscribe);
  subscription.stop();
  connected(() => { stopped = true; });
  await pause(0); emit(); await pause(15);
  expect(stopped).toBe(true);
  expect(calls).toBe(0);
});

test('visible interval pauses, refreshes immediately on return, and cleans up on cadence changes', () => {
  const timers = fakeIntervals();
  const env = browser();
  let ticks = 0;
  let refreshes = 0;
  const stopFine = startVisibleInterval(() => { ticks++; }, 1_000, () => { refreshes++; });
  let stopCoarse: (() => void) | undefined;
  try {
    expect(timers.active()).toHaveLength(1);
    expect(timers.active()[0]?.delay).toBe(1_000);
    expect(refreshes).toBe(0);
    expect(ticks).toBe(0);
    env.doc.hidden = true; env.doc.dispatchEvent(new Event('visibilitychange'));
    expect(timers.active()).toHaveLength(0);
    timers.tick(); expect(ticks).toBe(0);
    env.doc.hidden = false; env.doc.dispatchEvent(new Event('visibilitychange'));
    expect(refreshes).toBe(1);
    expect(timers.active()).toHaveLength(1);
    expect(timers.created()).toBe(2);
    timers.tick(); expect(ticks).toBe(1);

    stopFine(); expect(timers.active()).toHaveLength(0);
    stopCoarse = startVisibleInterval(() => { ticks++; }, 30_000);
    expect(timers.active()).toHaveLength(1);
    expect(timers.active()[0]?.delay).toBe(30_000);
    timers.tick(); expect(ticks).toBe(2);
    stopCoarse(); stopCoarse = undefined; expect(timers.active()).toHaveLength(0);
  } finally { stopCoarse?.(); stopFine(); timers.restore(); env.restore(); }
});

test('visible interval falls back to a plain interval without document', () => {
  const timers = fakeIntervals();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'document');
  let ticks = 0;
  let stop: (() => void) | undefined;
  try {
    expect(typeof document).toBe('undefined');
    stop = startVisibleInterval(() => { ticks++; }, 1_000);
    expect(timers.active()).toHaveLength(1);
    expect(timers.active()[0]?.delay).toBe(1_000);
    timers.tick(); expect(ticks).toBe(1);
    stop(); stop = undefined; expect(timers.active()).toHaveLength(0);
  } finally {
    stop?.();
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    timers.restore();
  }
});

test('focus refresh is strictly stale, visible, not event-pending, and query/manual freshness resets it', () => {
  const env = browser();
  let now = 1_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  let pending = false;
  let calls = 0;
  const focus = startStaleFocusRefresh(() => { calls++; }, 30_000, () => pending);
  try {
    now += 30_000; env.win.dispatchEvent(new Event('focus')); expect(calls).toBe(0);
    now++; env.win.dispatchEvent(new Event('focus')); expect(calls).toBe(1);
    now += 20_000; focus.markFresh();
    now += 20_000; env.win.dispatchEvent(new Event('focus')); expect(calls).toBe(1);
    now += 11_000; pending = true;
    env.win.dispatchEvent(new Event('focus')); expect(calls).toBe(1);
    pending = false; env.doc.hidden = true;
    env.win.dispatchEvent(new Event('focus')); expect(calls).toBe(1);
    env.doc.hidden = false; env.doc.dispatchEvent(new Event('visibilitychange')); expect(calls).toBe(2);
    focus.stop(); now += 31_000; env.win.dispatchEvent(new Event('focus')); expect(calls).toBe(2);
  } finally { focus.stop(); clock.mockRestore(); env.restore(); }
});
