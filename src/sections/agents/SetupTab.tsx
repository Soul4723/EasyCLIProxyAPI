import type { AgentsController } from './useAgentsController';

/** STUB: replaced by its worker. */
export function SetupTab({ ctl }: { ctl: AgentsController }) {
  return <div data-stub="SetupTab">{ctl.activeDefinition.name}</div>;
}
