import { expect, test } from 'bun:test';
import { createDocumentTarget } from '../src/services/documentTarget';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  let revision = 7;
  let captures = 0;
  const sent: { command: string; payload: Record<string, any> }[] = [];
  const attempted: typeof sent = [];
  const target = createDocumentTarget((async (command: string, payload: Record<string, any> = {}) => {
    if (command === 'get_management_target_revision') { captures++; return revision; }
    attempted.push({ command, payload });
    const expected = command === 'management_request' ? payload.request.expectedRevision : payload.expectedRevision;
    // Model the native pre-dispatch check; complementary Rust tests exercise the real handlers.
    if (expected !== revision) throw new Error('The core connection changed; request cancelled');
    sent.push({ command, payload });
    return { ok: true };
  }) as typeof import('@tauri-apps/api/core').invoke);
  return { target, sent, attempted, switchTarget: () => revision++, captures: () => captures };
}

test('document never recaptures: generic old read/modify/write continuation is rejected before send without an event', async () => {
  const f = fixture();
  await f.target.invoke('management_request', { request: { method: 'GET', path: '/config' } });
  f.switchTarget();
  await expect(f.target.invoke('management_request', { request: { method: 'PUT', path: '/config', body: { old: true } } })).rejects.toThrow('connection changed');
  expect(f.sent).toHaveLength(1);
  expect(f.attempted[1].payload.request.expectedRevision).toBe(7);
  expect(f.captures()).toBe(1);
});

for (const command of ['upload_auth_file', 'import_vertex_credential', 'start_oauth_login', 'get_oauth_status', 'submit_oauth_callback', 'save_extended_core_config', 'create_thinking_alias']) {
  test(`${command}: delayed old-document invocation keeps immutable revision`, async () => {
    const f = fixture();
    await f.target.getRevision();
    const read = deferred<void>();
    const pending = read.promise.then(() => f.target.invoke(command, { state: 'state-A', data: [1, 2] }));
    f.switchTarget(); read.resolve();
    await expect(pending).rejects.toThrow('connection changed');
    expect(f.sent).toHaveLength(0);
    expect(f.attempted[0].payload.expectedRevision).toBe(7);
    expect(f.captures()).toBe(1);
  });
}

for (const request of [
  { method: 'DELETE', path: '/oauth/session', query: { state: 'state-A' } },
  { method: 'POST', path: '/plugins/store/test/install', query: { source: 'private' }, timeoutMs: 120000 },
]) {
  test(`${request.path}: generic bypass paths are also document-bound`, async () => {
    const f = fixture(); await f.target.getRevision(); f.switchTarget();
    await expect(f.target.invoke('management_request', { request })).rejects.toThrow('connection changed');
    expect(f.sent).toHaveLength(0);
    expect(f.attempted[0].payload.request).toEqual({ ...request, expectedRevision: 7 });
  });
}

test('save blocks pending work and a failed save restores the same revision', async () => {
  const f = fixture(); await f.target.getRevision();
  f.target.block();
  await expect(f.target.invoke('start_oauth_login', { provider: 'codex' })).rejects.toThrow('reload');
  expect(f.attempted).toHaveLength(0);
  f.target.restore();
  await f.target.invoke('start_oauth_login', { provider: 'codex' });
  expect(f.sent[0].payload.expectedRevision).toBe(7);
  expect(f.captures()).toBe(1);
});

test('explicit per-operation revision cannot rebind an old document to the new target', async () => {
  const f = fixture(); await f.target.getRevision(); f.switchTarget();
  await expect(f.target.invoke('management_request', { request: { method: 'POST', path: '/requests/api-call', expectedRevision: 8 } })).rejects.toThrow('reload');
  expect(f.attempted).toHaveLength(0);
});

test('revision initialization failure is fail-closed and is not retried into another target', async () => {
  let calls = 0;
  const f = createDocumentTarget((async () => { calls++; throw new Error('unavailable'); }) as typeof import('@tauri-apps/api/core').invoke);
  await expect(f.getRevision()).rejects.toThrow('unavailable');
  await expect(f.invoke('start_oauth_login')).rejects.toThrow('unavailable');
  expect(calls).toBe(1);
});

test('isBlocked follows block and restore', () => {
  const f = fixture();
  expect(f.target.isBlocked()).toBe(false);
  f.target.block();
  expect(f.target.isBlocked()).toBe(true);
  f.target.restore();
  expect(f.target.isBlocked()).toBe(false);
});
