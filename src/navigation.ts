import type { MessageKey } from './i18n/resources';

const alwaysAvailablePages = new Set(['easy', 'home', 'versions', 'config', 'usage-records', 'agents']);

export function isAlwaysAvailablePage(pageId: string) {
  return alwaysAvailablePages.has(pageId);
}

export function canOpenAppPage(pageId: string, coreReady: boolean) {
  return coreReady || isAlwaysAvailablePage(pageId);
}

// Version Management works remotely through a reachable remote host control.
export function isRemoteDisabledPage(pageId: string, remoteHostControl = false) {
  if (['usage-records', 'versions'].includes(pageId) && remoteHostControl) return false;
  return ['usage-records', 'versions'].includes(pageId);
}

// Why a page is locked in Remote mode (see isRemoteDisabledPage).
export function remoteDisabledReason(pageId: string): MessageKey {
  return pageId === 'versions' ? 'connection.remoteVersions' : 'connection.remoteUsage';
}

export const APP_NAVIGATION_REQUEST_EVENT = 'cpa-gui-navigation-request';

export type AppNavigationRequest = CustomEvent<() => void>;

export function requestAppNavigation(navigate: () => void) {
  const event: AppNavigationRequest = new CustomEvent(APP_NAVIGATION_REQUEST_EVENT, {
    cancelable: true,
    detail: navigate,
  });
  if (window.dispatchEvent(event)) navigate();
}
