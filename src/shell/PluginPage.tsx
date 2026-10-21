import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Puzzle } from 'lucide-react';
import { useOverlayOpen } from '../components/useOverlayOpen';
import { useI18n } from '../i18n';
import { pluginText } from '../i18n/plugins';
import { findPluginEntryForPage, type PluginNavEntry } from '../services/pluginNavigation';
import {
  EMPTY_BOUNDS, effectiveBounds, hidePluginWebview, newWebviewToken, roundBounds, sameBounds, setPluginWebviewBounds, showPluginWebview,
  type WebviewBounds,
} from '../services/pluginWebview';
import { Button, Skeleton } from '../ui';
import { PageHeader } from './PageHeader';
import { usePluginNav } from './PluginNav';
import { replaceRoute, useRoute } from './router';
import type { SectionRoute } from './types';
import './PluginPage.css';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Hosts a plugin's native child webview: the host div reports its bounds, the desktop app positions the webview over it
 * (hidden while a dialog/menu is open). The browser mock draws a placeholder over the same bounds.
 */
function PluginWebviewPage({ entry, reloadToken }: { entry: PluginNavEntry; reloadToken: number }) {
  const { t, locale } = useI18n();
  const pt = (key: Parameters<typeof pluginText>[0]) => pluginText(key, locale);
  const host = useRef<HTMLDivElement>(null);
  const overlay = useOverlayOpen();
  const [bounds, setBounds] = useState<WebviewBounds>(EMPTY_BOUNDS);
  const [forcedBoundsRevision, setForcedBoundsRevision] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const wanted = effectiveBounds({ active: !error, overlay, bounds });
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const token = useRef(0);
  const handledReload = useRef(reloadToken);
  const forceBoundsUpdate = useRef(false);

  const measure = useCallback((force = false) => {
    if (!host.current) return EMPTY_BOUNDS;
    const next = roundBounds(host.current.getBoundingClientRect(), window.innerHeight);
    setBounds((previous) => sameBounds(previous, next) ? previous : next);
    if (force) {
      forceBoundsUpdate.current = true;
      setForcedBoundsRevision((revision) => revision + 1);
    }
    return next;
  }, []);

  useLayoutEffect(() => {
    measure();
    const measureCurrentBounds = () => measure();
    const observer = new ResizeObserver(measureCurrentBounds);
    if (host.current) observer.observe(host.current);
    observer.observe(document.documentElement);
    window.addEventListener('resize', measureCurrentBounds);
    // A DPI change (moving between monitors) fires only the resolution query, and each query matches one ratio.
    let resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onResolutionChange = () => {
      resolution.removeEventListener('change', onResolutionChange);
      resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      resolution.addEventListener('change', onResolutionChange);
      measure(true);
    };
    resolution.addEventListener('change', onResolutionChange);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measureCurrentBounds);
      resolution.removeEventListener('change', onResolutionChange);
    };
  }, [measure]);

  useEffect(() => () => {
    void hidePluginWebview(token.current).catch(() => undefined);
  }, []);

  useEffect(() => {
    const reload = handledReload.current !== reloadToken;
    handledReload.current = reloadToken;
    const mine = newWebviewToken();
    token.current = mine;
    let cancelled = false;
    setReady(false);
    setError('');
    const initialBounds = measure();
    const initialWanted = effectiveBounds({ active: true, overlay, bounds: initialBounds });
    wantedRef.current = initialWanted;
    const labels = { back: pt('pageBack'), reload: pt('pageReload'), openExternal: pt('openExternal'), move: pt('pageMove') };
    showPluginWebview({ pluginId: entry.pluginID, menuIndex: entry.menuIndex, bounds: initialWanted, labels, reload, token: mine })
      .then(() => { if (!cancelled) setReady(true); })
      .catch((reason) => { if (!cancelled) setError(message(reason)); });
    return () => { cancelled = true; };
  }, [entry.pluginID, entry.menuIndex, reloadToken, attempt, locale]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const force = forceBoundsUpdate.current;
    forceBoundsUpdate.current = false;
    void setPluginWebviewBounds(wanted, token.current, force).catch((reason) => setError(message(reason)));
  }, [ready, wanted, forcedBoundsRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="ec-plugin-page" data-plugin-route={entry.route} aria-label={entry.label}>
      <PageHeader title={entry.label} />
      <div ref={host} className="ec-plugin-host" data-testid="plugin-host">
        {error ? (
          <div className="ec-plugin-error" role="alert">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>{pt('retry')}</Button>
          </div>
        ) : !ready && <p className="ec-plugin-status" role="status">{t('common.loading')}</p>}
      </div>
    </section>
  );
}

/** `#/plugin/<pluginId>[?menu=<n>]`: the plugin page for one enabled plugin menu, or the Plugins page when it no longer exists. */
/** Reads the route itself: the shell only passes declared sub-pages, and the sub here is the plugin id. */
function PluginPageRoute() {
  const { t } = useI18n();
  const { sub, params } = useRoute();
  const { entries, fetched, error, retry, reloadToken } = usePluginNav();
  const entry = findPluginEntryForPage(entries, sub, params.get('menu'));
  useEffect(() => {
    if (fetched && !error && !entry) replaceRoute('/plugins');
  }, [fetched, error, entry]);
  if (!entry) {
    return (
      <>
        <PageHeader title={t('shell.nav.plugins')} />
        <div className="ec-page-body">{error ? <div role="alert"><p>{error}</p><Button onClick={() => void retry()}>{t('common.retry')}</Button></div> : <Skeleton height={64} />}</div>
      </>
    );
  }
  return <PluginWebviewPage key={entry.route} entry={entry} reloadToken={reloadToken} />;
}

export const pluginPageRoute: SectionRoute = {
  id: 'plugin', labelKey: 'shell.nav.plugins', icon: Puzzle, group: 'hidden', Page: PluginPageRoute,
};
