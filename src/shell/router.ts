import { useSyncExternalStore } from 'react';
import { APP_NAVIGATION_REQUEST_EVENT, requestAppNavigation } from '../navigation';

/**
 * Hash router: `#/<page>[/<sub>][?k=v&…]`, e.g. `#/quota`, `#/usage/requests`, `#/settings/connection`.
 * Every in-app navigation goes through requestAppNavigation, so unsaved-changes guards
 * (the cancelable `cpa-gui-navigation-request` event) keep working for links, back/forward and typed hashes.
 */
export type Route = {
  page: string;
  sub: string | null;
  params: URLSearchParams;
  /** Normalised `/page/sub?query` (no leading `#`). */
  path: string;
};

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart, ...queryParts] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  const params = new URLSearchParams(queryParts.join('?'));
  const [page = '', sub = null] = segments;
  const query = params.toString();
  const path = `/${[page, sub].filter(Boolean).join('/')}${query ? `?${query}` : ''}`;
  return { page, sub, params, path };
}

export function routePath(page: string, sub?: string | null, params?: Record<string, string | undefined> | URLSearchParams): string {
  const query = new URLSearchParams();
  if (params instanceof URLSearchParams) params.forEach((value, key) => query.set(key, value));
  else for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined) query.set(key, value);
  const q = query.toString();
  return `/${[page, sub].filter(Boolean).map((segment) => encodeURIComponent(segment as string)).join('/')}${q ? `?${q}` : ''}`;
}

/** `href` for anchors: `href={routeHref('usage', 'requests')}`. */
export function routeHref(page: string, sub?: string | null, params?: Record<string, string | undefined>): string {
  return `#${routePath(page, sub, params)}`;
}

const listeners = new Set<() => void>();
let committed: Route = parseRoute(typeof window === 'undefined' ? '' : window.location.hash);
let started = false;

function emit() {
  listeners.forEach((listener) => listener());
}

function commit(route: Route) {
  if (committed.path === route.path) return;
  committed = route;
  emit();
}

/** Replaces the URL without a history entry or a guard check (redirects, gating). */
export function replaceRoute(path: string) {
  const next = parseRoute(path);
  window.history.replaceState(null, '', `#${next.path}`);
  commit(next);
}

/** Navigates to `/page/sub?query` through the navigation guard; resolves false when a guard cancelled/deferred it. */
export function navigate(path: string, options: { replace?: boolean } = {}) {
  const next = parseRoute(path);
  if (next.path === committed.path) return;
  requestAppNavigation(() => {
    if (options.replace) window.history.replaceState(null, '', `#${next.path}`);
    else window.location.hash = next.path;
    commit(next);
  });
}

function onHashChange() {
  const next = parseRoute(window.location.hash);
  if (next.path === committed.path) return;
  const target = committed;
  let allowed = true;
  const probe = new CustomEvent(APP_NAVIGATION_REQUEST_EVENT, {
    cancelable: true,
    detail: () => commit(parseRoute(window.location.hash)),
  });
  allowed = window.dispatchEvent(probe);
  if (allowed) commit(next);
  else window.history.replaceState(null, '', `#${target.path}`);
}

function onClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as Element | null)?.closest?.('a[href^="#/"]') as HTMLAnchorElement | null;
  if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
  event.preventDefault();
  navigate(anchor.getAttribute('href')!.slice(1));
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('click', onClick);
  committed = parseRoute(window.location.hash);
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function currentRoute(): Route {
  return committed;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, currentRoute, currentRoute);
}

/** Test/HMR hook: forget listeners and re-read the hash. */
export function resetRouterForTests(hash = '') {
  listeners.clear();
  committed = parseRoute(hash);
}
