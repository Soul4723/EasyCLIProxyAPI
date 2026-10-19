import { invoke as nativeInvoke, type InvokeArgs } from '@tauri-apps/api/core';
import { assertConnectionActive, assertConnectionCurrent, beginConnectionChange, connectionGeneration } from './connectionGeneration';

let targetRevision: number | undefined;
export function initializeTargetRevision(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid native target revision');
  if (targetRevision !== undefined && targetRevision !== revision) throw new Error('Core connection changed; reloading.');
  targetRevision = revision;
}
export function documentTargetRevision(): number {
  assertConnectionActive();
  if (targetRevision === undefined) throw new Error('Core connection is not initialized');
  return targetRevision;
}
export function isStaleTarget(error: unknown) {
  return /STALE_TARGET|Core connection changed|Core connection is changing/.test(String(error));
}
export const targetBoundCommands = new Set([
  'get_usage_analysis',
  'get_usage_events',
  'get_agent_models',

  'save_core_sensitive_words_settings',
  'save_retry_settings',
  'save_session_routing_settings',
  'get_core_config_settings',
  'save_core_logging_settings',
  'add_core_api_key',
  'update_core_api_key',
  'delete_core_api_key',
  'set_core_plugins_enabled',
  'set_core_request_log',
  'set_core_routing_strategy',
  'set_core_proxy_url',
  'set_core_session_affinity',
  'set_core_session_affinity_ttl',
  'get_core_sensitive_words_settings',
  'get_extended_core_config',
  'save_extended_core_config',
  'get_thinking_aliases',
  'get_model_alias_sources',
  'get_thinking_alias_sources',
  'get_model_alias_edit_source',
  'create_thinking_alias',
  'delete_thinking_alias',
  'get_speed_aliases',
  'get_speed_alias_sources',
  'create_speed_alias',
  'delete_speed_alias',
  'get_plugin_support',
  'get_plugin_resource_url',
  'import_vertex_credential',
  'upload_auth_file',
  'start_oauth_login',
  'get_oauth_status',
  'submit_oauth_callback',
  'save_gui_settings',
  'save_network_routing_settings',
  'save_network_endpoint_settings',
  'save_core_tls_settings',
  'set_core_management_secret_key',
  'clear_core_management_secret_key',
]);
export async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  const bound = command === 'management_request' || targetBoundCommands.has(command);
  if (!bound) return nativeInvoke<T>(command, args);
  const revision = documentTargetRevision();
  const generation = connectionGeneration();
  const values = (args ?? {}) as Record<string, unknown>;
  const payload = command === 'management_request'
    ? { ...values, request: { ...(values.request as object), expectedRevision: revision } }
    : { ...values, expectedRevision: revision };
  let result: T;
  try {
    result = await nativeInvoke<T>(command, payload);
  } catch (error) {
    if (isStaleTarget(error)) {
      beginConnectionChange();
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event('core-target-stale'));
      throw new Error('Core connection changed; reloading.');
    }
    throw error;
  }
  assertConnectionCurrent(generation);
  return result;
}
