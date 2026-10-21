import { invoke } from './platform';

export type WebviewBounds = { x: number; y: number; width: number; height: number; viewportHeight: number };

export const EMPTY_BOUNDS: WebviewBounds = { x: 0, y: 0, width: 0, height: 0, viewportHeight: 0 };

export const roundBounds = ({ left, top, width, height }: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, viewportHeight: number): WebviewBounds => ({
  x: Math.max(0, Math.round(left)),
  y: Math.max(0, Math.round(top)),
  width: Math.max(0, Math.round(width)),
  height: Math.max(0, Math.round(height)),
  viewportHeight: Math.max(0, Math.round(viewportHeight)),
});

export const hasArea = (bounds: WebviewBounds): boolean => bounds.width > 0 && bounds.height > 0;

export const sameBounds = (a: WebviewBounds, b: WebviewBounds): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.viewportHeight === b.viewportHeight;

export const effectiveBounds = ({ active, overlay, bounds }: { active: boolean; overlay: boolean; bounds: WebviewBounds }): WebviewBounds =>
  active && !overlay && hasArea(bounds) ? bounds : EMPTY_BOUNDS;

let lastToken = 0;

export const newWebviewToken = (): number => {
  lastToken = Math.max(lastToken + 1, Date.now() * 1000);
  return lastToken;
};

export type PluginWebviewLabels = { back: string; reload: string; openExternal: string; move: string };

type BoundsSender = (bounds: WebviewBounds, token: number) => Promise<unknown>;
type FrameScheduler = (callback: FrameRequestCallback) => number;

export function createBoundsUpdater(send: BoundsSender, scheduleFrame: FrameScheduler) {
  let lastSent: { bounds: WebviewBounds; token: number } | undefined;
  let pending: { bounds: WebviewBounds; token: number; force: boolean } | undefined;
  let waiters: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = [];
  let scheduled = false;
  let sending = false;

  const flush = () => {
    scheduled = false;
    if (sending) return;
    const next = pending;
    const currentWaiters = waiters;
    pending = undefined;
    waiters = [];
    if (!next) {
      currentWaiters.forEach(({ resolve }) => resolve());
      return;
    }
    if (!next.force && lastSent?.token === next.token && sameBounds(lastSent.bounds, next.bounds)) {
      currentWaiters.forEach(({ resolve }) => resolve());
      return;
    }
    sending = true;
    void send(next.bounds, next.token).then(() => {
      lastSent = next;
      currentWaiters.forEach(({ resolve }) => resolve());
    }, (reason) => currentWaiters.forEach(({ reject }) => reject(reason))).finally(() => {
      sending = false;
      if (pending && !scheduled) {
        scheduled = true;
        scheduleFrame(flush);
      }
    });
  };

  return {
    update(bounds: WebviewBounds, token: number, force = false): Promise<void> {
      pending = { bounds, token, force: force || (pending?.token === token && pending.force) };
      const result = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
      if (!scheduled) {
        scheduled = true;
        scheduleFrame(flush);
      }
      return result;
    },
    markApplied(bounds: WebviewBounds, token: number) {
      lastSent = { bounds, token };
    },
  };
}

const boundsUpdater = createBoundsUpdater(
  (bounds, token) => invoke('set_plugin_webview_bounds', { bounds, token }),
  (callback) => requestAnimationFrame(callback),
);

export const showPluginWebview = (args: { pluginId: string; menuIndex: number; bounds: WebviewBounds; labels: PluginWebviewLabels; reload: boolean; token: number }) => {
  // The native side places the webview from these bounds as soon as the show starts, so later
  // updates can be compared against them while the show is still in flight.
  boundsUpdater.markApplied(args.bounds, args.token);
  return invoke<string>('show_plugin_webview', args);
};
export const setPluginWebviewBounds = (bounds: WebviewBounds, token: number, force = false) => boundsUpdater.update(bounds, token, force);
export const hidePluginWebview = (token: number) => invoke('hide_plugin_webview', { token });
export const closePluginWebview = () => invoke('close_plugin_webview');
