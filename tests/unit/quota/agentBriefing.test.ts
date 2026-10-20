import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { documentTarget } from '../../../src/services/documentTarget';
import { credentialsSource } from '../../../src/services/credentials';
import { translate } from '../../../src/i18n';
import { updateQuotaCache } from '../../../src/services/quotaCache';
import { quotaKey, type AuthFile, type QuotaState } from '../../../src/services/quotaService';
import {
  buildBriefingAccounts,
  createBriefingPublisher,
  startAgentBriefing,
  type BriefingAccount,
} from '../../../src/sections/quota/agentBriefing';

const NOW = Date.parse('2030-01-01T00:00:00Z');
const HOUR = 3_600_000;
const SECRET_EMAIL = 'alice.private@example.test';
const SECRET_TOKEN = 'sk-live-0123456789SECRET';

const file = (index: string, extra: Record<string, unknown> = {}): AuthFile => ({
  name: `claude-${SECRET_EMAIL}.json`, auth_index: index, provider: 'claude', email: SECRET_EMAIL,
  access_token: SECRET_TOKEN, api_key: SECRET_TOKEN, path: '/home/someone/.auth/x.json', ...extra,
});
const success = (extra: Partial<QuotaState> = {}): QuotaState => ({
  status: 'success', fetchedAt: NOW - 60_000, plan: 'max',
  rows: [
    { label: translate('en', 'quota.service.window.fiveHour'), remainingPercent: 62, resetAtMs: NOW + HOUR },
    { label: translate('en', 'quota.service.window.sevenDay'), remainingPercent: 81, resetAtMs: NOW + 24 * HOUR },
  ],
  ...extra,
});

describe('briefing snapshot', () => {
  test('keeps availability and drops every identity, file name, path and key', () => {
    const files = [file('c1')];
    const accounts = buildBriefingAccounts(files, { [quotaKey(files[0])]: success() }, NOW, 'en');
    expect(accounts).toEqual([{
      authIndex: 'c1', provider: 'claude', label: 'al***@e***.test', plan: 'max', disabled: false, fetchedAtMs: NOW - 60_000,
      windows: [
        { kind: '5h', group: '', remainingPercent: 62, resetAtMs: NOW + HOUR },
        { kind: 'weekly', group: '', remainingPercent: 81, resetAtMs: NOW + 24 * HOUR },
      ],
    }]);
    const text = JSON.stringify(accounts);
    for (const secret of [SECRET_EMAIL, 'alice', SECRET_TOKEN, '/home/someone', 'access_token', 'example.test.json']) {
      expect(text).not.toContain(secret);
    }
  });

  test('only successful reads with an auth index are published', () => {
    const files = [file('a'), file('b'), file('', { name: 'no-index.json' }), file('c', { provider: 'unknown' })];
    const quotas = Object.fromEntries(files.map((f) => [quotaKey(f), success()]));
    quotas[quotaKey(files[1])] = { status: 'error', rows: [], error: 'boom' };
    expect(buildBriefingAccounts(files, quotas, NOW, 'en').map((a) => a.authIndex)).toEqual(['a']);
  });

  test('special pools carry a group so they never decide exhaustion', () => {
    const files = [file('c1')];
    const state = success({
      rows: [
        { label: translate('en', 'quota.service.window.fiveHour'), remainingPercent: 10, resetAtMs: NOW + HOUR },
        { label: translate('en', 'quota.service.window.sevenDayOpus'), remainingPercent: 0, resetAtMs: NOW + 24 * HOUR },
        { label: 'Extra usage', remainingPercent: 0 },
        { label: 'Untouched bucket', remainingPercent: null, quotaAvailable: true },
        { label: 'No data', remainingPercent: null },
      ],
    });
    const windows = buildBriefingAccounts(files, { [quotaKey(files[0])]: state }, NOW, 'en')[0].windows;
    expect(windows.map((w) => [w.kind, w.group])).toEqual([
      ['5h', ''], ['weekly', '7-day Opus window'], ['other', 'Extra usage'], ['other', 'Untouched bucket'],
    ]);
    expect(windows[3]).toMatchObject({ remainingPercent: null, available: true });
  });

  test('balance must look like money, credits are passed as a flag, bounds are applied', () => {
    const files = [file('c1')];
    const key = quotaKey(files[0]);
    const clean = (state: Partial<QuotaState>) => buildBriefingAccounts(files, { [key]: success(state) }, NOW, 'en')[0];
    expect(clean({ creditBalance: '$12.40' }).creditBalance).toBe('$12.40');
    expect(clean({ creditBalance: '<b>$1</b>' }).creditBalance).toBeUndefined();
    expect(clean({ creditsUnlimited: true }).creditsUnlimited).toBe(true);
    expect(clean({ plan: 'x'.repeat(100) }).plan).toHaveLength(24);
    const rows = Array.from({ length: 30 }, (_, n) => ({ label: `Pool ${n}`, remainingPercent: n }));
    expect(clean({ rows }).windows).toHaveLength(12);
    expect(clean({ rows: [{ label: 'Weekly limit', remainingPercent: 250 }] }).windows[0].remainingPercent).toBe(100);
  });

  test('accounts without a readable identity get an empty label, not the file name', () => {
    const files = [file('c1', { email: undefined, name: 'claude-bob.json' })];
    const [account] = buildBriefingAccounts(files, { [quotaKey(files[0])]: success() }, NOW, 'en');
    expect(account.label).toBe('');
  });
});

type Fake = ReturnType<typeof fakeClock>;
function fakeClock() {
  let now = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (handle: unknown) => { timers.delete(handle as number); },
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}
const account = (n: number): BriefingAccount => ({ authIndex: `i${n}`, provider: 'claude', label: '', plan: '', disabled: false, windows: [] });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(initial: BriefingAccount[] = [account(1)]) {
  const clock: Fake = fakeClock();
  const published: BriefingAccount[][] = [];
  let data = initial;
  let fail = false;
  const publisher = createBriefingPublisher({
    read: () => data,
    publish: async (accounts) => { if (fail) throw new Error('write failed'); published.push(accounts); },
    debounceMs: 2_000, maxWaitMs: 15_000,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
  });
  return { clock, published, publisher, set: (next: BriefingAccount[]) => { data = next; }, failWrites: (v: boolean) => { fail = v; } };
}

describe('briefing publisher', () => {
  test('a burst of cache changes becomes one publish after the quiet period', async () => {
    const h = harness();
    for (let n = 0; n < 10; n += 1) { h.set([account(n + 1)]); h.publisher.notify(); h.clock.advance(300); }
    expect(h.published).toHaveLength(0);
    expect(h.clock.pending()).toBe(1);
    h.clock.advance(2_000);
    await settle();
    expect(h.published).toHaveLength(1);
    expect(h.published[0][0].authIndex).toBe('i10');
    expect(h.clock.pending()).toBe(0);
  });

  test('nothing is published when the content did not change, and idle costs no timer', async () => {
    const h = harness();
    h.publisher.notify(); h.clock.advance(2_000); await settle();
    h.publisher.notify(); h.clock.advance(2_000); await settle();
    h.publisher.notify(); h.clock.advance(2_000); await settle();
    expect(h.published).toHaveLength(1);
    h.clock.advance(60 * 60_000);
    expect(h.clock.pending()).toBe(0);
    h.set([account(2)]); h.publisher.notify(); h.clock.advance(2_000); await settle();
    expect(h.published).toHaveLength(2);
  });

  test('a refresh that never goes quiet still publishes once the maximum wait is reached', async () => {
    const h = harness();
    for (let second = 1; second <= 16; second += 1) { h.set([account(second)]); h.publisher.notify(); h.clock.advance(1_000); await settle(); }
    expect(h.published).toHaveLength(1);
    expect(h.published[0][0].authIndex).toBe('i15');
  });

  test('an empty cache never replaces the last briefing', async () => {
    const h = harness([]);
    h.publisher.notify(); h.clock.advance(2_000); await settle();
    expect(h.published).toHaveLength(0);
    h.set([account(1)]); h.publisher.notify(); h.clock.advance(2_000); await settle();
    h.set([]); h.publisher.notify(); h.clock.advance(2_000); await settle();
    expect(h.published).toHaveLength(1);
  });

  test('a failed write is retried on the next change, not in a loop', async () => {
    const h = harness();
    h.failWrites(true);
    h.publisher.notify(); h.clock.advance(2_000); await settle();
    expect(h.published).toHaveLength(0);
    expect(h.clock.pending()).toBe(0);
    h.failWrites(false);
    h.publisher.notify(); h.clock.advance(2_000); await settle();
    expect(h.published).toHaveLength(1);
  });

  test('a change during a publish is published afterwards, never concurrently', async () => {
    const clock = fakeClock();
    let release!: () => void;
    let active = 0; let overlap = false; const seen: string[] = [];
    let data = [account(1)];
    const publisher = createBriefingPublisher({
      read: () => data,
      publish: async (accounts) => {
        active += 1; overlap ||= active > 1;
        await new Promise<void>((resolve) => { release = resolve; });
        seen.push(accounts[0].authIndex); active -= 1;
      },
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
    });
    publisher.notify(); clock.advance(2_000); await settle();
    data = [account(2)]; publisher.notify(); clock.advance(2_000); await settle();
    release(); await settle();
    release(); await settle();
    expect(seen).toEqual(['i1', 'i2']);
    expect(overlap).toBe(false);
  });
});

describe('startAgentBriefing over the real quota cache', () => {
  let originalWindow: PropertyDescriptor | undefined;
  let calls: Array<{ command: string; args: Record<string, unknown> }>;
  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
    calls = [];
    documentTarget.restore();
    mockIPC((command, args) => {
      calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
      return command === 'get_management_target_revision' ? 4 : null;
    });
  });
  afterEach(() => {
    documentTarget.restore(); clearMocks(); updateQuotaCache({});
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  test('refreshing 8 accounts costs one fenced IPC carrying masked data', async () => {
    const files = Array.from({ length: 8 }, (_, n) => file(`idx${n}`, { name: `acct-${n}.json`, email: `user${n}@example.test` }));
    credentialsSource.mutate(() => ({ files, receivedAtMs: NOW }));
    const stop = startAgentBriefing({ debounceMs: 80, maxWaitMs: 2_000 });
    // Four at a time, as the batch refresh does: loading flips and commits all hit the cache.
    for (const batch of [files.slice(0, 4), files.slice(4)]) {
      updateQuotaCache((cache) => ({ ...cache, ...Object.fromEntries(batch.map((f) => [quotaKey(f), { status: 'loading', rows: [] } as QuotaState])) }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const f of batch) {
        updateQuotaCache((cache) => ({ ...cache, [quotaKey(f)]: success({ fetchedAt: Date.now() }) }));
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const publishes = calls.filter((c) => c.command === 'agent_briefing_publish');
    expect(publishes).toHaveLength(1);
    expect(publishes[0].args.expectedRevision).toBe(4);
    const accounts = publishes[0].args.accounts as BriefingAccount[];
    expect(accounts).toHaveLength(8);
    expect(JSON.stringify(accounts)).not.toContain('example.test');
    // Re-reading the same state (a no-op cache update) publishes nothing more.
    updateQuotaCache((cache) => ({ ...cache }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls.filter((c) => c.command === 'agent_briefing_publish')).toHaveLength(1);
    stop();
    updateQuotaCache((cache) => ({ ...cache, extra: { status: 'idle', rows: [] } }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.filter((c) => c.command === 'agent_briefing_publish')).toHaveLength(1);
  });
});
