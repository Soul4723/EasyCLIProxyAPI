// Native commands that take expected_revision (src-tauri/src). tests/platformBoundary.test.ts keeps this list equal to the Rust signatures.
export const FENCED_COMMANDS: ReadonlySet<string> = new Set([
  'add_core_api_key',
  'clear_core_management_secret_key',
  'create_speed_alias',
  'create_thinking_alias',
  'delete_core_api_key',
  'delete_speed_alias',
  'delete_thinking_alias',
  'get_core_config_settings',
  'get_core_sensitive_words_settings',
  'get_core_tls_settings',
  'get_extended_core_config',
  'get_model_alias_edit_source',
  'get_model_alias_sources',
  'get_oauth_status',
  'get_speed_alias_sources',
  'get_speed_aliases',
  'get_thinking_alias_sources',
  'get_thinking_aliases',
  'import_vertex_credential',
  'lighting_report_reset',
  'lighting_save',
  'resume_usage_collection',
  'save_core_logging_settings',
  'save_core_sensitive_words_settings',
  'save_core_tls_settings',
  'save_extended_core_config',
  'save_gui_settings',
  'save_network_endpoint_settings',
  'save_network_routing_settings',
  'save_retry_settings',
  'save_session_routing_settings',
  'set_core_management_secret_key',
  'set_core_plugins_enabled',
  'set_core_proxy_url',
  'set_core_request_log',
  'set_core_routing_strategy',
  'set_core_session_affinity',
  'set_core_session_affinity_ttl',
  'start_oauth_login',
  'submit_oauth_callback',
  'update_core_api_key',
  'upload_auth_file',]);

/** management_request carries the revision inside its request struct; every other fenced command takes it as a top-level argument. */
export function suppliedRevision(command: string, payload: Record<string, unknown>): unknown {
  const holder = command === 'management_request' ? payload.request : payload;
  return holder && typeof holder === 'object' ? (holder as Record<string, unknown>).expectedRevision : undefined;
}

export const isFencedCommand = (command: string): boolean => command === 'management_request' || FENCED_COMMANDS.has(command);

/** What Tauri's argument deserialisation does natively: expected_revision is a required u64, so a fenced call without it never reaches the handler. */
export function assertFencedArgs(command: string, payload: unknown): void {
  const args = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (isFencedCommand(command) && typeof suppliedRevision(command, args) !== 'number') {
    throw new Error(`invalid args \`expectedRevision\` for command \`${command}\`: missing required key expectedRevision`);
  }
}
