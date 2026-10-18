import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useI18n } from '../../../i18n';
import {
  retainVisibleCodexSessionIds,
  type CodexSessionDeleteBatchResult,
  type CodexSessionPage,
  type CodexSessionRepairProgress,
  type CodexSessionRepairResult,
  type SessionIndexCleanupPreview,
  type SessionIndexCleanupResult,
} from '../../../services/codexSessionState';

/** Result line shown under the toolbar after an operation. */
export type SessionsNotice = { kind: 'success' | 'warning' | 'error'; message: string };
export type SessionsOperation = 'delete' | 'repair' | 'preview' | 'cleanup' | null;

export const SESSIONS_PAGE_SIZE = 50;

// Offset and selection survive switching tabs (same behaviour as the old panel).
let sessionViewCache = { offset: 0, selectedIds: new Set<string>() };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Codex sessions list state: paged `list_codex_sessions` with a request counter (stale responses are dropped),
 * selection, batch delete, metadata repair (with progress events) and the session-index cleanup preview/apply flow.
 * The UI only renders this and calls the handlers.
 */
export function useSessionsList() {
  const { t } = useI18n();
  const [page, setPage] = useState<CodexSessionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operation, setOperation] = useState<SessionsOperation>(null);
  const [notice, setNotice] = useState<SessionsNotice | null>(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set(sessionViewCache.selectedIds));
  const [cleanupPreview, setCleanupPreview] = useState<SessionIndexCleanupPreview | null>(null);
  const [cleanupSelectedIds, setCleanupSelectedIds] = useState<Set<string>>(() => new Set());
  const [repairProgress, setRepairProgress] = useState<CodexSessionRepairProgress>({
    phase: 'scanning', percent: 0, processed: 0, total: 0,
  });
  const mountedRef = useRef(false);
  const loadRequestRef = useRef(0);
  const initialOffsetRef = useRef(sessionViewCache.offset);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    sessionViewCache = { offset: page?.offset ?? initialOffsetRef.current, selectedIds: new Set(selectedIds) };
  }, [page, selectedIds]);

  const loadPage = useCallback(async (offset = 0, silent = false): Promise<CodexSessionPage | null> => {
    if (!mountedRef.current) return null;
    const requestId = ++loadRequestRef.current;
    if (!silent) {
      setLoading(true);
      setLoadError(null);
      setNotice((current) => current?.kind === 'error' ? null : current);
    }
    try {
      const result = await invoke<CodexSessionPage>('list_codex_sessions', {
        request: { offset, limit: SESSIONS_PAGE_SIZE },
      });
      if (!mountedRef.current || requestId !== loadRequestRef.current) return null;
      if (result.sessions.length === 0 && result.offset > 0) {
        return await loadPage(Math.max(0, result.offset - result.limit), silent);
      }
      setPage(result);
      setLoadError(null);
      setSelectedIds((current) => retainVisibleCodexSessionIds(current, result.sessions));
      return result;
    } catch (error) {
      if (!mountedRef.current || requestId !== loadRequestRef.current) return null;
      const message = t('agents.sessions.loadFailed', { error: errorMessage(error) });
      setLoadError(message);
      setNotice({ kind: 'error', message });
      return null;
    } finally {
      if (!silent && mountedRef.current && requestId === loadRequestRef.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadPage(sessionViewCache.offset);
  }, [loadPage]);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<CodexSessionRepairProgress>('codex-session-repair-progress', (event) => {
      if (!disposed) setRepairProgress(event.payload);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  const currentOffset = page?.offset ?? initialOffsetRef.current;
  const pageLimit = page?.limit ?? SESSIONS_PAGE_SIZE;
  const busy = operation !== null;

  const setSelected = (id: string, selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const deleteSessions = async (ids: string[]) => {
    if (ids.length === 0) return;
    setOperation('delete');
    setNotice(null);
    try {
      const result = await invoke<CodexSessionDeleteBatchResult>('delete_codex_sessions', {
        request: { sessionIds: ids },
      });
      const failed = result.results.filter((item) => !['deleted', 'partial'].includes(item.status));
      const partial = result.results.filter((item) => item.status === 'partial');
      const backupPaths = result.results.map((item) => item.backupPath).filter((path): path is string => Boolean(path));
      const details = [...partial, ...failed].map((item) => `${item.sessionId}: ${item.message}`).join('；');
      setNotice({
        kind: failed.length > 0 ? (result.deletedCount > 0 ? 'warning' : 'error') : partial.length > 0 ? 'warning' : 'success',
        message: t('agents.sessions.deleteResult', {
          deleted: result.deletedCount,
          failed: result.failedCount,
          details: details ? ` ${details}` : '',
          backup: backupPaths[0] ? t('agents.sessions.backupAt', { path: backupPaths[0] }) : '',
        }),
      });
      setSelectedIds(new Set());
      await loadPage(currentOffset, true);
    } catch (error) {
      setNotice({ kind: 'error', message: t('agents.sessions.deleteFailed', { error: errorMessage(error) }) });
    } finally {
      setOperation(null);
    }
  };

  const repairSessions = async () => {
    setOperation('repair');
    setNotice(null);
    setRepairProgress({ phase: 'scanning', percent: 4, processed: 0, total: 0 });
    try {
      const result = await invoke<CodexSessionRepairResult>('repair_codex_session_metadata');
      const messages = [
        t('agents.sessions.repairResult', {
          provider: result.targetProvider,
          files: result.changedRolloutFiles,
          rows: result.sqliteRowsUpdated,
          skipped: result.skippedLockedFiles.length,
        }),
      ];
      if (result.encryptedContentWarning) messages.push(result.encryptedContentWarning);
      if (result.warnings.length > 0) messages.push(result.warnings.join('；'));
      if (result.backupPath) messages.push(t('agents.sessions.backupAt', { path: result.backupPath }));
      setNotice({
        kind: result.encryptedContentWarning || result.warnings.length > 0 ? 'warning' : 'success',
        message: messages.join(' '),
      });
      await loadPage(currentOffset, true);
    } catch (error) {
      setNotice({ kind: 'error', message: t('agents.sessions.repairFailed', { error: errorMessage(error) }) });
    } finally {
      setOperation(null);
    }
  };

  const previewCleanup = async () => {
    setOperation('preview');
    setNotice(null);
    try {
      const preview = await invoke<SessionIndexCleanupPreview>('preview_codex_session_index_cleanup');
      setCleanupSelectedIds(new Set());
      if (preview.candidates.length === 0) {
        setCleanupPreview(null);
        setNotice({ kind: 'success', message: t('agents.sessions.cleanupNoCandidates') });
      } else {
        setCleanupPreview(preview);
      }
    } catch (error) {
      setNotice({ kind: 'error', message: t('agents.sessions.cleanupPreviewFailed', { error: errorMessage(error) }) });
    } finally {
      setOperation(null);
    }
  };

  const applyCleanup = async () => {
    if (!cleanupPreview || cleanupSelectedIds.size === 0) return;
    setOperation('cleanup');
    setNotice(null);
    try {
      const result = await invoke<SessionIndexCleanupResult>('apply_codex_session_index_cleanup', {
        request: { snapshotSha256: cleanupPreview.snapshotSha256, threadIds: Array.from(cleanupSelectedIds) },
      });
      setCleanupPreview(null);
      setCleanupSelectedIds(new Set());
      setNotice({
        kind: 'success',
        message: t('agents.sessions.cleanupResult', {
          count: result.prunedEntries,
          backup: result.backupPath ? t('agents.sessions.backupAt', { path: result.backupPath }) : '',
        }),
      });
    } catch (error) {
      setCleanupPreview(null);
      setCleanupSelectedIds(new Set());
      setNotice({ kind: 'error', message: t('agents.sessions.cleanupFailed', { error: errorMessage(error) }) });
    } finally {
      setOperation(null);
    }
  };

  const closeCleanup = () => {
    setCleanupPreview(null);
    setCleanupSelectedIds(new Set());
  };

  return {
    page, loading, loadError, operation, busy, notice, setNotice,
    selectedIds, setSelectedIds, setSelected,
    cleanupPreview, cleanupSelectedIds, setCleanupSelectedIds, closeCleanup,
    repairProgress, currentOffset, pageLimit,
    loadPage, deleteSessions, repairSessions, previewCleanup, applyCleanup,
  };
}

export type SessionsList = ReturnType<typeof useSessionsList>;
