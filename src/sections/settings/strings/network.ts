// Settings → network tab strings. Keys are 'sec.settings.network.*'. zh-CN is the key source; en/ja must mirror it.
export const networkZhCN = {
  "sec.settings.network.listen.title": "监听地址",
  "sec.settings.network.listen.lanHint": "开启后监听 0.0.0.0，局域网内的设备可访问；关闭则仅监听 127.0.0.1。",
  "sec.settings.network.listen.hostHint": "留空监听所有 IPv4/IPv6 接口，也可填写 localhost 或具体 IP。",
  "sec.settings.network.proxy.title": "上游代理",
  "sec.settings.network.tls.title": "TLS / HTTPS",
  "sec.settings.network.tls.on": "HTTPS",
  "sec.settings.network.tls.off": "HTTP",
  "sec.settings.network.tls.loadFailed": "无法读取 TLS 设置：{error}",
  "sec.settings.network.tls.remoteOnly": "证书与私钥路径位于远程主机，仅本地内核可在此处选择文件。",
  "sec.settings.network.saved.restarted": "已保存，内核已重启",
  "sec.settings.network.saved.nextStart": "已保存，下次启动内核时生效",
  "sec.settings.network.saved.applied": "已保存",
} as const;

export const networkEn: Record<keyof typeof networkZhCN, string> = {
  "sec.settings.network.listen.title": "Listening",
  "sec.settings.network.listen.lanHint": "On binds 0.0.0.0 so devices on your network can connect; off binds 127.0.0.1 only.",
  "sec.settings.network.listen.hostHint": "Leave blank to bind all IPv4/IPv6 interfaces, or enter localhost or an IP address.",
  "sec.settings.network.proxy.title": "Upstream proxy",
  "sec.settings.network.tls.title": "TLS / HTTPS",
  "sec.settings.network.tls.on": "HTTPS",
  "sec.settings.network.tls.off": "HTTP",
  "sec.settings.network.tls.loadFailed": "Couldn't read TLS settings: {error}",
  "sec.settings.network.tls.remoteOnly": "Certificate and key paths live on the remote host; only a local core can pick files here.",
  "sec.settings.network.saved.restarted": "Saved · core restarted",
  "sec.settings.network.saved.nextStart": "Saved · applies the next time the core starts",
  "sec.settings.network.saved.applied": "Saved",
};

export const networkJa: Record<keyof typeof networkZhCN, string> = {
  "sec.settings.network.listen.title": "待ち受け",
  "sec.settings.network.listen.lanHint": "オンにすると 0.0.0.0 で待ち受け、同じネットワークの端末から接続できます。オフでは 127.0.0.1 のみです。",
  "sec.settings.network.listen.hostHint": "空欄ではすべての IPv4/IPv6 インターフェースで待ち受けます。localhost または IP アドレスも指定できます。",
  "sec.settings.network.proxy.title": "上流プロキシ",
  "sec.settings.network.tls.title": "TLS / HTTPS",
  "sec.settings.network.tls.on": "HTTPS",
  "sec.settings.network.tls.off": "HTTP",
  "sec.settings.network.tls.loadFailed": "TLS 設定を読み込めません: {error}",
  "sec.settings.network.tls.remoteOnly": "証明書と秘密鍵のパスはリモートホスト上にあります。ここでファイルを選べるのはローカルコアのみです。",
  "sec.settings.network.saved.restarted": "保存しました · コアを再起動しました",
  "sec.settings.network.saved.nextStart": "保存しました · 次回のコア起動時に適用されます",
  "sec.settings.network.saved.applied": "保存しました",
};
