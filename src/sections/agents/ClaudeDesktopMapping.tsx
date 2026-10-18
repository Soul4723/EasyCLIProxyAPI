import type { AgentsController } from './useAgentsController';

/** STUB: replaced by its worker. */
export function ClaudeDesktopMapping({ ctl }: { ctl: AgentsController }) {
  return <div data-stub="ClaudeDesktopMapping">{ctl.activeDefinition.name}</div>;
}
