import { useDataSource } from '../../services/dataSource';
// Lighting state for the quota page: schedules per credential, provider capabilities, runner status and the
// "report observed reset after each quota fetch" hook. Contract: src/services/lighting.ts (ui/cp-lighting API.md).
import { useCallback, useMemo, useRef } from 'react';
import {
  deleteLightingSchedule, lightingSource,
  reportLightingReset, runLightingNow, saveLightingSchedule, setLightingEnabled,
  type LightingCapabilities, type LightingRunResult, type LightingSchedule, type LightingStatus,
} from '../../services/lighting';
import { managementApi } from '../../services/managementApi';
import type { AppLocale } from '../../i18n';
import type { QuotaAccount } from './model';
import { windowsOf } from './model';
import type { QuotaState } from '../../services/quotaService';

export const lightingKey = (credential: { provider: string; authFileName: string; authIndex: string }) =>
  `${credential.provider}::${credential.authFileName}::${credential.authIndex}`;
export const accountLightingKey = (account: Pick<QuotaAccount, 'provider' | 'fileName' | 'authIndex'>) =>
  lightingKey({ provider: account.provider, authFileName: account.fileName, authIndex: account.authIndex });

export type LightingState =
  | 'off' | 'scheduled' | 'running' | 'failed' | 'retrying' | 'paused' | 'noReset' | 'ok';

/** What the card/popover show for one schedule. `lit` = the ⚡ button is highlighted (mode is not Off). */
export function lightingStateOf(schedule: LightingSchedule | undefined, runningIds: readonly string[], now: number): LightingState {
  if (!schedule || !schedule.enabled) return 'off';
  if (runningIds.includes(schedule.id)) return 'running';
  if (schedule.circuitUntil !== null && schedule.circuitUntil > now) return 'paused';
  if (schedule.lastRun && !schedule.lastRun.ok) return schedule.nextRun !== null && schedule.nextRun > now ? 'retrying' : 'failed';
  if (schedule.mode === 'after_reset' && schedule.observedReset === null) return 'noReset';
  if (schedule.nextRun !== null) return 'scheduled';
  return schedule.lastRun?.ok ? 'ok' : 'off';
}

/** The reset time (epoch ms) a quota snapshot reports for a schedule's window, or undefined if nothing new is known. */
export function observedResetFor(schedule: LightingSchedule, quota: QuotaState, now: number, locale: AppLocale): number | undefined {
  if (quota.status !== 'success') return undefined;
  const wanted = windowsOf(quota, now, locale).filter((window) => window.kind === schedule.windowKind
    && window.resetAtMs !== undefined && window.resetAtMs > now && (window.leftPct ?? 100) < 100);
  const resetAt = (wanted.find((window) => window.prefix === '') ?? wanted[0])?.resetAtMs;
  if (resetAt === undefined) return undefined;
  // Reset times drift by seconds between fetches; only report real changes.
  if (schedule.observedReset !== null && Math.abs(schedule.observedReset - resetAt) < 120_000) return undefined;
  return resetAt;
}

export type LightingApi = {
  /** False when the lighting commands are not reachable (for example a non-desktop host with no mock). */
  available: boolean;
  loading: boolean;
  error: string | null;
  status: LightingStatus | null;
  schedules: Map<string, LightingSchedule>;
  capabilityFor: (provider: string) => LightingCapabilities | undefined;
  scheduleFor: (account: QuotaAccount) => LightingSchedule | undefined;
  reload: () => Promise<void>;
  save: (schedule: LightingSchedule) => Promise<LightingSchedule>;
  setEnabled: (schedule: LightingSchedule, enabled: boolean) => Promise<LightingSchedule>;
  remove: (schedule: LightingSchedule) => Promise<void>;
  runNow: (schedule: LightingSchedule) => Promise<LightingRunResult>;
  /** Call after every quota fetch: forwards the observed reset time to matching schedules. */
  reportObserved: (account: AccountIdentity, quota: QuotaState) => void;
};

export type AccountIdentity = Pick<QuotaAccount, 'provider' | 'fileName' | 'authIndex'>;

export function useLighting(locale: AppLocale): LightingApi {
  const source = useDataSource(lightingSource);
  const schedules = useMemo(() => new Map((source.data?.schedules ?? []).map(s => [lightingKey(s.credential), s])), [source.data]);
  const capabilities = useMemo(() => new Map((source.data?.capabilities ?? []).map(c => [c.provider, c])), [source.data]);
  const status = source.data?.status ?? null;
  const available = !!source.data || !source.error;
  const loading = source.loading;
  const error = source.error ?? status?.error ?? null;
  const schedulesRef = useRef(schedules);
  schedulesRef.current = schedules;
  const reload = lightingSource.refresh;

  const save = useCallback(async (schedule: LightingSchedule) => {
    const revision = await managementApi.getTargetRevision();
    return saveLightingSchedule(schedule, revision);
  }, []);
  const setEnabled = useCallback(async (schedule: LightingSchedule, enabled: boolean) =>
    setLightingEnabled(schedule.id, enabled), []);
  const remove = useCallback(async (schedule: LightingSchedule) => {
    await deleteLightingSchedule(schedule.id);
  }, []);
  const runNow = useCallback((schedule: LightingSchedule) => runLightingNow(schedule.id), []);

  const reportObserved = useCallback((account: AccountIdentity, quota: QuotaState) => {
    const schedule = schedulesRef.current.get(accountLightingKey(account));
    if (!schedule || quota.status !== 'success') return;
    const now = Date.now();
    const resetAt = observedResetFor(schedule, quota, now, locale);
    if (resetAt === undefined) return;
    const revision = quota.targetRevision;
    void (async () => {
      try {
        const expected = revision ?? await managementApi.getTargetRevision();
        await reportLightingReset(schedule.id, Math.round(resetAt), expected);
      } catch {
        // Stale connection revision or out-of-range reset: the next fetch reports again.
      }
    })();
  }, [locale]);

  const capabilityFor = useCallback((provider: string) => capabilities.get(provider), [capabilities]);
  const scheduleFor = useCallback((account: QuotaAccount) => schedules.get(accountLightingKey(account)), [schedules]);

  return useMemo(() => ({
    available, loading, error, status, schedules, capabilityFor, scheduleFor, reload, save, setEnabled, remove,
    runNow, reportObserved,
  }), [available, loading, error, status, schedules, capabilityFor, scheduleFor, reload, save, setEnabled, remove, runNow, reportObserved]);
}
