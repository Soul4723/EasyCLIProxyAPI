import { afterEach, beforeEach, expect, test } from 'bun:test';
import { managementApi } from '../../../src/services/managementApi';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { enrichXaiQuotaPlan, loadQuota, consumeClaudeResetCredit, consumeCodexResetCredit, invalidateQuotaRequests, quotaKey, idleQuota } from '../../../src/services/quotaService';
import { captureQuotaCacheGeneration, getQuotaCacheSnapshot, invalidateQuotaCache } from '../../../src/services/quotaCache';
import { commitFetchedQuota } from '../../../src/services/quotaEnrichment';
import { startQuotaOperation } from '../../../src/services/quotaOperation';
import { resetQuotaWithConfirmation } from '../../../src/services/quotaActions';
import { renderCard } from '../../helpers/quotaAccount';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const grants = { eligible: true, at_limit: true, grants: [{ id: 'test', resets_total: 2, resets_left: 2, usable_now: true }] };
type Request = { path: string; expectedRevision: number; body: { url: string; method: string } };
let originalWindow: PropertyDescriptor | undefined;
let revision: number;
let reads: number;
let accepted: Request[];
let attempted: Request[];
let atCapture: ((captured: number) => Promise<number>) | undefined;
let atDispatch: ((request: Request) => void) | undefined;
let responseGate: Promise<void> | undefined;
const switchTarget = (event = true) => {
  revision++;
  if (event) { invalidateQuotaRequests(); invalidateQuotaCache(); }
};
const fileFor = (provider: string) => ({ name: 'shared.json', auth_index: 'shared', provider });
beforeEach(async () => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { navigator: { language: 'en' } }, configurable: true, writable: true });
  revision = 41; reads = 0; accepted = []; attempted = [];
  atCapture = undefined; atDispatch = undefined; responseGate = undefined;
  invalidateQuotaRequests(); invalidateQuotaCache();
  mockIPC(async (command, payload) => {
    if (command === 'get_management_target_revision') {
      reads++;
      const captured = revision;
      return atCapture ? atCapture(captured) : captured;
    }
    expect(command).toBe('management_request');
    const request = (payload as { request: Request }).request;
    attempted.push(request);
    atDispatch?.(request);
    // Model the actual native dispatch check; Rust tests cover both sides of its lock.
    if (request.expectedRevision !== revision) throw new Error('The core connection changed; request cancelled');
    accepted.push(request);
    const gate = responseGate;
    if (gate) await gate;
    const url = request.body.url;
    const old = request.expectedRevision === 41;
    const body: unknown = url.endsWith('/profile')
      ? { account: { has_claude_max: old, has_claude_pro: !old }, organization: { uuid: '11111111-2222-3333-4444-555555555555' } }
      : url.includes('reset_rate_limits') || url.endsWith('/consume') ? { result: 'reset' }
      : url.includes('rate-limit-reset-credits') ? { available_count: old ? 2 : 7 }
      : { plan_type: 'TARGET A PRIVATE', rate_limit: { primary_window: { used_percent: old ? 10 : 70 } }, five_hour: { utilization: old ? 10 : 70 }, cedar_ember: old ? grants : { ...grants, grants: [{ ...grants.grants[0], resets_total: 7, resets_left: 7 }] } };
    return { status_code: 200, body };
  });
  await managementApi.getTargetRevision(); // this test process is one document at revision 41
  reads = 0;
});
afterEach(() => {
  clearMocks(); invalidateQuotaRequests(); invalidateQuotaCache();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

for (const provider of ['claude', 'codex']) {
  test(`${provider}: every fetch and reset follow-up uses one captured native revision`, async () => {
    const file = fileFor(provider);
    await loadQuota(file);
    expect(reads).toBe(1); // document capture is shared; one completion validation
    expect(accepted.length).toBe(provider === 'claude' ? 3 : 2);
    accepted.forEach(request => expect(request.expectedRevision).toBe(41));
    reads = 0; accepted = [];
    await (provider === 'claude' ? consumeClaudeResetCredit(file) : consumeCodexResetCredit(file));
    expect(reads).toBe(1);
    expect(accepted.some(request => request.body.method === 'POST')).toBe(true);
    accepted.forEach(request => expect(request.expectedRevision).toBe(41));
  });

  test(`${provider}: late old-target load cannot commit or display on either quota surface with the same key`, async () => {
    const file = fileFor(provider);
    const generation = captureQuotaCacheGeneration();
    const gate = deferred<void>(); responseGate = gate.promise;
    const old = loadQuota(file).then(result => commitFetchedQuota(generation, file, result));
    const refused = old.then(() => false, () => true);
    for (let i = 0; i < 30 && !accepted.length; i++) await Promise.resolve();
    expect(accepted.length).toBeGreaterThan(0);
    switchTarget(); responseGate = undefined;
    await expect(loadQuota(file)).rejects.toThrow('connection changed');
    gate.resolve();
    expect(await refused).toBe(true);
    const displayed = getQuotaCacheSnapshot()[quotaKey(file)] ?? idleQuota();
    expect(getQuotaCacheSnapshot()[quotaKey(file)]).toBeUndefined();
    const html = renderCard(file, displayed);
    expect(html).not.toContain('90%');
    expect(html).not.toContain('TARGET A PRIVATE');
  });

  test(`${provider}: commit rejects an already returned old result before the connection event arrives`, async () => {
    const file = fileFor(provider);
    const generation = captureQuotaCacheGeneration();
    const result = await loadQuota(file);
    switchTarget(false);
    await commitFetchedQuota(generation, file, result);
    expect(getQuotaCacheSnapshot()[quotaKey(file)]).toBeUndefined();
  });

  for (const event of [false, true]) {
    test(`${provider}: delayed old-document work cannot borrow a switched target (event=${event})`, async () => {
      const gate = deferred<void>();
      const file = fileFor(provider);
      const delayed = gate.promise.then(() => loadQuota(file));
      switchTarget(event);
      gate.resolve();
      await expect(delayed).rejects.toThrow('connection changed');
      expect(accepted).toHaveLength(0);
      expect(attempted.every(request => request.expectedRevision === 41)).toBe(true);
    });
  }

  test(`${provider}: a refused UI reset never restores stale quota or credits`, async () => {
    const file = fileFor(provider);
    await commitFetchedQuota(captureQuotaCacheGeneration(), file, await loadQuota(file));
    atDispatch = request => {
      if (request.body.method === 'POST') { atDispatch = undefined; switchTarget(false); }
    };
    expect(await resetQuotaWithConfirmation(file, async () => true)).toBe('error');
    expect(accepted.some(request => request.body.method === 'POST')).toBe(false);
    expect(getQuotaCacheSnapshot()[quotaKey(file)]).toEqual(idleQuota());
  });

  test(`${provider}: native dispatch refuses a reset if target changes after the JS guard, before the event`, async () => {
    atDispatch = request => {
      if (request.body.method === 'POST') { atDispatch = undefined; switchTarget(false); }
    };
    const reset = provider === 'claude' ? consumeClaudeResetCredit : consumeCodexResetCredit;
    await expect(reset(fileFor(provider))).rejects.toThrow();
    const mutations = attempted.filter(request => request.body.method === 'POST');
    expect(mutations).toHaveLength(1);
    expect(mutations[0].expectedRevision).toBe(41);
    expect(accepted.some(request => request.body.method === 'POST')).toBe(false);
    expect(attempted.every(request => request.expectedRevision === 41)).toBe(true);
  });

  test(`${provider}: confirmation cannot spend displayed old-target credits before the event`, async () => {
    const file = fileFor(provider);
    await commitFetchedQuota(captureQuotaCacheGeneration(), file, await loadQuota(file));
    const decision = deferred<boolean>();
    const action = resetQuotaWithConfirmation(file, () => decision.promise);
    switchTarget(false); decision.resolve(true);
    await action.catch(() => undefined);
    expect(accepted.some(request => request.body.method === 'POST')).toBe(false);
  });

  test(`${provider}: opening confirmation after a native switch cannot reuse old displayed credits`, async () => {
    const file = fileFor(provider);
    await commitFetchedQuota(captureQuotaCacheGeneration(), file, await loadQuota(file));
    switchTarget(false);
    await expect(resetQuotaWithConfirmation(file, async () => true)).rejects.toThrow('connection changed');
    expect(accepted.some(request => request.body.method === 'POST')).toBe(false);
  });

  test(`${provider}: later refresh-all batches retain the original operation revision`, async () => {
    const operation = startQuotaOperation();
    await loadQuota(fileFor(provider), operation);
    switchTarget(false);
    await expect(loadQuota({ ...fileFor(provider), name: 'second.json' }, operation)).rejects.toThrow('connection changed');
    expect(attempted.every(request => request.expectedRevision === 41)).toBe(true);
    expect(accepted.every(request => request.expectedRevision === 41)).toBe(true);
  });

  test(`${provider}: queued reset captures before waiting and is rejected after same-key target switch`, async () => {
    const gate = deferred<void>(); responseGate = gate.promise;
    const file = fileFor(provider);
    const old = loadQuota(file).catch(() => undefined);
    for (let i = 0; i < 30 && !accepted.length; i++) await Promise.resolve();
    expect(accepted.length).toBeGreaterThan(0);
    const reset = (provider === 'claude' ? consumeClaudeResetCredit(file) : consumeCodexResetCredit(file)).then(() => false, () => true);
    switchTarget(); responseGate = undefined;
    await expect(loadQuota(file)).rejects.toThrow('connection changed');
    gate.resolve(); await old;
    expect(await reset).toBe(true);
    expect(accepted.some(request => request.body.method === 'POST')).toBe(false);
  });
}

test('revision validation failure is fail-closed: no fetched result is accepted', async () => {
  atCapture = async () => { throw new Error('revision unavailable'); };
  for (const provider of ['claude', 'codex']) {
    const file = fileFor(provider);
    await expect(loadQuota(file)).rejects.toThrow('revision unavailable');
    await expect((provider === 'claude' ? consumeClaudeResetCredit(file) : consumeCodexResetCredit(file))).rejects.toThrow('revision unavailable');
  }
  await expect(enrichXaiQuotaPlan(fileFor('xai'), { status: 'success', rows: [] })).rejects.toThrow('revision unavailable');
  expect(attempted.every(request => request.expectedRevision === 41)).toBe(true);
});

test('shared UI batch validates the target once for all accounts and shares first-visit work', async () => {
  const { refreshQuotaBatch } = await import('../../../src/services/quotaBatch');
  const files = [fileFor('claude'), { ...fileFor('codex'), name: 'codex.json' }];
  const first = refreshQuotaBatch(files, true);
  expect(refreshQuotaBatch(files, true)).toBe(first);
  await first;
  expect(reads).toBe(1);
  for (const file of files) expect(getQuotaCacheSnapshot()[quotaKey(file)]?.status).toBe('success');
  accepted = []; reads = 0;
  await refreshQuotaBatch(files, true);
  expect(accepted).toHaveLength(0);
  expect(reads).toBe(0);
});

test('same-key pruning publishes loading resets and fences late quota commits', async () => {
  const { pruneQuotaCache, updateQuotaCache } = await import('../../../src/services/quotaCache');
  const file = fileFor('codex');
  const key = quotaKey(file);
  const rows = [{ label: 'last good', remainingPercent: 90 }];
  updateQuotaCache({ [key]: { status: 'loading', rows } });
  const generation = captureQuotaCacheGeneration();
  const previous = getQuotaCacheSnapshot();
  pruneQuotaCache(new Set([key]));
  expect(getQuotaCacheSnapshot()).not.toBe(previous);
  expect(captureQuotaCacheGeneration()).toBe(generation + 1);
  expect(getQuotaCacheSnapshot()[key]).toEqual({ status: 'idle', rows });
  await commitFetchedQuota(generation, file, { status: 'success', rows: [] });
  expect(getQuotaCacheSnapshot()[key].rows).toBe(rows);
});
