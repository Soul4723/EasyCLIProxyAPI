import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useCoreRuntime } from '../coreRuntime';
import type { PluginNavEntry } from '../services/pluginNavigation';
import { usePluginNavEntries } from '../usePluginNavEntries';

type PluginNavValue = {
  entries: PluginNavEntry[];
  /** True once the entries came from the core (the cached list may be stale until then). */
  fetched: boolean;
  /** Bumped when the active plugin entry is clicked again; the webview page reloads on change. */
  reloadToken: number;
  reload: () => void;
};

const PluginNavContext = createContext<PluginNavValue>({ entries: [], fetched: false, reloadToken: 0, reload: () => undefined });

/** One fetch of the plugin page entries (menus of enabled plugins) shared by the sidebar group and the plugin route. */
export function PluginNavProvider({ children }: { children: ReactNode }) {
  const { status } = useCoreRuntime();
  const { entries, fetched } = usePluginNavEntries(Boolean(status?.ready));
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((value) => value + 1), []);
  const value = useMemo(() => ({ entries, fetched, reloadToken, reload }), [entries, fetched, reloadToken, reload]);
  return <PluginNavContext.Provider value={value}>{children}</PluginNavContext.Provider>;
}

export const usePluginNav = () => useContext(PluginNavContext);
