import { useSyncExternalStore } from 'react';

export type Density = 'comfortable' | 'compact';

const STORAGE_KEY = 'easy-cli-proxy-api.density';
const listeners = new Set<() => void>();

function read(): Density {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

let current: Density = typeof window === 'undefined' ? 'comfortable' : read();

function apply(density: Density) {
  document.documentElement.dataset.density = density;
}

/** Applies the persisted density to the document; call once at startup (the first-paint script already did most of it). */
export function initializeDensity() {
  apply(current);
}

export function setDensity(next: Density) {
  if (next === current) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
  }
  apply(next);
  listeners.forEach((listener) => listener());
}

export function useDensity() {
  const density = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
    () => current,
  );
  return [density, setDensity] as const;
}
