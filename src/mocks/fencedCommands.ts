import { isFencedCommand } from '../services/fencedCommands';

/** management_request carries the revision inside its request struct; every other fenced command takes it as a top-level argument. */
export function suppliedRevision(command: string, payload: Record<string, unknown>): unknown {
  const holder = command === 'management_request' ? payload.request : payload;
  return holder && typeof holder === 'object' ? (holder as Record<string, unknown>).expectedRevision : undefined;
}

/** What Tauri's argument deserialisation does natively: expected_revision is a required u64, so a fenced call without it never reaches the handler. */
export function assertFencedArgs(command: string, payload: unknown): void {
  const args = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (isFencedCommand(command) && typeof suppliedRevision(command, args) !== 'number') {
    throw new Error(`invalid args \`expectedRevision\` for command \`${command}\`: missing required key expectedRevision`);
  }
}
