import { createContext, useContext } from 'react';
import { coreConfigSource, useSharedCoreConfig, type CoreConfigSettings } from '../../services/coreConfig';
export type { CoreApiKey, CoreConfigSettings } from '../../services/coreConfig';

export type CoreConfigApi = {
  settings: CoreConfigSettings | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  /** Replace the cached settings with the value a save command returned. */
  apply: (next: CoreConfigSettings) => void;
};

export const CoreConfigContext = createContext<CoreConfigApi | null>(null);

export function useCoreConfig(): CoreConfigApi {
  const api = useContext(CoreConfigContext);
  if (!api) throw new Error('useCoreConfig must be used inside the Settings page');
  return api;
}

/** Settings adapts the shared owner to the tabs' loading/error contract. */
export function useCoreConfigLoader(): CoreConfigApi {
  const snapshot = useSharedCoreConfig();
  return {
    settings: snapshot.data ?? null, loading: snapshot.loading, error: snapshot.error ?? '',
    reload: coreConfigSource.refresh,
    apply: next => coreConfigSource.mutate(() => next),
  };
}
