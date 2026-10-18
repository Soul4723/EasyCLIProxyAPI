// Quota section strings. Own this file: add keys as 'sec.quota.*' (zh-CN is the key source; en/ja must mirror it; zh-TW is derived automatically).
export const quotaZhCN = {
  "sec.quota.title": "额度",
} as const;

export const quotaEn: Record<keyof typeof quotaZhCN, string> = {
  "sec.quota.title": "Quota",
};

export const quotaJa: Record<keyof typeof quotaZhCN, string> = {
  "sec.quota.title": "クォータ",
};
