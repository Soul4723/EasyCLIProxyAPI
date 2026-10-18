// Overview section strings. Own this file: add keys as 'sec.overview.*' (zh-CN is the key source; en/ja must mirror it; zh-TW is derived automatically).
export const overviewZhCN = {
  "sec.overview.title": "概览",
} as const;

export const overviewEn: Record<keyof typeof overviewZhCN, string> = {
  "sec.overview.title": "Overview",
};

export const overviewJa: Record<keyof typeof overviewZhCN, string> = {
  "sec.overview.title": "概要",
};
