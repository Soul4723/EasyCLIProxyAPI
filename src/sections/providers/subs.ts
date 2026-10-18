import type { SectionSub } from '../../shell/types';

/** Sub-pages (tabs) of this section; subs[0] is the default. Provider detail is `#/providers?p=<brand>` on the first tab. */
export const providersSubs: readonly SectionSub[] = [
  { id: 'overview', labelKey: 'sec.providers.tab.overview' },
  { id: 'all', labelKey: 'sec.providers.tab.all' },
  { id: 'exclusions', labelKey: 'sec.providers.tab.exclusions' },
];
