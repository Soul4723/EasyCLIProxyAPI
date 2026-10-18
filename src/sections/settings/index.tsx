import { Suspense, lazy, type ComponentType } from 'react';
import { Boxes, Download, KeyRound, Network, Plug, Route, ScrollText, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useCoreRuntime } from '../../coreRuntime';
import { PageHeader } from '../../shell/PageHeader';
import { routeHref } from '../../shell/router';
import type { SectionPageProps } from '../../shell/types';
import { Skeleton } from '../../ui';
import { CoreConfigContext, useCoreConfigLoader } from './coreConfig';
import { SettingsDirtyContext, useSettingsDirtyState } from './ui';
import { settingsSubs } from './subs';
import './settings.css';

const tabs: Record<string, { icon: LucideIcon; Tab: ComponentType }> = {
  connection: { icon: Plug, Tab: lazy(() => import('./tabs/ConnectionTab').then((m) => ({ default: m.ConnectionTab }))) },
  access: { icon: KeyRound, Tab: lazy(() => import('./tabs/AccessTab').then((m) => ({ default: m.AccessTab }))) },
  routing: { icon: Route, Tab: lazy(() => import('./tabs/RoutingTab').then((m) => ({ default: m.RoutingTab }))) },
  network: { icon: Network, Tab: lazy(() => import('./tabs/NetworkTab').then((m) => ({ default: m.NetworkTab }))) },
  models: { icon: Boxes, Tab: lazy(() => import('./tabs/ModelsTab').then((m) => ({ default: m.ModelsTab }))) },
  logs: { icon: ScrollText, Tab: lazy(() => import('./tabs/LogsTab').then((m) => ({ default: m.LogsTab }))) },
  app: { icon: SlidersHorizontal, Tab: lazy(() => import('./tabs/AppTab').then((m) => ({ default: m.AppTab }))) },
  updates: { icon: Download, Tab: lazy(() => import('./tabs/UpdatesTab').then((m) => ({ default: m.UpdatesTab }))) },
};

export function SettingsSection({ sub }: SectionPageProps) {
  const { t } = useI18n();
  const { status } = useCoreRuntime();
  const coreConfig = useCoreConfigLoader();
  const { dirtyTabs, api, guardDialog } = useSettingsDirtyState();
  const active = settingsSubs.some((entry) => entry.id === sub) ? (sub as string) : settingsSubs[0].id;
  const { Tab } = tabs[active];
  return (
    <div className="ec-sec-settings">
      <PageHeader title={t('sec.settings.title')} />
      <SettingsDirtyContext.Provider value={api}>
        <CoreConfigContext.Provider value={coreConfig}>
          <div className="ec-set-layout" data-remote={status?.connectionMode === 'remote' ? 'true' : undefined}>
            <nav className="ec-set-nav" aria-label={t('sec.settings.nav')}>
              {settingsSubs.map((entry) => {
                const Icon = tabs[entry.id].icon;
                return (
                  <a key={entry.id} href={routeHref('settings', entry.id === settingsSubs[0].id ? null : entry.id)} data-settings-tab={entry.id} aria-current={entry.id === active ? 'page' : undefined}>
                    <Icon size={15} aria-hidden="true" />
                    <span>{t(entry.labelKey)}</span>
                    {dirtyTabs[entry.id] ? <span className="ec-set-nav-dot" title={t('sec.settings.unsavedDot')} role="img" aria-label={t('sec.settings.unsavedDot')} /> : null}
                  </a>
                );
              })}
            </nav>
            <div className="ec-set-content" id="settings-panel" data-settings-panel={active}>
              <Suspense fallback={<Skeleton lines={4} />}><Tab key={active} /></Suspense>
            </div>
          </div>
        </CoreConfigContext.Provider>
      </SettingsDirtyContext.Provider>
      {guardDialog}
    </div>
  );
}
