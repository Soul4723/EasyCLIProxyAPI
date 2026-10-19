import { createDataSource } from './dataSource';

/**
 * Explicit-read owner for Settings drafts and visit-triggered metadata. Unlike live
 * views, these consumers must not refresh on focus or overwrite an unsaved draft.
 * Mount reads share one request; event/action reads pass fresh:true to queue a
 * follow-up if a read is already running. Authoritative results publish through
 * mutate so older responses cannot replace them. No subscription means no polling,
 * focus listener, or idle IPC.
 * The caller still owns draft application, notifications, and request guards.
 */
export function createSettingsRead<T>(load: () => Promise<T>) {
  const source = createDataSource({ load });
  let pending: Promise<T> | undefined;
  return {
    read(options?: { fresh?: boolean }): Promise<T> {
      if (pending && !options?.fresh) return pending;
      const next = source.refresh().then(() => {
        const snapshot = source.getSnapshot();
        if (snapshot.error !== null) throw new Error(snapshot.error);
        return snapshot.data as T;
      }).finally(() => { if (pending === next) pending = undefined; });
      pending = next;
      return next;
    },
    publish(value: T) { source.mutate(() => value); },
  };
}
