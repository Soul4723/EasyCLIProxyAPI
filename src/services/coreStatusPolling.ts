import type { ActivitySource } from './activePolling';

// One completed request per tick. Unreachable cores back off to one minute;
// resuming the window always probes immediately, without replaying missed ticks.
export function startCoreStatusPolling(source: ActivitySource, refresh: () => Promise<boolean>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let running = false;
  let delay = 10_000;
  let revision = 0;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const tick = async () => {
    if (disposed || !source.active() || running) return;
    running = true;
    const before = revision;
    try {
      const reachable = await refresh();
      delay = reachable ? 10_000 : Math.min(delay * 2, 60_000);
    } finally {
      running = false;
      if (!disposed && source.active()) {
        // A hide/resume while awaiting a request still gets a fresh probe.
        timer = setTimeout(() => { void tick(); }, before === revision ? delay : 0);
      }
    }
  };
  const update = () => {
    ++revision;
    clear();
    delay = 10_000;
    if (source.active()) void tick();
  };
  const unsubscribe = source.subscribe(update);
  update();
  return () => { disposed = true; unsubscribe(); clear(); };
}
