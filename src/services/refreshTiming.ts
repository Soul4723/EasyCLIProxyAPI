import { useEffect, useRef } from 'react';
import { listen } from './platform';

/** A fixed trailing window: the first event starts it; later events never move it. */
export function subscribeFixedWindowEvent(
  event: string,
  delayMs: number,
  refresh: () => void,
  onError: (error: unknown) => void,
  subscribe = listen,
) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unlisten: (() => void) | undefined;
  void subscribe(event, () => {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; refresh(); }, delayMs);
  }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(error => { if (!disposed) onError(error); });
  return {
    pending: () => timer !== undefined,
    stop() {
      if (disposed) return;
      disposed = true; clearTimeout(timer); unlisten?.();
    },
  };
}

/** No initial or catch-up interval tick. Hidden time does not count toward the next interval. */
export function startVisibleInterval(tick: () => void, intervalMs: number, onVisible?: () => void) {
  if (typeof document === 'undefined') {
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let initialized = false;
  const onVisibility = () => {
    clearInterval(timer);
    timer = undefined;
    if (initialized && !document.hidden) onVisible?.();
    initialized = true;
    if (!document.hidden) {
      timer = setInterval(tick, intervalMs);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
}

/** Runs only while enabled and visible; callback changes do not restart its clock. */
export function useVisibleInterval(tick: () => void, intervalMs: number, enabled: boolean) {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    if (enabled) return startVisibleInterval(() => latest.current(), intervalMs);
  }, [intervalMs, enabled]);
}

/** One focus owner. Query changes and explicit refreshes call markFresh without invalidating again. */
export function startStaleFocusRefresh(refresh: () => void, staleMs: number, pending: () => boolean) {
  let refreshedAt = Date.now();
  const markFresh = () => { refreshedAt = Date.now(); };
  const onFocus = () => {
    if (document.hidden || pending() || Date.now() - refreshedAt <= staleMs) return;
    markFresh();
    refresh();
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  return {
    markFresh,
    stop() { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); },
  };
}
