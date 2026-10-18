// api strings for the Providers section. Keys: 'sec.providers.api.*'. zh-CN is the key source; en/ja must mirror it (zh-TW is derived).
// Field labels, validation and health copy that already exist as `apiAccess.*` keys are reused rather than duplicated.
export const apiZhCN = {
  "sec.providers.api.row.modelOne": "模型 1 个",
  "sec.providers.api.form.basic": "基本信息",
  "sec.providers.api.form.check": "检测",
  "sec.providers.api.error.load": "无法加载 API 密钥",
  "sec.providers.api.empty.brand": "还没有 {provider} 密钥",
  "sec.providers.api.health.cost": "每个密钥发送一个极小的流式请求，可能产生少量费用。",
  "sec.providers.api.bulk.title": "检测全部密钥",
  "sec.providers.api.bulk.running": "检测中 {done}/{total}",
  "sec.providers.api.bulk.summary": "正常 {ok} · 失败 {failed} · 跳过 {skipped}",
  "sec.providers.api.bulk.none": "没有已启用的密钥可检测",
  "sec.providers.api.bulk.via": "使用 {model}",
  "sec.providers.api.bulk.skipped": "已跳过",
  "sec.providers.api.bulk.details": "详情",
} as const;

export const apiEn: Record<keyof typeof apiZhCN, string> = {
  "sec.providers.api.row.modelOne": "1 model",
  "sec.providers.api.form.basic": "Basic",
  "sec.providers.api.form.check": "Check",
  "sec.providers.api.error.load": "Couldn't load API keys",
  "sec.providers.api.empty.brand": "No {provider} keys yet",
  "sec.providers.api.health.cost": "Sends one tiny streaming request per key; may cost a little.",
  "sec.providers.api.bulk.title": "Check all keys",
  "sec.providers.api.bulk.running": "Checking {done}/{total}",
  "sec.providers.api.bulk.summary": "Healthy {ok} · Failed {failed} · Skipped {skipped}",
  "sec.providers.api.bulk.none": "No enabled keys to check",
  "sec.providers.api.bulk.via": "via {model}",
  "sec.providers.api.bulk.skipped": "Skipped",
  "sec.providers.api.bulk.details": "Details",
};

export const apiJa: Record<keyof typeof apiZhCN, string> = {
  "sec.providers.api.row.modelOne": "1 モデル",
  "sec.providers.api.form.basic": "基本",
  "sec.providers.api.form.check": "チェック",
  "sec.providers.api.error.load": "API キーを読み込めませんでした",
  "sec.providers.api.empty.brand": "{provider} のキーはまだありません",
  "sec.providers.api.health.cost": "キーごとに極小のストリーミングリクエストを 1 回送信します。わずかな料金が発生する場合があります。",
  "sec.providers.api.bulk.title": "すべてのキーをチェック",
  "sec.providers.api.bulk.running": "チェック中 {done}/{total}",
  "sec.providers.api.bulk.summary": "正常 {ok} · 失敗 {failed} · スキップ {skipped}",
  "sec.providers.api.bulk.none": "チェックできる有効なキーがありません",
  "sec.providers.api.bulk.via": "{model} を使用",
  "sec.providers.api.bulk.skipped": "スキップ",
  "sec.providers.api.bulk.details": "詳細",
};
