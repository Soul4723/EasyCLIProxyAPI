import { useEffect, useMemo, useRef } from 'react';

/**
 * Sequencing for async loaders: `begin()` starts a request and returns `isCurrent()`, which turns false once a newer
 * request began, `invalidate()` ran (a save result supersedes in-flight loads) or the component unmounted.
 */
export function useRequestGuard() {
  const revision = useRef(0);
  useEffect(() => {
    return () => { revision.current += 1; };
  }, []);
  return useMemo(() => ({
    begin: () => {
      const request = ++revision.current;
      return () => request === revision.current;
    },
    invalidate: () => { revision.current += 1; },
  }), []);
}
