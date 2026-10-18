// Providers section strings. Own this file: add keys as 'sec.providers.*' (zh-CN is the key source; en/ja must mirror it; zh-TW is derived automatically).
export const providersZhCN = {
  "sec.providers.title": "提供商",
} as const;

export const providersEn: Record<keyof typeof providersZhCN, string> = {
  "sec.providers.title": "Providers",
};

export const providersJa: Record<keyof typeof providersZhCN, string> = {
  "sec.providers.title": "プロバイダー",
};
