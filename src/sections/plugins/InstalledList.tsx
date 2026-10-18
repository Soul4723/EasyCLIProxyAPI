import { ArrowUp, Download, ExternalLink, Folder, LogIn, Puzzle, Settings2, Trash2 } from 'lucide-react';
import { navigate, routePath } from '../../shell/router';
import { usePrivacyMask } from '../../privacy';
import { collectPluginResourceEntries } from '../../services/pluginResources';
import { Button, Card, Chip, EmptyState, FilterChips, IconButton, Masked, SearchInput, Skeleton, Toggle } from '../../ui';
import { PluginStatus, PluginTile } from './parts';
import type { PluginsController } from './usePlugins';

/** Installed tab: toolbar (search · filter chips · source) over one row per plugin, then the active/directory summary. */
export function InstalledList({ ctl }: { ctl: PluginsController }) {
  const { t, pt, data, plugins, locked } = ctl;
  const mask = usePrivacyMask();
  const showSources = Boolean(ctl.store) && ctl.storeSources.length > 1;
  const filtered = ctl.installedSearch.trim() !== '' || ctl.installedFilter !== 'all' || Boolean(ctl.installedSource);
  const filters = [
    { value: 'all' as const, label: t('sec.plugins.filter.all'), count: data?.plugins.length ?? 0 },
    { value: 'updates' as const, label: t('sec.plugins.filter.updates'), count: ctl.updatesCount },
    { value: 'local' as const, label: t('sec.plugins.filter.local'), count: ctl.installedCount },
    ...(ctl.configOnlyCount > 0 || ctl.installedFilter === 'configOnly'
      ? [{ value: 'configOnly' as const, label: t('sec.plugins.filter.configOnly'), count: ctl.configOnlyCount }] : []),
  ];
  const changeFilter = (value: typeof ctl.installedFilter) => {
    ctl.setInstalledFilter(value);
    if (value === 'updates') void ctl.ensureStore();
  };

  return (
    <div className="pl-stack">
      <div className="pl-toolbar">
        <FilterChips ariaLabel={t('sec.plugins.filterLabel')} value={ctl.installedFilter} onChange={changeFilter} options={filters} />
        <div className="pl-toolbar-end">
          {showSources ? (
            <select className="pl-select" aria-label={pt('storeSource')} value={ctl.installedSource} onChange={event => ctl.setInstalledSource(event.target.value)}>
              <option value="">{pt('allStores')}</option>
              {ctl.storeSources.map(source => <option key={source.key} value={source.key}>{source.label}</option>)}
            </select>
          ) : null}
          <div className="pl-search"><SearchInput value={ctl.installedSearch} onChange={ctl.setInstalledSearch} placeholder={pt('search')} /></div>
        </div>
      </div>

      {ctl.installedFilter === 'updates' && ctl.storeLoading ? <p className="pl-note" role="status">{t('sec.plugins.storeLoading')}</p> : null}
      {ctl.installedFilter === 'updates' && ctl.storeError ? <p className="pl-note pl-note--error" role="alert"><Masked value={ctl.storeError} /></p> : null}

      {ctl.loading && !data ? (
        <Card padded={false} aria-busy="true">
          {[0, 1, 2].map(index => (
            <div className="pl-row pl-row--skeleton" key={index}>
              <Skeleton width={36} height={36} radius="var(--ec-r-md)" />
              <Skeleton width="40%" height={12} lines={2} />
            </div>
          ))}
        </Card>
      ) : plugins.length === 0 ? (
        <EmptyState icon={<Puzzle size={20} />} title={pt(filtered ? 'noMatches' : 'empty')}
          action={!filtered ? <Button variant="primary" onClick={() => navigate(routePath('plugins', 'store'))}>{t('sec.plugins.tab.store')}</Button> : undefined} />
      ) : (
        <Card padded={false} as="section">
          <ul className="pl-list">
            {plugins.map(plugin => {
              const title = ctl.getPluginTitle(plugin);
              const installed = ctl.isPluginInstalled(plugin);
              const status = ctl.getPluginStatus(plugin, data?.pluginsEnabled ?? false);
              const info = ctl.storeInfo.get(plugin.id);
              const resources = collectPluginResourceEntries([plugin]);
              const version = plugin.metadata?.version;
              const author = plugin.metadata?.author;
              const hint = status === 'missingFile' ? pt('missingFileHint') : status === 'notLoaded' ? pt('notLoadedHint') : undefined;
              const removeLabel = `${pt(installed ? 'remove' : 'removeConfig')} · ${title}`;
              const toggleLabel = `${pt(plugin.enabled ? 'disabled' : 'enabled')} · ${title}`;
              return (
                <li key={plugin.id} className={`pl-row${installed && !plugin.enabled ? ' pl-row--off' : ''}`}>
                  <PluginTile dim={!installed || !plugin.enabled} />
                  <div className="pl-id">
                    <strong className="ec-trunc">{title}</strong>
                    {title !== plugin.id ? <Masked value={plugin.id} kind="identifier" mono className="pl-id-code ec-trunc" /> : null}
                    {resources.length > 0 ? (
                      <span className="pl-links">
                        {resources.map(entry => (
                          <Button key={entry.menuIndex} size="xs" variant="ghost" icon={<ExternalLink size={12} />} title={entry.description}
                            disabled={locked} onClick={() => ctl.openResource(entry)}>{entry.label}</Button>
                        ))}
                      </span>
                    ) : null}
                  </div>
                  <div className="pl-meta">
                    {version ? <span title={plugin.path ? mask.identifier(plugin.path) : undefined}><Chip size="sm" tone="outline">{version}</Chip></span> : null}
                    {info?.updateAvailable ? (
                      <span title={`${t('sec.plugins.status.updateAvailable')}: ${info.entry.installedVersion || version || ''} → ${info.entry.version}`}>
                        <Chip size="sm" tone="info" icon={<ArrowUp size={10} />}>{info.entry.version}</Chip>
                      </span>
                    ) : null}
                    {author ? <span className="pl-author ec-trunc">{author}</span> : null}
                  </div>
                  <PluginStatus status={status} hint={hint} />
                  <div className="pl-actions">
                    {plugin.effectiveEnabled && plugin.supportsOAuth && plugin.oauthProvider ? (
                      <IconButton size="sm" icon={<LogIn size={14} />} label={pt('oauth')} disabled={locked} onClick={() => ctl.setOAuthPlugin(plugin)} />
                    ) : null}
                    {status === 'notLoaded' ? <IconButton size="sm" icon={<Folder size={14} />} label={pt('openLogs')} disabled={locked} onClick={ctl.openLogs} /> : null}
                    {installed ? (
                      <Toggle size="sm" checked={plugin.enabled} label={toggleLabel} disabled={locked} onChange={enabled => ctl.setPluginEnabled(plugin, enabled)} />
                    ) : (
                      <Button size="sm" variant="outline" icon={<Download size={14} />} disabled={locked}
                        onClick={() => { ctl.findInStore(plugin); navigate(routePath('plugins', 'store')); }}>{pt('findInStore')}</Button>
                    )}
                    <Button size="sm" variant="secondary" icon={<Settings2 size={14} />} disabled={locked} aria-label={`${pt('configure')} · ${title}`} title={pt('configure')} onClick={() => ctl.setConfigPlugin(plugin)}>
                      <span className="pl-btn-text">{pt('configure')}</span>
                    </Button>
                    <IconButton size="sm" icon={<Trash2 size={14} />} label={removeLabel} disabled={locked} onClick={() => ctl.setRemoveTarget(plugin)} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {data ? (
        <div className="pl-summary">
          <span className={`pl-dot${ctl.activeCount > 0 ? ' pl-dot--on' : ''}`} aria-hidden />
          <span>{t('sec.plugins.summary.active', { count: ctl.activeCount })}</span>
          <span className="pl-summary-dir"><Folder size={13} aria-hidden /><Masked value={data.pluginsDir} kind="identifier" mono className="ec-trunc" /></span>
        </div>
      ) : null}
    </div>
  );
}
