import type { ComponentType } from 'react';
import { Bot } from 'lucide-react';
import type { MessageKey } from '../../i18n/resources';
import claudeIcon from '../../assets/icons/claude.svg';
import codexIcon from '../../assets/icons/codex.svg';
import copilotIcon from '../../assets/icons/copilot.svg';
import deepseekIcon from '../../assets/icons/deepseek.svg';
import hermesIcon from '../../assets/icons/hermes.png';
import grokIcon from '../../assets/icons/grok.svg';
import kimiIcon from '../../assets/icons/kimi-light.svg';
import openclawIcon from '../../assets/icons/openclaw.svg';
import opencodeIcon from '../../assets/icons/opencode.svg';
import piIcon from '../../assets/icons/pi-logo-on-light.svg';
import zcodeIcon from '../../assets/icons/zcode.png';
import workbuddyIcon from '../../assets/icons/workbuddy.png';
import antigravityIcon from '../../assets/icons/antigravity.svg';
import { CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS } from '../../services/claudeCodeModels';
import { sameAgentModel, sameAgentModelMappings } from '../../services/agentConfigurationDraft';
import { createDefaultDesktopModels, type ClaudeDesktopModelMapping } from '../../services/claudeDesktopModels';
import { parseAgentLaunchDirectoryHistory, type AgentLaunchDirectoryHistory } from '../../services/agentLaunchDirectoryHistory';
import type { ModelOption } from '../../services/modelService';

export const setupErrors: Record<string, MessageKey> = {
  COPILOT_SETUP_REQUIRED: 'agents.copilotSetup.required',
  COPILOT_SETUP_NOT_INSTALLED: 'agents.copilotSetup.notInstalled',
  COPILOT_SETUP_LAUNCH_FAILED: 'agents.copilotSetup.launchFailed',
  COPILOT_SETUP_DISABLED: 'agents.copilotSetup.disabled',
  COPILOT_SETUP_DIRTY: 'agents.copilotSetup.dirty',
  COPILOT_SETUP_UNSUPPORTED: 'agents.copilotSetup.unsupported',
  COPILOT_SETUP_PROFILE: 'agents.copilotSetup.profile',
  COPILOT_SETUP_FAILED: 'agents.copilotSetup.failed',
  COPILOT_SETUP_TIMEOUT: 'agents.copilotSetup.timeout',
};

export function copilotSetupErrorKey(error: string): MessageKey | undefined {
  const code = error.match(/\bCOPILOT_SETUP_[A-Z_]+\b/)?.[0];
  return code ? setupErrors[code] : undefined;
}

export type AgentClientId =
  | 'claude-code'
  | 'claude-desktop'
  | 'codex'
  | 'opencode'
  | 'openclaw'
  | 'hermes'
  | 'deepseek-harness'
  | 'zcode'
  | 'workbuddy'
  | 'antigravity-cli'
  | 'copilot-cli'
  | 'vscode-copilot'
  | 'kimi-code'
  | 'grok-build'
  | 'omp'
  | 'pi';

export type ClaudeModelMappingClientId = 'claude-code' | 'claude-desktop';

export type AgentModificationState = 'unconfigured' | 'applied' | 'invalid';

export type AgentConfigStatus = {
  id: AgentClientId;
  name: string;
  supportedPlatform: boolean;
  installed: boolean;
  pluginInstalled: boolean;
  launchTargets: AgentLaunchTarget[];
  version: string | null;
  cliVersion: string | null;
  appVersion: string | null;
  pluginVersion: string | null;
  configExists: boolean;
  configValid: boolean;
  configured: boolean;
  connectionState: 'configured' | 'not-configured' | 'needs-update' | 'invalid';
  configurationSynchronized: boolean;
  currentModel: string | null;
  oauthConfiguration: boolean;
  codexNativeOauth: boolean;
  /** Codex uses the built-in `openai` provider identity instead of `cpa-gui`. */
  codexOpenaiProvider?: boolean;
  codexRemoteCompaction?: boolean;
  modificationEnabled: boolean;
  modificationState: AgentModificationState;
  backupAvailable: boolean;
  appliedModel: string | null;
  claudeCodeModelMappings: ClaudeModelMappings | null;
  claudeDesktopModelMappings: ClaudeModelMappings | null;
  warnings: string[];
  error: string | null;
};

export type AgentLaunchTarget = {
  id: 'app' | 'cli';
  label: string;
  detail: string;
};

export type DeepSeekHarnessProcessStatus = {
  running: boolean;
  pid: number | null;
  mode: string | null;
};

export type AgentConfigActionResult = {
  outcome: 'applied' | 'default' | 'updated' | 'unchanged';
  enabled: boolean;
  model: string | null;
  changedFiles: string[];
  conflictFiles: string[];
};

export type PiProviderUpdateStatus = {
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
};

export type OAuthLoginRequiredAction = 'enable' | 'apply' | 'launch';

export type ClaudeModelMappings = {
  desktopModels?: ClaudeDesktopModelMapping[];
  opus: string;
  sonnet: string;
  haiku: string;
  fable: string;
  fable1m: boolean;
  opus1m: boolean;
  sonnet1m: boolean;
  haiku1m: boolean;
  maxContextTokens: number;
  autoCompactPct: number;
  disableAutoCompact: boolean;
  manageDefaultModel: boolean;
  manageSubagentModel: boolean;
  startupModel: string;
  subagentModel: string;
};

export type AgentFormValues = {
  model: string;
  oauthConfiguration: boolean;
  mappings: ClaudeModelMappings | null;
};

export const sameAgentFormValues = (left: AgentFormValues, right: AgentFormValues) => (
  sameAgentModel(left.model, right.model)
  && left.oauthConfiguration === right.oauthConfiguration
  && (left.mappings && right.mappings
    ? sameAgentModelMappings(left.mappings, right.mappings)
    : left.mappings === right.mappings)
);

export const CODEX_OAUTH_LOGIN_REQUIRED_ERROR = 'CODEX_OAUTH_LOGIN_REQUIRED';
export const DEFAULT_CLAUDE_AUTO_COMPACT_PCT = 90;

export const createClaudeModelMappings = (): ClaudeModelMappings => ({
  opus: '',
  sonnet: '',
  haiku: '',
  fable: '',
  fable1m: false,
  opus1m: false,
  sonnet1m: false,
  haiku1m: false,
  maxContextTokens: CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS,
  autoCompactPct: DEFAULT_CLAUDE_AUTO_COMPACT_PCT,
  disableAutoCompact: false,
  manageDefaultModel: true,
  manageSubagentModel: false,
  startupModel: 'opus',
  subagentModel: '',
});

export const createClaudeModelMappingsByClient = (): Record<
  ClaudeModelMappingClientId,
  ClaudeModelMappings
> => ({
  'claude-code': createClaudeModelMappings(),
  'claude-desktop': { ...createClaudeModelMappings(), desktopModels: createDefaultDesktopModels() },
});

export const createClaudeBooleanByClient = (): Record<ClaudeModelMappingClientId, boolean> => ({
  'claude-code': false,
  'claude-desktop': false,
});

export const claudeMappingRoles = [
  { key: 'fable', contextKey: 'fable1m', labelKey: 'agents.claudeDesktopMapping.fable' },
  {
    key: 'opus',
    contextKey: 'opus1m',
    labelKey: 'agents.claudeDesktopMapping.opus',
  },
  {
    key: 'sonnet',
    contextKey: 'sonnet1m',
    labelKey: 'agents.claudeDesktopMapping.sonnet',
  },
  {
    key: 'haiku',
    contextKey: 'haiku1m',
    labelKey: 'agents.claudeDesktopMapping.haiku',
  },
] as const;

export type AgentDefinition = {
  id: AgentClientId;
  name: string;
  icon?: string;
  Icon?: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  descriptionKey: 'agents.description.copilotCli' | 'agents.description.vscodeCopilot' | 'agents.description.claudeCode' | 'agents.description.claudeDesktop' | 'agents.description.codex' | 'agents.description.opencode' | 'agents.description.openclaw' | 'agents.description.hermes' | 'agents.description.deepseekHarness' | 'agents.description.zcode' | 'agents.description.workbuddy' | 'agents.description.antigravityCli' | 'agents.description.kimiCode' | 'agents.description.grokBuild' | 'agents.description.omp' | 'agents.description.pi';
};

export const agentDefinitions: AgentDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: claudeIcon,
    descriptionKey: 'agents.description.claudeCode',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    icon: claudeIcon,
    descriptionKey: 'agents.description.claudeDesktop',
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: codexIcon,
    descriptionKey: 'agents.description.codex',
  },
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    icon: deepseekIcon,
    descriptionKey: 'agents.description.deepseekHarness',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    icon: opencodeIcon,
    descriptionKey: 'agents.description.opencode',
  },
  {
    id: 'omp',
    name: 'Oh My Pi',
    icon: piIcon,
    descriptionKey: 'agents.description.omp',
  },
  {
    id: 'pi',
    name: 'Pi',
    icon: piIcon,
    descriptionKey: 'agents.description.pi',
  },
  {
    id: 'grok-build',
    name: 'Grok Build',
    icon: grokIcon,
    descriptionKey: 'agents.description.grokBuild',
  },
  { id: 'copilot-cli', name: 'Copilot CLI', Icon: Bot, descriptionKey: 'agents.description.copilotCli' },
  { id: 'vscode-copilot', name: 'VSCode Copilot', icon: copilotIcon, descriptionKey: 'agents.description.vscodeCopilot' },
  { id: 'antigravity-cli', name: 'Antigravity CLI', icon: antigravityIcon, descriptionKey: 'agents.description.antigravityCli' },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    icon: workbuddyIcon,
    descriptionKey: 'agents.description.workbuddy',
  },
  {
    id: 'zcode',
    name: 'ZCode',
    icon: zcodeIcon,
    descriptionKey: 'agents.description.zcode',
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    icon: kimiIcon,
    descriptionKey: 'agents.description.kimiCode',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    icon: openclawIcon,
    descriptionKey: 'agents.description.openclaw',
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    icon: hermesIcon,
    descriptionKey: 'agents.description.hermes',
  },
];
export const AGENT_MODEL_SELECTIONS_KEY = 'cpa-gui.agent-model-selections.v1';
export const AGENT_SELECTED_CLIENT_KEY = 'cpa-gui.agent-selected-client.v1';
export const AGENT_LAUNCH_DIRECTORY_HISTORY_KEY = 'cpa-gui.agent-launch-directory-history.v1';
export const AGENT_EXECUTABLE_PATHS_KEY = 'cpa-gui.agent-executable-paths.v1';
export type AgentExecutablePaths = Partial<Record<AgentClientId | `${AgentClientId}:app`, string>>;
export const readAgentExecutablePaths = (): AgentExecutablePaths => {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AGENT_EXECUTABLE_PATHS_KEY) || '{}') as Record<string, unknown>;
    return agentDefinitions.reduce<AgentExecutablePaths>((result, agent) => {
      for (const key of [agent.id, `${agent.id}:app`] as const) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim()) result[key] = value.trim();
      }
      return result;
    }, {});
  } catch { return {}; }
};
export const writeAgentExecutablePaths = (paths: AgentExecutablePaths) => {
  try { window.localStorage.setItem(AGENT_EXECUTABLE_PATHS_KEY, JSON.stringify(paths)); } catch { /* ignore storage failures */ }
};

export const readSelectedAgentClient = (): AgentClientId => {
  const fallback = agentDefinitions[0].id;
  if (typeof window === 'undefined') return fallback;
  try {
    const saved = window.localStorage.getItem(AGENT_SELECTED_CLIENT_KEY);
    return agentDefinitions.some((agent) => agent.id === saved)
      ? (saved as AgentClientId)
      : fallback;
  } catch {
    return fallback;
  }
};

export const writeSelectedAgentClient = (client: AgentClientId) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AGENT_SELECTED_CLIENT_KEY, client);
  } catch {
  }
};

export const readAgentModelSelections = (): Partial<Record<AgentClientId, string>> => {
  if (typeof window === 'undefined') return {};
  try {
    const payload = window.localStorage.getItem(AGENT_MODEL_SELECTIONS_KEY);
    if (!payload) return {};
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return agentDefinitions.reduce<Partial<Record<AgentClientId, string>>>((result, agent) => {
      const value = parsed[agent.id];
      if (typeof value === 'string' && value.trim()) result[agent.id] = value.trim();
      return result;
    }, {});
  } catch {
    return {};
  }
};

export const writeAgentModelSelections = (
  selections: Partial<Record<AgentClientId, string>>,
) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AGENT_MODEL_SELECTIONS_KEY, JSON.stringify(selections));
  } catch {
  }
};

export const readAgentLaunchDirectoryHistory = (): AgentLaunchDirectoryHistory => {
  if (typeof window === 'undefined') return {};
  try {
    return parseAgentLaunchDirectoryHistory(
      window.localStorage.getItem(AGENT_LAUNCH_DIRECTORY_HISTORY_KEY),
      agentDefinitions.map((agent) => agent.id),
    );
  } catch {
    return {};
  }
};

export const writeAgentLaunchDirectoryHistory = (history: AgentLaunchDirectoryHistory) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AGENT_LAUNCH_DIRECTORY_HISTORY_KEY, JSON.stringify(history));
  } catch {
  }
};

export const agentModelsCache: Partial<Record<AgentClientId, ModelOption[]>> = {};

export type AgentViewState = {
  connectionHelpOpen: boolean;
  configurationError: string;
  configurationNotice: string;
  clearNotice: string;
  launchError: string;
};

export const DEFAULT_AGENT_VIEW_STATE: AgentViewState = {
  connectionHelpOpen: false,
  configurationError: '',
  configurationNotice: '',
  clearNotice: '',
  launchError: '',
};
