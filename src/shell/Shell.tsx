import { useCallback, useEffect, useMemo, useState } from 'react';
import { ServerCog } from 'lucide-react';
import { useCoreRuntime } from '../coreRuntime';
import { useI18n } from '../i18n';
import { canOpenAppPage, isAlwaysAvailablePage } from '../navigation';
import { Button } from '../ui/Button';
import { EmptyState, ErrorState } from '../ui/EmptyState';
import { AppUpdateDialog } from '../appUpdate';
import { closePluginWebview } from '../services/pluginWebview';
import { PageHeader } from './PageHeader';
import { PluginNavProvider } from './PluginNav';
import { ShellContext } from './ShellContext';
import { Sidebar } from './Sidebar';
import { WindowsCloseHandler } from './WindowsCloseHandler';
import { defaultRouteId, findRoute, resolveNavigationTarget } from './routes';
import { navigate, replaceRoute, routeHref, useRoute } from './router';
import './shell.css';

/** App shell: sidebar + routed page. Owns gating (core-not-ready), `app:navigate` and the mobile drawer. */
export function Shell() {
  const { t } = useI18n();
  const route = useRoute();
  const { status, statusError, refreshStatus, connection, connectionRevision } = useCoreRuntime();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const coreReady = Boolean(status?.ready) && !statusError;
  const current = findRoute(route.page);
  // Until the first core status arrives nothing is known, so deep links to gated pages wait instead of redirecting.
  const statusKnown = status !== null;
  const blocked = !statusError && statusKnown && Boolean(current) && !canOpenAppPage(current!.id, coreReady);

  useEffect(() => {
    if (!route.page || route.page === 'easy') replaceRoute(`/${defaultRouteId}`);
    else if (blocked) replaceRoute(`/${defaultRouteId}`);
  }, [route.page, blocked]);

  // The native plugin webview floats above the page: drop it as soon as the core is no longer usable.
  useEffect(() => {
    if (statusKnown && !coreReady) void closePluginWebview().catch(() => undefined);
  }, [statusKnown, coreReady]);

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      const target = typeof detail === 'string' ? resolveNavigationTarget(detail) : null;
      if (target) navigate(target);
    };
    window.addEventListener('app:navigate', handleNavigate);
    return () => window.removeEventListener('app:navigate', handleNavigate);
  }, []);

  useEffect(() => { setDrawerOpen(false); }, [route.path]);
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLElement>('.ec-sidebar a')?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawerOpen(false); };
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('keydown', close);
      if (previousFocus?.isConnected) previousFocus.focus();
      else document.querySelector<HTMLElement>('.ec-page-menu')?.focus();
    };
  }, [drawerOpen]);

  const shell = useMemo(() => ({ openMenu: () => setDrawerOpen(true), menuOpen: drawerOpen }), [drawerOpen]);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const sub = current?.subs?.some((entry) => entry.id === route.sub) ? route.sub : null;

  let body;
  if (!current) {
    body = <NotFound title={t('shell.notFound')} action={t('shell.notFound.action')} />;
  } else if (statusError && !isAlwaysAvailablePage(current.id)) {
    body = <><PageHeader title={t(current.labelKey)} /><div className="ec-page-body" role="alert">
      <ErrorState title={connection?.mode === 'remote'
        ? t('shell.core.unreachable', { origin: connection.managementOrigin }) : t('sec.overview.offlineError')}
        message={statusError}
        onRetry={() => void refreshStatus()} />
    </div></>;
  } else if (!statusKnown && !isAlwaysAvailablePage(current.id)) {
    body = <PageHeader title={t(current.labelKey)} />;
  } else if (blocked || !(isAlwaysAvailablePage(current.id) || coreReady)) {
    body = <CoreLocked title={t(current.labelKey)} />;
  } else {
    const Page = current.Page;
    body = <Page sub={sub} params={route.params} />;
  }

  return (
    <ShellContext.Provider value={shell}>
      <PluginNavProvider>
      <div className={`ec-app${current?.bare ? ' ec-app--bare' : ''}`} data-page={route.page}>
        {current?.bare ? null : <Sidebar activeId={route.page} drawerOpen={drawerOpen} onNavigate={closeDrawer} />}
        {drawerOpen ? <div className="ec-drawer-scrim" onClick={closeDrawer} aria-hidden="true" /> : null}
        <main className="ec-main" id="main" key={connectionRevision}>{body}</main>
      </div>
      </PluginNavProvider>
      <WindowsCloseHandler />
      <AppUpdateDialog />
    </ShellContext.Provider>
  );
}

function NotFound({ title, action }: { title: string; action: string }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="ec-page-body">
        <EmptyState title={title} action={<a href={routeHref(defaultRouteId)}><Button size="sm" variant="outline" tabIndex={-1}>{action}</Button></a>} />
      </div>
    </>
  );
}

function CoreLocked({ title }: { title: string }) {
  const { t } = useI18n();
  return (
    <section className="core-locked-page">
      <PageHeader title={title} />
      <div className="ec-page-body">
        <EmptyState icon={<ServerCog size={22} />} title={`${t('app.coreRequired.title')} — ${t('app.coreRequired.description')}`} />
      </div>
    </section>
  );
}
