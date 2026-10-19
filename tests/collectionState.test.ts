import { describe, expect, test } from 'bun:test';
import { deriveCollectionState, formatRecordTime } from '../src/sections/usage/collectionState';
import type { CollectorStatus } from '../src/sections/usage/types';

const collector = (state: CollectorStatus['state'], extra: Partial<CollectorStatus> = {}): CollectorStatus => ({
  state, message: '', lastCollectedAt: '2026-10-19T14:02:00.000Z', totalRecords: 12, ...extra,
});

describe('deriveCollectionState', () => {
  test('is live only while the core answers and the collector collects', () => {
    const state = deriveCollectionState(collector('collecting'), { ready: true, connectionMode: 'local' });
    expect(state).toEqual({ kind: 'collecting', live: true, lastCollectedAt: '2026-10-19T14:02:00.000Z', coreDown: false });
  });

  test('a stopped local core beats a stale "collecting" collector status', () => {
    const state = deriveCollectionState(collector('collecting'), { ready: false, connectionMode: 'local' });
    expect(state.kind).toBe('stopped');
    expect(state.live).toBe(false);
    expect(state.lastCollectedAt).toBe('2026-10-19T14:02:00.000Z');
  });

  test('an unreachable remote core is reported as unreachable, not stopped', () => {
    expect(deriveCollectionState(collector('waiting-core'), { ready: false, connectionMode: 'remote' }).kind).toBe('unreachable');
  });

  test('a starting core is neither live nor stopped', () => {
    const state = deriveCollectionState(collector('waiting-core'), { ready: false, starting: true });
    expect(state.kind).toBe('starting');
    expect(state.live).toBe(false);
  });

  test('paused and error collector states remain visible while the core is ready', () => {
    expect(deriveCollectionState(collector('paused'), { ready: true }).kind).toBe('paused');
    expect(deriveCollectionState(collector('error'), { ready: true }).live).toBe(false);
    expect(deriveCollectionState(collector('error'), { ready: true }).kind).toBe('error');
    expect(deriveCollectionState(collector('error'), { ready: false }).kind).toBe('stopped');
    expect(deriveCollectionState(collector('error'), { ready: false, connectionMode: 'remote' }).kind).toBe('unreachable');
    expect(deriveCollectionState(collector('error'), { ready: false, starting: true }).kind).toBe('starting');
  });

  test('a reachable core whose collector has not attached is not live', () => {
    expect(deriveCollectionState(collector('waiting-core'), { ready: true })).toMatchObject({ kind: 'starting', live: false });
  });

  test('nothing loaded yet is unknown; an empty history keeps a null last record', () => {
    expect(deriveCollectionState(null, null).kind).toBe('unknown');
    expect(deriveCollectionState(collector('waiting-core', { lastCollectedAt: null, totalRecords: 0 }), { ready: false }).lastCollectedAt).toBeNull();
    expect(deriveCollectionState(null, { ready: true }).live).toBe(false);
  });
});

describe('formatRecordTime', () => {
  const now = new Date(2026, 9, 19, 16, 0);
  test('shows only the time for today and a date for earlier days', () => {
    const today = formatRecordTime(new Date(2026, 9, 19, 14, 2).toISOString(), now, 'en-GB');
    expect(today).toBe('14:02');
    expect(formatRecordTime(new Date(2026, 9, 17, 14, 2).toISOString(), now, 'en-GB')).toContain('17');
  });
  test('returns null for missing or invalid input', () => {
    expect(formatRecordTime(null, now)).toBeNull();
    expect(formatRecordTime('nope', now)).toBeNull();
  });
});

describe('coreDown', () => {
  test('is true whenever the shared core status is not ready, even if the collector is paused or errored', () => {
    expect(deriveCollectionState(collector('collecting'), { ready: false, connectionMode: 'local' }).coreDown).toBe(true);
    expect(deriveCollectionState(collector('paused'), { ready: false }).coreDown).toBe(true);
    expect(deriveCollectionState(collector('waiting-core'), { ready: false, connectionMode: 'remote' }).coreDown).toBe(true);
    expect(deriveCollectionState(collector('waiting-core'), { ready: false, starting: true }).coreDown).toBe(true);
  });

  test('is false while the core is ready or its status is unknown', () => {
    expect(deriveCollectionState(collector('waiting-core'), { ready: true }).coreDown).toBe(false);
    expect(deriveCollectionState(collector('collecting'), null).coreDown).toBe(false);
  });
});
