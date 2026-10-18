import { normalizeAuthIndex } from './managementApi';
import { authFileHealth } from './authFileHealth';
import { captureQuotaCacheGeneration, getQuotaCacheSnapshot, updateQuotaCache } from './quotaCache';
import { startQuotaOperation, finishQuotaOperation, assertQuotaOperation } from './quotaOperation';
import { commitFetchedQuota } from './quotaEnrichment';
import { loadQuota, quotaKey, providerForFile, idleQuota, type AuthFile, type QuotaState } from './quotaService';

let batch: Promise<void> | null = null;
let batchGeneration = -1;
const attempted = new Set<string>();
let attemptedGeneration = -1;

/** Shared by Overview and Quota, including their first-visit pass. */
export function refreshQuotaBatch(files: AuthFile[], neverFetched = false): Promise<void> {
  const generation = captureQuotaCacheGeneration();
  if (batch && batchGeneration === generation) return batch;
  if (attemptedGeneration !== generation) { attempted.clear(); attemptedGeneration = generation; }
  const targets = files.filter(file => {
    const key = quotaKey(file);
    return providerForFile(file) && !authFileHealth(file).disabled
      && normalizeAuthIndex(file.auth_index ?? file.authIndex)
      && getQuotaCacheSnapshot()[key]?.status !== 'loading'
      && (!neverFetched || (!attempted.has(key) && !getQuotaCacheSnapshot()[key]?.fetchedAt));
  });
  if (!targets.length) return Promise.resolve();
  targets.forEach(file => attempted.add(quotaKey(file)));
  batchGeneration = generation;
  const operation = startQuotaOperation();
  updateQuotaCache(current => ({ ...current, ...Object.fromEntries(targets.map(file => {
    const key = quotaKey(file);
    return [key, { ...(current[key] ?? idleQuota()), status: 'loading' }];
  })) }));
  const request = (async () => {
    try {
      const identity = await operation;
      const results: Array<[AuthFile, QuotaState]> = [];
      for (let index = 0; index < targets.length; index += 4) {
        assertQuotaOperation(identity);
        results.push(...await Promise.all(targets.slice(index, index + 4).map(async (file): Promise<[AuthFile, QuotaState]> => {
          try { return [file, await loadQuota(file, operation, true)]; }
          catch (error) { return [file, { status: 'error', rows: [], error: String(error), targetRevision: identity.expectedRevision }]; }
        })));
      }
      // Validate the captured identity once, immediately before committing the batch.
      await finishQuotaOperation(identity);
      for (const [file, result] of results) await commitFetchedQuota(generation, file, result, true);
    } catch (error) {
      if (generation === captureQuotaCacheGeneration()) {
        updateQuotaCache(current => ({ ...current, ...Object.fromEntries(targets.map(file => {
          const key = quotaKey(file);
          return [key, { ...current[key], status: 'error', error: String(error) }];
        })) }));
      }
    }
  })().finally(() => { if (batch === request) batch = null; });
  batch = request;
  return request;
}
