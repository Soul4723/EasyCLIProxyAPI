import { describe, expect, it } from 'bun:test';
import { singleFlight } from '../src/services/inFlight';

describe('concurrent reads', () => {
  it('shares identical in-flight reads, separates arguments, and never caches completed results', async () => {
    const resolvers: ((value: number) => void)[] = [];
    let calls = 0;
    const read = singleFlight((_key: string) => {
      calls++;
      return new Promise<number>(resolve => resolvers.push(resolve));
    });
    const first = read('one');
    expect(read('one')).toBe(first);
    const other = read('two');
    expect(calls).toBe(2);
    resolvers[0](1);
    resolvers[1](2);
    expect(await first).toBe(1);
    expect(await other).toBe(2);
    const fresh = read('one');
    expect(calls).toBe(3);
    resolvers[2](3);
    expect(await fresh).toBe(3);
  });

  it('shares failures but allows a fresh retry', async () => {
    let calls = 0;
    const read = singleFlight(async () => {
      if (++calls === 1) throw new Error('offline');
      return 'online';
    });
    const first = read();
    expect(read()).toBe(first);
    await expect(first).rejects.toThrow('offline');
    expect(await read()).toBe('online');
    expect(calls).toBe(2);
  });
});
