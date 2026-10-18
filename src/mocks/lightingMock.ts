import type {
  LightingCapabilities,
  LightingCredential,
  LightingRunResult,
  LightingSchedule,
  LightingStatus,
} from '../services/lighting';

type JsonObject = Record<string, unknown>;
type Scenario = 'running' | 'stopped' | 'empty' | 'error';

const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const clone = <T,>(value: T): T => structuredClone(value);
const CURRENT_TARGET = 'a3a9e0a502765449a214d47148be4db5d5ed8a826c5f8e0670c1429788e1d5e1';
const FIXTURE_ID = '700c7d6ac70579ca8fff677d7a39e6ac81186a959dbee9f1edb7709f2cdf583a';
const AFTER_RESET_ID = '3e9a1457f1f8f2f1f3ce49cc6b2e06cbf9567cefe3e9bb02e0a7be063b5e3b9a';

const CAPABILITIES: LightingCapabilities[] = [
  { provider: 'codex', supported: true, defaultModel: 'gpt-5.5', allowedWindows: ['5h', 'weekly'], reason: null },
  { provider: 'claude', supported: true, defaultModel: 'claude-haiku-4-5-20251001', allowedWindows: ['5h', 'weekly'], reason: null },
  ...['antigravity', 'gemini', 'kimi', 'xai', 'devin'].map((provider) => ({
    provider, supported: false, defaultModel: null, allowedWindows: [] as ('5h' | 'weekly')[],
    reason: 'Lighting is not supported for this provider.',
  })),
];

async function scheduleId(target: string, credential: LightingCredential): Promise<string> {
  const identity = JSON.stringify([target, credential]);
  const bytes = new TextEncoder().encode(identity);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function afterResetFixture(): LightingSchedule {
  return {
    id: AFTER_RESET_ID,
    credential: { provider: 'codex', authFileName: 'codex-preview-account.json', authIndex: 'preview-codex-account' },
    target: CURRENT_TARGET, enabled: true, mode: 'after_reset', times: [], weekdays: [1, 2, 3, 4, 5, 6, 7],
    timezone: 'Australia/Melbourne', windowKind: '5h', model: 'gpt-5.5', activeHours: { start: '06:00', end: '22:00' },
    retry: { maxAttempts: 3, intervalSeconds: 30, backoff: 2, circuitSeconds: 900 },
    lastRun: { scheduleId: AFTER_RESET_ID, at: Date.now() - 3_600_000, ok: false, httpStatus: 429, message: 'Preview request was rate limited; retrying after reset.', attempt: 2 },
    nextRun: Date.now() + 45 * 60 * 1000, observedReset: Date.now() + 45 * 60 * 1000, consumedReset: null, attempt: 2, circuitUntil: null,
  };
}

function fixtureSchedule(): LightingSchedule {
  return {
    id: FIXTURE_ID,
    credential: { provider: 'claude', authFileName: 'claude-preview-account.json', authIndex: 'preview-claude-account' },
    target: CURRENT_TARGET,
    enabled: true,
    mode: 'schedule',
    times: ['06:00'],
    weekdays: [1, 2, 3, 4, 5],
    timezone: 'Australia/Melbourne',
    windowKind: 'weekly',
    model: 'claude-haiku-4-5-20251001',
    activeHours: { start: '05:30', end: '07:00' },
    retry: { maxAttempts: 3, intervalSeconds: 60, backoff: 2, circuitSeconds: 900 },
    lastRun: null,
    nextRun: Date.now() + 6 * 60 * 60 * 1000,
    observedReset: null,
    consumedReset: null,
    attempt: 0,
    circuitUntil: null,
  };
}

/** Fictional in-memory lighting contracts for the browser preview; never calls a provider. */
export function createLightingMock(
  scenario: Scenario,
  emit: (event: string, payload: unknown) => void,
  getRevision: () => number,
) {
  const schedules = new Map<string, LightingSchedule>();
  const history: LightingRunResult[] = [];
  if (scenario === 'running') {
    schedules.set(FIXTURE_ID, fixtureSchedule());
    schedules.set(AFTER_RESET_ID, afterResetFixture());
    history.push(afterResetFixture().lastRun!);
  }
  const currentTarget = () => CURRENT_TARGET;
  const assertCurrentTarget = (target: string) => {
    if (target !== currentTarget()) throw new Error('The core connection changed; lighting operation cancelled');
  };
  const assertRevision = (value: unknown) => {
    if (typeof value !== 'number' || value !== getRevision()) throw new Error('The core connection changed; lighting operation cancelled');
  };
  const find = (id: string) => {
    const schedule = schedules.get(id);
    if (!schedule) throw new Error('Lighting schedule not found');
    assertCurrentTarget(schedule.target);
    return schedule;
  };

  async function handle(command: string, payload: JsonObject): Promise<{ handled: false } | { handled: true; value: unknown }> {
    const result = (value: unknown) => ({ handled: true as const, value: clone(value) });
    switch (command) {
      case 'lighting_list':
        return result([...schedules.values()].filter((schedule) => schedule.target === currentTarget()));
      case 'lighting_get':
        return result(schedules.get(text(payload.id)) ?? null);
      case 'lighting_save': {
        assertRevision(payload.expectedRevision);
        const input = object(payload.schedule) as unknown as LightingSchedule;
        if (!input.credential || !text(input.credential.provider) || !text(input.credential.authFileName) || !text(input.credential.authIndex)) {
          throw new Error('Lighting credential identity is required');
        }
        const target = text(input.target) || currentTarget();
        assertCurrentTarget(target);
        const id = await scheduleId(target, input.credential);
        const saved: LightingSchedule = { ...clone(input), id, target };
        schedules.set(id, saved);
        return result(saved);
      }
      case 'lighting_delete': {
        const schedule = find(text(payload.id));
        schedules.delete(schedule.id);
        return result(null);
      }
      case 'lighting_set_enabled': {
        const schedule = find(text(payload.id));
        schedule.enabled = payload.enabled === true;
        if (!schedule.enabled) schedule.nextRun = null;
        else if (schedule.nextRun === null) schedule.nextRun = Date.now() + 60 * 60 * 1000;
        return result(schedule);
      }
      case 'lighting_run_now': {
        const schedule = find(text(payload.id));
        const run: LightingRunResult = {
          scheduleId: schedule.id, at: Date.now(), ok: true, httpStatus: 200,
          message: 'Browser preview simulated a successful run; no provider request was made.',
          attempt: schedule.attempt + 1,
        };
        schedule.attempt = run.attempt;
        schedule.lastRun = run;
        schedule.nextRun = schedule.enabled ? Date.now() + 24 * 60 * 60 * 1000 : null;
        history.unshift(run);
        emit('lighting-run-result', run);
        return result(run);
      }
      case 'lighting_report_reset': {
        assertRevision(payload.expectedRevision);
        const schedule = find(text(payload.id));
        if (typeof payload.resetAt !== 'number' || !Number.isFinite(payload.resetAt)) throw new Error('Invalid reset timestamp');
        schedule.observedReset = payload.resetAt;
        schedule.consumedReset = null;
        schedule.attempt = 0;
        schedule.circuitUntil = null;
        schedule.nextRun = schedule.enabled && schedule.mode === 'after_reset' ? payload.resetAt : schedule.nextRun;
        return result(schedule);
      }
      case 'lighting_history': {
        const id = text(payload.id);
        if (id) find(id);
        return result(history.filter((item) => !id || item.scheduleId === id));
      }
      case 'lighting_capabilities':
        return result(CAPABILITIES);
      case 'lighting_status': {
        const active = scenario === 'running';
        const runningIds = active
          ? [...schedules.values()].filter((schedule) => schedule.enabled && schedule.target === currentTarget()).map(({ id }) => id)
          : [];
        const status: LightingStatus = {
          running: active,
          onlyWhileAppRunning: true,
          currentTarget: currentTarget(),
          runningIds,
          error: null,
        };
        return result(status);
      }
      default:
        return { handled: false };
    }
  }

  return { handle };
}
