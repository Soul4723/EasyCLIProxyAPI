import type { AgentsController } from './useAgentsController';

/** STUB: replaced by its worker. */
export function BackupsTab({ ctl }: { ctl: AgentsController }) {
  return <div data-stub="BackupsTab">{ctl.activeDefinition.name}</div>;
}
