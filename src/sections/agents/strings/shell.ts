// Agents section strings: page frame (tabs, detail header, run controls).
export const shellZhCN = {
  'sec.agents.tab.clients': '客户端',
  'sec.agents.tab.sessions': 'Codex 会话',
  'sec.agents.detail.back': '全部客户端',
  'sec.agents.detail.tab.setup': '配置',
  'sec.agents.detail.tab.backups': '备份',
  'sec.agents.detail.tab.manage': '管理',
  'sec.agents.detail.tabs': '客户端设置',
  'sec.agents.detail.sessions': '会话',
  'sec.agents.detail.notFound': '未找到该客户端',
  'sec.agents.rescan': '重新检测',
} as const;
export const shellEn: Record<keyof typeof shellZhCN, string> = {
  'sec.agents.tab.clients': 'Clients',
  'sec.agents.tab.sessions': 'Codex sessions',
  'sec.agents.detail.back': 'All clients',
  'sec.agents.detail.tab.setup': 'Setup',
  'sec.agents.detail.tab.backups': 'Backups',
  'sec.agents.detail.tab.manage': 'Manage',
  'sec.agents.detail.tabs': 'Client settings',
  'sec.agents.detail.sessions': 'Sessions',
  'sec.agents.detail.notFound': 'Client not found',
  'sec.agents.rescan': 'Rescan',
};
export const shellJa: Record<keyof typeof shellZhCN, string> = {
  'sec.agents.tab.clients': 'クライアント',
  'sec.agents.tab.sessions': 'Codex セッション',
  'sec.agents.detail.back': 'すべてのクライアント',
  'sec.agents.detail.tab.setup': '設定',
  'sec.agents.detail.tab.backups': 'バックアップ',
  'sec.agents.detail.tab.manage': '管理',
  'sec.agents.detail.tabs': 'クライアント設定',
  'sec.agents.detail.sessions': 'セッション',
  'sec.agents.detail.notFound': 'クライアントが見つかりません',
  'sec.agents.rescan': '再検出',
};
