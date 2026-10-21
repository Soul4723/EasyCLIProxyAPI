import { createDataSource } from './dataSource';
import { invoke } from './platform';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type LightingCredential = {
  provider: string;
  authFileName: string;
  authIndex: string;
};

export type LightingTarget = { id: string };
export type LightingMode = 'schedule' | 'after_reset';
export type LightingWindowKind = '5h' | 'weekly';

export type LightingRunResult = {
  scheduleId: string;
  at: number;
  ok: boolean;
  httpStatus: number | null;
  message: string;
  attempt: number;
};

export type LightingRetry = {
  maxAttempts: number;
  intervalSeconds: number;
  backoff: number;
  circuitSeconds: number;
};

export type LightingActiveHours = { start: string; end: string };

export type LightingSchedule = {
  id: string;
  credential: LightingCredential;
  target: string;
  enabled: boolean;
  mode: LightingMode;
  times: string[];
  weekdays: number[];
  timezone: string;
  windowKind: LightingWindowKind;
  model: string | null;
  activeHours: LightingActiveHours | null;
  retry: LightingRetry;
  lastRun: LightingRunResult | null;
  nextRun: number | null;
  observedReset: number | null;
  consumedReset: number | null;
  attempt: number;
  circuitUntil: number | null;
};

export type LightingCapabilities = {
  provider: string;
  supported: boolean;
  defaultModel: string | null;
  allowedWindows: LightingWindowKind[];
  reason: string | null;
};

export type LightingStatus = {
  running: boolean;
  onlyWhileAppRunning: boolean;
  currentTarget: string;
  runningIds: string[];
  error: string | null;
};

export type SaveLightingSchedule = (schedule: LightingSchedule, expectedRevision: number) => Promise<LightingSchedule>;

export const listLightingSchedules = () => invoke<LightingSchedule[]>('lighting_list');
export const getLightingSchedule = (id: string) => invoke<LightingSchedule | null>('lighting_get', { id });
export const saveLightingSchedule: SaveLightingSchedule = (schedule, expectedRevision) =>
  invoke<LightingSchedule>('lighting_save', { schedule, expectedRevision }).then(changed);
export const deleteLightingSchedule = (id: string) => invoke<void>('lighting_delete', { id }).then(changed);
export const setLightingEnabled = (id: string, enabled: boolean) =>
  invoke<LightingSchedule>('lighting_set_enabled', { id, enabled }).then(changed);
export const runLightingNow = (id: string) => invoke<LightingRunResult>('lighting_run_now', { id });
export const reportLightingReset = (id: string, resetAt: number, expectedRevision: number) =>
  invoke<LightingSchedule>('lighting_report_reset', { id, resetAt, expectedRevision }).then(changed);
export const getLightingHistory = (id?: string) => invoke<LightingRunResult[]>('lighting_history', { id });
export const getLightingCapabilities = () => invoke<LightingCapabilities[]>('lighting_capabilities');
export const getLightingStatus = () => invoke<LightingStatus>('lighting_status');

export const listenForLightingRunResult = (handler: (result: LightingRunResult) => void): Promise<UnlistenFn> =>
  listen<LightingRunResult>('lighting-run-result', (event) => handler(event.payload));

export const lightingSource = createDataSource({
  events: ['lighting-run-result'],
  load: async () => {
    const [schedules, capabilities, status] = await Promise.all([
      listLightingSchedules(), getLightingCapabilities(), getLightingStatus(),
    ]);
    return { schedules, capabilities, status };
  },
});

function changed<T>(value: T): T { lightingSource.invalidate(); return value; }
