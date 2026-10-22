import { invoke } from '@tauri-apps/api/core';

export type CoreLatest = {
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
  // Installs requested through remote host control carry the requesting client's job id.
  job?: string | null;
};

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

export type VersionSourceSettings = {
  source: VersionDownloadSource;
  gitcodeAvailable: boolean;
  customMirrors: string[];
};

export type VersionDownloadSource = string;

export const checkLatestCore = (): Promise<CoreLatest> =>
  invoke<CoreLatest>('check_latest_core');

export const getCoreInstallTask = (): Promise<CoreInstallTask> =>
  invoke<CoreInstallTask>('get_core_install_task');

export const setDownloadSource = (args: { source: string; }): Promise<VersionSourceSettings> =>
  invoke<VersionSourceSettings>('set_download_source', args);

export const addCustomDownloadMirror = (args: { url: string; }): Promise<VersionSourceSettings> =>
  invoke<VersionSourceSettings>('add_custom_download_mirror', args);

export const removeCustomDownloadMirror = (args: { url: string; }): Promise<VersionSourceSettings> =>
  invoke<VersionSourceSettings>('remove_custom_download_mirror', args);

export const installBundledCore = (): Promise<CoreInstallResult> =>
  invoke<CoreInstallResult>('install_bundled_core');

export const installCoreVersion = (args: { version: string; }): Promise<CoreInstallResult> =>
  invoke<CoreInstallResult>('install_core_version', args);

export const cancelCoreInstall = (): Promise<void> =>
  invoke<void>('cancel_core_install');

export const detectBundledCore = (): Promise<BundledCoreInfo | null> =>
  invoke<BundledCoreInfo | null>('detect_bundled_core');

export const getVersionSourceSettings = (): Promise<VersionSourceSettings> =>
  invoke<VersionSourceSettings>('get_version_source_settings');

// Follows an install that this page did not start (for example another computer's install on the remote host,
// whose progress is not relayed here) until it finishes, so the page never stays busy.
export async function followInstallTask(
  fetchTask: () => Promise<CoreInstallTask>,
  onTask: (task: CoreInstallTask) => void,
  active: () => boolean,
  intervalMs = 1000,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  while (active()) {
    await wait(intervalMs);
    if (!active()) return;
    let task: CoreInstallTask;
    try { task = await fetchTask(); } catch { continue; }
    if (!active()) return;
    onTask(task);
    if (!task.running) return;
  }
}

export const remoteVersionSource = (action = '', value?: string): Promise<VersionSourceSettings> =>
  invoke<VersionSourceSettings>('remote_version_source', { action, value: value ?? null });
