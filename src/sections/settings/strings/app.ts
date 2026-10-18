// Settings → app tab strings. Keys are 'sec.settings.app.*'. zh-CN is the key source; en/ja must mirror it.
export const appZhCN = {
  "sec.settings.app.groupAppearance": "外观",
  "sec.settings.app.groupPrivacy": "隐私",
  "sec.settings.app.groupStartup": "启动与窗口",
  "sec.settings.app.groupAbout": "关于",
  "sec.settings.app.privacyHint": "隐藏界面中的邮箱、标识符和密钥；也可用页面右上角的眼睛按钮临时切换",
  "sec.settings.app.version": "应用版本",
  "sec.settings.app.versionLink": "在“更新”中查看",
  "sec.settings.app.loadFailed": "无法读取应用设置",
} as const;

export const appEn: Record<keyof typeof appZhCN, string> = {
  "sec.settings.app.groupAppearance": "Appearance",
  "sec.settings.app.groupPrivacy": "Privacy",
  "sec.settings.app.groupStartup": "Startup & window",
  "sec.settings.app.groupAbout": "About",
  "sec.settings.app.privacyHint": "Hides emails, identifiers and keys across the app. The eye button in the page header toggles the same setting.",
  "sec.settings.app.version": "App version",
  "sec.settings.app.versionLink": "View in Updates",
  "sec.settings.app.loadFailed": "Couldn't read app settings",
};

export const appJa: Record<keyof typeof appZhCN, string> = {
  "sec.settings.app.groupAppearance": "外観",
  "sec.settings.app.groupPrivacy": "プライバシー",
  "sec.settings.app.groupStartup": "起動とウィンドウ",
  "sec.settings.app.groupAbout": "情報",
  "sec.settings.app.privacyHint": "メールアドレス、識別子、キーをアプリ全体で非表示にします。ページ上部の目のボタンでも同じ設定を切り替えられます。",
  "sec.settings.app.version": "アプリのバージョン",
  "sec.settings.app.versionLink": "アップデートで確認",
  "sec.settings.app.loadFailed": "アプリ設定を読み込めません",
};
