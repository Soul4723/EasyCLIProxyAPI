import type { CoreConnection } from '../coreConnection';

export function normalizedCoreConnection(connection: CoreConnection): CoreConnection {
  if (connection.mode === 'local') return { ...connection };
  const normalizeOrigin = (value: string, required: boolean) => {
    const trimmed = value.trim();
    if (!trimmed) { if (required) throw new Error('origin'); return ''; }
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error('origin');
    return url.origin;
  };
  const remoteManagementOrigin = normalizeOrigin(connection.remoteManagementOrigin, true);
  const remoteManagementKey = connection.remoteManagementKey.trim();
  if (!remoteManagementKey) throw new Error('key');
  const clientApiOrigin = normalizeOrigin(connection.clientApiOrigin, Boolean(connection.clientApiKey.trim()));
  const clientApiKey = connection.clientApiKey.trim();
  if (clientApiOrigin && !clientApiKey) throw new Error('client key');
  if (clientApiKey && !clientApiOrigin) throw new Error('client origin');
  return { ...connection, remoteManagementOrigin, remoteManagementKey, clientApiOrigin, clientApiKey };
}

export const remoteConfigFieldRequiresServer = (path: readonly string[]) =>
  ['server/host', 'server/port', 'server/tls', 'management', 'oauth/auth-dir'].some(prefix =>
    path.join('/') === prefix || path.join('/').startsWith(`${prefix}/`));
