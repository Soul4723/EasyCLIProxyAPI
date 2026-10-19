// guards the browser-mock contract used by the UI suite
// Lighting commands, revision checks and run-result events support quota-ui.cjs.
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as tauriCore from '@tauri-apps/api/core';
import { createBrowserMockRuntime } from '../../../src/mocks/browserMockRuntime';
import {
  deleteLightingSchedule,
  getLightingCapabilities,
  getLightingHistory,
  getLightingSchedule,
  getLightingStatus,
  listenForLightingRunResult,
  listLightingSchedules,
  reportLightingReset,
  runLightingNow,
  saveLightingSchedule,
  setLightingEnabled,
} from '../../../src/services/lighting';

afterEach(() => {
  (tauriCore.invoke as unknown as { mockRestore?: () => void }).mockRestore?.();
});

test('lighting service wrappers use the native command contract and event name', async () => {
  const calls: Array<[string, unknown]> = [];
  const invokeSpy = spyOn(tauriCore, 'invoke').mockImplementation(async (command, args) => {
    calls.push([command, args]);
    return null as never;
  });
  const listenSpy = spyOn(await import('@tauri-apps/api/event'), 'listen').mockImplementation(async (event) => {
    calls.push([`event:${event}`, undefined]);
    return (() => {}) as never;
  });
  const schedule = { id: 'id', credential: { provider: 'codex', authFileName: 'fake.json', authIndex: 'fake' } } as never;
  await listLightingSchedules();
  await getLightingSchedule('id');
  await saveLightingSchedule(schedule, 7);
  await deleteLightingSchedule('id');
  await setLightingEnabled('id', true);
  await runLightingNow('id');
  await reportLightingReset('id', 123, 7);
  await getLightingHistory();
  await getLightingHistory('id');
  await getLightingCapabilities();
  await getLightingStatus();
  await listenForLightingRunResult(() => {});

  expect(calls).toEqual([
    ['lighting_list', undefined],
    ['lighting_get', { id: 'id' }],
    ['lighting_save', { schedule, expectedRevision: 7 }],
    ['lighting_delete', { id: 'id' }],
    ['lighting_set_enabled', { id: 'id', enabled: true }],
    ['lighting_run_now', { id: 'id' }],
    ['lighting_report_reset', { id: 'id', resetAt: 123, expectedRevision: 7 }],
    ['lighting_history', { id: undefined }],
    ['lighting_history', { id: 'id' }],
    ['lighting_capabilities', undefined],
    ['lighting_status', undefined],
    ['event:lighting-run-result', undefined],
  ]);
  invokeSpy.mockRestore();
  listenSpy.mockRestore();
});

test('running fixture supports list, get, enable, run/event, reset report, history and delete', async () => {
  const emitted: Array<[string, unknown]> = [];
  const runtime = createBrowserMockRuntime('running', (event, payload) => emitted.push([event, payload]));
  const schedules = await runtime.invoke('lighting_list') as Array<{ id: string; enabled: boolean; target: string }>;
  expect(schedules).toHaveLength(2);
  const [schedule] = schedules;
  expect(schedule).toMatchObject({ enabled: true, target: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await runtime.invoke('lighting_get', { id: schedule.id })).toEqual(schedule);

  expect(await runtime.invoke('lighting_set_enabled', { id: schedule.id, enabled: false })).toMatchObject({ enabled: false, nextRun: null });
  const run = await runtime.invoke('lighting_run_now', { id: schedule.id }) as { scheduleId: string; ok: boolean; attempt: number };
  expect(run).toMatchObject({ scheduleId: schedule.id, ok: true, attempt: 1 });
  expect(emitted).toEqual([['lighting-run-result', run]]);
  expect(await runtime.invoke('lighting_history', { id: schedule.id })).toEqual([run]);
  expect(await runtime.invoke('lighting_report_reset', { id: schedule.id, resetAt: 5_000, expectedRevision: 0 }))
    .toMatchObject({ observedReset: 5_000, consumedReset: null });
  expect(await runtime.invoke('lighting_set_enabled', { id: schedule.id, enabled: true })).toMatchObject({ enabled: true });
  await runtime.invoke('lighting_delete', { id: schedule.id });
  expect(await runtime.invoke('lighting_get', { id: schedule.id })).toBeNull();
});

test('save derives a stable SHA-256 identity, rejects stale revisions and exposes capabilities/status', async () => {
  const runtime = createBrowserMockRuntime('empty');
  expect(await runtime.invoke('lighting_list')).toEqual([]);
  await expect(runtime.invoke('lighting_save', { schedule: {}, expectedRevision: 1 })).rejects.toThrow('connection changed');
  const currentTarget = (await runtime.invoke('lighting_status') as { currentTarget: string }).currentTarget;
  const schedule = {
    id: 'ignored',
    target: currentTarget,
    credential: { provider: 'codex', authFileName: 'fictional-codex.json', authIndex: 'preview-codex' },
    enabled: true,
    mode: 'schedule',
    times: ['06:00'],
    weekdays: [1, 2, 3, 4, 5],
    timezone: 'Australia/Melbourne',
    windowKind: '5h',
    model: 'gpt-5.5',
    activeHours: null,
    retry: { maxAttempts: 2, intervalSeconds: 30, backoff: 2, circuitSeconds: 600 },
    lastRun: null,
    nextRun: null,
    observedReset: null,
    consumedReset: null,
    attempt: 0,
    circuitUntil: null,
  };
  const saved = await runtime.invoke('lighting_save', { schedule, expectedRevision: 0 }) as typeof schedule & { id: string };
  expect(saved.id).toMatch(/^[a-f0-9]{64}$/);
  expect((await runtime.invoke('lighting_save', { schedule, expectedRevision: 0 }) as { id: string }).id).toBe(saved.id);
  expect(await runtime.invoke('lighting_capabilities')).toContainEqual(expect.objectContaining({ provider: 'codex', supported: true, defaultModel: 'gpt-5.5' }));
  expect(await runtime.invoke('lighting_capabilities')).toContainEqual(expect.objectContaining({ provider: 'antigravity', supported: false }));
  expect(await runtime.invoke('lighting_status')).toMatchObject({ running: false, onlyWhileAppRunning: true, runningIds: [] });
  await expect(runtime.invoke('lighting_report_reset', { id: saved.id, resetAt: 1, expectedRevision: 1 })).rejects.toThrow('connection changed');
});

test('all lighting commands are explicitly handled in empty/error scenarios', async () => {
  const runtime = createBrowserMockRuntime('empty');
  expect(await runtime.invoke('lighting_list')).toEqual([]);
  expect(await runtime.invoke('lighting_capabilities')).toBeArray();
  expect(await runtime.invoke('lighting_history')).toEqual([]);
  expect(await runtime.invoke('lighting_status')).toMatchObject({ running: false, error: null });
  expect(await runtime.invoke('lighting_get', { id: 'missing' })).toBeNull();
  await expect(runtime.invoke('lighting_set_enabled', { id: 'missing', enabled: true })).rejects.toThrow('not found');
  await expect(runtime.invoke('lighting_run_now', { id: 'missing' })).rejects.toThrow('not found');
  await expect(runtime.invoke('lighting_delete', { id: 'missing' })).rejects.toThrow('not found');
  await expect(runtime.invoke('lighting_report_reset', { id: 'missing', resetAt: 1, expectedRevision: 0 })).rejects.toThrow('not found');
  const errorRuntime = createBrowserMockRuntime('error');
  expect(await errorRuntime.invoke('lighting_status')).toMatchObject({ error: null });
});
