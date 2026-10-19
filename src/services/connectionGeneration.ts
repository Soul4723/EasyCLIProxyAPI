let generation = 0;
export const connectionGeneration = () => generation;
export const invalidateConnectionRequests = () => { generation += 1; };
export function assertConnectionCurrent(expected: number) {
  if (expected !== generation) throw new Error('Core connection changed; retry on the selected core.');
}

let switching = false;
export function beginConnectionChange() {
  switching = true;
  invalidateConnectionRequests();
}
export function assertConnectionActive() {
  if (switching) throw new Error('Core connection changed; reloading.');
}

export function restoreConnectionAfterSaveFailure() { switching = false; }
