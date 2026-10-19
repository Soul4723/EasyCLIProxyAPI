// Core install task state for the Updates tab: install (release / bundled), live progress events, cancel, bundled-core detection.
// Same commands, events and result handling as the old Version page.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../../services/platform';
import { createSettingsRead } from '../../../services/settingsData';
import { listen } from '../../../services/platform';
import { useI18n } from '../../../i18n';
import { useCoreRuntime } from '../../../coreRuntime';
import type { NoticeMessage, NoticeTone } from '../../../appNotice';
import type { BundledCoreInfo, CoreInstallResult, CoreInstallTask } from './model';

type Notify = (message: NoticeMessage, tone?: NoticeTone) => void;

export type CoreInstallTarget = { kind: 'bundled' } | { kind: 'release'; version: string };

const installTaskRead = createSettingsRead(() => invoke<CoreInstallTask>('get_core_install_task'));
const bundledCoreRead = createSettingsRead(() => invoke<BundledCoreInfo | null>('detect_bundled_core'));

export function useCoreInstall(notify: Notify) {
  const { t } = useI18n();
  const { status: coreStatus, refreshStatus } = useCoreRuntime();
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<CoreInstallTask | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [bundledCore, setBundledCore] = useState<BundledCoreInfo | null>(null);
  const [bundledCoreError, setBundledCoreError] = useState('');
  const completedKeyRef = useRef('');
  const manualRef = useRef(false);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const refreshRef = useRef(refreshStatus);
  refreshRef.current = refreshStatus;
  const tRef = useRef(t);
  tRef.current = t;

  const announceCompleted = useCallback((result: CoreInstallResult, message?: string | null) => {
    const key = `${result.version}\u0000${result.assetName}\u0000${result.binaryPath ?? ''}`;
    if (completedKeyRef.current === key) return;
    completedKeyRef.current = key;
    notifyRef.current(message || tRef.current('kernel.install.completed', { version: result.version }), 'success');
  }, []);

  // `showUi`: this tab started the install (or a manual one is in flight), so surface progress and results.
  const applyTask = useCallback((task: CoreInstallTask, showUi: boolean) => {
    if (!task.running && !task.message && !task.result) {
      setProgress(null);
      setInstalling(false);
      setCancelling(false);
      return;
    }
    setInstalling(task.running);
    if (!task.running) setCancelling(false);
    setProgress(task.running || showUi ? task : null);
    if (task.result) {
      if (showUi) announceCompleted(task.result, task.message);
      setProgress(null);
      setCancelling(false);
      void refreshRef.current();
      return;
    }
    if (task.message && !task.running) {
      notifyRef.current(task.message, task.phase === 'Installation failed' ? 'error' : 'info');
    }
  }, [announceCompleted]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<CoreInstallTask>('core-install-progress', (event) => {
      applyTask(event.payload, manualRef.current);
      if (!event.payload.running) manualRef.current = false;
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    void installTaskRead.read()
      .then((task) => { if (!disposed) applyTask(task, false); })
      .catch(() => undefined);
    void bundledCoreRead.read()
      .then((info) => { if (!disposed) setBundledCore(info); })
      .catch((error) => { if (!disposed) setBundledCoreError(String(error)); });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyTask]);

  const install = useCallback(async (target: CoreInstallTarget) => {
    if (!coreStatus || coreStatus.connectionMode === 'remote') return;
    completedKeyRef.current = '';
    manualRef.current = true;
    setInstalling(true);
    setCancelling(false);
    setProgress({
      running: true,
      cancellable: target.kind === 'release',
      phase: target.kind === 'bundled' ? 'Preparing bundled kernel' : 'Preparing download',
      downloaded: 0,
      total: null,
      percent: null,
      message: null,
      result: null,
    });
    try {
      const result = target.kind === 'bundled'
        ? await invoke<CoreInstallResult>('install_bundled_core')
        : await invoke<CoreInstallResult>('install_core_version', { version: target.version });
      announceCompleted(result, tRef.current(target.kind === 'bundled' ? 'kernel.install.bundledCompleted' : 'kernel.install.completed', { version: result.version }));
      manualRef.current = false;
      setProgress(null);
      setCancelling(false);
    } catch (error) {
      manualRef.current = false;
      const message = String(error);
      const cancelled = /cancel/i.test(message);
      notifyRef.current(message, cancelled ? 'info' : 'error');
      setProgress((current) => ({
        running: false,
        cancellable: false,
        phase: cancelled ? 'Canceled' : 'Installation failed',
        downloaded: current?.downloaded ?? 0,
        total: current?.total ?? null,
        percent: current?.percent ?? null,
        message,
        result: null,
      }));
    } finally {
      setInstalling(false);
      await refreshRef.current();
    }
  }, [announceCompleted, coreStatus]);

  const cancel = useCallback(async () => {
    if (cancelling || !progress?.running || !progress.cancellable) return;
    setCancelling(true);
    try {
      await invoke('cancel_core_install');
    } catch (error) {
      setCancelling(false);
      notifyRef.current(String(error), 'error');
    }
  }, [cancelling, progress]);

  const dismiss = useCallback(() => {
    if (installing || progress?.running) return;
    setProgress(null);
    setCancelling(false);
  }, [installing, progress]);

  return { installing, progress, cancelling, bundledCore, bundledCoreError, install, cancel, dismiss };
}
