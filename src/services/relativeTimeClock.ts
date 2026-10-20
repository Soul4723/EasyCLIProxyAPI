const HOUR_MS = 3_600_000;

/** Countdown cadence: fine ticks under an hour, otherwise the shared coarse cadence. */
export function countdownIntervalMs(remainingEstimate: number): number {
  return remainingEstimate > 0 && remainingEstimate < HOUR_MS ? 1_000 : 30_000;
}
