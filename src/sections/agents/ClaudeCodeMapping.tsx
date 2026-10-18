import type { AgentsController } from './useAgentsController';

/** STUB: replaced by its worker. */
export function ClaudeCodeMapping({ ctl }: { ctl: AgentsController }) {
  return <div data-stub="ClaudeCodeMapping">{ctl.activeDefinition.name}</div>;
}
