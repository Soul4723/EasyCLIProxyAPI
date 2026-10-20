import { expect, test } from 'bun:test';
import { countdownIntervalMs } from '../../../src/services/relativeTimeClock';

test('countdown uses one-second ticks only under an hour', () => {
  expect(countdownIntervalMs(3_599_000)).toBe(1_000);
  expect(countdownIntervalMs(3_600_000)).toBe(30_000);
  expect(countdownIntervalMs(3_601_000)).toBe(30_000);
  expect(countdownIntervalMs(0)).toBe(30_000);
});
