import { useEffect, useRef } from 'react';
import { listen } from './platform';
import { windowActivity } from './windowActivity';

/** A fixed trailing window: the first event starts it; later events never move it.
 * Hidden windows retain one pending refresh and consume it immediately on resume.
 */
export function subscribeFixedWindowEvent(
  event: string,
  delayMs: number,
  refresh: () => void,
  onError: (error: unknown) => void,
  subscribe = listen,
) {
  let disposed = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unlisten: (() => void) | undefined;
  const schedule = () => {
    if (!pending || timer !== undefined || !windowActivity.active()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || !pending) return;
      if (!windowActivity.active()) return;
      pending = false;
      refresh();
    }, delayMs);
  };
  const stopActivity = windowActivity.subscribe(() => {
    if (!windowActivity.active()) {
      clearTimeout(timer);
      timer = undefined;
    } else if (pending) {
      // If a trailing window was interrupted by hiding, do one catch-up refresh.
      pending = false;
      refresh();
    }
  });
  void subscribe(event, () => {
    if (disposed) return;
    if (!pending) pending = true;
    schedule();
  }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(error => { if (!disposed) onError(error); });
  return {
    pending: () => pending,
    stop() {
      if (disposed) return;
      disposed = true; clearTimeout(timer); stopActivity(); unlisten?.();
    },
  };
}

/** No initial or catch-up interval tick. Hidden time does not count toward the next interval. */
export function startVisibleInterval(tick: () => void, intervalMs: number, onVisible?: () => void) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let initialized = false;
  let wasActive = false;
  const update = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    const active = windowActivity.active();
    if (active) {
      if (initialized && !wasActive) onVisible?.();
      timer = setInterval(tick, intervalMs);
    }
    wasActive = active;
    initialized = true;
  };
  const unsubscribe = windowActivity.subscribe(update);
  update();
  return () => { if (timer !== undefined) clearInterval(timer); unsubscribe(); };
}

/** Runs only while enabled and in an active native/browser window. */
export function useVisibleInterval(tick: () => void, intervalMs: number, enabled: boolean) {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    if (enabled) return startVisibleInterval(() => latest.current(), intervalMs);
  }, [intervalMs, enabled]);
}

/** One freshness owner. Query changes and explicit refreshes call markFresh without invalidating again. */
export function startStaleFocusRefresh(refresh: () => void, staleMs: number, pending: () => boolean) {
  let refreshedAt = Date.now();
  let wasActive = windowActivity.active();
  let freshRevision = 0;
  let freshRevisionAtHide = freshRevision;
  const markFresh = () => { refreshedAt = Date.now(); freshRevision++; };
  const onActivity = () => {
    const active = windowActivity.active();
    if (!active && wasActive) {
      freshRevisionAtHide = freshRevision;
    } else if (active && !wasActive && !pending()) {
      const needsRefresh = windowActivity.native()
        ? freshRevision === freshRevisionAtHide
        : Date.now() - refreshedAt > staleMs;
      if (needsRefresh) {
        markFresh();
        refresh();
      }
    }
    wasActive = active;
  };
  const unsubscribe = windowActivity.subscribe(onActivity);
  const onFocus = () => {
    if (!windowActivity.active() || pending() || Date.now() - refreshedAt <= staleMs) return;
    markFresh();
    refresh();
  };
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
  return { markFresh, stop() {
    unsubscribe();
    if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
  } };
}
