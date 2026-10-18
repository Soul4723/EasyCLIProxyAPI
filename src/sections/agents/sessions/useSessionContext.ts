import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../../../services/platform';
import { useI18n } from '../../../i18n';
import { APP_NAVIGATION_REQUEST_EVENT, type AppNavigationRequest } from '../../../navigation';
import type {
  CodexSessionContextDetail,
  CodexSessionNewMessage,
  SaveCodexSessionContextRequest,
  SaveCodexSessionContextResult,
} from '../../../services/codexSessionState';

export type EditorNotice = { kind: 'success' | 'error'; message: string };
export type MessageEditState = { content: string; isEditing: boolean; isDeleted: boolean };
export type RoleFilter = 'all' | 'user' | 'assistant' | 'tool' | 'reasoning';

type Options = {
  sessionId: string;
  /** Closes the editor (called after a confirmed discard, or directly when nothing is unsaved). */
  onClose: () => void;
  /** Called after a successful save so the list can refresh. */
  onSessionUpdated?: () => void;
};

/**
 * State and handlers of the Codex session context editor: reads the rollout through `get_codex_session_context`
 * (shared pending read, so a double mount fetches once), tracks metadata + per-message edits, saves with
 * `save_codex_session_context` (expectedRolloutSha256 guard) and guards unsaved changes against close/navigation.
 */
export function useSessionContext({ sessionId, onClose, onSessionUpdated }: Options) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const [detail, setDetail] = useState<CodexSessionContextDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<EditorNotice | null>(null);

  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [modelProvider, setModelProvider] = useState('');
  const [archived, setArchived] = useState(false);

  const [messageEdits, setMessageEdits] = useState<Record<number, MessageEditState>>({});
  const [newMessages, setNewMessages] = useState<CodexSessionNewMessage[]>([]);
  const [addingMessage, setAddingMessage] = useState(false);
  const [newRole, setNewRole] = useState<'user' | 'assistant'>('user');
  const [newContent, setNewContent] = useState('');

  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);

  const mountedRef = useRef(true);
  const pendingReadRef = useRef<{ sessionId: string; promise: Promise<CodexSessionContextDetail> } | null>(null);
  const savingRef = useRef(false);
  const translateRef = useRef(t);
  translateRef.current = t;
  const pendingNavigationRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadContext = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setNotice(null);
      setLoadError(null);
    }
    const pending = pendingReadRef.current?.sessionId === sessionId
      ? pendingReadRef.current
      : { sessionId, promise: invoke<CodexSessionContextDetail>('get_codex_session_context', { request: { sessionId } }) };
    pendingReadRef.current = pending;
    try {
      const data = await pending.promise;
      if (!mountedRef.current || pendingReadRef.current !== pending) return false;
      setDetail(data);
      setTitle(data.title || '');
      setCwd(data.cwd || '');
      setModel(data.model || '');
      setModelProvider(data.modelProvider || '');
      setArchived(Boolean(data.archived));
      const initialEdits: Record<number, MessageEditState> = {};
      data.messages.forEach((msg) => {
        initialEdits[msg.lineNumber] = { content: msg.content, isEditing: false, isDeleted: false };
      });
      setMessageEdits(initialEdits);
      setNewMessages([]);
      setNewContent('');
      setAddingMessage(false);
      return true;
    } catch (error) {
      if (!mountedRef.current) return false;
      const message = translateRef.current('agents.sessions.context.loadFailed', {
        error: error instanceof Error ? error.message : String(error),
      });
      setNotice({ kind: 'error', message });
      if (!silent) setLoadError(message);
      return false;
    } finally {
      if (pendingReadRef.current === pending) pendingReadRef.current = null;
      if (!silent && mountedRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  const metadataDirty = useMemo(() => {
    if (!detail) return false;
    return title !== (detail.title || '')
      || cwd !== (detail.cwd || '')
      || model !== (detail.model || '')
      || modelProvider !== (detail.modelProvider || '')
      || archived !== Boolean(detail.archived);
  }, [detail, title, cwd, model, modelProvider, archived]);

  const messagesByLine = useMemo(() => new Map(detail?.messages.map((message) => [message.lineNumber, message])), [detail]);

  const draftPending = addingMessage && newContent.trim().length > 0;
  const structuredDirty = useMemo(() => {
    if (!detail) return false;
    if (newMessages.length > 0 || draftPending) return true;
    return Object.entries(messageEdits).some(([lineStr, edit]) => {
      const original = messagesByLine.get(Number(lineStr));
      if (!original) return true;
      return edit.isDeleted || edit.content !== original.content;
    });
  }, [detail, newMessages, messageEdits, messagesByLine, draftPending]);

  const isDirty = metadataDirty || structuredDirty;

  const changeCount = useMemo(() => {
    if (!detail) return 0;
    const metadata = [
      title !== (detail.title || ''), cwd !== (detail.cwd || ''), model !== (detail.model || ''),
      modelProvider !== (detail.modelProvider || ''), archived !== Boolean(detail.archived),
    ].filter(Boolean).length;
    const edited = Object.entries(messageEdits).filter(([lineStr, edit]) => {
      const original = messagesByLine.get(Number(lineStr));
      return Boolean(original) && (edit.isDeleted || edit.content !== original!.content);
    }).length;
    return metadata + edited + newMessages.length + (draftPending ? 1 : 0);
  }, [detail, title, cwd, model, modelProvider, archived, messageEdits, messagesByLine, newMessages, draftPending]);

  useEffect(() => {
    const guardNavigation = (event: Event) => {
      if (!isDirty && !savingRef.current) return;
      event.preventDefault();
      if (savingRef.current) return;
      pendingNavigationRef.current = (event as AppNavigationRequest).detail;
      setDiscardOpen(true);
    };
    const guardUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty && !savingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener(APP_NAVIGATION_REQUEST_EVENT, guardNavigation);
    window.addEventListener('beforeunload', guardUnload);
    return () => {
      window.removeEventListener(APP_NAVIGATION_REQUEST_EVENT, guardNavigation);
      window.removeEventListener('beforeunload', guardUnload);
    };
  }, [isDirty]);

  /** Close request from the panel (X, scrim, Esc): ask before discarding unsaved edits. */
  const requestClose = () => {
    if (savingRef.current) return;
    if (discardOpen) {
      setDiscardOpen(false);
    } else if (isDirty) {
      pendingNavigationRef.current = onClose;
      setDiscardOpen(true);
    } else {
      onClose();
    }
  };

  const confirmDiscard = () => {
    setDiscardOpen(false);
    (pendingNavigationRef.current ?? onClose)();
  };

  const save = async () => {
    if (!detail || !isDirty || loading || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setNotice(null);
    try {
      const payload: SaveCodexSessionContextRequest = {
        sessionId,
        expectedRolloutSha256: detail.rolloutSha256 || undefined,
      };
      if (title !== (detail.title || '')) payload.title = title;
      if (cwd !== (detail.cwd || '')) payload.cwd = cwd;
      if (model !== (detail.model || '')) payload.model = model;
      if (modelProvider !== (detail.modelProvider || '')) payload.modelProvider = modelProvider;
      if (archived !== Boolean(detail.archived)) payload.archived = archived;

      if (structuredDirty) {
        const messageUpdates = Object.entries(messageEdits)
          .map(([lineStr, edit]) => {
            const lineNumber = Number(lineStr);
            const original = messagesByLine.get(lineNumber);
            if (!original) return null;
            if (edit.isDeleted) return { lineNumber, deleted: true };
            const update: { lineNumber: number; content?: string } = { lineNumber };
            if (edit.content !== original.content) update.content = edit.content;
            return update.content !== undefined ? update : null;
          })
          .filter((item): item is NonNullable<typeof item> => item !== null);
        payload.messageUpdates = messageUpdates;
        const messagesToAppend = [...newMessages];
        if (draftPending) messagesToAppend.push({ role: newRole, content: newContent });
        if (messagesToAppend.length > 0) payload.newMessages = messagesToAppend;
      }

      const result = await invoke<SaveCodexSessionContextResult>('save_codex_session_context', { request: payload });
      if (!mountedRef.current) return;
      let successMessage = t('agents.sessions.context.saveSuccess');
      if (result.backupPath) successMessage += ' ' + t('agents.sessions.backupAt', { path: result.backupPath });
      onSessionUpdated?.();
      if (await loadContext(true)) setNotice({ kind: 'success', message: successMessage });
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setNotice({ kind: 'error', message: t('agents.sessions.context.saveFailed', { error: message }) });
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const exportJsonl = () => {
    const text = detail?.rawJsonl || '';
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-jsonlines;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `session-${sessionId}-${new Date().toISOString().slice(0, 10)}.jsonl`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const openRollout = async () => {
    setOpening(true);
    try {
      await invoke('open_codex_session_rollout', { request: { sessionId } });
    } catch (error) {
      setNotice({ kind: 'error', message: t('agents.sessions.context.openFailed', { error: String(error) }) });
    } finally {
      setOpening(false);
    }
  };

  const commitNewMessage = () => {
    if (!newContent.trim()) return;
    setNewMessages((prev) => [...prev, { role: newRole, content: newContent }]);
    setNewContent('');
    setAddingMessage(false);
  };

  const cancelNewMessage = () => {
    setAddingMessage(false);
    setNewContent('');
  };

  const updateEdit = (lineNumber: number, patch: Partial<MessageEditState>) => {
    setMessageEdits((prev) => {
      const current = prev[lineNumber];
      if (!current) return prev;
      return { ...prev, [lineNumber]: { ...current, ...patch } };
    });
  };

  /** Removing a tool record also removes every message sharing its call id (call + result). */
  const toggleDeleted = (lineNumber: number) => {
    const target = messagesByLine.get(lineNumber);
    if (!target) return;
    const nextDeleted = !messageEdits[lineNumber]?.isDeleted;
    setMessageEdits((prev) => {
      const next = { ...prev };
      for (const message of detail?.messages ?? []) {
        if (message.lineNumber === lineNumber
          || (target.role === 'tool' && target.callId && message.role === 'tool' && message.callId === target.callId)) {
          next[message.lineNumber] = { ...prev[message.lineNumber], isDeleted: nextDeleted };
        }
      }
      return next;
    });
  };

  const filteredMessages = useMemo(() => {
    if (!detail) return [];
    const query = searchQuery.trim().toLowerCase();
    return detail.messages.filter((msg) => {
      const content = (messageEdits[msg.lineNumber]?.content ?? msg.content);
      if (roleFilter !== 'all' && msg.role !== roleFilter) return false;
      if (query) return content.toLowerCase().includes(query) || msg.role.toLowerCase().includes(query);
      return true;
    });
  }, [detail, messageEdits, roleFilter, searchQuery]);

  return {
    loading, saving, opening, detail, loadError, notice, setNotice,
    title, setTitle, cwd, setCwd, model, setModel, modelProvider, setModelProvider, archived, setArchived,
    messageEdits, newMessages, setNewMessages, addingMessage, setAddingMessage, newRole, setNewRole, newContent, setNewContent,
    roleFilter, setRoleFilter, searchQuery, setSearchQuery, filteredMessages,
    isDirty, changeCount, discardOpen, setDiscardOpen,
    loadContext, requestClose, confirmDiscard, save, exportJsonl, openRollout,
    commitNewMessage, cancelNewMessage, updateEdit, toggleDeleted,
  };
}

export type SessionContextController = ReturnType<typeof useSessionContext>;
