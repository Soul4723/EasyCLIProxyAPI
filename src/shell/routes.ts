import { lazy } from 'react';
import { overviewRoute } from '../sections/overview/route';
import { providersSubs } from '../sections/providers/subs';
import { quotaSubs } from '../sections/quota/subs';
import { usageSubs } from '../sections/usage/subs';
import { agentsSubs } from '../sections/agents/subs';
import { pluginsSubs } from '../sections/plugins/subs';
import { settingsSubs } from '../sections/settings/subs';
import { pluginPageRoute } from './PluginPage';
import { kitRoute } from './kitRoute';
import { legacyPagePaths } from './legacyPaths';
import { pluginPagePathFromLegacyRoute } from '../services/pluginNavigation';
import type { SectionRoute } from './types';
import { Network, Gauge, ChartNoAxesColumn, Bot, Puzzle, Settings } from 'lucide-react';

const ProvidersSection = lazy(() => import('../sections/providers/index').then((m) => ({ default: m.ProvidersSection })));
const QuotaSection = lazy(() => import('../sections/quota/index').then((m) => ({ default: m.QuotaSection })));
const UsageSection = lazy(() => import('../sections/usage/index').then((m) => ({ default: m.UsageSection })));
const AgentsSection = lazy(() => import('../sections/agents/index').then((m) => ({ default: m.AgentsSection })));
const PluginsSection = lazy(() => import('../sections/plugins/index').then((m) => ({ default: m.PluginsSection })));
const SettingsSection = lazy(() => import('../sections/settings/index').then((m) => ({ default: m.SettingsSection })));

const providersPage = () => import('../sections/providers/index');
const quotaPage = () => import('../sections/quota/index');
const usagePage = () => import('../sections/usage/index');
const agentsPage = () => import('../sections/agents/index');
const pluginsPage = () => import('../sections/plugins/index');
const settingsPage = () => import('../sections/settings/index');

/** Sidebar order: main group, divider, secondary group. Add a page by adding its route here. */
export const routes: readonly SectionRoute[] = [
  overviewRoute,
  { id: 'providers', labelKey: 'shell.nav.providers', icon: Network, group: 'main', subs: providersSubs, Page: ProvidersSection, preload: () => { void providersPage().catch(() => undefined); } },
  { id: 'quota', labelKey: 'shell.nav.quota', icon: Gauge, group: 'main', subs: quotaSubs, Page: QuotaSection, preload: () => { void quotaPage().catch(() => undefined); } },
  { id: 'usage', labelKey: 'shell.nav.usage', icon: ChartNoAxesColumn, group: 'main', subs: usageSubs, alwaysAvailable: true, Page: UsageSection, preload: () => { void usagePage().catch(() => undefined); } },
  { id: 'agents', labelKey: 'shell.nav.agents', icon: Bot, group: 'secondary', subs: agentsSubs, alwaysAvailable: true, Page: AgentsSection, preload: () => { void agentsPage().catch(() => undefined); } },
  { id: 'plugins', labelKey: 'shell.nav.plugins', icon: Puzzle, group: 'secondary', subs: pluginsSubs, Page: PluginsSection, preload: () => { void pluginsPage().catch(() => undefined); } },
  { id: 'settings', labelKey: 'shell.nav.settings', icon: Settings, group: 'secondary', subs: settingsSubs, alwaysAvailable: true, Page: SettingsSection, preload: () => { void settingsPage().catch(() => undefined); } },
  pluginPageRoute, ...(import.meta.env.DEV ? [kitRoute] : []),
];

export const defaultRouteId = 'overview';

export function findRoute(id: string): SectionRoute | undefined {
  return routes.find((route) => route.id === id);
}

export function resolveNavigationTarget(detail: string): string | null {
  const plugin = pluginPagePathFromLegacyRoute(detail);
  if (plugin) return plugin;
  if (detail.startsWith('/')) return detail;
  return legacyPagePaths[detail] ?? (findRoute(detail) ? `/${detail}` : null);
}
