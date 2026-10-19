// Shared types and pure helpers for the Settings → Updates tab (mirrors the commands used by the old Version page).
import type { MessageKey } from '../../../i18n/resources';

export type CoreInstallResult = {
  version: string;
  assetName: string;
  installDir: string;
  binaryPath: string | null;
};

export type BundledCoreInfo = {
  version: string;
  assetName: string;
};

export type CoreInstallTask = {
  running: boolean;
  cancellable: boolean;
  phase: string;
  downloaded: number;
  total: number | null;
  percent: number | null;
  message: string | null;
  result: CoreInstallResult | null;
};

export type VersionDownloadSource = string;

export type VersionSourceSettings = {
  source: VersionDownloadSource;
  gitcodeAvailable: boolean;
  customMirrors: string[];
};

export const DEFAULT_VERSION_DOWNLOAD_SOURCE = 'github';
export const APP_RELEASE_URL = 'https://github.com/router-for-me/EasyCLIProxyAPI/releases/latest';

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export const BUILTIN_SOURCES: { id: VersionDownloadSource; labelKey: MessageKey; host: string }[] = [
  { id: 'github', labelKey: 'kernel.versions.source.github', host: 'github.com' },
  { id: 'gitcode', labelKey: 'kernel.versions.source.gitcode', host: 'gitcode.com' },
  { id: 'gh-proxy', labelKey: 'kernel.versions.source.ghProxy', host: 'gh-proxy.com' },
  { id: 'gh-fast', labelKey: 'kernel.versions.source.ghFast', host: 'ghfast.top' },
];

export function displayAppVersion(version: string) {
  const resolved = version.trim();
  return resolved.startsWith('v') ? resolved : `v${resolved}`;
}

export function downloadSourceLabel(source: VersionDownloadSource, t: Translate) {
  const builtin = BUILTIN_SOURCES.find((entry) => entry.id === source);
  if (builtin) return t(builtin.labelKey);
  if (source.startsWith('custom:')) {
    try {
      return `${t('kernel.versions.source.custom')} · ${new URL(source.slice('custom:'.length)).host}`;
    } catch {
      return t('kernel.versions.source.custom');
    }
  }
  return t('kernel.versions.source.github');
}

export function localizeInstallPhase(phase: string, t: Translate) {
  const keys: Record<string, MessageKey> = {
    'Preparing download': 'kernel.phase.preparingDownload',
    Downloading: 'kernel.phase.downloading',
    Extracting: 'kernel.phase.extracting',
    'Preparing bundled kernel': 'kernel.phase.preparingBundled',
    'Verify bundled kernel': 'kernel.phase.preparingBundled',
    'Extract bundled kernel': 'kernel.phase.preparingBundled',
    'Installation complete': 'kernel.phase.completed',
    'Installation failed': 'kernel.phase.failed',
    Canceled: 'kernel.phase.cancelled',
  };
  const key = keys[phase];
  if (key) return t(key);
  if (phase === 'Preparing to install the latest version') return t('kernel.install.installingLatest');
  const version = phase.match(/^Preparing to install (.+)$/)?.[1];
  return version ? t('kernel.install.installingVersion', { version }) : phase;
}

export function taskPercent(task: { percent: number | null; downloaded: number; total: number | null } | null) {
  if (!task) return null;
  const raw = task.percent ?? (task.total && task.total > 0 ? (task.downloaded / task.total) * 100 : null);
  return raw === null ? null : Math.min(100, Math.max(0, raw));
}

// A missing result is idle, not an in-flight check. Failure wins over cached data.
export function latestCheckText(checking: boolean, error: string, version: string, t: Translate) {
  if (checking) return t('sec.settings.updates.checking');
  if (error) return t('sec.settings.updates.checkFailed');
  return version || t('sec.settings.updates.notChecked');
}
