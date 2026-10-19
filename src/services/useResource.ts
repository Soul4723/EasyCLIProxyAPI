import { useMemo, useRef, type DependencyList } from 'react';
import { createDataSource, useDataSource, type DataSourceOptions } from './dataSource';

/**
 * A component-owned query. Dependencies identify an immutable request (including
 * its target); replacing it fences old responses without discarding displayed data.
 * Shared resources belong in module-owned sources instead. The owner invalidates
 * queries on events/focus; there is no implicit polling or focus refresh.
 */
export function useResource<T>(load: () => Promise<T>, dependencies: DependencyList, options: Omit<DataSourceOptions<T>, 'load'> = {}) {
  const source = useMemo(() => createDataSource({ focusMs: Infinity, ...options, trackRefresh: true, load }), dependencies);
  const snapshot = useDataSource(source);
  const previous = useRef<T | undefined>(undefined);
  if (snapshot.data !== undefined) previous.current = snapshot.data;
  const data = snapshot.data === undefined ? previous.current : snapshot.data;
  // Match shared sources: retained data is a background refresh, not initial loading.
  return { ...snapshot, data, loading: snapshot.loading && data === undefined, refreshing: snapshot.loading && data !== undefined, source };
}
