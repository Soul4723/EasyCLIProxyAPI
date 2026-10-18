import type { SectionSub } from '../../shell/types';

/** Tabs of the Usage page: #/usage, #/usage/requests, #/usage/routing, #/usage/prices, #/usage/data (subs[0] = default). */
export const usageSubs: readonly SectionSub[] = [
  { id: 'overview', labelKey: 'sec.usage.tab.overview' },
  { id: 'requests', labelKey: 'sec.usage.tab.requests' },
  { id: 'routing', labelKey: 'sec.usage.tab.routing' },
  { id: 'prices', labelKey: 'sec.usage.tab.prices' },
  { id: 'data', labelKey: 'sec.usage.tab.data' },
];
