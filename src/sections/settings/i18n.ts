// Settings section strings. Own this file: shared keys here, per-tab keys in strings/<tab>.ts (zh-CN is the key source;
// en/ja must mirror it; zh-TW is derived automatically).
import { connectionZhCN, connectionEn, connectionJa } from './strings/connection';
import { accessZhCN, accessEn, accessJa } from './strings/access';
import { routingZhCN, routingEn, routingJa } from './strings/routing';
import { networkZhCN, networkEn, networkJa } from './strings/network';
import { modelsZhCN, modelsEn, modelsJa } from './strings/models';
import { logsZhCN, logsEn, logsJa } from './strings/logs';
import { appZhCN, appEn, appJa } from './strings/app';
import { updatesZhCN, updatesEn, updatesJa } from './strings/updates';

const baseZhCN = {
  "sec.settings.title": "设置",
  "sec.settings.nav": "设置分类",
  "sec.settings.tab.connection": "连接",
  "sec.settings.tab.access": "访问密钥",
  "sec.settings.tab.routing": "路由",
  "sec.settings.tab.network": "网络与 TLS",
  "sec.settings.tab.models": "模型",
  "sec.settings.tab.logs": "日志",
  "sec.settings.tab.app": "应用",
  "sec.settings.tab.updates": "更新",
  "sec.settings.unsavedDot": "有未保存的更改",
  "sec.settings.leave.title": "放弃未保存的更改？",
  "sec.settings.leave.message": "此页面有尚未保存的更改，离开后将丢失。",
  "sec.settings.leave.confirm": "放弃并离开",
  "sec.settings.effect.instant": "无需重启",
  "sec.settings.effect.restart": "重启内核生效",
  "sec.settings.effect.nextStart": "下次启动生效",
  "sec.settings.effect.remoteHost": "在远程主机生效",
  "sec.settings.save.region": "未保存的更改",
  "sec.settings.save.unsaved": "{count} 项未保存的更改",
  "sec.settings.save.saved": "已保存",
  "sec.settings.save.discard": "放弃",
  "sec.settings.loadFailed": "无法读取设置",
  "sec.settings.remoteBanner": "已连接远程内核 · 以下为远程主机上的设置",
} as const;

const baseEn: Record<keyof typeof baseZhCN, string> = {
  "sec.settings.title": "Settings",
  "sec.settings.nav": "Settings sections",
  "sec.settings.tab.connection": "Connection",
  "sec.settings.tab.access": "Access keys",
  "sec.settings.tab.routing": "Routing",
  "sec.settings.tab.network": "Network & TLS",
  "sec.settings.tab.models": "Models",
  "sec.settings.tab.logs": "Logs",
  "sec.settings.tab.app": "App",
  "sec.settings.tab.updates": "Updates",
  "sec.settings.unsavedDot": "Unsaved changes",
  "sec.settings.leave.title": "Discard unsaved changes?",
  "sec.settings.leave.message": "This page has changes that are not saved yet. They are lost if you leave.",
  "sec.settings.leave.confirm": "Discard and leave",
  "sec.settings.effect.instant": "No restart",
  "sec.settings.effect.restart": "Restarts core",
  "sec.settings.effect.nextStart": "Next start",
  "sec.settings.effect.remoteHost": "On remote host",
  "sec.settings.save.region": "Unsaved changes",
  "sec.settings.save.unsaved": "{count} unsaved changes",
  "sec.settings.save.saved": "Saved",
  "sec.settings.save.discard": "Discard",
  "sec.settings.loadFailed": "Couldn't read settings",
  "sec.settings.remoteBanner": "Connected to a remote core · these settings live on the remote host",
};

const baseJa: Record<keyof typeof baseZhCN, string> = {
  "sec.settings.title": "設定",
  "sec.settings.nav": "設定カテゴリ",
  "sec.settings.tab.connection": "接続",
  "sec.settings.tab.access": "アクセスキー",
  "sec.settings.tab.routing": "ルーティング",
  "sec.settings.tab.network": "ネットワークと TLS",
  "sec.settings.tab.models": "モデル",
  "sec.settings.tab.logs": "ログ",
  "sec.settings.tab.app": "アプリ",
  "sec.settings.tab.updates": "アップデート",
  "sec.settings.unsavedDot": "未保存の変更",
  "sec.settings.leave.title": "未保存の変更を破棄しますか？",
  "sec.settings.leave.message": "このページには保存されていない変更があります。離れると失われます。",
  "sec.settings.leave.confirm": "破棄して移動",
  "sec.settings.effect.instant": "再起動不要",
  "sec.settings.effect.restart": "コア再起動",
  "sec.settings.effect.nextStart": "次回起動時",
  "sec.settings.effect.remoteHost": "リモートホスト側",
  "sec.settings.save.region": "未保存の変更",
  "sec.settings.save.unsaved": "未保存の変更 {count} 件",
  "sec.settings.save.saved": "保存しました",
  "sec.settings.save.discard": "破棄",
  "sec.settings.loadFailed": "設定を読み込めません",
  "sec.settings.remoteBanner": "リモートコアに接続中 · これらの設定はリモートホスト上にあります",
};

export const settingsZhCN = {
  ...baseZhCN, ...connectionZhCN, ...accessZhCN, ...routingZhCN, ...networkZhCN, ...modelsZhCN, ...logsZhCN, ...appZhCN, ...updatesZhCN,
} as const;

export const settingsEn: Record<keyof typeof settingsZhCN, string> = {
  ...baseEn, ...connectionEn, ...accessEn, ...routingEn, ...networkEn, ...modelsEn, ...logsEn, ...appEn, ...updatesEn,
};

export const settingsJa: Record<keyof typeof settingsZhCN, string> = {
  ...baseJa, ...connectionJa, ...accessJa, ...routingJa, ...networkJa, ...modelsJa, ...logsJa, ...appJa, ...updatesJa,
};
