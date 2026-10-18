// Usage section strings. Own this file: add keys as 'sec.usage.*' (zh-CN is the key source; en/ja must mirror it; zh-TW is derived automatically).
export const usageZhCN = {
  "sec.usage.title": "用量",
} as const;

export const usageEn: Record<keyof typeof usageZhCN, string> = {
  "sec.usage.title": "Usage",
};

export const usageJa: Record<keyof typeof usageZhCN, string> = {
  "sec.usage.title": "使用状況",
};
