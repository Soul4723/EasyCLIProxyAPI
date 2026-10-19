import { expect, test } from 'bun:test';
import { createDataSource } from '../src/services/dataSource';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('process status owner coalesces readers, pauses hidden and stops after detail closes', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = Object.assign(new EventTarget(), { hidden: false });
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  let reads = 0;
  const source = createDataSource({ pollMs: 20, load: async () => { reads++; return { running: false }; } });
  const close = source.subscribe(() => {});
  const badge = source.subscribe(() => {});
  try {
    await source.load();
    expect(reads).toBe(1);
    const snapshot = source.getSnapshot();
    await wait(30);
    expect(reads).toBe(2);
    expect(source.getSnapshot()).toBe(snapshot);
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    await wait(50);
    expect(reads).toBe(2);
    badge(); close();
    doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
    await wait(30);
    expect(reads).toBe(2);
  } finally {
    badge(); close();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('collector action publication fences a pending status read and retains data on later failures', async () => {
  let resolve!: (status: { phase: string }) => void;
  let fail = false;
  const source = createDataSource({ load: () => fail ? Promise.reject(new Error('storage error')) : new Promise<{ phase: string }>(done => { resolve = done; }) });
  const pending = source.refresh();
  source.mutate(() => ({ phase: 'paused' }));
  resolve({ phase: 'collecting' });
  await pending;
  expect(source.getSnapshot().data).toEqual({ phase: 'paused' });
  fail = true;
  await source.refresh();
  expect(source.getSnapshot().data).toEqual({ phase: 'paused' });
  expect(source.getSnapshot().error).toBe('storage error');
});
