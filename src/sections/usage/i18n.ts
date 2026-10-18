// Usage section strings ('sec.usage.*'). zh-CN is the key source; en/ja must mirror it; zh-TW is derived automatically.
// Each tab keeps its strings in its own fragment file so tabs can be built in parallel.
import { coreZhCN, coreEn, coreJa } from './i18n.core';
import { overviewZhCN, overviewEn, overviewJa } from './i18n.overview';
import { requestsZhCN, requestsEn, requestsJa } from './i18n.requests';
import { routingZhCN, routingEn, routingJa } from './i18n.routing';
import { pricesZhCN, pricesEn, pricesJa } from './i18n.prices';
import { dataZhCN, dataEn, dataJa } from './i18n.data';

export const usageZhCN = { ...coreZhCN, ...overviewZhCN, ...requestsZhCN, ...routingZhCN, ...pricesZhCN, ...dataZhCN } as const;
export const usageEn: Record<keyof typeof usageZhCN, string> = { ...coreEn, ...overviewEn, ...requestsEn, ...routingEn, ...pricesEn, ...dataEn };
export const usageJa: Record<keyof typeof usageZhCN, string> = { ...coreJa, ...overviewJa, ...requestsJa, ...routingJa, ...pricesJa, ...dataJa };
