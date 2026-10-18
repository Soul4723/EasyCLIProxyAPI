// Sign-in flow controller. Port of the OAuthLoginPage flow (ManagementPages.tsx) and of the plugin PluginOAuthDialog:
// snapshot credentials -> start_oauth_login -> poll get_oauth_status every 3s -> default priority 0 on new credentials
// -> success; refresh link, callback submit with the xAI/Devin validation, browser preference. One flow per provider;
// the dialog shows the active one. Behaviour matches the old page, only the surface changed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../../../services/documentTarget';
import { useI18n } from '../../../i18n';
import { useCoreRuntime } from '../../../coreRuntime';
import { providerInfo } from '../../../ui';
import {
  changedOAuthAuthFileNames,
  snapshotAuthFiles,
  type AuthFileSnapshot,
} from '../../../services/authFiles';
import { managementApi, responseList } from '../../../services/managementApi';
import { createOAuthLoginSuccessCache } from '../../../services/oauthLoginState';
import { getPluginTitle, notifyPluginResourcesChanged } from '../../../services/pluginResources';
import {
  BUILTIN_OAUTH_IDS,
  BUILTIN_OAUTH_PROVIDERS,
  NO_AUTO_OPEN_BROWSER_ID,
  OAUTH_BROWSER_STORAGE_KEY,
  OAUTH_POLL_INTERVAL_MS,
  PLUGIN_SESSION_MAX_MS,
  VERTEX_PROVIDER_ID,
  checkCallbackInput,
  isHttpUrl,
  loadOAuthBrowserPreference,
  openBrowserId,
  resolveOAuthBrowserSelection,
  type OAuthBrowserOption,
} from './logic';
import type {
  FlowState,
  OAuthSignInController,
  SignInDialogController,
  SignInFlowState,
  SignInProvider,
  SignInSession,
} from './types';
import { usePluginOAuthProviders } from './usePluginOAuthProviders';
import { SignInDialog } from './SignInDialog';
import { VertexImportDialog } from './VertexImportDialog';

type OAuthStartResult = {
  url: string;
  state?: string | null;
  userCode?: string | null;
  flow?: string | null;
  expiresIn?: number | null;
  opened: boolean;
  openError?: string | null;
};

type OAuthStatusResult = { status: string; error?: string | null };

export type UseOAuthSignInOptions = {
  /** Called after a sign-in or Vertex import saved a credential, so the page can reload its lists. */
  onSuccess?: (providerId: string) => void;
};

// Reserved so a plugin cannot shadow a built-in provider card.
const RESERVED_PROVIDER_IDS: readonly string[] = [...BUILTIN_OAUTH_IDS, VERTEX_PROVIDER_ID];

let loginSuccessCache = createOAuthLoginSuccessCache<string>();
let cacheRevision = 0;

const cachedStates = (): Record<string, FlowState> => Object.fromEntries(
  loginSuccessCache.snapshot().map((provider) => [provider, { status: 'success' } satisfies FlowState]),
);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useOAuthSignIn(options: UseOAuthSignInOptions = {}): OAuthSignInController {
  const { t } = useI18n();
  const { status: coreStatus, connectionRevision } = useCoreRuntime();
  if (cacheRevision !== connectionRevision) {
    loginSuccessCache = createOAuthLoginSuccessCache<string>();
    cacheRevision = connectionRevision;
  }
  const remote = coreStatus?.connectionMode === 'remote';

  const [states, setStates] = useState<Record<string, FlowState>>(cachedStates);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [browsers, setBrowsers] = useState<OAuthBrowserOption[]>([]);
  const [browsersLoading, setBrowsersLoading] = useState(true);
  const [selectedBrowser, setSelectedBrowser] = useState(loadOAuthBrowserPreference);
  const pluginProviders = usePluginOAuthProviders(RESERVED_PROVIDER_IDS);

  const statesRef = useRef(states);
  statesRef.current = states;
  const tRef = useRef(t);
  tRef.current = t;
  const onSuccessRef = useRef(options.onSuccess);
  onSuccessRef.current = options.onSuccess;
  const browserRef = useRef(selectedBrowser);
  browserRef.current = selectedBrowser;
  const remoteRef = useRef(remote);
  remoteRef.current = remote;

  const pollingTimers = useRef<Record<string, number>>({});
  const expiryTimers = useRef<Record<string, number>>({});
  const pollingRequests = useRef<Record<string, boolean>>({});
  const pollingSessions = useRef<Record<string, string>>({});
  const credentialSnapshots = useRef<Record<string, AuthFileSnapshot>>({});
  const attempts = useRef<Record<string, number>>({});
  const pluginSessions = useRef<Record<string, string>>({});

  const providers = useMemo<SignInProvider[]>(() => [
    ...BUILTIN_OAUTH_PROVIDERS.map((provider) => ({
      id: provider.id,
      brand: provider.id,
      name: providerInfo(provider.id).name,
      kind: 'oauth' as const,
      callbackSupported: provider.callback,
    })),
    {
      id: VERTEX_PROVIDER_ID,
      brand: VERTEX_PROVIDER_ID,
      name: providerInfo(VERTEX_PROVIDER_ID).name,
      kind: 'vertex' as const,
      callbackSupported: false,
    },
    ...pluginProviders.plugins.map((plugin) => ({
      id: plugin.oauthProvider!,
      brand: plugin.oauthProvider!,
      name: getPluginTitle(plugin),
      kind: 'plugin' as const,
      callbackSupported: true,
    })),
  ], [pluginProviders.plugins]);
  const providersRef = useRef(providers);
  providersRef.current = providers;

  useEffect(() => {
    let active = true;
    void invoke<OAuthBrowserOption[]>('list_oauth_browsers')
      .then((available) => {
        if (!active) return;
        setBrowsers(available);
        setSelectedBrowser((current) => resolveOAuthBrowserSelection(available, current));
      })
      .catch((error) => {
        if (!active) return;
        console.warn('Failed to detect installed browsers', error);
        const fallback = [{ id: 'default', label: 'System Default' }];
        setBrowsers(fallback);
        setSelectedBrowser((current) => resolveOAuthBrowserSelection(fallback, current));
      })
      .finally(() => {
        if (active) setBrowsersLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(OAUTH_BROWSER_STORAGE_KEY, selectedBrowser);
    } catch {
      // Storage is optional; the choice then only lasts for this session.
    }
  }, [selectedBrowser]);

  const updateState = useCallback((id: string, next: Partial<FlowState>) => {
    setStates((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { status: 'idle' as const }), ...next },
    }));
  }, []);

  const clearPolling = useCallback((id: string) => {
    const timer = pollingTimers.current[id];
    if (timer !== undefined) window.clearInterval(timer);
    const expiry = expiryTimers.current[id];
    if (expiry !== undefined) window.clearTimeout(expiry);
    delete pollingSessions.current[id];
    delete pollingTimers.current[id];
    delete expiryTimers.current[id];
    delete pollingRequests.current[id];
  }, []);

  const cancelSession = useCallback((state: string | undefined) => {
    if (!state) return;
    void managementApi.delete('/oauth/session', { query: { state } }).catch(() => {});
  }, []);

  const completeAuth = useCallback((id: string, priorityError = '') => {
    clearPolling(id);
    delete pluginSessions.current[id];
    loginSuccessCache.mark(id);
    updateState(id, {
      url: undefined,
      state: undefined,
      userCode: undefined,
      status: 'success',
      error: undefined,
      polling: false,
      device: undefined,
      expiresAt: undefined,
      callbackUrl: '',
      callbackSubmitting: false,
      callbackStatus: undefined,
      callbackError: undefined,
      notice: undefined,
      priorityError: priorityError || undefined,
    });
    // A flow that finished in the background brings its result back up.
    setActiveId((current) => current ?? id);
    notifyPluginResourcesChanged();
    onSuccessRef.current?.(id);
  }, [clearPolling, updateState]);

  const captureCredentialSnapshot = useCallback(async (id: string) => {
    const payload = await managementApi.get('/credentials');
    credentialSnapshots.current[id] = snapshotAuthFiles(responseList(payload, 'files'));
  }, []);

  const applyDefaultCredentialPriority = useCallback(async (id: string) => {
    const before = credentialSnapshots.current[id];
    delete credentialSnapshots.current[id];
    if (!before) return;
    const payload = await managementApi.get('/credentials');
    const names = changedOAuthAuthFileNames(before, responseList(payload, 'files'), id);
    await Promise.all(names.map((name) => managementApi.patch('/credentials/fields', { name, priority: 0 })));
  }, []);

  const failFlow = useCallback((id: string, message: string, plugin: boolean) => {
    const state = pollingSessions.current[id];
    clearPolling(id);
    updateState(id, { status: 'error', error: message, polling: false, callbackSubmitting: false });
    if (plugin) {
      delete pluginSessions.current[id];
      cancelSession(state);
    }
  }, [cancelSession, clearPolling, updateState]);

  const startPolling = useCallback((id: string, state: string, plugin: boolean) => {
    clearPolling(id);
    pollingSessions.current[id] = state;
    const isCurrent = () => pollingSessions.current[id] === state;
    const checkStatus = async () => {
      if (pollingRequests.current[id]) return;
      pollingRequests.current[id] = true;
      try {
        const result = await invoke<OAuthStatusResult>('get_oauth_status', { state });
        if (!isCurrent()) return;
        const status = (result.status || '').toLowerCase();
        if (status === 'ok') {
          let priorityError = '';
          if (!plugin) {
            try {
              await applyDefaultCredentialPriority(id);
            } catch (error) {
              priorityError = String(error);
            }
            if (!isCurrent()) return;
          }
          completeAuth(id, priorityError);
        } else if (status === 'error') {
          failFlow(id, result.error
            || tRef.current(plugin ? 'sec.providers.signin.error.pluginFailed' : 'sec.providers.signin.error.authFailed'), plugin);
        } else if (plugin && status !== 'wait') {
          failFlow(id, tRef.current('sec.providers.signin.error.pluginFailed'), true);
        }
      } catch (error) {
        if (!isCurrent()) return;
        failFlow(id, errorText(error), plugin);
      } finally {
        if (isCurrent()) delete pollingRequests.current[id];
      }
    };
    pollingTimers.current[id] = window.setInterval(() => void checkStatus(), OAUTH_POLL_INTERVAL_MS);
  }, [applyDefaultCredentialPriority, clearPolling, completeAuth, failFlow]);

  useEffect(() => () => {
    // Leaving the page stops polling; plugin sessions are cancelled like the old plugin dialog did on close.
    Object.values(pollingTimers.current).forEach((timer) => window.clearInterval(timer));
    Object.values(expiryTimers.current).forEach((timer) => window.clearTimeout(timer));
    Object.values(pluginSessions.current).forEach((state) => {
      void managementApi.delete('/oauth/session', { query: { state } }).catch(() => {});
    });
    pollingSessions.current = {};
    pluginSessions.current = {};
  }, []);

  const startLogin = useCallback(async (provider: SignInProvider) => {
    const id = provider.id;
    const plugin = provider.kind === 'plugin';
    const tt = tRef.current;
    const attempt = (attempts.current[id] ?? 0) + 1;
    attempts.current[id] = attempt;
    const isAttempt = () => attempts.current[id] === attempt;
    clearPolling(id);
    updateState(id, {
      url: undefined,
      state: undefined,
      userCode: undefined,
      status: 'waiting',
      polling: true,
      error: undefined,
      device: undefined,
      expiresAt: undefined,
      callbackUrl: '',
      callbackStatus: undefined,
      callbackError: undefined,
      callbackSubmitting: false,
      notice: undefined,
      priorityError: undefined,
    });

    try {
      if (!plugin) await captureCredentialSnapshot(id);
      // Remote cores never get an automatic local browser; plugin sessions are opened by the explicit button.
      const browser = plugin || remoteRef.current ? NO_AUTO_OPEN_BROWSER_ID : browserRef.current;
      const result = await invoke<OAuthStartResult>(
        'start_oauth_login',
        plugin ? { provider: id, browser, pluginProvider: true } : { provider: id, browser },
      );
      const returnedState = result.state?.trim() ?? '';
      if (!isAttempt()) {
        if (plugin) cancelSession(returnedState);
        return;
      }
      if (!returnedState) {
        delete credentialSnapshots.current[id];
        updateState(id, {
          url: result.url,
          state: undefined,
          status: 'error',
          error: tt('sec.providers.signin.error.missingState'),
          polling: false,
        });
        return;
      }
      if (plugin && !isHttpUrl(result.url)) {
        cancelSession(returnedState);
        updateState(id, { status: 'error', error: tt('sec.providers.signin.error.invalidUrl'), polling: false });
        return;
      }

      const device = plugin
        ? result.flow?.toLowerCase() === 'device' || Boolean(result.userCode)
        : undefined;
      const duration = typeof result.expiresIn === 'number' && Number.isFinite(result.expiresIn) && result.expiresIn > 0
        ? Math.min(result.expiresIn * 1000, PLUGIN_SESSION_MAX_MS) : PLUGIN_SESSION_MAX_MS;
      updateState(id, {
        url: result.url,
        state: returnedState,
        userCode: result.userCode?.trim() || undefined,
        status: 'waiting',
        polling: true,
        device,
        expiresAt: plugin ? Date.now() + duration : undefined,
        notice: !plugin && !result.opened && !remoteRef.current
          ? {
            tone: 'info',
            text: result.openError
              ? tt('sec.providers.signin.openFailedDetail', { error: result.openError })
              : tt('sec.providers.signin.openFailed'),
          }
          : undefined,
      });
      startPolling(id, returnedState, plugin);
      if (plugin) {
        pluginSessions.current[id] = returnedState;
        expiryTimers.current[id] = window.setTimeout(() => {
          if (pollingSessions.current[id] === returnedState) {
            failFlow(id, tRef.current('sec.providers.signin.error.expired'), true);
          }
        }, duration);
      }
    } catch (error) {
      delete credentialSnapshots.current[id];
      if (!isAttempt()) return;
      updateState(id, { status: 'error', error: errorText(error), polling: false });
    }
  }, [cancelSession, captureCredentialSnapshot, clearPolling, failFlow, startPolling, updateState]);

  const refreshLink = useCallback(async (provider: SignInProvider) => {
    const id = provider.id;
    const currentState = statesRef.current[id]?.state;
    clearPolling(id);
    updateState(id, { refreshing: true, notice: undefined });
    try {
      if (currentState) {
        await managementApi.delete('/oauth/session', { query: { state: currentState } });
      }
    } catch (error) {
      if (id === 'devin') {
        updateState(id, { refreshing: false, notice: { tone: 'error', text: String(error) } });
        if (currentState) startPolling(id, currentState, false);
        return;
      }
      console.warn('Failed to cancel the previous OAuth session before refreshing', error);
    }
    try {
      await startLogin(provider);
    } finally {
      updateState(id, { refreshing: false });
    }
  }, [clearPolling, startLogin, startPolling, updateState]);

  const openLink = useCallback(async (id: string) => {
    const url = statesRef.current[id]?.url;
    if (!url) return;
    try {
      await invoke('open_oauth_url', { url, browser: openBrowserId(browserRef.current) });
    } catch (error) {
      updateState(id, { notice: { tone: 'error', text: errorText(error) } });
    }
  }, [updateState]);

  const submitCallback = useCallback(async (provider: SignInProvider) => {
    const id = provider.id;
    const plugin = provider.kind === 'plugin';
    const current = statesRef.current[id];
    if (current?.callbackSubmitting) return;
    const tt = tRef.current;
    const check = checkCallbackInput(id, current?.callbackUrl ?? '', current?.state, plugin);
    if (!check.ok) {
      const xai = id === 'xai';
      const message = check.reason === 'empty'
        ? tt(xai ? 'sec.providers.signin.callback.emptyXai' : 'sec.providers.signin.callback.empty')
        : check.reason === 'state_mismatch'
          ? tt('sec.providers.signin.callback.stateMismatch')
          : tt(plugin
            ? 'sec.providers.signin.callback.invalidPlugin'
            : xai ? 'sec.providers.signin.callback.invalidXai' : 'sec.providers.signin.callback.invalid');
      updateState(id, { callbackStatus: 'error', callbackError: message });
      return;
    }
    const sessionState = current?.state;
    updateState(id, { callbackSubmitting: true, callbackStatus: undefined, callbackError: undefined });
    try {
      await invoke(
        'submit_oauth_callback',
        plugin
          ? { provider: id, redirectUrl: check.redirectUrl, pluginProvider: true }
          : { provider: id, redirectUrl: check.redirectUrl },
      );
      if (statesRef.current[id]?.state !== sessionState) return;
      updateState(id, { callbackSubmitting: false, callbackStatus: 'success' });
    } catch (error) {
      if (statesRef.current[id]?.state !== sessionState) return;
      updateState(id, { callbackSubmitting: false, callbackStatus: 'error', callbackError: errorText(error) });
    }
  }, [updateState]);

  const close = useCallback(() => {
    const id = activeId;
    setActiveId(null);
    if (!id) return;
    const provider = providersRef.current.find((item) => item.id === id);
    if (provider?.kind !== 'plugin') return; // built-in flows keep polling in the background
    const flow = statesRef.current[id];
    if (flow?.status === 'success') return;
    attempts.current[id] = (attempts.current[id] ?? 0) + 1;
    const state = pollingSessions.current[id] ?? flow?.state;
    clearPolling(id);
    delete pluginSessions.current[id];
    if (flow?.status === 'waiting') cancelSession(state);
    updateState(id, { status: 'idle', url: undefined, state: undefined, userCode: undefined, error: undefined, polling: false, expiresAt: undefined, device: undefined, callbackUrl: '', callbackStatus: undefined, callbackError: undefined, notice: undefined });
  }, [activeId, cancelSession, clearPolling, updateState]);

  // A plugin that is disabled or removed while its dialog is open takes the dialog with it.
  useEffect(() => {
    if (activeId && !providers.some((provider) => provider.id === activeId)) close();
  }, [activeId, close, providers]);

  const start = useCallback((providerId: string) => {
    const provider = providersRef.current.find((item) => item.id === providerId);
    if (!provider || provider.disabledReason) return;
    setActiveId(providerId);
    if (provider.kind === 'vertex') return;
    const current = statesRef.current[providerId];
    if (current?.polling && current.status === 'waiting') return;
    void startLogin(provider);
  }, [startLogin]);

  const flowState = useCallback((providerId: string): SignInFlowState => states[providerId]?.status ?? 'idle', [states]);

  const activeProvider = activeId ? providers.find((provider) => provider.id === activeId) ?? null : null;
  const session = useMemo<SignInSession | null>(() => {
    if (!activeProvider || activeProvider.kind === 'vertex') return null;
    const id = activeProvider.id;
    return {
      provider: activeProvider,
      flow: states[id] ?? { status: 'idle' },
      setCallbackUrl: (value) => updateState(id, { callbackUrl: value, callbackStatus: undefined, callbackError: undefined }),
      submitCallback: () => void submitCallback(activeProvider),
      refreshLink: () => void refreshLink(activeProvider),
      openLink: () => void openLink(id),
      restart: () => void startLogin(activeProvider),
      close,
    };
  }, [activeProvider, close, openLink, refreshLink, startLogin, states, submitCallback, updateState]);

  const handleVertexImported = useCallback(() => {
    loginSuccessCache.mark(VERTEX_PROVIDER_ID);
    updateState(VERTEX_PROVIDER_ID, { status: 'success' });
    onSuccessRef.current?.(VERTEX_PROVIDER_ID);
  }, [updateState]);

  const base: SignInDialogController = {
    providers,
    browsers,
    browsersLoading,
    selectedBrowser,
    setBrowser: setSelectedBrowser,
    start,
    activeProviderId: activeId,
    flowState,
    remote,
    pluginError: pluginProviders.error,
    reload: notifyPluginResourcesChanged,
    session,
  };
  const dialogs = (
    <>
      <SignInDialog controller={base} />
      <VertexImportDialog
        open={activeId === VERTEX_PROVIDER_ID}
        onClose={() => setActiveId(null)}
        onImported={handleVertexImported}
      />
    </>
  );
  return { ...base, dialogs };
}
