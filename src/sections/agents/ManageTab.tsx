import type { AgentsController } from './useAgentsController';

/** STUB: replaced by its worker. */
export function ManageTab({ ctl }: { ctl: AgentsController }) {
  return <div data-stub="ManageTab">{ctl.activeDefinition.name}</div>;
}
