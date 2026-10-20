import { useEffect, useRef, useState } from 'react';
import { ExternalLink, ShieldAlert } from 'lucide-react';
import { useI18n } from '../../i18n';
import { pluginText } from '../../i18n/plugins';
import { pluginStoreApi, type PluginStoreEntry, type PluginStoreInstallResult } from '../../services/plugins';
import { buildRepositoryURL, getPluginConfirmToken, isDefaultPluginStoreSource, isOfficialPlugin, isOfficialRepository } from '../../services/pluginResources';
import { buildGitHubReleasesPageURL, isValidManualReleaseTag, supportsPluginVersionSelection } from '../../services/pluginReleaseVersions';
import { Button, Chip, Dialog, IconButton, Masked } from '../../ui';
import { Banner, GitHubTokenHint, PluginTile, Scope, isGitHubRateLimit } from './parts';
import { errorMessage } from './usePlugins';

/**
 * Install / update / choose-version dialog for one store entry.
 * Third-party entries (anything but the official registry + official repository) need a review step and a typed
 * confirmation (repository slug) before the install call; official ones install directly.
 * Props: entry, onClose, onInstalled(result), onOpenExternal(url) (opens the repository / releases page in the browser).
 */
export function InstallDialog({ entry, onClose, onInstalled, onOpenExternal }: {
  entry: PluginStoreEntry;
  onClose: () => void;
  onInstalled: (result: PluginStoreInstallResult) => void | Promise<void>;
  onOpenExternal: (url: string) => void;
}) {
  const { t, locale } = useI18n();
  const pt = (key: Parameters<typeof pluginText>[0]) => pluginText(key, locale);
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [typed, setTyped] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  // Every exit (Cancel, Close, Escape) aborts an in-flight install and closes at once.
  const cancel = () => {
    controller.current?.abort();
    onClose();
  };

  const thirdParty = !isOfficialPlugin(entry);
  // Listed by the official store but hosted outside the official organisation: the store does not vouch for the author.
  const externalRepository = isDefaultPluginStoreSource(entry) && !isOfficialRepository(entry.repository);
  const token = getPluginConfirmToken(entry);
  const confirmed = !thirdParty || (reviewed && typed.trim() === token);
  const canSelectVersion = supportsPluginVersionSelection(entry.installType);
  const validVersion = !version.trim() || isValidManualReleaseTag(version);
  const repository = buildRepositoryURL(entry.repository);
  const releases = buildGitHubReleasesPageURL(entry.repository);
  const action = pt(entry.installed ? (entry.updateAvailable ? 'update' : 'reinstall') : 'install');

  const install = async () => {
    if (pending.current || !validVersion || !confirmed) return;
    pending.current = true; setBusy(true); setError('');
    const request = new AbortController();
    controller.current = request;
    try {
      const result = await pluginStoreApi.install(entry.id, { sourceId: entry.sourceId, version: canSelectVersion ? version.trim() : undefined, signal: request.signal });
      if (mounted.current && !request.signal.aborted) await onInstalled(result);
    } catch (reason) {
      if (mounted.current && !request.signal.aborted) setError(errorMessage(reason));
    } finally { controller.current = null; pending.current = false; if (mounted.current) setBusy(false); }
  };

  return (
    <Dialog open onClose={cancel} size="md"
      title={<Scope><span className="pl-dialog-title"><PluginTile size={28} />{entry.name || entry.id}<Chip size="sm" tone={entry.updateAvailable ? 'info' : 'outline'}>{entry.installed && entry.installedVersion ? `${entry.installedVersion} → ${entry.version}` : entry.version}</Chip></span></Scope>}
      footer={<>
        <Button variant="secondary" onClick={cancel}>{t('common.cancel')}</Button>
        {thirdParty && !reviewed
          ? <Button variant="primary" icon={<ShieldAlert size={14} />} onClick={() => setReviewed(true)}>{pt('trustNext')}</Button>
          : <Button variant="primary" loading={busy} disabled={!validVersion || !confirmed} onClick={() => void install()}>{action}</Button>}
      </>}>
      <Scope><div className="pl-form pl-install">
        <div className="pl-kv">
          <span className="pl-kv-k">{pt('source')}</span>
          <span className="pl-kv-v">
            <span className="pl-kv-line"><Chip size="sm" tone={thirdParty ? 'warn' : 'ok'}>{pt(thirdParty ? 'thirdParty' : 'official')}</Chip>{entry.sourceName || entry.sourceId}</span>
            {entry.sourceUrl ? <Masked value={entry.sourceUrl} mono className="pl-muted ec-trunc" /> : null}
          </span>
          <span className="pl-kv-k">{pt('repository')}</span>
          <span className="pl-kv-v pl-kv-line">
            <Masked value={entry.repository || '—'} mono className="ec-trunc" />
            {repository ? <IconButton size="xs" icon={<ExternalLink size={12} />} label={t('sec.plugins.openRepository')} onClick={() => onOpenExternal(repository)} /> : null}
          </span>
        </div>

        {canSelectVersion ? (
          <label className="pl-field">
            <span className="pl-field-label">{pt('version')}
              {releases ? <Button size="xs" variant="ghost" icon={<ExternalLink size={12} />} onClick={() => onOpenExternal(releases)}>{t('sec.plugins.releases')}</Button> : null}
            </span>
            <input className="pl-input pl-input--mono" value={version} onChange={event => setVersion(event.target.value)} disabled={busy}
              placeholder={entry.version || t('sec.plugins.latest')} aria-invalid={!validVersion} spellCheck={false} autoComplete="off" />
            {!validVersion ? <small className="pl-field-error" role="alert">{pt('invalidVersion')}</small> : null}
          </label>
        ) : null}

        {thirdParty ? (
          <Banner tone="warn">{externalRepository ? t('sec.plugins.officialStoreThirdParty') : pt('trustWarning')}</Banner>
        ) : (
          <Banner tone="info">{pt('installHint')}</Banner>
        )}

        {thirdParty && reviewed ? (
          <label className="pl-field">
            <span className="pl-field-label">{entry.installed ? t('sec.plugins.trustTypeUpdate') : pt('trustType')}<code className="pl-token">{token}</code></span>
            <input className="pl-input pl-input--mono" value={typed} onChange={event => setTyped(event.target.value)} disabled={busy}
              placeholder={token} spellCheck={false} autoComplete="off" />
          </label>
        ) : null}

        {error ? <Banner tone="error"><Masked value={error} />{isGitHubRateLimit(error) ? <GitHubTokenHint /> : null}</Banner> : null}
      </div></Scope>
    </Dialog>
  );
}
