/** Old page ids still used by `app:navigate` events (settingsNavigation.ts, HomeAccessPanel) → new paths. */
export const legacyPagePaths: Readonly<Record<string, string>> = {
  home: '/overview', easy: '/easy', api: '/providers/api', oauth: '/providers/oauth', quota: '/quota',
  agents: '/agents', 'usage-records': '/usage', plugins: '/plugins', config: '/settings', versions: '/settings/updates',
};

