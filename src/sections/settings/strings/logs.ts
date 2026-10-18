// Settings → logs tab strings. Keys are 'sec.settings.logs.*'. zh-CN is the key source; en/ja must mirror it.
export const logsZhCN = {
  "sec.settings.logs.groupLogging": "日志",
  "sec.settings.logs.groupUsage": "用量统计",
  "sec.settings.logs.loadFailed": "无法读取日志设置",
  "sec.settings.logs.openFolderHint": "在文件管理器中打开内核日志目录",
  "sec.settings.logs.openFolderFailed": "无法打开日志文件夹：{error}",
  "sec.settings.logs.remoteOnly": "日志位于远程主机，无法在本机打开",
  "sec.settings.logs.restartNote": "保存后将自动重启本机内核以应用商业模式",
  "sec.settings.logs.integerError": "日志总大小与错误日志保留数须为非负整数",
  "sec.settings.logs.retentionError": "用量队列保留时间须为 1 到 3600 之间的整数",
  "sec.settings.logs.savedRestarted": "已保存，内核已重启",
} as const;

export const logsEn: Record<keyof typeof logsZhCN, string> = {
  "sec.settings.logs.groupLogging": "Logging",
  "sec.settings.logs.groupUsage": "Usage statistics",
  "sec.settings.logs.loadFailed": "Couldn't read logging settings",
  "sec.settings.logs.openFolderHint": "Open the core's log directory in your file manager",
  "sec.settings.logs.openFolderFailed": "Couldn't open the log folder: {error}",
  "sec.settings.logs.remoteOnly": "Logs live on the remote host and can't be opened here",
  "sec.settings.logs.restartNote": "Saving restarts the local core to apply commercial mode",
  "sec.settings.logs.integerError": "Log size and error log retention must be non-negative integers",
  "sec.settings.logs.retentionError": "Usage queue retention must be an integer between 1 and 3600",
  "sec.settings.logs.savedRestarted": "Saved · core restarted",
};

export const logsJa: Record<keyof typeof logsZhCN, string> = {
  "sec.settings.logs.groupLogging": "ログ",
  "sec.settings.logs.groupUsage": "使用量統計",
  "sec.settings.logs.loadFailed": "ログ設定を読み込めません",
  "sec.settings.logs.openFolderHint": "コアのログフォルダーをファイルマネージャーで開きます",
  "sec.settings.logs.openFolderFailed": "ログフォルダーを開けませんでした：{error}",
  "sec.settings.logs.remoteOnly": "ログはリモートホスト上にあるため、ここでは開けません",
  "sec.settings.logs.restartNote": "保存するとローカルコアを再起動してコマーシャルモードを適用します",
  "sec.settings.logs.integerError": "ログの合計サイズとエラーログの保持数には 0 以上の整数を指定してください",
  "sec.settings.logs.retentionError": "使用量キューの保持時間は 1〜3600 の整数で指定してください",
  "sec.settings.logs.savedRestarted": "保存しました · コアを再起動しました",
};
