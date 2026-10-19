import { expect, test } from 'bun:test';
import { startSessionPolling } from '../../../src/services/sessionPolling';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('first check is delayed; pending checks are serial and stop at a terminal result', async () => {
  let reads = 0;
  let release!: (pending: boolean) => void;
  const stop = startSessionPolling({ intervalMs: 10, check: async () => {
    reads++;
    return new Promise<boolean>(resolve => { release = resolve; });
  }, onError: () => { throw new Error('unexpected'); } });
  try {
    expect(reads).toBe(0);
    await wait(30);
    expect(reads).toBe(1);
    await wait(30);
    expect(reads).toBe(1);
    release(true);
    await wait(30);
    expect(reads).toBe(2);
    release(false);
    await wait(30);
    expect(reads).toBe(2);
  } finally { stop(); }
});

test('unsubscribe during an in-flight check never queues a followup', async () => {
  let reads = 0;
  let release!: (pending: boolean) => void;
  const stop = startSessionPolling({ intervalMs: 10, check: async () => {
    reads++;
    return new Promise<boolean>(resolve => { release = resolve; });
  }, onError: () => {} });
  await wait(30);
  stop(); stop();
  release(true);
  await wait(30);
  expect(reads).toBe(1);
});

test('a rejected check reports once and is terminal', async () => {
  let reads = 0;
  const errors: unknown[] = [];
  const failure = new Error('offline');
  const stop = startSessionPolling({ intervalMs: 10, check: async () => { reads++; throw failure; }, onError: error => errors.push(error) });
  try {
    await wait(50);
    expect(reads).toBe(1);
    expect(errors).toEqual([failure]);
  } finally { stop(); }
});

test('hidden sessions do not poll and resume only after the interval', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = Object.assign(new EventTarget(), { hidden: true });
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  let reads = 0;
  const stop = startSessionPolling({ intervalMs: 10, check: async () => { reads++; return true; }, onError: () => {} });
  try {
    await wait(30);
    expect(reads).toBe(0);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(reads).toBe(0);
    await wait(30);
    expect(reads).toBeGreaterThan(0);
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    const before = reads;
    await wait(30);
    expect(reads).toBe(before);
  } finally {
    stop();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
