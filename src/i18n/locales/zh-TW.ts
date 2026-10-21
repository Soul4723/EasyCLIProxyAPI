import { createTraditionalMessages } from './traditional';
import { zhCN, type MessageKey } from './zh-CN';

let cachedZhTW: Readonly<Record<MessageKey, string>> | undefined;

export const zhTWOverrides: Readonly<Partial<Record<MessageKey, string>>> = Object.freeze({
  "app.theme.lightGroup": "淺色主題",
  "app.theme.darkGroup": "深色主題",
  'app.theme.triggerLabel': '外觀',

  'app.theme.triggerHint': '切換日夜模式與主題外觀',

  "app.theme.current": "主題：{name}",
  "app.theme.unavailable": "主題無法使用",
  "app.theme.unavailableHint": "已儲存的主題無法使用，目前使用亮色。請選擇其他主題。",
  "app.theme.readFailed": "無法讀取主題設定，目前使用亮色。重新選擇主題後將儲存新設定。",
  "app.theme.saveFailed": "主題已暫時套用，但無法儲存。",
  "app.theme.retrySave": "重試儲存",
  'app.theme.custom.openFolder': '開啟主題資料夾',
  'app.theme.custom.openFailed': '無法開啟主題資料夾。',
  'app.theme.custom.loadFailed': '無法讀取自訂主題，已保留目前的主題列表。',
  'app.theme.custom.skipped': '已略過無效的主題檔案：{files}',
  'app.theme.custom.omitted': '另有 {count} 個主題檔案超出 64 個的上限，未讀取。',
  'app.theme.warmSand.name': '暖砂',
  'app.theme.warmSand.description': '奶油紙色與陶土色，溫潤清晰',
  'app.theme.graphite.name': '石墨',
  'app.theme.graphite.description': '炭灰底色與柔和藍調，沉穩清晰',
  'app.theme.midnight.name': '午夜藍',
  'app.theme.midnight.description': '墨藍漸層至靛藍，搭配輕透面板與霧紫藍點綴',
  'app.theme.sakura.name': '櫻語紅粉',
  'app.theme.sakura.description': '淡櫻粉漸層至奶油白，搭配輕透面板與灰黑文字',
  'app.privacy.enable': '開啟隱私模式，隱藏帳號信箱等身分資訊',
  'app.privacy.disable': '關閉隱私模式，顯示完整帳號資訊',
  'authFiles.cooldown.resetButton': '清除冷卻',
  'authFiles.cooldown.resetHint': '清除此憑證的本機路由冷卻狀態',
  'authFiles.cooldown.resetTitle': '清除憑證冷卻？',
  'authFiles.cooldown.resetConfirm': '確定清除「{name}」的本機路由冷卻狀態嗎？清除後此憑證可能立即再次參與請求，但不會恢復上游額度。',
  'authFiles.cooldown.resetSuccess': '已清除 {name} 的冷卻狀態。',
  'authFiles.cooldown.resetFailed': '無法清除 {name} 的冷卻狀態：{message}',
  'authFiles.cooldown.resetting': '正在清除…',
  'authFiles.cooldown.missingIndex': '憑證缺少有效的驗證索引，無法清除冷卻。請重新整理列表後重試。',
  'authFiles.cooldown.invalidResponse': '核心未傳回有效的清除結果，請重新整理列表確認冷卻狀態。',
  'app.contact.label': '加入 Discord 伺服器',
  'appUpdate.notes.title': '軟體更新說明',
  'appUpdate.notes.expand': '展開',
  'appUpdate.notes.collapse': '收合',
  'appUpdate.notes.publishedAt': '{date}發布',
  'appUpdate.notes.openRelease': '查看完整發布說明',
  'appUpdate.notes.empty': '尚未取得目前語言的更新說明。',
  'appUpdate.notes.loading': '正在取得更新說明…',
  'appUpdate.notes.failed': '暫時無法取得更新說明，請稍後重新檢查。',
  'appUpdate.notes.notChecked': '檢查軟體更新後，將顯示最新版的更新說明。',
});

export function getZhTW(): Readonly<Record<MessageKey, string>> {
  if (cachedZhTW) return cachedZhTW;
  cachedZhTW = Object.freeze({
    ...createTraditionalMessages(zhCN),
    ...zhTWOverrides,
  });
  return cachedZhTW;
}

export function isZhTWBuilt(): boolean {
  return cachedZhTW !== undefined;
}

// Preserve the object-shaped export while deferring conversion until it is read.
export const zhTW: Record<MessageKey, string> = new Proxy({} as Record<MessageKey, string>, {
  get: (_target, property) => Reflect.get(getZhTW(), property),
  has: (_target, property) => Reflect.has(getZhTW(), property),
  ownKeys: () => Reflect.ownKeys(getZhTW()),
  set: () => false,
  defineProperty: () => false,
  deleteProperty: () => false,
  getOwnPropertyDescriptor: (_target, property) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(getZhTW(), property);
    return descriptor && { ...descriptor, configurable: true };
  },
});
