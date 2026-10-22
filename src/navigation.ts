import type { MessageKey } from './i18n/resources';

const alwaysAvailablePages = new Set(['easy', 'home', 'versions', 'config', 'usage-records', 'agents']);

export function isAlwaysAvailablePage(pageId: string) {
  return alwaysAvailablePages.has(pageId);
}

export function canOpenAppPage(pageId: string, coreReady: boolean) {
  return coreReady || isAlwaysAvailablePage(pageId);
}

// Usage history is recorded by the app on the core's computer, so Remote mode reads it only through a reachable
// remote host control. Version Management stays open: this app's own updates are this computer's.
export function isRemoteDisabledPage(pageId: string, remoteHostControl = false) {
  return pageId === 'usage-records' && !remoteHostControl;
}

export const remoteDisabledReason: MessageKey = 'connection.remoteUsage';

export const APP_NAVIGATION_REQUEST_EVENT = 'cpa-gui-navigation-request';

export type AppNavigationRequest = CustomEvent<() => void>;

export function requestAppNavigation(navigate: () => void) {
  const event: AppNavigationRequest = new CustomEvent(APP_NAVIGATION_REQUEST_EVENT, {
    cancelable: true,
    detail: navigate,
  });
  if (window.dispatchEvent(event)) navigate();
}
