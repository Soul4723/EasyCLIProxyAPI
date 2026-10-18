import { Download, ExternalLink, Store } from 'lucide-react';
import { buildRepositoryURL, isOfficialPlugin } from '../../services/pluginResources';
import type { PluginStoreEntry } from '../../services/plugins';
import { Button, Card, Chip, EmptyState, FilterChips, IconButton, Masked, SearchInput, Skeleton } from '../../ui';
import { GitHubTokenHint, PluginTile, isGitHubRateLimit } from './parts';
import type { PluginsController } from './usePlugins';

/** Store tab: toolbar (search · filter chips · source) over a card grid; each card carries its install/update/version action. */
export function StoreList({ ctl }: { ctl: PluginsController }) {
  const { t, pt, store, storePlugins, locked } = ctl;
  const filtered = ctl.storeSearch.trim() !== '' || ctl.storeFilter !== 'all' || Boolean(ctl.sourceFilter);
  const all = store?.plugins ?? [];
  const filters = [
    { value: 'all' as const, label: t('sec.plugins.filter.all'), count: all.length },
    { value: 'installed' as const, label: t('sec.plugins.filter.installed'), count: all.filter(entry => entry.installed).length },
    { value: 'updates' as const, label: t('sec.plugins.filter.updates'), count: all.filter(entry => entry.updateAvailable).length },
  ];
  const sourceErrors = store?.sourceErrors ?? [];

  return (
    <div className="pl-stack">
      <div className="pl-toolbar">
        <FilterChips ariaLabel={t('sec.plugins.filterLabel')} value={ctl.storeFilter} onChange={ctl.setStoreFilter} options={filters} />
        <div className="pl-toolbar-end">
          {ctl.storeSources.length > 1 || ctl.sourceFilter ? (
            <select className="pl-select" aria-label={pt('storeSource')} value={ctl.sourceFilter} onChange={event => ctl.setSourceFilter(event.target.value)}>
              <option value="">{pt('allStores')}</option>
              {ctl.storeSources.map(source => <option key={source.key} value={source.key}>{source.label}</option>)}
            </select>
          ) : null}
          <div className="pl-search"><SearchInput value={ctl.storeSearch} onChange={ctl.setStoreSearch} placeholder={pt('search')} /></div>
        </div>
      </div>

      {sourceErrors.length > 0 ? (
        <details className="pl-source-errors" open>
          <summary>{pt('sourceErrors')}<span className="pl-count">{sourceErrors.length}</span></summary>
          <ul>
            {sourceErrors.map((entry, index) => (
              <li key={index}><strong>{entry.sourceName || entry.sourceId || entry.sourceUrl}</strong><Masked value={entry.message} /></li>
            ))}
          </ul>
          {sourceErrors.some(entry => isGitHubRateLimit(entry.message)) ? <GitHubTokenHint /> : null}
        </details>
      ) : null}

      {ctl.loading && !store ? (
        <div className="pl-grid" aria-busy="true">
          {[0, 1, 2, 3].map(index => (
            <Card key={index}><Skeleton width={36} height={36} radius="var(--ec-r-md)" /><Skeleton lines={3} height={10} /></Card>
          ))}
        </div>
      ) : storePlugins.length === 0 ? (
        <EmptyState icon={<Store size={20} />} title={pt(filtered ? 'noMatches' : 'empty')} />
      ) : (
        <ul className="pl-grid">
          {storePlugins.map(entry => <StoreCard key={entry.storeId} entry={entry} ctl={ctl} locked={locked} />)}
        </ul>
      )}
    </div>
  );
}

function StoreCard({ entry, ctl, locked }: { entry: PluginStoreEntry; ctl: PluginsController; locked: boolean }) {
  const { pt, t } = ctl;
  const official = isOfficialPlugin(entry);
  const repository = buildRepositoryURL(entry.repository);
  const needsAuth = entry.authRequired && !entry.authConfigured;
  const label = needsAuth ? 'authMissing' : !entry.installed ? 'install' : entry.updateAvailable ? 'update' : 'reinstall';
  const platforms = entry.platforms.map(platform => `${platform.goos}/${platform.goarch}`);
  return (
    <li>
      <Card className="pl-card" as="article">
        <div className="pl-card-head">
          <PluginTile />
          <div className="pl-id">
            <strong className="ec-trunc">{entry.name || entry.id}</strong>
            <Masked value={entry.id} kind="identifier" mono className="pl-id-code ec-trunc" />
          </div>
          <Chip size="sm" tone={official ? 'ok' : 'warn'}>{pt(official ? 'official' : 'thirdParty')}</Chip>
        </div>
        {entry.description ? <p className="pl-card-desc">{entry.description}</p> : null}
        <div className="pl-card-meta">
          <Chip size="sm" tone="outline">{entry.version}</Chip>
          {entry.author ? <span className="ec-trunc">{entry.author}</span> : null}
          {entry.license ? <span className="pl-muted">{entry.license}</span> : null}
        </div>
        <div className="pl-card-meta pl-muted">
          <span className="pl-card-source ec-trunc" title={`${pt('source')}: ${entry.sourceName || entry.sourceId}`}>{entry.sourceName || entry.sourceId}</span>
          {platforms.length > 0 ? <span className="pl-platforms ec-trunc" title={platforms.join(' · ')}>{platforms.join(' · ')}</span> : null}
        </div>
        <div className="pl-card-foot">
          {entry.installed ? (
            entry.updateAvailable
              ? <Chip size="sm" tone="info">{entry.installedVersion} → {entry.version}</Chip>
              : <Chip size="sm" tone="ok">{pt('installed')}{entry.installedVersion ? ` ${entry.installedVersion}` : ''}</Chip>
          ) : null}
          <span className="pl-spacer" />
          {repository ? <IconButton size="sm" icon={<ExternalLink size={14} />} label={t('sec.plugins.openRepository')} onClick={() => ctl.openExternal(repository)} /> : null}
          <Button size="sm" variant={entry.installed && !entry.updateAvailable ? 'secondary' : 'primary'} icon={needsAuth ? undefined : <Download size={14} />}
            disabled={locked || needsAuth} title={needsAuth ? pt('authMissing') : undefined} onClick={() => ctl.setInstallEntry(entry)}>
            {pt(label)}
          </Button>
        </div>
      </Card>
    </li>
  );
}
