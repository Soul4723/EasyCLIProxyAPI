// Agents section strings. Own this file: add keys as 'sec.agents.*' (zh-CN is the key source; en/ja must mirror it; zh-TW is derived automatically).
export const agentsZhCN = {
  "sec.agents.title": "智能体",
} as const;

export const agentsEn: Record<keyof typeof agentsZhCN, string> = {
  "sec.agents.title": "Agents",
};

export const agentsJa: Record<keyof typeof agentsZhCN, string> = {
  "sec.agents.title": "エージェント",
};
