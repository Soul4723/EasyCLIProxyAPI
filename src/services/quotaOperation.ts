import { managementApi } from './managementApi';
import { captureQuotaCacheGeneration } from './quotaCache';

/** Captured before queuing or awaiting provider work; never rebound to another target. */
export type QuotaOperation = Readonly<{ expectedRevision: number; generation: number }>;
export async function startQuotaOperation(): Promise<QuotaOperation> {
  const generation = captureQuotaCacheGeneration();
  const expectedRevision = await managementApi.getTargetRevision();
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error('Invalid core target revision; quota cancelled');
  const operation = Object.freeze({ expectedRevision, generation });
  assertQuotaOperation(operation);
  return operation;
}
export function assertQuotaOperation(operation: QuotaOperation) {
  if (captureQuotaCacheGeneration() !== operation.generation)
    throw new Error('The core connection changed; quota cancelled');
}
export async function finishQuotaOperation(operation: QuotaOperation) {
  assertQuotaOperation(operation);
  // Validate, do not recapture: native changes may precede the browser event.
  if (await managementApi.getTargetRevision() !== operation.expectedRevision)
    throw new Error('The core connection changed; quota cancelled');
  assertQuotaOperation(operation);
}
