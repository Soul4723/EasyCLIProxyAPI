import { useEffect } from 'react';
import { Puzzle, RefreshCw, RotateCw } from 'lucide-react';
import { useI18n } from '../../i18n';
import { PageHeader } from '../../shell/PageHeader';
import { RouteTabs } from '../../shell/RouteTabs';
import { navigate, routePath } from '../../shell/router';
import type { SectionPageProps } from '../../shell/types';
import { isPluginInstalled } from '../../services/pluginStatus';
import { Button, ConfirmDialog, EmptyState, ErrorState, Masked, Skeleton, Toggle } from '../../ui';
import { ConfigPanel } from './ConfigPanel';
import { InstallDialog } from './InstallDialog';
import { InstalledList } from './InstalledList';
import { OAuthDialog } from './OAuthDialog';
import { Banner, GitHubTokenHint, isGitHubRateLimit } from './parts';
import { ResourceView } from './ResourceView';
import { SettingsTab } from './SettingsTab';
import { StoreList } from './StoreList';
import { pluginsSubs, type PluginTab } from './subs';
import { usePlugins } from './usePlugins';
import './plugins.css';

/** Plugins: Installed · Store · Settings sub-pages over one controller (`usePlugins`); dialogs/panels are opened from it. */
export function PluginsSection({ sub }: SectionPageProps) {
  const { t } = useI18n();
  const active = (pluginsSubs.find(entry => entry.id === sub)?.id ?? pluginsSubs[0].id) as PluginTab;
  const ctl = usePlugins(active);
  const { pt, data, supported, locked, notice } = ctl;

  // Success notices fade on their own; errors stay until dismissed.
  useEffect(() => {
    if (!notice || notice.tone !== 'success') return;
    const timer = window.setTimeout(ctl.dismissNotice, 5000);
    return () => window.clearTimeout(timer);
  }, [notice, ctl.dismissNotice]);

  const tabs = pluginsSubs.map(entry => ({
    ...entry,
    count: entry.id === 'installed' ? (data ? ctl.installedCount : undefined) : entry.id === 'store' ? ctl.store?.plugins.length : undefined,
  }));
  const removeInstalled = ctl.removeTarget ? isPluginInstalled(ctl.removeTarget) : true;
  const removeLabel = pt(removeInstalled ? 'remove' : 'removeConfig');

  const actions = supported && data ? (
    <>
      <label className="pl-global" title={t('sec.plugins.enableGlobal')}>
        <span className="pl-global-label">{t('sec.plugins.enableGlobal')}</span>
        <Toggle checked={data.pluginsEnabled} label={pt('global')} disabled={locked}
          onChange={ctl.setGlobalEnabled} />
      </label>
      <Button variant="secondary" icon={<RefreshCw size={14} />} loading={ctl.loading} disabled={ctl.busy} aria-label={t('common.refresh')} title={t('common.refresh')} onClick={() => void ctl.load()}>
        <span className="pl-btn-text">{t('common.refresh')}</span>
      </Button>
    </>
  ) : supported === null && !ctl.error ? undefined : (
    <Button variant="secondary" icon={<RefreshCw size={14} />} loading={ctl.loading} disabled={ctl.busy} aria-label={t('common.refresh')} title={t('common.refresh')} onClick={() => void ctl.load()}>
      <span className="pl-btn-text">{t('common.refresh')}</span>
    </Button>
  );

  let body;
  if (supported === false) {
    body = (
      <EmptyState icon={<Puzzle size={20} />} title={t('sec.plugins.unsupported')}
        action={<Button variant="secondary" onClick={() => navigate(routePath('settings', 'updates'))}>{t('sec.plugins.openUpdates')}</Button>} />
    );
  } else if (supported === null) {
    body = ctl.error
      ? <ErrorState title={t('sec.plugins.loadFailed')} message={<Masked value={ctl.error} />} onRetry={() => void ctl.load()} />
      : <div className="pl-stack" aria-busy="true"><Skeleton height={44} lines={3} /></div>;
  } else if (ctl.error && (active === 'installed' ? !data : active === 'store' ? !ctl.store : false)) {
    // Nothing to show yet: a full error state with retry instead of a banner above an empty list.
    body = (
      <ErrorState title={t('sec.plugins.loadFailed')} onRetry={() => void ctl.load()}
        message={<><Masked value={ctl.error} />{isGitHubRateLimit(ctl.error) ? <GitHubTokenHint /> : null}</>} />
    );
  } else {
    body = (
      <>
        {ctl.error ? (
          <Banner tone="error" action={<Button size="xs" variant="secondary" disabled={ctl.busy || ctl.loading} onClick={() => void ctl.load()}>{pt('retry')}</Button>}>
            <Masked value={ctl.error} />{isGitHubRateLimit(ctl.error) ? <GitHubTokenHint /> : null}
          </Banner>
        ) : null}
        {data && !data.pluginsEnabled ? <Banner tone="warn">{pt('disabledHint')}</Banner> : null}
        {ctl.restartRequired ? (
          <Banner tone="warn" action={
            <Button size="xs" variant="primary" icon={<RotateCw size={12} />} disabled={locked || ctl.remote}
              title={ctl.remote ? t('sec.plugins.restartRemote') : undefined} onClick={() => ctl.setRestartOpen(true)}>{pt('restartButton')}</Button>
          }>{ctl.remote ? t('connection.lifecycleHint') : pt('restart')}</Banner>
        ) : null}
        {ctl.resource ? <ResourceView ctl={ctl} />
          : active === 'settings' ? <SettingsTab onSaved={() => { ctl.notify(pt('saved')); void ctl.load(); }} />
          : active === 'store' ? <StoreList ctl={ctl} />
          : <InstalledList ctl={ctl} />}
      </>
    );
  }

  return (
    <div className="ec-sec-plugins">
      <PageHeader title={t('sec.plugins.title')} count={data ? ctl.installedCount : undefined}
        tabs={<RouteTabs page="plugins" subs={tabs} active={active} ariaLabel={t('sec.plugins.title')} />}
        actions={actions} />
      <div className="ec-page-body">{body}</div>

      {notice ? (
        <div className={`pl-toast pl-toast--${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'} key={`${notice.tone}:${notice.text}`}>
          <Masked value={notice.text} />
        </div>
      ) : null}

      {ctl.configPlugin ? (
        <ConfigPanel plugin={ctl.configPlugin} onClose={() => ctl.setConfigPlugin(null)}
          onSaved={() => { ctl.notify(pt('saved')); void ctl.load(); }} />
      ) : null}
      {ctl.installEntry ? (
        <InstallDialog entry={ctl.installEntry} onClose={() => ctl.setInstallEntry(null)} onInstalled={ctl.onInstalled} onOpenExternal={ctl.openExternal} />
      ) : null}
      {ctl.oauthPlugin ? (
        <OAuthDialog plugin={ctl.oauthPlugin} onClose={() => ctl.setOAuthPlugin(null)}
          onCompleted={() => { ctl.notify(pt('authorized')); void ctl.load(); }} />
      ) : null}
      <ConfirmDialog open={Boolean(ctl.removeTarget)} danger
        title={`${removeLabel} · ${ctl.removeTarget ? ctl.getPluginTitle(ctl.removeTarget) : ''}`}
        message={pt(removeInstalled ? 'removeHint' : 'removeConfigHint')} confirmLabel={removeLabel}
        onCancel={() => ctl.setRemoveTarget(null)} onConfirm={() => void ctl.confirmRemove()} />
      <ConfirmDialog open={ctl.restartOpen} title={pt('restartButton')} message={pt('restartConfirm')}
        confirmLabel={pt('restartButton')} onCancel={() => ctl.setRestartOpen(false)} onConfirm={() => void ctl.confirmRestart()} />
    </div>
  );
}
