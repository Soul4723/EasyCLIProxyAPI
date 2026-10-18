import type { AgentsController } from './useAgentsController';

/** STUB: replaced by its worker. */
export function AgentDialogs({ ctl }: { ctl: AgentsController }) {
  return <div data-stub="AgentDialogs">{ctl.activeDefinition.name}</div>;
}
