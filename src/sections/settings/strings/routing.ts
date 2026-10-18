// Settings → routing tab strings. Keys are 'sec.settings.routing.*'. zh-CN is the key source; en/ja must mirror it.
export const routingZhCN = {
  "sec.settings.routing.groupSelect": "凭据选择",
  "sec.settings.routing.groupRetry": "重试与冷却",
  "sec.settings.routing.weighted": "加权轮询",
  "sec.settings.routing.strategyHint": "选择请求如何在可用凭据之间分配；切换后立即写入配置",
  "sec.settings.routing.ttlPlaceholder": "例如 1h",
  "sec.settings.routing.retryRange": "重试轮数与凭据上限须为非负整数；等待时间可为负整数",
  "sec.settings.routing.loadFailed": "无法读取路由设置",
} as const;

export const routingEn: Record<keyof typeof routingZhCN, string> = {
  "sec.settings.routing.groupSelect": "Credential selection",
  "sec.settings.routing.groupRetry": "Retries & cooldowns",
  "sec.settings.routing.weighted": "Weighted round robin",
  "sec.settings.routing.strategyHint": "How requests are spread across available credentials. Saved as soon as you switch.",
  "sec.settings.routing.ttlPlaceholder": "e.g. 1h",
  "sec.settings.routing.retryRange": "Retry rounds and credential limits must be non-negative integers; cooldown wait may be a negative integer.",
  "sec.settings.routing.loadFailed": "Couldn't read routing settings",
};

export const routingJa: Record<keyof typeof routingZhCN, string> = {
  "sec.settings.routing.groupSelect": "認証情報の選択",
  "sec.settings.routing.groupRetry": "再試行とクールダウン",
  "sec.settings.routing.weighted": "加重ラウンドロビン",
  "sec.settings.routing.strategyHint": "リクエストを利用可能な認証情報へ振り分ける方式です。切り替えるとすぐに保存されます。",
  "sec.settings.routing.ttlPlaceholder": "例: 1h",
  "sec.settings.routing.retryRange": "再試行ラウンド数と認証情報の上限には 0 以上の整数を指定してください。待機時間には負の整数も指定できます。",
  "sec.settings.routing.loadFailed": "ルーティング設定を読み込めません",
};
