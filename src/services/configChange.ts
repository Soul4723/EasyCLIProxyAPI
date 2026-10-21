import { listen, type UnlistenFn } from './platform';

export const CONFIG_FILES_CHANGED = 'config-files-changed';

/** Kinds of watched file, as classified natively: the GUI config, the core config and agent configs. */
export type ConfigScope = 'gui' | 'core' | 'agent';
const KNOWN_SCOPES: readonly string[] = ['gui', 'core', 'agent'];

/** What the core, connection and credentials readers depend on; agent-only edits do not touch them. */
export const CORE_CONFIG_SCOPES: readonly ConfigScope[] = ['gui', 'core'];

/**
 * Whether a `config-files-changed` payload touches a file the listener reads. Anything that does not
 * say what changed (no payload, no scopes, errors only, a scope this build does not know) refreshes.
 */
export function configChangeAffects(payload: unknown, scopes: readonly ConfigScope[]): boolean {
  const changed = (payload as { scopes?: unknown } | null | undefined)?.scopes;
  if (!Array.isArray(changed) || changed.length === 0) return true;
  return changed.some(scope => typeof scope !== 'string' || !KNOWN_SCOPES.includes(scope) || (scopes as readonly string[]).includes(scope));
}

/** Payload filter for `createDataSource({ events, eventFilter })`. */
export const configChangeFilter = (scopes: readonly ConfigScope[]) => (payload: unknown) => configChangeAffects(payload, scopes);

/** `listen('config-files-changed')` that only calls `handler` for changes inside `scopes`. */
export function listenConfigChange(scopes: readonly ConfigScope[], handler: () => void): Promise<UnlistenFn> {
  return listen<unknown>(CONFIG_FILES_CHANGED, event => { if (configChangeAffects(event.payload, scopes)) handler(); });
}
