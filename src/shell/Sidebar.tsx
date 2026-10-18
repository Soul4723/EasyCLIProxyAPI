import { Lock } from 'lucide-react';
import appLogo from '../assets/logo.jpg';
import { useCoreRuntime } from '../coreRuntime';
import { useAppUpdate } from '../appUpdate';
import { useCoreUpdate } from '../coreUpdate';
import { appUpdateIndicatorState } from '../appUpdateModel';
import { useI18n } from '../i18n';
import { canOpenAppPage } from '../navigation';
import { Chip } from '../ui/Chip';
import { AppMenu } from './AppMenu';
import { routeHref } from './router';
import { routes } from './routes';
import { useCoreStatusLine } from './useCoreStatusLine';
import type { SectionRoute } from './types';
import './Sidebar.css';

function NavItem({ route, active, locked, updateDot, dotTitle }: {
  route: SectionRoute; active: boolean; locked: boolean; updateDot: 'available' | 'processing' | null; dotTitle: string;
}) {
  const { t } = useI18n();
  const Icon = route.icon;
  const label = t(route.labelKey);
  const content = (
    <>
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="ec-nav-label">{label}</span>
      {locked ? <Lock size={12} className="ec-nav-lock" aria-hidden="true" />
        : updateDot ? <i className={`ec-nav-dot ec-nav-dot--${updateDot}`} title={dotTitle} aria-label={dotTitle} /> : null}
    </>
  );
  if (locked) {
    return (
      <button type="button" className="ec-nav-item is-locked" disabled aria-label={label} title={t('app.nav.lockedHint')}
        data-nav={route.id}>{content}</button>
    );
  }
  return (
    <a href={routeHref(route.id)} className={`ec-nav-item${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined}
      aria-label={label} title={label} data-nav={route.id}>{content}</a>
  );
}

/** Left sidebar: brand, nav (main · divider · secondary), footer core-status line + Local/Remote chip + app menu. */
export function Sidebar({ activeId, drawerOpen, onNavigate }: { activeId: string; drawerOpen: boolean; onNavigate: () => void }) {
  const { t } = useI18n();
  const { status } = useCoreRuntime();
  const { info: appUpdateInfo, hasUpdate, processing } = useAppUpdate();
  const { latest: coreLatest, hasUpdate: coreHasUpdate } = useCoreUpdate();
  const line = useCoreStatusLine();
  const coreReady = Boolean(status?.ready);
  const remote = status?.connectionMode === 'remote';
  const updateState = appUpdateIndicatorState(hasUpdate, coreHasUpdate, processing);
  const updateLabel = updateState === 'processing' ? t('appUpdate.progressTitle') : [
    hasUpdate ? t('appUpdate.badgeAvailable', { version: appUpdateInfo?.latestVersion ?? '' }) : '',
    coreHasUpdate ? `${t('kernel.versions.coreCardTitle')}: ${t('kernel.update.available')} ${coreLatest?.version ?? ''}`.trim() : '',
  ].filter(Boolean).join(' · ');
  const main = routes.filter((route) => route.group === 'main');
  const secondary = routes.filter((route) => route.group === 'secondary');
  const statusText = line.kind === 'running'
    ? (line.port ? t('shell.core.running', { port: line.port }) : t('shell.core.runningNoPort'))
    : line.kind === 'remote' ? t('shell.core.remote', { host: line.host })
      : line.kind === 'remoteDown' ? t('shell.core.remoteDown', { host: line.host })
        : t(`shell.core.${line.kind}`);
  const item = (route: SectionRoute) => (
    <NavItem key={route.id} route={route} active={route.id === activeId} locked={!canOpenAppPage(route.id, coreReady)}
      updateDot={route.id === 'settings' ? updateState : null} dotTitle={updateLabel} />
  );
  return (
    <aside className={`ec-sidebar${drawerOpen ? ' is-open' : ''}`} aria-label={t('app.navigation')} onClick={(event) => {
      if ((event.target as Element).closest('a')) onNavigate();
    }}>
      <a className="ec-brand" href={routeHref('overview')} title="EasyCLIProxyAPI">
        <img src={appLogo} alt="" className="ec-brand-mark" />
        <strong className="ec-brand-name">EasyCLIProxyAPI</strong>
      </a>
      <nav className="ec-nav" aria-label={t('app.navigation')}>
        {main.map(item)}
        <div className="ec-nav-sep" role="separator" />
        {secondary.map(item)}
      </nav>
      {remote ? <p id="remote-navigation-reason" className="ec-sr-only">{t('connection.navigationReason')}</p> : null}
      <div className="ec-sidebar-foot">
        <a href={routeHref('overview')} className="ec-core-line" title={t('shell.core.open')} data-core-status={line.kind}>
          <i className={`ec-core-dot ec-core-dot--${line.tone}`} aria-hidden="true" />
          <span className="ec-core-text">{statusText}</span>
        </a>
        <Chip size="sm" tone={remote ? 'info' : 'neutral'} className="ec-mode-chip">{t(remote ? 'shell.mode.remote' : 'shell.mode.local')}</Chip>
        <span className="ec-sidebar-foot-spacer" />
        <AppMenu />
      </div>
    </aside>
  );
}
