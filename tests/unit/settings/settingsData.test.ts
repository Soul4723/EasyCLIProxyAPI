import { expect, test } from 'bun:test';
import { createSettingsRead } from '../../../src/services/settingsData';

test('Settings explicit reads coalesce concurrent callers but revisit fresh data', async () => {
  let calls = 0;
  let resolve!: (value: number) => void;
  const owner = createSettingsRead(() => {
    calls++;
    return new Promise<number>(done => { resolve = done; });
  });
  const first = owner.read();
  const second = owner.read();
  expect(calls).toBe(1);
  resolve(1);
  expect(await first).toBe(1);
  expect(await second).toBe(1);
  const revisit = owner.read();
  expect(calls).toBe(2);
  resolve(2);
  expect(await revisit).toBe(2);
});

test('Settings explicit reads propagate failures and allow a deliberate retry', async () => {
  let calls = 0;
  const owner = createSettingsRead(async () => {
    if (++calls === 1) throw new Error('unavailable');
    return 'saved';
  });
  await expect(owner.read()).rejects.toThrow('unavailable');
  expect(await owner.read()).toBe('saved');
  expect(calls).toBe(2);
});

test('an event during a pending Settings read waits for a fresh follow-up', async () => {
  const loads: Array<(value: string) => void> = [];
  const owner = createSettingsRead(() => new Promise<string>(resolve => loads.push(resolve)));
  const mounted = owner.read();
  const event = owner.read({ fresh: true });
  let eventDone = false;
  void event.then(() => { eventDone = true; });
  loads[0]('before event');
  // Let the first request finish and the source start its queued follow-up.
  for (let i = 0; i < 10 && loads.length < 2; i++) await Promise.resolve();
  expect(loads).toHaveLength(2);
  expect(eventDone).toBe(false);
  loads[1]('after event');
  expect(await event).toBe('after event');
  expect(await mounted).toBe('after event');
});

test('authoritative Settings writes fence an old read before a subsequent event refresh', async () => {
  const loads: Array<(value: string) => void> = [];
  const owner = createSettingsRead(() => new Promise<string>(resolve => loads.push(resolve)));
  const old = owner.read();
  owner.publish('saved');
  const event = owner.read({ fresh: true });
  loads[0]('before save');
  for (let i = 0; i < 10 && loads.length < 2; i++) await Promise.resolve();
  expect(loads).toHaveLength(2);
  loads[1]('saved');
  expect(await event).toBe('saved');
  expect(await old).toBe('saved');
});

test('authoritative Settings payload wins over an in-flight response without another read', async () => {
  let resolve!: (value: string) => void;
  const owner = createSettingsRead(() => new Promise<string>(done => { resolve = done; }));
  const old = owner.read();
  owner.publish('auto-switched');
  resolve('previous source');
  expect(await old).toBe('auto-switched');
});
