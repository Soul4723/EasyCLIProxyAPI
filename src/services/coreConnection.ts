import type { CoreConnection } from '../coreConnection';

export function normalizedCoreConnection(connection: CoreConnection): CoreConnection {
  if (connection.mode === 'local') return { ...connection };
  const normalizeOrigin = (value: string, required: boolean) => {
    if (/[\x00-\x1f\x7f]/.test(value) || / /.test(value.trim())) throw new Error('origin');
    const trimmed = value.trim();
    if (!trimmed) { if (required) throw new Error('origin'); return ''; }
    if (!/^https?:\/\/[^/?#\\]+\/?$/i.test(trimmed)) throw new Error('origin');
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || url.port === '0') throw new Error('origin');
    return url.origin;
  };
  const remoteManagementOrigin = normalizeOrigin(connection.remoteManagementOrigin, true);
  const remoteManagementKey = connection.remoteManagementKey.trim();
  if (!remoteManagementKey || /[\x00-\x1f\x7f]/.test(connection.remoteManagementKey)) throw new Error('key');
  const clientApiOrigin = normalizeOrigin(connection.clientApiOrigin, Boolean(connection.clientApiKey.trim()));
  const clientApiKey = connection.clientApiKey.trim();
  if (/[\x00-\x1f\x7f]/.test(connection.clientApiKey)) throw new Error('client key');
  if (clientApiOrigin && !clientApiKey) throw new Error('client key');
  if (clientApiKey && !clientApiOrigin) throw new Error('client origin');
  return { ...connection, remoteManagementOrigin, remoteManagementKey, clientApiOrigin, clientApiKey };
}

export const remoteConfigFieldRequiresServer = (path: readonly string[]) =>
  ['server/host', 'server/port', 'server/tls', 'management', 'oauth/auth-dir'].some(prefix =>
    path.join('/') === prefix || path.join('/').startsWith(`${prefix}/`));
