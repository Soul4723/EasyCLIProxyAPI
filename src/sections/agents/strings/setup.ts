// Agents section strings: setup part. zh-CN is the key source for this part; en/ja mirror it.
export const setupZhCN = {
  'sec.agents.setup.detection': '检测',
  'sec.agents.setup.saveBar': '应用配置',
} as const;
export const setupEn: Record<keyof typeof setupZhCN, string> = {
  'sec.agents.setup.detection': 'Detection',
  'sec.agents.setup.saveBar': 'Apply configuration',
};
export const setupJa: Record<keyof typeof setupZhCN, string> = {
  'sec.agents.setup.detection': '検出',
  'sec.agents.setup.saveBar': '設定を適用',
};
