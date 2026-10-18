import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke as invokeNative } from '../../services/platform';
import { listen } from '../../services/platform';
import { open } from '../../services/platform';
import { useCoreTargetRevision } from '../../coreRuntime';
import { getCurrentLocale, translate, useI18n } from '../../i18n';
import {
  CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS,
  followClaudeCodeContextWindow,
} from '../../services/claudeCodeModels';
import {
  filterAgentModelsByAlias,
  findAgentModel,
  resolveAgentModelForAliasMode,
  resolveAgentModelSelection,
} from '../../services/agentModelPicker';
import {
  resolveAgentModelMappingsDraftSourceForClient,
  sameAgentModelMappings,
} from '../../services/agentConfigurationDraft';
import {
  rememberAgentLaunchDirectory,
} from '../../services/agentLaunchDirectoryHistory';
import {
  buildDeepSeekHarnessLaunchOptions,
  DEFAULT_DEEPSEEK_HARNESS_LAUNCH_DRAFT,
  type DeepSeekHarnessLaunchDraft,
  type DeepSeekHarnessLaunchOptions,
} from '../../services/deepSeekHarnessLaunch';
import type { ModelOption } from '../../services/modelService';
import {
  createDefaultDesktopModels,
  desktopModelEntries,
  desktopModelValidation,
  selectedDesktopModelEntries,
  suffixCollidingDesktopAliases,
  type ClaudeDesktopModelMapping,
} from '../../services/claudeDesktopModels';
import {
  agentDefinitions,
  agentModelsCache,
  claudeMappingRoles,
  CODEX_OAUTH_LOGIN_REQUIRED_ERROR,
  copilotSetupErrorKey,
  createClaudeBooleanByClient,
  createClaudeModelMappings,
  createClaudeModelMappingsByClient,
  DEFAULT_AGENT_VIEW_STATE,
  DEFAULT_CLAUDE_AUTO_COMPACT_PCT,
  readAgentExecutablePaths,
  readAgentLaunchDirectoryHistory,
  readAgentModelSelections,
  sameAgentFormValues,
  writeAgentExecutablePaths,
  writeAgentLaunchDirectoryHistory,
  writeAgentModelSelections,
  type AgentClientId,
  type AgentConfigActionResult,
  type AgentConfigStatus,
  type AgentFormValues,
  type AgentLaunchTarget,
  type AgentViewState,
  type ClaudeModelMappingClientId,
  type ClaudeModelMappings,
  type DeepSeekHarnessProcessStatus,
  type OAuthLoginRequiredAction,
  type PiProviderUpdateStatus,
} from './model';

// Module caches survive section visits; the target revision (core connection) invalidates them.
let claudeModelMappingsDraftCache = createClaudeModelMappingsByClient();
let claudeCustomMappingCache = createClaudeBooleanByClient();
const claudeModelMappingsDirtyCache = createClaudeBooleanByClient();
let codexOauthConfigurationDraftCache: boolean | null = null;
let agentFormEditBaselineCache: Partial<Record<AgentClientId, AgentFormValues>> = {};
let agentViewStateCache: Partial<Record<AgentClientId, AgentViewState>> = {};
// Keep the last successful data across page visits; revalidate it in the background.
let agentCacheRevision = 0;
let agentStatusesCache: AgentConfigStatus[] | null = null;
// A Codex daemon restart outlives page visits; a remounted page waits on it instead of starting another.
let codexCliServiceRestart: Promise<void> | null = null;

export type AgentBusyAction =
  | 'backup' | 'apply' | 'close-config' | 'default' | 'clear' | 'install-pi' | 'update-pi' | 'repair-pi'
  | 'uninstall-pi' | 'oauth-check' | 'native-oauth' | 'directory' | 'launch' | 'launch-cli' | 'launch-app'
  | 'restart-app' | 'stop-deepseek' | 'restart-deepseek';

export function useAgentsController(clientId: AgentClientId | null, options: { onOpenManage?: () => void } = {}) {
  const selected: AgentClientId = clientId ?? agentDefinitions[0].id;
  const detailOpen = clientId !== null;
  const { t } = useI18n();
  const targetRevision = useCoreTargetRevision();
  // App remounts the page on target changes, but module caches survive page visits.
  if (agentCacheRevision !== targetRevision) {
    agentCacheRevision = targetRevision;
    agentStatusesCache = null;
    agentViewStateCache = {};
    agentFormEditBaselineCache = {};
    claudeModelMappingsDraftCache = createClaudeModelMappingsByClient();
    claudeCustomMappingCache = createClaudeBooleanByClient();
    Object.assign(claudeModelMappingsDirtyCache, createClaudeBooleanByClient());
    codexOauthConfigurationDraftCache = null;
    for (const client of Object.keys(agentModelsCache) as AgentClientId[]) delete agentModelsCache[client];
  }
  const currentTarget = useRef(true);
  useEffect(() => {
    currentTarget.current = true;
    return () => { currentTarget.current = false; };
  }, []);
  // A completed command must not start follow-up work on a newly selected target.
  const invoke = useCallback(async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (!currentTarget.current) throw new Error('The core connection changed; agent operation cancelled');
    const result = await invokeNative<T>(command, args);
    if (!currentTarget.current) throw new Error('The core connection changed; agent operation cancelled');
    return result;
  }, []);
  const [viewStateByClient, setViewStateByClient] = useState(() => agentViewStateCache);
  const viewState = viewStateByClient[selected] ?? DEFAULT_AGENT_VIEW_STATE;
  const updateViewStateForClient = (client: AgentClientId, patch: Partial<AgentViewState>) => {
    if (!currentTarget.current) return;
    setViewStateByClient((current) => {
      const next = {
        ...current,
        [client]: { ...(current[client] ?? DEFAULT_AGENT_VIEW_STATE), ...patch },
      };
      agentViewStateCache = next;
      return next;
    });
  };
  const updateViewState = (patch: Partial<AgentViewState>) => updateViewStateForClient(selected, patch);
  const { connectionHelpOpen, configurationError, configurationNotice, clearNotice, launchError } = viewState;
  const setConfigurationError = (configurationError: string) => updateViewState({ configurationError });
  const setConfigurationNotice = (configurationNotice: string) => updateViewState({ configurationNotice });
  const setClearNotice = (clearNotice: string) => updateViewState({ clearNotice });
  const setLaunchError = (launchError: string) => updateViewState({ launchError });
  const [statuses, setStatuses] = useState<AgentConfigStatus[]>(() => agentStatusesCache ?? []);
  const [executablePaths, setExecutablePaths] = useState(() => readAgentExecutablePaths());
  const [modelData, setModelData] = useState(() => ({
    client: selected, models: agentModelsCache[selected] ?? [],
  }));
  const models = modelData.client === selected ? modelData.models : agentModelsCache[selected] ?? [];
  const [modelByClient, setModelByClient] = useState<Partial<Record<AgentClientId, string>>>(
    readAgentModelSelections,
  );
  const [formEditBaselineByClient, setFormEditBaselineByClient] = useState(
    () => ({ ...agentFormEditBaselineCache }),
  );
  const [claudeModelMappingsDraftByClient, setClaudeModelMappingsDraftByClientState] = useState(
    () => ({
      'claude-code': { ...claudeModelMappingsDraftCache['claude-code'] },
      'claude-desktop': { ...claudeModelMappingsDraftCache['claude-desktop'] },
    }),
  );
  const [claudeCustomMappingByClient, setClaudeCustomMappingByClientState] = useState(
    () => ({ ...claudeCustomMappingCache }),
  );
  const [loading, setLoading] = useState(() => agentStatusesCache === null);
  const [modelLoading, setModelLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<AgentBusyAction | null>(null);
  const busy = busyAction !== null;
  // Codex drains running turns before restarting its daemon, which can take about a minute, so the
  // restart only locks its own controls instead of the page-wide busy state.
  const [cliServiceRestarting, setCliServiceRestarting] = useState(() => codexCliServiceRestart !== null);
  const [cliRestartConfirm, setCliRestartConfirm] = useState<((confirmed: boolean) => void) | null>(null);
  const askCliRestartConfirmation = () => new Promise<boolean>((resolve) => setCliRestartConfirm(() => resolve));
  const answerCliRestartConfirmation = (confirmed: boolean) => { cliRestartConfirm?.(confirmed); setCliRestartConfirm(null); };
  const [detectionError, setDetectionError] = useState('');
  const [modelError, setModelError] = useState('');
  const [modelSelectionError, setModelSelectionError] = useState('');
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [defaultError, setDefaultError] = useState('');
  const [templatePreview, setTemplatePreview] = useState<{ revision: string; files: string[] } | null>(null);
  const [defaultConfirmOpen, setDefaultConfirmOpen] = useState(false);
  const [clearError, setClearError] = useState('');
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [launchDirectoryDialogOpen, setLaunchDirectoryDialogOpen] = useState(false);
  const [codexCatalogDialogOpen, setCodexCatalogDialogOpen] = useState(false);
  const [harnessCatalogDialogOpen, setHarnessCatalogDialogOpen] = useState(false);
  const [desktopHelpOpen, setDesktopHelpOpen] = useState(false);
  const [launchDirectory, setLaunchDirectory] = useState('');
  const [launchDirectoryTarget, setLaunchDirectoryTarget] = useState<AgentLaunchTarget | null>(null);
  const [launchDirectoryError, setLaunchDirectoryError] = useState('');
  const [deepSeekHarnessLaunchDraft, setDeepSeekHarnessLaunchDraft] = useState<DeepSeekHarnessLaunchDraft>(
    () => ({ ...DEFAULT_DEEPSEEK_HARNESS_LAUNCH_DRAFT }),
  );
  const [deepSeekHarnessProcessStatus, setDeepSeekHarnessProcessStatus] = useState<DeepSeekHarnessProcessStatus>({
    running: false,
    pid: null,
    mode: null,
  });
  const [launchDirectoryHistory, setLaunchDirectoryHistory] = useState(
    readAgentLaunchDirectoryHistory,
  );
  const [oauthLoginRequiredAction, setOauthLoginRequiredAction] = useState<OAuthLoginRequiredAction | null>(null);
  const [oauthConfigurationDraft, setOauthConfigurationDraftState] = useState<boolean | null>(
    () => codexOauthConfigurationDraftCache,
  );
  const [piProviderUpdateStatus, setPiProviderUpdateStatus] = useState<PiProviderUpdateStatus | null>(null);
  const modelRequestRef = useRef(0);
  const statusRequestRef = useRef(0);
  const piUpdateRequestRef = useRef(0);
  const claudeModelMappingsDirtyRef = useRef(claudeModelMappingsDirtyCache);
  const setClaudeModelMappingsDraftByClient = useCallback((
    update: (
      current: Record<ClaudeModelMappingClientId, ClaudeModelMappings>,
    ) => Record<ClaudeModelMappingClientId, ClaudeModelMappings>,
  ) => {
    setClaudeModelMappingsDraftByClientState((current) => {
      const next = update(current);
      claudeModelMappingsDraftCache = next;
      return next;
    });
  }, []);

  const setClaudeCustomMappingByClient = useCallback((
    update: (
      current: Record<ClaudeModelMappingClientId, boolean>,
    ) => Record<ClaudeModelMappingClientId, boolean>,
  ) => {
    setClaudeCustomMappingByClientState((current) => {
      const next = update(current);
      claudeCustomMappingCache = next;
      return next;
    });
  }, []);

  const setOauthConfigurationDraft = useCallback((value: boolean | null) => {
    codexOauthConfigurationDraftCache = value;
    setOauthConfigurationDraftState(value);
  }, []);

  const loadStatuses = useCallback(async (forceRefresh = false) => {
    const requestId = ++statusRequestRef.current;
    const command = forceRefresh
      ? 'refresh_agent_config_statuses'
      : 'get_agent_config_statuses';
    const nextStatuses = await invoke<AgentConfigStatus[]>(command, { executableOverrides: executablePaths });
    if (requestId !== statusRequestRef.current) return;
    setStatuses(nextStatuses);
  }, [executablePaths]);

  useEffect(() => {
    if (statuses.length && agentCacheRevision === targetRevision) agentStatusesCache = statuses;
  }, [statuses, targetRevision]);

  useEffect(() => () => {
    // Responses from a previous visit must not overwrite the shared cache.
    modelRequestRef.current += 1;
    statusRequestRef.current += 1;
  }, []);

  const loadDeepSeekHarnessProcessStatus = useCallback(async () => {
    const status = await invoke<DeepSeekHarnessProcessStatus>('get_deepseek_harness_process_status');
    setDeepSeekHarnessProcessStatus(status);
  }, []);

  const loadModels = useCallback(async (client: AgentClientId, preferredModel = '', background = false) => {
    const requestId = modelRequestRef.current + 1;
    modelRequestRef.current = requestId;
    setModelLoading(!background || agentModelsCache[client] === undefined);
    setModelError('');
    try {
      const nextModels = await invoke<ModelOption[]>('get_agent_models', { client });
      if (modelRequestRef.current !== requestId) return;
      agentModelsCache[client] = nextModels;
      setModelData({ client, models: nextModels });
      setModelSelectionError('');
      setModelByClient((current) => {
        const next = {
          ...current,
          [client]: resolveAgentModelSelection(nextModels, current[client] || preferredModel),
        };
        writeAgentModelSelections(next);
        return next;
      });
    } catch (requestError) {
      if (modelRequestRef.current === requestId) setModelError(String(requestError));
    } finally {
      if (modelRequestRef.current === requestId) setModelLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setDetectionError('');
    try {
      await loadStatuses(true);
    } catch (requestError) {
      setDetectionError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, [loadStatuses]);

  useEffect(() => {
    setLoading(agentStatusesCache === null);
    setDetectionError('');
    void loadStatuses()
      .catch((requestError) => setDetectionError(String(requestError)))
      .finally(() => setLoading(false));
  }, [loadStatuses]);

  useEffect(() => {
    if (loading || !detailOpen) return;
    const status = statuses.find((status) => status.id === selected);
    const preferredModel = status?.currentModel ?? '';
    void loadModels(selected, preferredModel, true);
  }, [detailOpen, loadModels, loading, selected]);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void listen('config-files-changed', () => {
      if (disposed) return;
      setDetectionError('');
      void loadStatuses().catch((requestError) => {
        if (!disposed) setDetectionError(String(requestError));
      });
      if (detailOpen) void loadModels(selected, '', true);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [detailOpen, loadModels, loadStatuses, selected]);

  useEffect(() => {
    if (detailOpen && selected !== 'deepseek-harness') return undefined;
    let disposed = false;
    const refreshProcessStatus = () => {
      void loadDeepSeekHarnessProcessStatus().catch((requestError) => {
        if (!disposed) setLaunchError(String(requestError));
      });
    };
    refreshProcessStatus();
    const timer = window.setInterval(refreshProcessStatus, 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [detailOpen, loadDeepSeekHarnessProcessStatus, selected]);

  useEffect(() => {
    setModelSelectionError('');
    setBackupsOpen(false);
    setDefaultError('');
    setDefaultConfirmOpen(false);
    setClearError('');
    setClearConfirmOpen(false);
    setCodexCatalogDialogOpen(false);
    setDesktopHelpOpen(false);
    setLaunchDirectoryDialogOpen(false);
    setLaunchDirectoryTarget(null);
    setLaunchDirectoryError('');
    setOauthLoginRequiredAction(null);
  }, [selected]);

  const activeDefinition = agentDefinitions.find((agent) => agent.id === selected)
    ?? agentDefinitions[0];
  const activeStatus = statuses.find((status) => status.id === selected) ?? null;
  const nativeOauth = selected === 'codex' && Boolean(activeStatus?.codexNativeOauth);
  const oauthConfiguration = oauthConfigurationDraft
    ?? activeStatus?.oauthConfiguration
    ?? false;
  const savedSelectedModel = modelByClient[selected] ?? '';
  const selectedModelOption = findAgentModel(models, savedSelectedModel);
  const selectedModel = selectedModelOption?.name ?? '';
  const missingModelHint = !modelLoading && savedSelectedModel && !selectedModelOption
    ? t('agents.error.selectionGone') : '';
  const isPiClient = selected === 'pi';
  const isDeepSeekHarnessClient = selected === 'deepseek-harness';
  const hasIndependentCliAndApp = selected === 'codex' || selected === 'opencode' || isDeepSeekHarnessClient;
  const isClaudeModelMappingClient = selected === 'claude-code' || selected === 'claude-desktop';
  const claudeModelMappingsDraft = isClaudeModelMappingClient
    ? claudeModelMappingsDraftByClient[selected]
    : createClaudeModelMappings();
  const claudeCustomMapping = isClaudeModelMappingClient
    ? claudeCustomMappingByClient[selected]
    : false;
  const claudeMappingModels = useMemo(
    () => filterAgentModelsByAlias(models, claudeCustomMapping),
    [claudeCustomMapping, models],
  );
  const desktopEntries = claudeModelMappingsDraft.desktopModels ?? desktopModelEntries(claudeModelMappingsDraft);
  const appliedDesktopEntries = activeStatus?.claudeDesktopModelMappings
    ? desktopModelEntries(activeStatus.claudeDesktopModelMappings) : [];
  const resolvedDesktopEntries = suffixCollidingDesktopAliases(desktopEntries, models, appliedDesktopEntries);
  const desktopValidation = desktopModelValidation(resolvedDesktopEntries, models, appliedDesktopEntries);

  const loadPiProviderUpdateStatus = useCallback(async () => {
    const requestId = piUpdateRequestRef.current + 1;
    piUpdateRequestRef.current = requestId;
    try {
      const nextStatus = await invoke<PiProviderUpdateStatus>('check_pi_provider_update');
      if (piUpdateRequestRef.current === requestId) setPiProviderUpdateStatus(nextStatus);
    } catch {
      if (piUpdateRequestRef.current === requestId) setPiProviderUpdateStatus(null);
    }
  }, []);

  useEffect(() => {
    if (!isPiClient || !activeStatus?.pluginInstalled || !activeStatus.pluginVersion) {
      piUpdateRequestRef.current += 1;
      setPiProviderUpdateStatus(null);
      return;
    }
    void loadPiProviderUpdateStatus();
  }, [activeStatus?.pluginInstalled, activeStatus?.pluginVersion, isPiClient, loadPiProviderUpdateStatus]);

  const piPluginUpdateAvailable = Boolean(
    piProviderUpdateStatus?.updateAvailable
      && piProviderUpdateStatus.installedVersion === activeStatus?.pluginVersion
      && piProviderUpdateStatus.latestVersion,
  );
  const piPluginUpdateTitle = piPluginUpdateAvailable
    ? t('agents.pi.updateAvailable', { version: piProviderUpdateStatus?.latestVersion ?? '' })
    : activeStatus?.pluginVersion ?? undefined;

  useEffect(() => {
    if (!isClaudeModelMappingClient) return;
    const appliedMappings = selected === 'claude-code'
      ? activeStatus?.claudeCodeModelMappings
      : activeStatus?.claudeDesktopModelMappings;
    const dirty = claudeModelMappingsDirtyRef.current[selected];
    if (!dirty && selected === 'claude-code' && models.length > 0) {
      const appliedModels = appliedMappings
        ? claudeMappingRoles
            .map((role) => findAgentModel(models, appliedMappings[role.key]))
            .filter((model): model is ModelOption => model !== null)
        : [];
      setClaudeCustomMappingByClient((current) => ({
        ...current,
        [selected]: appliedModels.length === claudeMappingRoles.length
          && appliedModels.every((model) => Boolean(model.isAlias)),
      }));
    }
    if (!dirty && selected === 'claude-desktop' && models.length > 0 && appliedMappings) {
      const appliedEntries = desktopModelEntries(appliedMappings).filter((entry) => entry.model.trim());
      const appliedModels = appliedEntries
        .map((entry) => findAgentModel(models, entry.model))
        .filter((model): model is ModelOption => model !== null);
      if (appliedModels.length > 0 && appliedModels.length === appliedEntries.length) {
        setClaudeCustomMappingByClient((current) => ({
          ...current,
          [selected]: appliedModels.every((model) => Boolean(model.isAlias)),
        }));
      }
    }
    setClaudeModelMappingsDraftByClient((current) => {
      const currentClientDraft = current[selected];
      const source = resolveAgentModelMappingsDraftSourceForClient(
        current,
        selected,
        appliedMappings,
        createClaudeModelMappings(),
        dirty,
      );
      const next: ClaudeModelMappings = {
        ...(selected === 'claude-desktop' ? { desktopModels: dirty && source.desktopModels
          ? source.desktopModels : appliedMappings ? desktopModelEntries(source) : createDefaultDesktopModels() } : {}),
        opus: findAgentModel(models, source.opus)?.name ?? '',
        sonnet: findAgentModel(models, source.sonnet)?.name ?? '',
        haiku: findAgentModel(models, source.haiku)?.name ?? '',
        opus1m: Boolean(source.opus1m),
        sonnet1m: Boolean(source.sonnet1m),
        haiku1m: Boolean(source.haiku1m),
        fable: findAgentModel(models, source.fable)?.name ?? '',
        fable1m: Boolean(source.fable1m),
        maxContextTokens: source.maxContextTokens ?? CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS,
        autoCompactPct: source.autoCompactPct ?? DEFAULT_CLAUDE_AUTO_COMPACT_PCT,
        disableAutoCompact: Boolean(source.disableAutoCompact),
        manageDefaultModel: source.manageDefaultModel !== false,
        manageSubagentModel: source.manageSubagentModel !== false,
        startupModel: source.startupModel?.trim() || 'opus',
        subagentModel: source.subagentModel ?? '',
      };
      return sameAgentModelMappings(currentClientDraft, next)
        ? current
        : { ...current, [selected]: next };
    });
  }, [
    activeStatus?.claudeCodeModelMappings,
    activeStatus?.claudeDesktopModelMappings,
    isClaudeModelMappingClient,
    models,
    selected,
  ]);

  const connectionState = activeStatus?.connectionState ?? 'invalid';
  const appliedModel = activeStatus?.currentModel ?? activeStatus?.appliedModel ?? '';
  const canCloseConfiguration = !isPiClient && !nativeOauth
    && (connectionState === 'configured' || (selected !== 'codex' && connectionState === 'needs-update'));
  const configurationActionLabel = t(nativeOauth ? 'agents.modify.update'
    : connectionState === 'not-configured' ? selected === 'codex' ? 'agents.modify.apply' : 'agents.modify.connect'
    : connectionState === 'needs-update' ? 'agents.modify.repair' : 'agents.modify.update');
  const configurationWriteBlocked = loading || !activeStatus || connectionState === 'invalid';
  const formValues: AgentFormValues = {
    model: isClaudeModelMappingClient ? '' : selectedModel,
    oauthConfiguration: selected === 'codex' && oauthConfiguration,
    mappings: isClaudeModelMappingClient ? claudeModelMappingsDraft : null,
  };
  const hasPendingChanges = Boolean(formEditBaselineByClient[selected]);

  const trackFormEdit = (nextValues: AgentFormValues) => {
    setConfigurationNotice('');
    setClearNotice('');
    setFormEditBaselineByClient((current) => {
      const baseline = current[selected] ?? formValues;
      const next = { ...current };
      if (sameAgentFormValues(baseline, nextValues)) delete next[selected];
      else next[selected] = baseline;
      agentFormEditBaselineCache = next;
      return next;
    });
  };

  const clearPendingChanges = () => {
    setFormEditBaselineByClient((current) => {
      const next = { ...current };
      delete next[selected];
      agentFormEditBaselineCache = next;
      return next;
    });
  };
  const claudeMappingsReady = !isClaudeModelMappingClient
    || (selected === 'claude-desktop' ? !desktopValidation : claudeMappingRoles.every((role) =>
      Boolean(findAgentModel(models, claudeModelMappingsDraft[role.key])),
    ));
  const claudeCodeRuntimeSettingsReady = selected !== 'claude-code' || (
    claudeModelMappingsDraft.maxContextTokens >= 100_000
    && claudeModelMappingsDraft.maxContextTokens <= 1_000_000
    && claudeModelMappingsDraft.autoCompactPct >= 1
    && claudeModelMappingsDraft.autoCompactPct <= 100
  );
  const canConfigureActiveClient = Boolean(
    activeStatus?.supportedPlatform
      && (activeStatus.installed || activeStatus.configExists),
  );
  const canEnable = Boolean(
    canConfigureActiveClient
      && !modelLoading
      && (isClaudeModelMappingClient
        ? claudeMappingsReady && claudeCodeRuntimeSettingsReady
        : selectedModelOption),
  );
  const activeLaunchTargets = activeStatus?.launchTargets ?? [];
  const launchEnabled = Boolean(
    activeStatus?.supportedPlatform
      && activeStatus.installed,
  );
  const activeLaunchDirectoryHistory = launchDirectoryHistory[selected] ?? [];
  const deepSeekHarnessLaunchModeLabel = {
    web: t('agents.deepseekLaunch.mode.web'),
    headless: t('agents.deepseekLaunch.mode.headless'),
    acp: t('agents.deepseekLaunch.mode.acp'),
    sdk: t('agents.deepseekLaunch.mode.sdk'),
    'sdk-minimal': t('agents.deepseekLaunch.mode.sdkMinimal'),
    custom: t('agents.deepseekLaunch.mode.custom'),
  }[deepSeekHarnessLaunchDraft.mode];
  const deepSeekHarnessLaunchModeDescription = {
    web: t('agents.deepseekLaunch.mode.webDescription'),
    headless: t('agents.deepseekLaunch.mode.headlessDescription'),
    acp: t('agents.deepseekLaunch.mode.acpDescription'),
    sdk: t('agents.deepseekLaunch.mode.sdkDescription'),
    'sdk-minimal': t('agents.deepseekLaunch.mode.sdkMinimalDescription'),
    custom: t('agents.deepseekLaunch.mode.customDescription'),
  }[deepSeekHarnessLaunchDraft.mode];
  const modelHint = (modelLoading
      ? t('agents.model.readingAvailable')
      : models.length === 0
        ? ''
        : activeStatus?.modificationState === 'applied'
          ? t('agents.model.current', { model: appliedModel || '—' })
          : t('agents.model.firstSelection', { count: models.length }));
  const modificationDescription = activeStatus?.modificationState === 'invalid'
    ? t('agents.modify.invalid')
    : nativeOauth ? t('agents.nativeOAuth.activeHint')
    : selected === 'copilot-cli' ? t('agents.modify.copilotCliHint')
    : selected === 'vscode-copilot' ? t('agents.modify.vscodeCopilotHint')
    : selected === 'antigravity-cli' ? t('agents.modify.antigravityCliHint')
    : selected === 'workbuddy'
      ? t('agents.modify.workbuddyHint')
    : selected === 'zcode'
      ? t('agents.modify.zcodeRestart')
      : '';
  const refreshModels = () => {
    void loadModels(selected);
  };

  const applySelectedConfiguration = () => {
    if (isPiClient) {
      void (activeStatus?.pluginInstalled ? repairPiProvider() : installPiProvider());
      return;
    }
    void applyConfigurationChanges();
  };

  const reloadStatusesAfterAction = async () => {
    setDetectionError('');
    try {
      await loadStatuses(true);
    } catch (requestError) {
      setDetectionError(String(requestError));
    }
  };

  const selectModel = (value: string) => {
    setConfigurationNotice('');
    setClearNotice('');
    const model = findAgentModel(models, value);
    if (!model) return;
    if (!isClaudeModelMappingClient) trackFormEdit({ ...formValues, model: model.name });
    setModelSelectionError('');
    setModelByClient((current) => {
      const next = { ...current, [selected]: model.name };
      writeAgentModelSelections(next);
      return next;
    });
  };

  const editClaudeModelMappings = (update: (current: ClaudeModelMappings) => ClaudeModelMappings) => {
    if (!isClaudeModelMappingClient) return;
    const next = update(claudeModelMappingsDraft);
    trackFormEdit({ ...formValues, mappings: next });
    if (!sameAgentModelMappings(claudeModelMappingsDraft, next)) {
      claudeModelMappingsDirtyRef.current[selected] = true;
    }
    setClaudeModelMappingsDraftByClient((current) => ({ ...current, [selected]: next }));
  };

  const selectEmbeddedModel = (value: string) => {
    const model = findAgentModel(models, value);
    if (!model) return;
    if (isClaudeModelMappingClient) {
      editClaudeModelMappings((current) => ({ ...current, sonnet: model.name }));
    }
    selectModel(model.name);
  };

  const selectClaudeModelMapping = (
    role: 'opus' | 'sonnet' | 'haiku' | 'fable',
    value: string,
  ) => {
    const model = findAgentModel(models, value);
    if (!model || !isClaudeModelMappingClient) return;
    setModelSelectionError('');
    editClaudeModelMappings((current) => followClaudeCodeContextWindow(
      { ...current, [role]: model.name }, current.maxContextTokens, selected === 'claude-code',
    ));
  };

  const changeClaude1mPreference = (
    preference: 'opus1m' | 'sonnet1m' | 'haiku1m' | 'fable1m',
    enabled: boolean,
  ) => {
    if (!isClaudeModelMappingClient) return;
    editClaudeModelMappings((current) => followClaudeCodeContextWindow(
      { ...current, [preference]: enabled }, current.maxContextTokens, selected === 'claude-code',
    ));
  };

  const changeClaudeCodeRuntimeSetting = (
    key: 'maxContextTokens' | 'autoCompactPct',
    value: number,
  ) => {
    if (selected !== 'claude-code') return;
    editClaudeModelMappings((current) => ({ ...current, [key]: value }));
  };

  const changeClaudeCodeAutoCompactDisabled = (disabled: boolean) => {
    if (selected !== 'claude-code') return;
    editClaudeModelMappings((current) => ({ ...current, disableAutoCompact: disabled }));
  };

  const changeClaudeCustomMapping = (enabled: boolean) => {
    if (!isClaudeModelMappingClient) return;
    setClaudeCustomMappingByClient((current) => ({ ...current, [selected]: enabled }));
    setModelSelectionError('');
    if (selected !== 'claude-code') return;
    editClaudeModelMappings((current) => ({
      ...current,
      opus: resolveAgentModelForAliasMode(models, current.opus, enabled),
      sonnet: resolveAgentModelForAliasMode(models, current.sonnet, enabled),
      haiku: resolveAgentModelForAliasMode(models, current.haiku, enabled),
    }));
  };

  const requireSelectedModel = () => {
    if (modelLoading) {
      setModelSelectionError(t('agents.error.modelsLoading'));
      return null;
    }
    if (models.length === 0) {
      setModelSelectionError(modelError || t('agents.error.noModels'));
      return null;
    }
    const model = findAgentModel(models, selectedModel);
    if (!model) {
      setModelSelectionError(t('agents.error.selectionGone'));
      return null;
    }
    setModelSelectionError('');
    return model.name;
  };

  const requireClaudeModelMappings = (): ClaudeModelMappings | null => {
    if (!isClaudeModelMappingClient) return null;
    if (selected === 'claude-desktop') {
      if (desktopValidation) {
        setModelSelectionError(t(`agents.claudeDesktopMapping.error.${desktopValidation}`));
        return null;
      }
      const selectedEntries = selectedDesktopModelEntries(resolvedDesktopEntries);
      return { ...createClaudeModelMappings(), sonnet: selectedEntries[0].model.trim(),
        desktopModels: selectedEntries.map((entry) => ({ ...entry, model: entry.model.trim(), alias: entry.alias.trim() })) };
    }
    const resolved = {} as ClaudeModelMappings;
    for (const role of claudeMappingRoles) {
      const model = findAgentModel(models, claudeModelMappingsDraft[role.key]);
      if (!model) {
        setModelSelectionError(t('agents.error.mappingSelectionGone'));
        return null;
      }
      resolved[role.key] = model.name;
      resolved[role.contextKey] = claudeModelMappingsDraft[role.contextKey];
    }
    if (selected === 'claude-code') {
      if (!claudeCodeRuntimeSettingsReady) {
        setModelSelectionError(t('agents.error.claudeCodeRuntimeSettingsInvalid'));
        return null;
      }
    }
    resolved.maxContextTokens = claudeModelMappingsDraft.maxContextTokens;
    resolved.autoCompactPct = claudeModelMappingsDraft.autoCompactPct;
    resolved.disableAutoCompact = claudeModelMappingsDraft.disableAutoCompact;
    resolved.startupModel = claudeModelMappingsDraft.startupModel.trim() || 'opus';
    resolved.subagentModel = claudeModelMappingsDraft.subagentModel.trim();
    resolved.manageDefaultModel = resolved.startupModel.length > 0;
    resolved.manageSubagentModel = resolved.subagentModel.length > 0;
    return resolved;
  };

  const handleOAuthLoginError = (requestError: unknown, action: OAuthLoginRequiredAction) => {
    const message = String(requestError);
    if (message.includes(CODEX_OAUTH_LOGIN_REQUIRED_ERROR)) {
      setOauthLoginRequiredAction(action);
      return true;
    }
    return false;
  };

  const clearCodexIntegration = async () => {
    setBusyAction('native-oauth');
    setConfigurationError('');
    setConfigurationNotice('');
    setClearNotice('');
    try {
      await invoke('restore_codex_official_config');
      setModelError('');
      setModelSelectionError('');
      setStatuses((current) => current.map((status) => status.id === 'codex'
        ? { ...status, codexNativeOauth: true } : status));
      await reloadStatusesAfterAction();
      setConfigurationNotice(t('agents.nativeOAuth.restored'));
    } catch (cause) {
      setConfigurationError(String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const closeConfigurationChanges = async () => {
    setBusyAction('close-config');
    setConfigurationError('');
    setConfigurationNotice('');
    setClearNotice('');
    try {
      await removeSelectedConfiguration();
      clearPendingChanges();
      if (isClaudeModelMappingClient) claudeModelMappingsDirtyRef.current[selected] = false;
      await reloadStatusesAfterAction();
      setModelSelectionError('');
      setModelError('');
      setConfigurationNotice(selected === 'codex' ? t('agents.modify.closed')
        : t('agents.clearIntegration.success', { name: activeDefinition.name }));
    } catch (cause) {
      setConfigurationError(String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const changeOauthConfiguration = async (enabled: boolean) => {
    setConfigurationNotice('');
    setClearNotice('');
    if (!enabled) {
      trackFormEdit({ ...formValues, oauthConfiguration: false });
      setOauthConfigurationDraft(false);
      return;
    }

    setBusyAction('oauth-check');
    try {
      await invoke('check_codex_oauth_login');
      trackFormEdit({ ...formValues, oauthConfiguration: true });
      setOauthConfigurationDraft(true);
    } catch (requestError) {
      if (!handleOAuthLoginError(requestError, 'enable')) {
        setConfigurationError(String(requestError));
      }
    } finally {
      setBusyAction(null);
    }
  };

  const applyConfigurationChanges = async () => {
    setConfigurationError('');
    const claudeModelMappings = requireClaudeModelMappings();
    if (isClaudeModelMappingClient && !claudeModelMappings) return;
    const model = isClaudeModelMappingClient
      ? claudeModelMappings?.sonnet ?? null
      : requireSelectedModel();
    if (!model) return;
    setBusyAction('apply');
    setConfigurationNotice('');
    try {
      const result = await invoke<AgentConfigActionResult>('update_agent_config', {
        client: selected,
        model,
        oauthConfiguration,
        claudeCodeModelMappings: selected === 'claude-code' ? claudeModelMappings : null,
        claudeDesktopModelMappings: selected === 'claude-desktop' ? claudeModelMappings : null,
        executableOverrides: executablePaths,
      });
      clearPendingChanges();
      if (isClaudeModelMappingClient) {
        claudeModelMappingsDirtyRef.current[selected] = false;
      }
      await reloadStatusesAfterAction();
      if (isDeepSeekHarnessClient) await loadModels('deepseek-harness');
      setOauthConfigurationDraft(null);
      setConfigurationNotice(t(result.outcome === 'unchanged' ? 'agents.backup.unchanged' : 'agents.backup.updated'));
    } catch (requestError) {
      if (!handleOAuthLoginError(requestError, 'apply')) {
        setConfigurationError(String(requestError));
      }
    } finally {
      setBusyAction(null);
    }
  };

  const installPiProvider = async () => {
    const model = requireSelectedModel();
    if (!model) return;
    setBusyAction('install-pi');
    setConfigurationError('');
    setConfigurationNotice('');
    setClearNotice('');
    try {
      await invoke<AgentConfigActionResult>('install_pi_provider', { model, executableOverrides: executablePaths });
      clearPendingChanges();
      await reloadStatusesAfterAction();
      setConfigurationNotice(t('agents.management.pluginInstalled'));
    } catch (requestError) {
      setConfigurationError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const updatePiProvider = async () => {
    const model = requireSelectedModel();
    if (!model) return;
    setBusyAction('update-pi');
    setConfigurationError('');
    setConfigurationNotice('');
    setClearNotice('');
    setPiProviderUpdateStatus(null);
    try {
      await invoke<AgentConfigActionResult>('update_pi_provider', { model, executableOverrides: executablePaths });
      clearPendingChanges();
      await reloadStatusesAfterAction();
      setConfigurationNotice(t('agents.management.pluginUpdated'));
      await loadPiProviderUpdateStatus();
    } catch (requestError) {
      setConfigurationError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const repairPiProvider = async () => {
    const model = requireSelectedModel();
    if (!model) return;
    setBusyAction('repair-pi');
    setConfigurationError('');
    try {
      const result = await invoke<AgentConfigActionResult>('repair_pi_provider', { model });
      clearPendingChanges();
      await reloadStatusesAfterAction();
      setConfigurationNotice(t(result.outcome === 'unchanged' ? 'agents.backup.unchanged' : 'agents.backup.updated'));
    } catch (requestError) {
      setConfigurationError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const uninstallPiProvider = async () => {
    setBusyAction('uninstall-pi');
    setConfigurationError('');
    setConfigurationNotice('');
    setClearNotice('');
    setPiProviderUpdateStatus(null);
    try {
      await invoke<AgentConfigActionResult>('uninstall_pi_provider', { executableOverrides: executablePaths });
      clearPendingChanges();
      await reloadStatusesAfterAction();
      setConfigurationNotice(t('agents.management.pluginUninstalled'));
    } catch (requestError) {
      setConfigurationError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const resetConfigurationToDefault = async () => {
    if (!templatePreview) return;
    const claudeModelMappings = requireClaudeModelMappings();
    if (isClaudeModelMappingClient && !claudeModelMappings) return;
    const model = isClaudeModelMappingClient
      ? claudeModelMappings?.sonnet ?? null
      : requireSelectedModel();
    if (!model) return;
    setBusyAction('default');
    setDefaultError('');
    try {
      await invoke<AgentConfigActionResult>('apply_agent_config_template', {
        revision: templatePreview.revision,
        client: selected,
        model,
        oauthConfiguration,
        claudeCodeModelMappings: selected === 'claude-code' ? claudeModelMappings : null,
        claudeDesktopModelMappings: selected === 'claude-desktop' ? claudeModelMappings : null,
      });
      clearPendingChanges();
      setDefaultConfirmOpen(false);
      if (isClaudeModelMappingClient) {
        claudeModelMappingsDirtyRef.current[selected] = false;
      }
      const refreshed = await invoke<AgentConfigStatus[]>('refresh_agent_config_statuses', { executableOverrides: executablePaths });
      setStatuses(refreshed);
      const current = refreshed.find((status) => status.id === selected)?.currentModel;
      setModelByClient((values) => { const next = { ...values, [selected]: current ?? '' }; writeAgentModelSelections(next); return next; });
      setConfigurationNotice(t('agents.backup.updated'));
      setOauthConfigurationDraft(null);
    } catch (requestError) {
      if (!handleOAuthLoginError(requestError, 'apply')) {
        const error = String(requestError);
        const setupError = selected === 'vscode-copilot' ? copilotSetupErrorKey(error) : undefined;
        setDefaultError(setupError ? t(setupError) : error);
        setTemplatePreview(null);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const removeSelectedConfiguration = () => selected === 'codex'
    ? invoke<AgentConfigActionResult>('close_codex_config_modification')
    : invoke<AgentConfigActionResult>('set_agent_config_enabled', {
      client: selected, model: '', enabled: false, forceRestore: false,
      claudeCodeModelMappings: null, claudeDesktopModelMappings: null,
      executableOverrides: executablePaths,
    });

  const clearConfiguration = async () => {
    setBusyAction('clear');
    setConfigurationError('');
    setConfigurationNotice('');
    setClearError('');
    setClearNotice('');
    try {
      if (selected === 'codex') await invoke<string[]>('clear_codex_config');
      else await removeSelectedConfiguration();
      clearPendingChanges();
      if (isClaudeModelMappingClient) claudeModelMappingsDirtyRef.current[selected] = false;
      setClearConfirmOpen(false);
      setModelSelectionError('');
      setModelError('');
      setClearNotice(selected === 'codex' ? t('agents.clear.success')
        : t('agents.clearIntegration.success', { name: activeDefinition.name }));
      await reloadStatusesAfterAction();
      setOauthConfigurationDraft(null);
    } catch (requestError) {
      setClearError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const openLaunchDirectoryDialog = (target: AgentLaunchTarget) => {
    setLaunchDirectory(activeLaunchDirectoryHistory[0] ?? '');
    setLaunchDirectoryTarget(target);
    setLaunchDirectoryError('');
    setLaunchDirectoryDialogOpen(true);
  };

  const updateDeepSeekHarnessLaunchDraft = (update: Partial<DeepSeekHarnessLaunchDraft>) => {
    setDeepSeekHarnessLaunchDraft((current) => ({ ...current, ...update }));
    setLaunchDirectoryError('');
  };

  const chooseLaunchDirectory = async () => {
    setBusyAction('directory');
    setLaunchDirectoryError('');
    try {
      const selectedDirectory = await open({
        directory: true,
        multiple: false,
        defaultPath: launchDirectory || undefined,
        title: t('agents.launchDirectory.dialogTitle', { client: activeDefinition.name }),
      });
      if (typeof selectedDirectory === 'string') setLaunchDirectory(selectedDirectory);
    } catch (requestError) {
      setLaunchDirectoryError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const chooseExecutablePath = async (desktop = false) => {
    try {
      const selectedPath = await open({ directory: false, multiple: false, title: t('agents.executablePath.dialogTitle') });
      if (typeof selectedPath !== 'string' || !selectedPath.trim()) return;
      const key = desktop ? `${selected}:app` as const : selected;
      const next = { ...executablePaths, [key]: selectedPath.trim() };
      setExecutablePaths(next);
      writeAgentExecutablePaths(next);
      const refreshed = await invoke<AgentConfigStatus[]>('refresh_agent_config_statuses', { executableOverrides: next });
      setStatuses(refreshed);
      setConfigurationNotice(t('agents.executablePath.saved'));
    } catch (requestError) {
      setConfigurationError(String(requestError));
    }
  };

  const clearExecutablePath = (desktop = false) => {
    const next = { ...executablePaths };
    delete next[desktop ? `${selected}:app` as const : selected];
    setExecutablePaths(next);
    writeAgentExecutablePaths(next);
    void invoke<AgentConfigStatus[]>('refresh_agent_config_statuses', { executableOverrides: next })
      .then(setStatuses).catch((requestError) => setConfigurationError(String(requestError)));
  };

  const rememberLaunchDirectory = (client: AgentClientId, directory: string) => {
    setLaunchDirectoryHistory((current) => {
      const next = rememberAgentLaunchDirectory(current, client, directory);
      writeAgentLaunchDirectoryHistory(next);
      return next;
    });
  };

  const invokeAgentLaunch = async (
    target: AgentLaunchTarget,
    workingDirectory: string | null = null,
    deepSeekHarnessOptions: DeepSeekHarnessLaunchOptions | null = null,
  ) => {
    const action = hasIndependentCliAndApp
      ? target.id === 'cli' ? 'launch-cli' : 'launch-app'
      : 'launch';
    setBusyAction(action);
    setLaunchError('');
    try {
      await invoke('launch_agent', {
        client: selected,
        target: target.id,
        executablePath: executablePaths[selected] ?? null,
        desktopExecutablePath: executablePaths[`${selected}:app`] ?? null,
        workingDirectory,
        deepseekHarnessOptions: deepSeekHarnessOptions,
      });
      if (selected === 'deepseek-harness') {
        await loadDeepSeekHarnessProcessStatus();
      }
      if (workingDirectory) {
        rememberLaunchDirectory(selected, workingDirectory);
        setLaunchDirectoryDialogOpen(false);
        setLaunchDirectoryTarget(null);
      }
    } catch (requestError) {
      if (workingDirectory) {
        setLaunchDirectoryError(String(requestError));
      } else if (!handleOAuthLoginError(requestError, 'launch')) {
        setLaunchError(String(requestError));
      }
    } finally {
      setBusyAction(null);
    }
  };

  const launchAgent = async (target: AgentLaunchTarget | null) => {
    if (!target) return;
    if (target.id === 'cli' || selected === 'vscode-copilot') {
      openLaunchDirectoryDialog(target);
      return;
    }
    await invokeAgentLaunch(target);
  };

  const stopDeepSeekHarness = async () => {
    setBusyAction('stop-deepseek');
    setLaunchError('');
    try {
      const status = await invoke<DeepSeekHarnessProcessStatus>('stop_deepseek_harness_process');
      setDeepSeekHarnessProcessStatus(status);
    } catch (requestError) {
      setLaunchError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const restartDesktopApp = async () => {
    if (!['codex', 'opencode', 'claude-desktop', 'zcode', 'workbuddy'].includes(selected)) return;
    setBusyAction('restart-app');
    setLaunchError('');
    try {
      await invoke('restart_agent_app', { client: selected,
        executablePath: executablePaths[hasIndependentCliAndApp ? `${selected}:app` as const : selected] ?? null });
    } catch (requestError) {
      if (!handleOAuthLoginError(requestError, 'launch')) {
        setLaunchError(String(requestError));
      }
    } finally {
      setBusyAction(null);
    }
  };

  useEffect(() => {
    const pending = codexCliServiceRestart;
    if (!pending) return;
    let active = true;
    pending.then(
      // The restart belongs to Codex whichever client is selected after a remount.
      () => { if (active) updateViewStateForClient('codex', { configurationNotice: t('agents.launch.cliServiceRestarted') }); },
      (requestError) => { if (active) updateViewStateForClient('codex', { launchError: String(requestError) }); },
    ).finally(() => { if (active) setCliServiceRestarting(false); });
    return () => { active = false; };
  }, []);

  const restartCodexCliService = async () => {
    if (selected !== 'codex' || cliServiceRestarting || codexCliServiceRestart) return;
    const executablePath = executablePaths[selected] ?? null;
    setCliServiceRestarting(true);
    setLaunchError('');
    setConfigurationNotice('');
    try {
      if (!await invoke<boolean>('get_codex_cli_daemon_running', { executablePath })) {
        setConfigurationNotice(t('agents.launch.cliServiceNotRunning'));
        return;
      }
      const confirmed = await askCliRestartConfirmation();
      if (!confirmed) return;
      // Not the target-guarded invoke: the restart outlives this mount and a remounted section waits on the same promise.
      const restart = invokeNative<void>('restart_codex_cli_daemon', { executablePath })
        .finally(() => { codexCliServiceRestart = null; });
      codexCliServiceRestart = restart;
      await restart;
      setConfigurationNotice(t('agents.launch.cliServiceRestarted'));
    } catch (requestError) {
      setLaunchError(String(requestError));
    } finally {
      setCliServiceRestarting(false);
    }
  };

  const restartDeepSeekHarness = async () => {
    setBusyAction('restart-deepseek');
    setLaunchError('');
    try {
      setDeepSeekHarnessProcessStatus(await invoke<DeepSeekHarnessProcessStatus>('restart_deepseek_harness_process'));
    } catch (requestError) {
      setLaunchError(String(requestError));
      await loadDeepSeekHarnessProcessStatus().catch(() => undefined);
    } finally {
      setBusyAction(null);
    }
  };

  const launchFromDirectoryDialog = async () => {
    if (!launchDirectoryTarget) return;
    const workingDirectory = launchDirectory.trim();
    if (!workingDirectory) {
      setLaunchDirectoryError(t('agents.launchDirectory.directoryRequired'));
      return;
    }
    let deepSeekHarnessOptions: DeepSeekHarnessLaunchOptions | null = null;
    if (isDeepSeekHarnessClient) {
      const result = buildDeepSeekHarnessLaunchOptions(deepSeekHarnessLaunchDraft);
      if (result.error) {
        const errorKeys = {
          invalidPort: 'agents.deepseekLaunch.error.invalidPort',
          taskRequired: 'agents.deepseekLaunch.error.taskRequired',
          profileRequired: 'agents.deepseekLaunch.error.profileRequired',
          invalidProfile: 'agents.deepseekLaunch.error.invalidProfile',
        } as const;
        setLaunchDirectoryError(t(errorKeys[result.error]));
        return;
      }
      deepSeekHarnessOptions = result.options;
    }
    setLaunchDirectoryError('');
    await invokeAgentLaunch(launchDirectoryTarget, workingDirectory, deepSeekHarnessOptions);
  };

  const createManualBackup = async () => {
    setBusyAction('backup'); setConfigurationError(''); setConfigurationNotice('');
    try {
      await invoke('create_agent_config_backup', { client: selected });
      setConfigurationNotice(t('agents.backup.created'));
    } catch (cause) { setConfigurationError(String(cause)); }
    finally { setBusyAction(null); }
  };

  const openDefaultConfirmation = async () => {
    const mappings = requireClaudeModelMappings();
    if (isClaudeModelMappingClient && !mappings) return;
    const model = isClaudeModelMappingClient ? mappings?.sonnet : requireSelectedModel();
    if (!model) return;
    setDefaultError(''); setConfigurationError(''); setTemplatePreview(null); setBusyAction('default');
    try {
      const preview = await invoke<{ revision: string; files: string[] }>('preview_agent_config_template', {
        client: selected, model, oauthConfiguration,
        claudeCodeModelMappings: selected === 'claude-code' ? mappings : null,
        claudeDesktopModelMappings: selected === 'claude-desktop' ? mappings : null,
      });
      setTemplatePreview(preview); setDefaultConfirmOpen(true);
    } catch (cause) { setConfigurationError(String(cause)); }
    finally { setBusyAction(null); }
  };

  const closeDefaultConfirmation = () => {
    setDefaultError('');
    setDefaultConfirmOpen(false);
  };

  const openClearConfirmation = () => {
    setClearError('');
    setClearConfirmOpen(true);
  };

  const closeClearConfirmation = () => {
    setClearError('');
    setClearConfirmOpen(false);
  };

  const openClearIntegrationGuide = () => {
    setOauthLoginRequiredAction(null);
    options.onOpenManage?.();
    requestAnimationFrame(() => document.getElementById('agent-clear-integration')?.focus());
  };

  const setupErrorKey = selected === 'vscode-copilot' ? copilotSetupErrorKey(configurationError) : undefined;
  const configurationErrorMessage = (setupErrorKey ? t(setupErrorKey) : configurationError) || (!nativeOauth ? modelSelectionError || (selected === 'claude-code' ? '' : modelError) : '');

  const editDesktopEntries = (entries: ClaudeDesktopModelMapping[]) => {
    setModelSelectionError('');
    editClaudeModelMappings((current) => ({ ...current, desktopModels: entries }));
  };
  const updateDesktopEntry = (index: number, changes: Partial<ClaudeDesktopModelMapping>) => {
    editDesktopEntries(desktopEntries.map((entry, i) => i === index ? { ...entry, ...changes } : entry));
  };

  const afterBackupRestored = async () => {
    clearPendingChanges();
    if (selected === 'claude-code' || selected === 'claude-desktop') claudeModelMappingsDirtyRef.current[selected] = false;
    setOauthConfigurationDraft(null);
    const refreshed = await invoke<AgentConfigStatus[]>('refresh_agent_config_statuses', { executableOverrides: executablePaths });
    setStatuses(refreshed);
    const current = refreshed.find((status) => status.id === selected)?.currentModel;
    setModelByClient((values) => { const next = { ...values, [selected]: current ?? '' }; writeAgentModelSelections(next); return next; });
    setConfigurationNotice(t('agents.backup.restored'));
  };

  const dismissMessages = () => { setConfigurationError(''); setModelSelectionError(''); setModelError(''); };
  const dismissNotices = () => { setConfigurationNotice(''); setClearNotice(''); };

  return {
    // selection + detection
    selected, activeDefinition, activeStatus, statuses, loading, detectionError, setDetectionError, refresh,
    busy, busyAction,
    // executable paths
    executablePaths, chooseExecutablePath, clearExecutablePath,
    // models
    models, modelLoading, modelError, refreshModels, savedSelectedModel, selectedModelOption, missingModelHint,
    modelHint, selectModel, modelSelectionError, loadModels, loadStatuses,
    // client kinds
    isPiClient, isDeepSeekHarnessClient, hasIndependentCliAndApp, isClaudeModelMappingClient,
    // codex auth
    nativeOauth, oauthConfiguration, changeOauthConfiguration, connectionHelpOpen, updateViewState,
    // claude mapping
    claudeModelMappingsDraft, claudeCustomMapping, claudeMappingModels, changeClaudeCustomMapping,
    editClaudeModelMappings, selectClaudeModelMapping, changeClaude1mPreference,
    changeClaudeCodeRuntimeSetting, changeClaudeCodeAutoCompactDisabled,
    desktopEntries, resolvedDesktopEntries, appliedDesktopEntries, desktopValidation, editDesktopEntries,
    updateDesktopEntry, desktopHelpOpen, setDesktopHelpOpen,
    // pi plugin
    piPluginUpdateAvailable, piPluginUpdateTitle, installPiProvider, updatePiProvider, repairPiProvider,
    uninstallPiProvider,
    // configuration state + actions
    connectionState, appliedModel, canCloseConfiguration, configurationActionLabel, configurationWriteBlocked,
    hasPendingChanges, canEnable, canConfigureActiveClient, modificationDescription,
    applySelectedConfiguration, closeConfigurationChanges, clearCodexIntegration, createManualBackup,
    afterBackupRestored,
    // template reset / clear dialogs
    templatePreview, defaultConfirmOpen, openDefaultConfirmation, closeDefaultConfirmation,
    resetConfigurationToDefault, defaultError, clearConfirmOpen, openClearConfirmation, closeClearConfirmation,
    clearConfiguration, clearError,
    // launch
    activeLaunchTargets, launchEnabled, launchAgent, restartDesktopApp, restartCodexCliService,
    cliServiceRestarting, cliRestartConfirm: cliRestartConfirm !== null, answerCliRestartConfirmation,
    stopDeepSeekHarness, restartDeepSeekHarness, deepSeekHarnessProcessStatus,
    launchDirectoryDialogOpen, setLaunchDirectoryDialogOpen, launchDirectory, setLaunchDirectory,
    launchDirectoryTarget, setLaunchDirectoryTarget, launchDirectoryError, setLaunchDirectoryError,
    activeLaunchDirectoryHistory, chooseLaunchDirectory, launchFromDirectoryDialog,
    deepSeekHarnessLaunchDraft, updateDeepSeekHarnessLaunchDraft, deepSeekHarnessLaunchModeLabel,
    deepSeekHarnessLaunchModeDescription,
    // oauth-required dialog
    oauthLoginRequiredAction, setOauthLoginRequiredAction, openClearIntegrationGuide,
    // catalogs
    codexCatalogDialogOpen, setCodexCatalogDialogOpen, harnessCatalogDialogOpen, setHarnessCatalogDialogOpen,
    // notices
    configurationErrorMessage, configurationNotice, clearNotice, launchError, setLaunchError,
    dismissMessages, dismissNotices,
  };
}

export type AgentsController = ReturnType<typeof useAgentsController>;
