// Share concurrent reads only. Completed results are never cached, so later reads
// (including those after a save) still reach the backend.
export function singleFlight<Args extends unknown[], T>(load: (...args: Args) => Promise<T>) {
  const pending = new Map<string, Promise<T>>();
  return (...args: Args): Promise<T> => {
    const key = JSON.stringify(args);
    const current = pending.get(key);
    if (current) return current;
    const request = load(...args).finally(() => { pending.delete(key); });
    pending.set(key, request);
    return request;
  };
}
