// Download-source state for the Updates tab: selected source, built-in channels and custom HTTPS mirrors.
// Same commands/events as the old Version page (get_version_source_settings, set_download_source, add/remove_custom_download_mirror).
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../../services/platform';
import { listen } from '../../../services/platform';
import { useI18n } from '../../../i18n';
import type { NoticeMessage, NoticeTone } from '../../../appNotice';
import { downloadSourceLabel, type VersionDownloadSource, type VersionSourceSettings } from './model';

type Notify = (message: NoticeMessage, tone?: NoticeTone) => void;

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

  const load = useCallback(async () => {
    try {
      setSettings(await invoke<VersionSourceSettings>('get_version_source_settings'));
      setError('');
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopConfig: (() => void) | null = null;
    let stopSource: (() => void) | null = null;
    void listen('config-files-changed', () => {
      if (disposed) return;
      void load();
      void refreshRef.current();
    }).then((stop) => {
      if (disposed) stop();
      else stopConfig = stop;
    });
    void listen<VersionSourceSettings>('version-download-source-changed', (event) => {
      if (disposed) return;
      setSettings(event.payload);
      setError('');
      notifyRef.current({ key: 'kernel.versions.sourceAutoSwitched', variables: { source: downloadSourceLabel(event.payload.source, tRef.current) } }, 'info');
    }).then((stop) => {
      if (disposed) stop();
      else stopSource = stop;
    });
    void load();
    return () => {
      disposed = true;
      stopConfig?.();
      stopSource?.();
    };
  }, [load]);

  const select = useCallback(async (source: VersionDownloadSource) => {
    setSaving(true);
    setError('');
    try {
      const next = await invoke<VersionSourceSettings>('set_download_source', { source });
      setSettings(next);
      changedRef.current();
      notifyRef.current({ key: 'kernel.versions.sourceSwitched', variables: { source: downloadSourceLabel(next.source, tRef.current) } }, 'info');
    } catch (cause) {
      await load();
      setError(tRef.current('kernel.versions.gitcodeSaveFailed', { error: String(cause) }));
    } finally {
      setSaving(false);
    }
  }, [load]);

  /** Resolves true when the mirror was added (the backend validates the URL and selects it). */
  const addMirror = useCallback(async (raw: string) => {
    const url = raw.trim();
    if (!url) return false;
    setSaving(true);
    setAddError('');
    try {
      setSettings(await invoke<VersionSourceSettings>('add_custom_download_mirror', { url }));
      changedRef.current();
      notifyRef.current({ key: 'kernel.versions.customMirrorAdded' }, 'success');
      return true;
    } catch (cause) {
      setAddError(tRef.current('kernel.versions.customMirrorAddFailed', { error: String(cause) }));
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const removeMirror = useCallback(async (url: string, wasSelected: boolean) => {
    setSaving(true);
    setError('');
    try {
      setSettings(await invoke<VersionSourceSettings>('remove_custom_download_mirror', { url }));
      notifyRef.current({ key: 'kernel.versions.customMirrorRemoved' }, 'success');
      if (wasSelected) changedRef.current();
    } catch (cause) {
      setError(tRef.current('kernel.versions.customMirrorRemoveFailed', { error: String(cause) }));
    } finally {
      setSaving(false);
    }
  }, []);

  return { settings, saving, error, addError, clearAddError: () => setAddError(''), clearError: () => setError(''), select, addMirror, removeMirror };
}
