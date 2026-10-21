import { invoke, isTauri, listen } from './platform';
import { startActivePolling } from './activePolling';

// Standalone fixtures and browser tests are active unless the browser visibility
// adapter is explicitly initialized. Native startup replaces this with the
// window's visibility state before rendering the application.
let active = true;
let nativeActivity = false;
const listeners = new Set<() => void>();
const publish = (value: boolean) => {
  if (active === value) return;
  active = value;
  listeners.forEach(listener => listener());
};

export const windowActivity = {
  active: () => active,
  native: () => nativeActivity,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

export const pollWhileActive = (refresh: () => void, interval: number, pause?: () => void) =>
  startActivePolling(windowActivity, refresh, interval, pause);

let initialization: Promise<void> | undefined;

// One application-lifetime subscription. Native visibility avoids treating an
// unfocused/occluded window on a second monitor as hidden (#493). Browser-only
// use (including fixtures) falls back to Page Visibility.
export function initializeWindowActivity(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    if (!isTauri()) {
      if (typeof document !== 'undefined') {
        const update = () => publish(!document.hidden);
        document.addEventListener('visibilitychange', update);
        update();
      }
      return;
    }

    nativeActivity = true;
    let revision = 0;
    try {
      await listen<boolean>('main-window-activity', ({ payload }) => { ++revision; publish(payload); });
      const before = revision;
      const initial = await invoke<boolean>('main_window_active');
      if (revision === before) publish(initial);
    } catch (error) {
      // A visibility-query failure must not prevent the application from starting.
      console.error('Failed to initialize window activity', error);
      if (revision === 0) publish(true);
    }
  })();
  return initialization;
}
