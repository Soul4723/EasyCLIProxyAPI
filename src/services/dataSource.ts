import { useSyncExternalStore } from 'react';
import { listen } from './platform';
import { windowActivity } from './windowActivity';

// updatedAt records the last published successful value, not every successful poll.
export type SourceSnapshot<T> = { data: T | undefined; error: string | null; updatedAt: number; loading: boolean };
export type DataSourceOptions<T> = {
  load: () => Promise<T>;
  /** Component-owned queries may expose background refresh progress; shared sources stay quiet. */
  trackRefresh?: boolean;
  events?: string[];
  /** Skips events whose payload does not concern this source. Absent: every event invalidates. */
  eventFilter?: (payload: unknown) => boolean;
  subscribeEvents?: (invalidate: () => void) => (() => void);
  pollMs?: number | (() => number);
  maxPollMs?: number;
  focusMs?: number;
  minIntervalMs?: number;
  /** Fixed coalescing window for events only; manual refresh/focus stay immediate. */
  eventDelayMs?: number;
};

// Sources carry JSON-like IPC values. Treat other object types as changed rather than
// comparing only their enumerable properties (e.g. two different Dates).
function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => structurallyEqual(value, right[index]));
  }
  if (Object.getPrototypeOf(left) !== Object.prototype || Object.getPrototypeOf(right) !== Object.prototype) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every(key => Object.hasOwn(b, key) && structurallyEqual(a[key], b[key]));
}

/** One owner per resource. Errors never discard data; reset fences every outstanding request. */
export function createDataSource<T>(options: DataSourceOptions<T>) {
  const initial: SourceSnapshot<T> = { data: undefined, error: null, updatedAt: 0, loading: true };
  let snapshot = initial;
  let generation = 0;
  // Freshness advances even when an unchanged success does not publish a snapshot.
  let lastSuccessfulAt = 0;
  let failures = 0;
  let dirty = true;
  let queued = false;
  let queuedExplicit = false;
  let refreshAfterCurrent = false;
  let request: Promise<void> | null = null;
  let startedAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let throttle: ReturnType<typeof setTimeout> | undefined;
  let stopEvents: (() => void) | undefined;
  let stopActivity: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const visible = () => windowActivity.active();
  const publish = (next: SourceSnapshot<T>) => {
    const data = structurallyEqual(snapshot.data, next.data) ? snapshot.data : next.data;
    if (Object.is(data, snapshot.data) && next.error === snapshot.error && next.loading === snapshot.loading) return;
    snapshot = { ...next, data };
    listeners.forEach(fn => fn());
  };
  const poll = () => {
    clearTimeout(timer);
    const base = typeof options.pollMs === 'function' ? options.pollMs() : options.pollMs;
    if (!base || !listeners.size || !visible()) return;
    timer = setTimeout(() => { void read(false); }, Math.min(base * 2 ** failures, options.maxPollMs ?? base * 4));
  };
  const read = (explicit: boolean): Promise<void> => {
    dirty = true;
    // Automatic work waits for visibility. Explicit action reads must still
    // complete with fresh data (OAuth completion and plugin reconciliation).
    if (!explicit && !visible()) return Promise.resolve();
    if (request) { queued = true; queuedExplicit ||= explicit; return request; }
    refreshAfterCurrent = false;
    clearTimeout(timer); clearTimeout(throttle); throttle = undefined;
    startedAt = Date.now();
    const current = generation;
    dirty = false;
    publish({ ...snapshot, loading: options.trackRefresh === true || snapshot.data === undefined });
    request = (async () => {
      try {
        const data = await options.load();
        if (current !== generation) return;
        if (!visible()) { dirty = true; if (!explicit) return; }
        failures = 0;
        lastSuccessfulAt = Date.now();
        publish({ data, error: null, updatedAt: lastSuccessfulAt, loading: false });
      } catch (error) {
        if (current !== generation) return;
        if (!visible()) { dirty = true; if (!explicit) return; }
        failures++;
        publish({ ...snapshot, error: error instanceof Error ? error.message : String(error), loading: false });
      }
    })().finally(async () => {
      request = null;
      if (queuedExplicit || ((queued || refreshAfterCurrent) && visible())) {
        const explicitNext = queuedExplicit;
        queued = false; queuedExplicit = false; refreshAfterCurrent = false;
        await read(explicitNext);
      }
      else if (!visible()) queued = false;
      else poll();
    });
    return request;
  };
  const invalidateAfter = (eventDelayMs: number) => {
    dirty = true;
    if (request && !visible()) refreshAfterCurrent = true;
    if (!listeners.size || !visible()) return;
    const delay = Math.max(eventDelayMs, (options.minIntervalMs ?? 0) - (Date.now() - startedAt));
    if (delay) {
      throttle ??= setTimeout(() => { throttle = undefined; void read(false); }, delay);
    } else void read(false);
  };
  const invalidate = () => invalidateAfter(0);
  const invalidateFromEvent = () => invalidateAfter(options.eventDelayMs ?? 0);
  const onVisible = () => {
    if (!visible()) {
      clearTimeout(timer); clearTimeout(throttle); throttle = undefined;
      // Automatic completions while hidden are discarded; shared sources
      // refresh once on resume to cover changes without events.
      // Infinity opts component-owned queries/session checks out of implicit
      // resume reads; their owner or the existing polling cadence refreshes them.
      if (options.focusMs !== Infinity || request) dirty = true;
      if (request) refreshAfterCurrent = true;
      return;
    }
    if (request || throttle) return;
    if (dirty || Date.now() - lastSuccessfulAt > (options.focusMs ?? 30_000)) invalidate();
    else poll();
  };
  const onFocus = () => {
    if (!visible() || request || throttle) return;
    if (Date.now() - lastSuccessfulAt > (options.focusMs ?? 30_000)) invalidate();
  };
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    if (listeners.size === 1) {
      let disposed = false;
      const stops: Array<() => void> = [];
      for (const event of options.events ?? []) {
        void listen<unknown>(event, e => { if (!options.eventFilter || options.eventFilter(e.payload)) invalidateFromEvent(); }).then(stop => { if (disposed) stop(); else stops.push(stop); }).catch(error => {
          if (!disposed) publish({ ...snapshot, error: String(error), loading: false });
        });
      }
      const customStop = options.subscribeEvents?.(invalidateFromEvent);
      stopEvents = () => { disposed = true; stops.forEach(stop => stop()); customStop?.(); };
      stopActivity = windowActivity.subscribe(onVisible);
      if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
      if (dirty || !lastSuccessfulAt) { if (!request && visible()) void read(false); }
      else poll();
    }
    return () => {
      listeners.delete(fn);
      if (listeners.size) return;
      clearTimeout(timer); clearTimeout(throttle); throttle = undefined;
      queued = queuedExplicit; refreshAfterCurrent = false;
      stopEvents?.();
      stopActivity?.(); stopActivity = undefined;
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
    };
  };
  return {
    getSnapshot: () => snapshot, subscribe, refresh: () => read(true), invalidate,
    load: () => !visible() && (request || dirty || !lastSuccessfulAt)
      ? read(true) : request ?? (dirty || !lastSuccessfulAt ? read(true) : Promise.resolve()),
    mutate(updater: (data: T | undefined) => T) {
      generation++;
      lastSuccessfulAt = Date.now();
      publish({ data: updater(snapshot.data), error: null, updatedAt: lastSuccessfulAt, loading: false });
      failures = 0;
    },
    reset() {
      generation++; failures = 0; lastSuccessfulAt = 0; dirty = true; queued = !!request && listeners.size > 0;
      refreshAfterCurrent = false; queuedExplicit = false;
      clearTimeout(timer); clearTimeout(throttle); throttle = undefined;
      publish(initial);
      if (listeners.size && !request) void read(false);
    },
  };
}
export type DataSource<T> = ReturnType<typeof createDataSource<T>>;
const noopSubscribe = () => () => {};
export function useDataSource<T>(source: DataSource<T>, enabled = true) {
  return useSyncExternalStore(enabled ? source.subscribe : noopSubscribe, source.getSnapshot, source.getSnapshot);
}
