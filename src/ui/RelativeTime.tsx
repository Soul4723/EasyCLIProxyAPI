/**
 * RelativeTime, Countdown, useNow, formatDurationParts: time display helpers.
 *
 * RelativeTime: "5m ago" / "in 2h 10m" / "now" / "Never" (for null). Props: value (Date | ms | ISO string | null),
 *   now? (ms, overrides the live clock), fallback? (text for null, default t('ui.time.never')), className.
 *   Renders <time> with dateTime and a title holding the absolute local date.
 * Countdown: "1h 48m" / "3d 6h" / "22m" / "45s". Props: to (same input), compact? (largest unit only),
 *   onDone? (called once when the target passes), className. Ticks every second under 1h, every 30s above.
 * useNow(intervalMs = 30000): shared clock. One timer per interval, shared by every subscriber.
 * formatDurationParts(ms, t, maxParts = 2): pure, takes a translate function (see uiText.ts).
 *
 * Self-check (not executed): formatDurationParts(6480000, t) -> "1h 48m"; (3*86400000 + 6*3600000) -> "3d 6h";
 * (22*60000) -> "22m"; (45000) -> "45s"; (0) -> "0s".
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useI18n } from '../i18n';
import { formatDurationParts } from '../services/format';
import { countdownIntervalMs } from '../services/relativeTimeClock';
import { startVisibleInterval } from '../services/refreshTiming';
import { cx } from './cx';
import { useUiText } from './uiText';
import './RelativeTime.css';

const MINUTE_MS = 60_000;

export type TimeInput = Date | number | string | null | undefined;

export function toTimestamp(value: TimeInput): number | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

type TickEntry = { now: number; listeners: Set<() => void>; stop: (() => void) | null };
const tickEntries = new Map<number, TickEntry>();

function entryFor(intervalMs: number): TickEntry {
  let entry = tickEntries.get(intervalMs);
  if (!entry) {
    entry = { now: Date.now(), listeners: new Set(), stop: null };
    tickEntries.set(intervalMs, entry);
  }
  return entry;
}

function subscribeTick(intervalMs: number, listener: () => void): () => void {
  const entry = entryFor(intervalMs);
  const isFirstListener = entry.listeners.size === 0;
  entry.listeners.add(listener);
  if (isFirstListener) {
    entry.now = Date.now();
    const tick = () => {
      entry.now = Date.now();
      entry.listeners.forEach((notify) => notify());
    };
    entry.stop = startVisibleInterval(tick, intervalMs, tick);
  }
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && entry.stop !== null) {
      entry.stop();
      entry.stop = null;
    }
  };
}

/** Shared wall clock (ms). Components with the same interval share one timer. */
export function useNow(intervalMs = 30_000): number {
  const subscribe = useCallback((listener: () => void) => subscribeTick(intervalMs, listener), [intervalMs]);
  const getSnapshot = useCallback(() => entryFor(intervalMs).now, [intervalMs]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export type RelativeTimeProps = {
  value: TimeInput;
  now?: number;
  fallback?: string;
  className?: string;
};

export function RelativeTime({ value, now, fallback, className }: RelativeTimeProps) {
  const tick = useNow(30_000);
  const { formatDate } = useI18n();
  const tu = useUiText();
  const target = toTimestamp(value);

  if (target === null) {
    return <span className={cx('ec-relative-time', className)}>{fallback ?? tu('ui.time.never')}</span>;
  }

  const diff = target - (now ?? tick);
  let text: string;
  if (Math.abs(diff) < MINUTE_MS) text = tu('ui.time.now');
  else if (diff < 0) text = tu('ui.time.ago', { value: formatDurationParts(-diff, tu) });
  else text = tu('ui.time.in', { value: formatDurationParts(diff, tu) });

  return (
    <time
      className={cx('ec-relative-time', className)}
      dateTime={new Date(target).toISOString()}
      title={formatDate(target, { dateStyle: 'medium', timeStyle: 'medium' })}
    >
      {text}
    </time>
  );
}

export type CountdownProps = {
  to: TimeInput;
  compact?: boolean;
  onDone?: () => void;
  className?: string;
};

export function Countdown({ to, compact = false, onDone, className }: CountdownProps) {
  const target = toTimestamp(to);
  const coarse = useNow(30_000);
  const remainingEstimate = target === null ? Infinity : target - coarse;
  // Fine ticks only while the target is under an hour away; once it has passed, fall back to the coarse clock.
  const fine = useNow(countdownIntervalMs(remainingEstimate));
  const tu = useUiText();
  const onDoneRef = useRef(onDone);

  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const left = target === null ? null : target - fine;
  const done = left !== null && left <= 0;

  useEffect(() => {
    if (done) onDoneRef.current?.();
  }, [done]);

  if (left === null) {
    return <span className={cx('ec-countdown', className)}>—</span>;
  }

  return (
    <span className={cx('ec-countdown', className)}>
      {formatDurationParts(Math.max(0, left), tu, compact ? 1 : 2)}
    </span>
  );
}
