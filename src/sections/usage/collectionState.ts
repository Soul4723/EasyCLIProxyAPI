import type { CollectorStatus } from './types';

/** The slice of the shared core status (useCoreRuntime) that decides whether collection can run. */
export type CoreReach = {
  ready: boolean;
  starting?: boolean;
  connectionMode?: 'local' | 'remote';
};

/**
 * What the Usage header says about collection. Stored history is shown in every kind;
 * only `collecting` may be styled as live.
 */
export type CollectionKind =
  | 'unknown'      // neither status loaded yet
  | 'collecting'   // core reachable and the collector is running
  | 'starting'     // core is starting; nothing collected yet
  | 'stopped'      // local core not running
  | 'unreachable'  // remote core not reachable
  | 'paused'       // collector paused (needs resume)
  | 'error';       // collector failed

export type CollectionState = {
  kind: CollectionKind;
  /** True only while records are really being collected. */
  live: boolean;
  /** ISO time of the last stored record the collector wrote, if known. */
  lastCollectedAt: string | null;
  /** True while the shared core status says the core is not ready, whatever the collector says: core-derived live state is stale. */
  coreDown: boolean;
};

/**
 * Combines the collector status with the shared core status. The collector status is polled slower than the
 * core status, so a stopped core wins over a stale "collecting".
 */
export function deriveCollectionState(collector: CollectorStatus | null, core: CoreReach | null): CollectionState {
  const lastCollectedAt = collector?.lastCollectedAt ?? null;
  const coreDown = Boolean(core && !core.ready);
  const done = (kind: CollectionKind): CollectionState => ({ kind, live: kind === 'collecting', lastCollectedAt, coreDown });
  if (!collector && !core) return done('unknown');
  if (core && !core.ready) {
    if (core.starting) return done('starting');
    return done(core.connectionMode === 'remote' ? 'unreachable' : 'stopped');
  }
  if (collector?.state === 'error') return done('error');
  if (collector?.state === 'paused') return done('paused');
  if (!collector) return done('unknown');
  if (collector.state === 'collecting') return done('collecting');
  // Core is reachable but the collector has not attached yet.
  return done('starting');
}

/** "14:02" for today, "Oct 17, 14:02" for earlier days; null when the time is unknown or invalid. */
export function formatRecordTime(iso: string | null, now: Date = new Date(), locale?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const sameDay = date.toDateString() === now.toDateString();
  return date.toLocaleString(locale, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
