// Settings → models tab strings. Keys are 'sec.settings.models.*'. zh-CN is the key source; en/ja must mirror it.
export const modelsZhCN = {
  "sec.settings.models.views": "模型设置分区",
  "sec.settings.models.view.aliases": "模型别名",
  "sec.settings.models.view.words": "敏感词",
  "sec.settings.models.view.defaults": "请求与上游默认值",
  "sec.settings.models.col.source": "原始模型",
  "sec.settings.models.col.alias": "别名",
  "sec.settings.models.col.options": "选项",
  "sec.settings.models.col.actions": "操作",
  "sec.settings.models.search": "搜索别名或模型",
  "sec.settings.models.instantHint": "每次新增、编辑或删除都会立即写入内核配置，无需另行保存",
  "sec.settings.models.tpl.requests": "模型与请求",
  "sec.settings.models.tpl.oauth": "上游与凭据默认值",
} as const;

export const modelsEn: Record<keyof typeof modelsZhCN, string> = {
  "sec.settings.models.views": "Model settings sections",
  "sec.settings.models.view.aliases": "Aliases",
  "sec.settings.models.view.words": "Sensitive words",
  "sec.settings.models.view.defaults": "Request & upstream defaults",
  "sec.settings.models.col.source": "Original model",
  "sec.settings.models.col.alias": "Alias",
  "sec.settings.models.col.options": "Options",
  "sec.settings.models.col.actions": "Actions",
  "sec.settings.models.search": "Search aliases or models",
  "sec.settings.models.instantHint": "Every add, edit or delete is written to the core config immediately — there is nothing to save separately",
  "sec.settings.models.tpl.requests": "Models & requests",
  "sec.settings.models.tpl.oauth": "Upstream & credential defaults",
};

export const modelsJa: Record<keyof typeof modelsZhCN, string> = {
  "sec.settings.models.views": "モデル設定のセクション",
  "sec.settings.models.view.aliases": "エイリアス",
  "sec.settings.models.view.words": "機微ワード",
  "sec.settings.models.view.defaults": "リクエストと上流の既定値",
  "sec.settings.models.col.source": "元のモデル",
  "sec.settings.models.col.alias": "エイリアス",
  "sec.settings.models.col.options": "オプション",
  "sec.settings.models.col.actions": "操作",
  "sec.settings.models.search": "エイリアスまたはモデルを検索",
  "sec.settings.models.instantHint": "追加・編集・削除はそのたびにコア設定へ即時に書き込まれます。別途保存は不要です",
  "sec.settings.models.tpl.requests": "モデルとリクエスト",
  "sec.settings.models.tpl.oauth": "上流と認証情報の既定値",
};
