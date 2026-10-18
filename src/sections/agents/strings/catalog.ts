// Agents section strings: Codex / DeepSeek Harness model catalog dialogs.
export const catalogZhCN = {
  'sec.agents.catalog.hidden': '已隐藏',
  'sec.agents.catalog.contextShort': '上下文',
  'sec.agents.catalog.models': '模型',
  'sec.agents.catalog.noSelection': '选择一个模型进行编辑',
  'sec.agents.catalog.reasoningWire': '{level} 的 reasoning_effort 值',
  'sec.agents.catalog.sourceLabel': '来源',
} as const;

export const catalogEn: Record<keyof typeof catalogZhCN, string> = {
  'sec.agents.catalog.hidden': 'Hidden',
  'sec.agents.catalog.contextShort': 'Context',
  'sec.agents.catalog.models': 'Models',
  'sec.agents.catalog.noSelection': 'Select a model to edit',
  'sec.agents.catalog.reasoningWire': 'reasoning_effort value for {level}',
  'sec.agents.catalog.sourceLabel': 'Source',
};

export const catalogJa: Record<keyof typeof catalogZhCN, string> = {
  'sec.agents.catalog.hidden': '非表示',
  'sec.agents.catalog.contextShort': 'コンテキスト',
  'sec.agents.catalog.models': 'モデル',
  'sec.agents.catalog.noSelection': '編集するモデルを選択してください',
  'sec.agents.catalog.reasoningWire': '{level} の reasoning_effort 値',
  'sec.agents.catalog.sourceLabel': 'ソース',
};
