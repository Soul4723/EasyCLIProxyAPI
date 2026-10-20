// Download-source state for the Updates tab: selected source, built-in channels and custom HTTPS mirrors.
// Commands: get_version_source_settings, set_download_source, set_mirror_fallback, add/remove_custom_download_mirror.
// The backend never changes the saved source on its own, so there is no auto-switch event.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, listen } from '../../../services/platform';
import { createSettingsRead } from '../../../services/settingsData';
import { useI18n } from '../../../i18n';
import type { NoticeMessage, NoticeTone } from '../../../appNotice';
import { useRequestGuard } from '../useRequestGuard';
import { downloadSourceLabel, type VersionDownloadSource, type VersionSourceSettings } from './model';

type Notify = (message: NoticeMessage, tone?: NoticeTone) => void;

const versionSourceRead = createSettingsRead(() => invoke<VersionSourceSettings>('get_version_source_settings'));

export function useVersionSource(notify: Notify, onSourceChanged: () => void, refreshStatus: () => Promise<void>) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<VersionSourceSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [addError, setAddError] = useState('');
  const tRef = useRef(t);
  tRef.current = t;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const changedRef = useRef(onSourceChanged);
  changedRef.current = onSourceChanged;
  const refreshRef = useRef(refreshStatus);
  refreshRef.current = refreshStatus;

  // A save result supersedes any load still in flight.
  const requests = useRequestGuard();
  const load = useCallback(async (fresh = false) => {
    const isCurrent = requests.begin();
    try {
      const value = await versionSourceRead.read({ fresh });
      if (!isCurrent()) return;
      setSettings(value);
      setError('');
    } catch (cause) {
      if (isCurrent()) setError(String(cause));
    }
  }, [requests]);

  useEffect(() => {
    let disposed = false;
    let stopConfig: (() => void) | null = null;
    void listen('config-files-changed', () => {
      if (disposed) return;
      void load(true);
      void refreshRef.current();
    }).then((stop) => {
      if (disposed) stop();
      else stopConfig = stop;
    });
    void load();
    return () => {
      disposed = true;
      stopConfig?.();
    };
  }, [load, requests]);

  const select = useCallback(async (source: VersionDownloadSource) => {
    setSaving(true);
    setError('');
    try {
      const next = await invoke<VersionSourceSettings>('set_download_source', { source });
      requests.invalidate();
      versionSourceRead.publish(next);
      setSettings(next);
      changedRef.current();
      notifyRef.current({ key: 'kernel.versions.sourceSwitched', variables: { source: downloadSourceLabel(next.source, tRef.current) } }, 'info');
    } catch (cause) {
      await load(true);
      setError(tRef.current('kernel.versions.gitcodeSaveFailed', { error: String(cause) }));
    } finally {
      setSaving(false);
    }
  }, [load, requests]);

  const setMirrorFallback = useCallback(async (enabled: boolean) => {
    setSaving(true);
    setError('');
    try {
      const next = await invoke<VersionSourceSettings>('set_mirror_fallback', { enabled });
      requests.invalidate();
      versionSourceRead.publish(next);
      setSettings(next);
    } catch (cause) {
      await load(true);
      setError(tRef.current('sec.settings.updates.sources.fallbackSaveFailed', { error: String(cause) }));
    } finally {
      setSaving(false);
    }
  }, [load, requests]);

  /** Resolves true when the mirror was added (the backend validates the URL and selects it). */
  const addMirror = useCallback(async (raw: string) => {
    const url = raw.trim();
    if (!url) return false;
    setSaving(true);
    setAddError('');
    try {
      const next = await invoke<VersionSourceSettings>('add_custom_download_mirror', { url });
      requests.invalidate();
      versionSourceRead.publish(next);
      setSettings(next);
      changedRef.current();
      notifyRef.current({ key: 'kernel.versions.customMirrorAdded' }, 'success');
      return true;
    } catch (cause) {
      setAddError(tRef.current('kernel.versions.customMirrorAddFailed', { error: String(cause) }));
      return false;
    } finally {
      setSaving(false);
    }
  }, [requests]);

  const removeMirror = useCallback(async (url: string, wasSelected: boolean) => {
    setSaving(true);
    setError('');
    try {
      const next = await invoke<VersionSourceSettings>('remove_custom_download_mirror', { url });
      requests.invalidate();
      versionSourceRead.publish(next);
      setSettings(next);
      notifyRef.current({ key: 'kernel.versions.customMirrorRemoved' }, 'success');
      if (wasSelected) changedRef.current();
    } catch (cause) {
      setError(tRef.current('kernel.versions.customMirrorRemoveFailed', { error: String(cause) }));
    } finally {
      setSaving(false);
    }
  }, [requests]);

  return { settings, saving, error, addError, clearAddError: () => setAddError(''), clearError: () => setError(''), select, setMirrorFallback, addMirror, removeMirror };
}
