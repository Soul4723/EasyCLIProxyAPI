// Settings section strings. Own this file: add keys as 'sec.settings.*' (zh-CN is the key source; en/ja must mirror it; zh-TW is derived automatically).
export const settingsZhCN = {
  "sec.settings.title": "设置",
} as const;

export const settingsEn: Record<keyof typeof settingsZhCN, string> = {
  "sec.settings.title": "Settings",
};

export const settingsJa: Record<keyof typeof settingsZhCN, string> = {
  "sec.settings.title": "設定",
};
