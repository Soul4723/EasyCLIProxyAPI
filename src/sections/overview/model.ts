// Pure view-model builders for the Overview: needs-action rows, coming-up events, per-provider quota %.
// Inputs are the real service shapes (credentials list, quota cache, lighting schedules); nothing is fetched here.
import { authFileHealth, normalizeAuthFileCooldowns, summarizeAuthFileCooldowns } from '../../services/authFileHealth';
import { authFileIdentities, authFileName, type AuthFileRecord } from '../../services/authFiles';
import { normalizeAuthIndex, readString } from '../../services/managementApi';
import { providerForFile, quotaKey, type QuotaState } from '../../services/quotaService';
import type { LightingSchedule } from '../../services/lighting';
import { providerInfo, type ProviderId } from '../../ui/providers';

export type NeedsKind = 'expired' | 'error' | 'exhausted' | 'cooldown' | 'light';

export type NeedsAction = {
  id: string;
  kind: NeedsKind;
  provider: ProviderId;
  /** Raw account label (email / file name); render through <Masked/>. */
  account: string;
  identities: string[];
  /** Short detail: reason text from the core, HTTP status, or window label. Never an explanatory sentence. */
  detail: string;
  /** Short status-vocabulary reason shown instead of a raw message (the raw text goes to the tooltip). */
  reason: 'signIn' | 'unavailable' | 'fetchFailed' | null;
  /** Raw core/quota message for the tooltip. */
  raw: string;
  /** Epoch ms of the retry/reset time when known. */
  at: number | null;
  /** Hash route that owns the item. */
  to: { page: 'quota' | 'providers'; params: Record<string, string> };
};

export type ComingKind = 'reset' | 'cooldown' | 'light';

export type ComingUp = {
  id: string;
  kind: ComingKind;
  provider: ProviderId;
  account: string;
  identities: string[];
  /** Window label (5h, Weekly …) or light summary key. */
  detail: string;
  /** Identical resets (same provider, window, minute) collapsed into one row. */
  count: number;
  at: number;
  to: { page: 'quota'; params: Record<string, string> };
};

export type ProviderQuotaSummary = {
  provider: ProviderId;
  accounts: number;
  fetched: number;
  /** Average of each fetched account's tightest window; null when nothing is fetched. */
  leftPct: number | null;
};

export const NEEDS_ORDER: readonly NeedsKind[] = ['expired', 'error', 'exhausted', 'cooldown', 'light'];

const EXPIRED_MARKERS = /token[_ ]expired|invalid[_ ]grant|unauthorized|sign in again|re-?login|login expired|expired/i;

export const accountLabel = (file: AuthFileRecord): string =>
  readString(file, 'email', 'label', 'account', 'name') || authFileName(file);

const credentialRoute = (file: AuthFileRecord): Record<string, string> => ({
  cred: normalizeAuthIndex(file.auth_index ?? file.authIndex) || authFileName(file),
});

const providerOf = (file: AuthFileRecord): ProviderId =>
  providerInfo(providerForFile(file) ?? readString(file, 'provider', 'type')).id;

/** Tightest remaining % across a quota state's windows, or null when none has a number. */
export function tightestLeft(quota: QuotaState | undefined): number | null {
  const values = (quota?.rows ?? []).map((row) => row.remainingPercent).filter((value): value is number => typeof value === 'number');
  return values.length ? Math.min(...values) : null;
}

export function summarizeProviders(files: AuthFileRecord[], quotas: Record<string, QuotaState>): ProviderQuotaSummary[] {
  const groups = new Map<ProviderId, { accounts: number; values: number[] }>();
  for (const file of files) {
    if (authFileHealth(file).disabled) continue;
    const quotaProvider = providerForFile(file);
    if (!quotaProvider) continue;
    const provider = providerInfo(quotaProvider).id;
    const group = groups.get(provider) ?? { accounts: 0, values: [] };
    group.accounts += 1;
    const left = quotas[quotaKey(file)]?.status === 'success' ? tightestLeft(quotas[quotaKey(file)]) : null;
    if (left !== null) group.values.push(left);
    groups.set(provider, group);
  }
  return [...groups.entries()].map(([provider, group]) => ({
    provider,
    accounts: group.accounts,
    fetched: group.values.length,
    leftPct: group.values.length ? Math.round(group.values.reduce((sum, value) => sum + value, 0) / group.values.length) : null,
  }));
}

function activeCooldown(file: AuthFileRecord, nowMs: number, receivedAtMs: number) {
  const snapshot = normalizeAuthFileCooldowns(file.cooldowns, receivedAtMs);
  const summary = summarizeAuthFileCooldowns(snapshot, nowMs);
  return summary;
}

const lightFor = (file: AuthFileRecord, schedules: LightingSchedule[]) => {
  const index = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  const name = authFileName(file);
  return schedules.filter((schedule) =>
    (index && schedule.credential.authIndex === index) || schedule.credential.authFileName === name);
};

export function buildNeedsAction(
  files: AuthFileRecord[],
  quotas: Record<string, QuotaState>,
  schedules: LightingSchedule[],
  nowMs: number,
  receivedAtMs: number = nowMs,
): NeedsAction[] {
  const rows: NeedsAction[] = [];
  for (const file of files) {
    const health = authFileHealth(file);
    if (health.disabled) continue;
    const base = {
      provider: providerOf(file), account: accountLabel(file), identities: authFileIdentities(file),
    };
    const quota = quotas[quotaKey(file)];
    const cooldown = activeCooldown(file, nowMs, receivedAtMs);
    const quotaLeft = quota?.status === 'success' ? tightestLeft(quota) : null;
    const exhaustedRow = quota?.rows.find((row) => row.remainingPercent !== null && row.remainingPercent <= 0);
    const quotaCooldown = cooldown.active.find(({ record }) => record.reason === 'quota' || record.reason === 'credential_quota');
    const text = `${health.status} ${health.message}`;
    let kind: NeedsKind | null = null;
    let detail = '';
    let reason: NeedsAction['reason'] = null;
    let raw = '';
    let at: number | null = null;
    let page: NeedsAction['to']['page'] = 'quota';
    if (health.tone === 'error' && EXPIRED_MARKERS.test(text)) {
      kind = 'expired'; raw = health.message; reason = 'signIn'; page = 'providers';
    } else if (health.tone === 'error' || quota?.status === 'error') {
      kind = 'error'; raw = health.message || quota?.error || '';
      reason = health.tone === 'error' ? 'unavailable' : 'fetchFailed';
    } else if (quotaLeft !== null && quotaLeft <= 0 && exhaustedRow || quotaCooldown) {
      kind = 'exhausted';
      detail = exhaustedRow?.label ?? quotaCooldown?.record.model ?? '';
      at = exhaustedRow?.resetAtMs ?? (quotaCooldown ? Date.parse(quotaCooldown.record.retryAt) : null);
    } else if (cooldown.credentialWide || cooldown.active.length > 0) {
      kind = 'cooldown';
      const first = [...cooldown.active].sort((a, b) => a.remainingSeconds - b.remainingSeconds)[0];
      detail = first.record.httpStatus ? `HTTP ${first.record.httpStatus}` : (first.record.model ?? '');
      at = Date.parse(first.record.retryAt);
    }
    if (kind) {
      rows.push({
        id: `${kind}:${quotaKey(file)}`, kind, ...base, detail, reason, raw,
        at: at !== null && Number.isFinite(at) ? at : null,
        to: { page, params: credentialRoute(file) },
      });
    }
    for (const schedule of lightFor(file, schedules)) {
      if (!schedule.enabled || !schedule.lastRun || schedule.lastRun.ok) continue;
      rows.push({
        id: `light:${schedule.id}`, kind: 'light', ...base, reason: null, raw: schedule.lastRun.message,
        detail: schedule.lastRun.httpStatus ? `HTTP ${schedule.lastRun.httpStatus}` : '',
        at: schedule.lastRun.at,
        to: { page: 'quota', params: credentialRoute(file) },
      });
    }
  }
  return rows.sort((a, b) => NEEDS_ORDER.indexOf(a.kind) - NEEDS_ORDER.indexOf(b.kind));
}

export function buildComingUp(
  files: AuthFileRecord[],
  quotas: Record<string, QuotaState>,
  schedules: LightingSchedule[],
  nowMs: number,
  receivedAtMs: number = nowMs,
): ComingUp[] {
  const events: ComingUp[] = [];
  for (const file of files) {
    if (authFileHealth(file).disabled) continue;
    const base = { provider: providerOf(file), account: accountLabel(file), identities: authFileIdentities(file) };
    const to = { page: 'quota' as const, params: credentialRoute(file) };
    const quota = quotas[quotaKey(file)];
    if (quota?.status === 'success') {
      for (const row of quota.rows) {
        // A full window has nothing to wait for; only windows that were started are interesting.
        if (row.resetAtMs && row.resetAtMs > nowMs && row.remainingPercent !== null && row.remainingPercent < 100) {
          events.push({ id: `reset:${quotaKey(file)}:${row.label}`, kind: 'reset', ...base, detail: row.label, count: 1, at: row.resetAtMs, to });
        }
      }
    }
    for (const { record } of activeCooldown(file, nowMs, receivedAtMs).active) {
      const at = Date.parse(record.retryAt);
      if (Number.isFinite(at) && at > nowMs) {
        events.push({ id: `cooldown:${quotaKey(file)}:${record.model ?? 'all'}`, kind: 'cooldown', ...base, detail: record.model ?? '', count: 1, at, to });
      }
    }
    for (const schedule of lightFor(file, schedules)) {
      if (schedule.enabled && schedule.nextRun && schedule.nextRun > nowMs) {
        events.push({ id: `light:${schedule.id}`, kind: 'light', ...base, detail: schedule.windowKind, count: 1, at: schedule.nextRun, to });
      }
    }
  }
  return collapseResets(events.sort((a, b) => a.at - b.at));
}

/** Same provider + window resetting in the same minute → one row with a count. */
export function collapseResets(events: ComingUp[]): ComingUp[] {
  const out: ComingUp[] = [];
  const seen = new Map<string, ComingUp>();
  for (const event of events) {
    if (event.kind !== 'reset') { out.push(event); continue; }
    const key = `${event.provider}|${event.detail}|${Math.floor(event.at / 60_000)}`;
    const first = seen.get(key);
    if (first) {
      first.count += 1;
      first.to = { page: 'quota', params: { provider: event.provider } };
    } else {
      const copy = { ...event };
      seen.set(key, copy);
      out.push(copy);
    }
  }
  return out;
}

export type DayBucket = 'today' | 'tomorrow' | 'later';

export function dayBucket(at: number, nowMs: number): DayBucket {
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const day = Math.floor((at - startOfToday.getTime()) / 86_400_000);
  return day <= 0 ? 'today' : day === 1 ? 'tomorrow' : 'later';
}

export function groupByDay<T extends { at: number }>(events: T[], nowMs: number): Array<{ bucket: DayBucket; items: T[] }> {
  const order: DayBucket[] = ['today', 'tomorrow', 'later'];
  return order
    .map((bucket) => ({ bucket, items: events.filter((event) => dayBucket(event.at, nowMs) === bucket) }))
    .filter((group) => group.items.length > 0);
}

/** Hourly timeline points → request counts for the sparkline (oldest first). */
export function requestSeries(timeline: ReadonlyArray<{ requests: number }> | undefined): number[] {
  return (timeline ?? []).map((point) => point.requests);
}
