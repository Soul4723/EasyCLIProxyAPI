// Lighting state for the quota page: schedules per credential, provider capabilities, runner status and the
// "report observed reset after each quota fetch" hook. Contract: src/services/lighting.ts (ui/cp-lighting API.md).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteLightingSchedule, getLightingCapabilities, getLightingStatus, listenForLightingRunResult,
  listLightingSchedules, reportLightingReset, runLightingNow, saveLightingSchedule, setLightingEnabled,
  type LightingCapabilities, type LightingRunResult, type LightingSchedule, type LightingStatus,
} from '../../services/lighting';
import { managementApi } from '../../services/managementApi';
import type { AppLocale } from '../../i18n';
import type { QuotaAccount, WindowView } from './model';
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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useLighting(locale: AppLocale): LightingApi {
  const [schedules, setSchedules] = useState<Map<string, LightingSchedule>>(new Map());
  const [capabilities, setCapabilities] = useState<Map<string, LightingCapabilities>>(new Map());
  const [status, setStatus] = useState<LightingStatus | null>(null);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const schedulesRef = useRef(schedules);
  schedulesRef.current = schedules;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const reload = useCallback(async () => {
    try {
      const [list, caps, nextStatus] = await Promise.all([
        listLightingSchedules(), getLightingCapabilities(), getLightingStatus(),
      ]);
      if (!mounted.current) return;
      setSchedules(new Map(list.map((schedule) => [lightingKey(schedule.credential), schedule])));
      setCapabilities(new Map(caps.map((cap) => [cap.provider, cap])));
      setStatus(nextStatus);
      setAvailable(true);
      setError(nextStatus.error);
    } catch (reason) {
      if (!mounted.current) return;
      setAvailable(false);
      setError(message(reason));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void listenForLightingRunResult(() => { void reload(); })
      .then((unlisten) => { if (cancelled) unlisten(); else off = unlisten; })
      .catch(() => undefined);
    return () => { cancelled = true; off?.(); };
  }, [reload]);

  const put = useCallback((schedule: LightingSchedule) => {
    schedulesRef.current = new Map(schedulesRef.current).set(lightingKey(schedule.credential), schedule);
    setSchedules((current) => new Map(current).set(lightingKey(schedule.credential), schedule));
    return schedule;
  }, []);

  const save = useCallback(async (schedule: LightingSchedule) => {
    const revision = await managementApi.getTargetRevision();
    return put(await saveLightingSchedule(schedule, revision));
  }, [put]);
  const setEnabled = useCallback(async (schedule: LightingSchedule, enabled: boolean) =>
    put(await setLightingEnabled(schedule.id, enabled)), [put]);
  const remove = useCallback(async (schedule: LightingSchedule) => {
    await deleteLightingSchedule(schedule.id);
    setSchedules((current) => {
      const next = new Map(current);
      next.delete(lightingKey(schedule.credential));
      return next;
    });
  }, []);
  const runNow = useCallback(async (schedule: LightingSchedule) => {
    const result = await runLightingNow(schedule.id);
    await reload();
    return result;
  }, [reload]);

  const reportObserved = useCallback((account: AccountIdentity, quota: QuotaState) => {
    const schedule = schedulesRef.current.get(accountLightingKey(account));
    if (!schedule || quota.status !== 'success') return;
    const now = Date.now();
    const windows: WindowView[] = windowsOf(quota, now, locale);
    const wanted = windows.filter((window) => window.kind === schedule.windowKind && window.resetAtMs !== undefined
      && window.resetAtMs > now && (window.leftPct ?? 100) < 100);
    const plain = wanted.find((window) => window.prefix === '') ?? wanted[0];
    const resetAt = plain?.resetAtMs;
    if (resetAt === undefined) return;
    // Reset times drift by seconds between fetches; only report real changes.
    if (schedule.observedReset !== null && Math.abs(schedule.observedReset - resetAt) < 120_000) return;
    const revision = quota.targetRevision;
    void (async () => {
      try {
        const expected = revision ?? await managementApi.getTargetRevision();
        const updated = await reportLightingReset(schedule.id, Math.round(resetAt), expected);
        if (mounted.current) put(updated);
      } catch {
        // Stale connection revision or out-of-range reset: the next fetch reports again.
      }
    })();
  }, [locale, put]);

  const capabilityFor = useCallback((provider: string) => capabilities.get(provider), [capabilities]);
  const scheduleFor = useCallback((account: QuotaAccount) => schedules.get(accountLightingKey(account)), [schedules]);

  return useMemo(() => ({
    available, loading, error, status, schedules, capabilityFor, scheduleFor, reload, save, setEnabled, remove,
    runNow, reportObserved,
  }), [available, loading, error, status, schedules, capabilityFor, scheduleFor, reload, save, setEnabled, remove, runNow, reportObserved]);
}
