// Plugins section strings. Own this file: add keys as 'sec.plugins.*' (zh-CN is the key source; en/ja must mirror it; zh-TW is derived automatically).
export const pluginsZhCN = {
  "sec.plugins.title": "插件",
} as const;

export const pluginsEn: Record<keyof typeof pluginsZhCN, string> = {
  "sec.plugins.title": "Plugins",
};

export const pluginsJa: Record<keyof typeof pluginsZhCN, string> = {
  "sec.plugins.title": "プラグイン",
};
