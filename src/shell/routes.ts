import { overviewRoute } from '../sections/overview/route';
import { providersRoute } from '../sections/providers/route';
import { quotaRoute } from '../sections/quota/route';
import { usageRoute } from '../sections/usage/route';
import { agentsRoute } from '../sections/agents/route';
import { pluginsRoute } from '../sections/plugins/route';
import { settingsRoute } from '../sections/settings/route';
import { pluginPageRoute } from './PluginPage';
import { easyRoute, kitRoute } from './extraRoutes';
import { legacyPagePaths } from './legacyPaths';
import { pluginPagePathFromLegacyRoute } from '../services/pluginNavigation';
import type { SectionRoute } from './types';

/** Sidebar order: main group, divider, secondary group. Add a page by adding its route here. */
export const routes: readonly SectionRoute[] = [
  overviewRoute, providersRoute, quotaRoute, usageRoute,
  agentsRoute, pluginsRoute, settingsRoute,
  pluginPageRoute, easyRoute, ...(import.meta.env.DEV ? [kitRoute] : []),
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
