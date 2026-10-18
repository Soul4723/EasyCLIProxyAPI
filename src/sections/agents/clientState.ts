import type { ChipTone } from '../../ui';
import type { AgentConfigStatus, AgentDefinition } from './model';

export type ClientStateKind =
  | 'detecting' | 'unsupported' | 'notInstalled' | 'invalid' | 'needsUpdate' | 'connected' | 'notConfigured'
  | 'nativeOauth' | 'pluginMissing';

export type ClientState = {
  kind: ClientStateKind;
  tone: ChipTone;
  /** i18n key of the short chip label (grid strings). */
  labelKey: `sec.agents.state.${ClientStateKind}`;
  /** Installed, or has a config file, or (Pi) the provider extension is installed. */
  detected: boolean;
};

export function clientState(definition: AgentDefinition, status: AgentConfigStatus | undefined): ClientState {
  const detected = Boolean(status && (status.installed || status.configExists || status.configured
    || (definition.id === 'pi' && status.pluginInstalled)));
  const make = (kind: ClientStateKind, tone: ChipTone): ClientState => ({ kind, tone, labelKey: `sec.agents.state.${kind}`, detected });
  if (!status) return make('detecting', 'outline');
  if (!status.supportedPlatform) return make('unsupported', 'outline');
  if (!status.installed && !status.configExists && !(definition.id === 'pi' && status.pluginInstalled)) return make('notInstalled', 'outline');
  if (definition.id === 'pi') return make(status.pluginInstalled ? 'connected' : 'pluginMissing', status.pluginInstalled ? 'ok' : 'neutral');
  if (status.modificationState === 'invalid' || status.connectionState === 'invalid') return make('invalid', 'danger');
  if (definition.id === 'codex' && status.codexNativeOauth) return make('nativeOauth', 'info');
  if (status.connectionState === 'needs-update') return make('needsUpdate', 'warn');
  if (status.connectionState === 'configured') return make('connected', 'ok');
  return make('notConfigured', 'neutral');
}

export const clientVersion = (status: AgentConfigStatus | undefined) =>
  status?.version ?? status?.cliVersion ?? status?.appVersion ?? null;
