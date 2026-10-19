import { createDataSource } from './dataSource';

/** A private, short-lived source per session: delayed first check, serial checks,
 * fixed cadence after completion, visibility pause, and terminal errors. Call stop
 * when the owner cancels/unmounts; callers still fence their asynchronous effects.
 * Session expiry is a separate wall-clock deadline, not another data poll.
 */
export function startSessionPolling(options: {
  intervalMs: number;
  check: () => Promise<boolean>; // false means terminal; never schedule another check
  onError: (error: unknown) => void;
}): () => void {
  let active = true;
  let initial = true;
  let unsubscribe = () => {};
  const stop = () => {
    if (!active) return;
    active = false;
    unsubscribe();
    source.reset(); // fence any in-flight completion, after removing the subscriber
  };
  const source = createDataSource({
    pollMs: options.intervalMs,
    maxPollMs: options.intervalMs,
    focusMs: Infinity,
    load: async () => {
      // Source subscription loads immediately; the session's first actual check
      // deliberately waits one interval, like every subsequent check.
      if (initial) { initial = false; return null; }
      if (!active) return null;
      try {
        const pending = await options.check();
        if (active && !pending) stop();
      } catch (error) {
        if (active) { stop(); options.onError(error); }
      }
      return null;
    },
  });
  unsubscribe = source.subscribe(() => {});
  return stop;
}
