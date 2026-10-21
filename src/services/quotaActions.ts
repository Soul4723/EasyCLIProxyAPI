import { startQuotaOperation, finishQuotaOperation, type QuotaOperation } from './quotaOperation';
import { resetGrantOperations, RETRY_WINDOW_MS } from './claudeResetOperations';
import { selectResetGrant } from './selectClaudeResetGrant';
import {
  captureQuotaCacheGeneration,
  commitQuotaCacheIfCurrent,
  getQuotaCacheSnapshot,
  updateQuotaCache,
} from './quotaCache';
import { managementApi, normalizeAuthIndex, readBoolean } from './managementApi';
import {
  consumeClaudeResetCredit, consumeCodexResetCredit, idleQuota, providerForFile, quotaKey,
  type AuthFile, type QuotaState,
} from './quotaService';

const pendingActions = new Set<string>();
type QuotaActionOutcome = 'cancelled' | 'success' | 'refresh-error' | 'error';

export const canResetCodexQuota = (file: AuthFile, quota: QuotaState): boolean =>
  providerForFile(file) === 'codex'
  && !readBoolean(file, 'disabled')
  && quota.status !== 'loading'
  && (quota.resetCredits ?? 0) > 0;

async function runConfirmedQuotaAction(
  file: AuthFile,
  action: 'reset',
  confirmAction: () => Promise<boolean>,
  execute: (file: AuthFile, operation?: Promise<QuotaOperation>) => Promise<QuotaState>,
): Promise<QuotaActionOutcome> {
  const key = quotaKey(file);
  const original = getQuotaCacheSnapshot()[key];
  const previous = original ?? idleQuota();
  const generation = captureQuotaCacheGeneration();
  const actionKey = `${generation}:${key}`;
  if (pendingActions.has(actionKey) || previous.status === 'loading' || readBoolean(file, 'disabled')) return 'cancelled';
  pendingActions.add(actionKey);
  let pending: QuotaState | undefined;
  const commit = (quota: QuotaState) => {
    commitQuotaCacheIfCurrent(generation, () => {
      updateQuotaCache((current) => current[key] === pending ? { ...current, [key]: quota } : current);
    });
  };
  try {
    const started = startQuotaOperation();
    // Attach a handler while the user may leave the dialog open.
    void started.catch(() => {});
    if (await confirmAction() !== true || captureQuotaCacheGeneration() !== generation
      || getQuotaCacheSnapshot()[key] !== original) return 'cancelled';
    const operation = await started;
    await finishQuotaOperation(operation);
    if (previous.targetRevision !== undefined && previous.targetRevision !== operation.expectedRevision) return 'cancelled';
    pending = { ...previous, status: 'loading', pendingAction: action, actionResult: undefined };
    updateQuotaCache((current) => ({ ...current, [key]: pending! }));
    const result = await execute(file, started);
    await finishQuotaOperation(operation);
    if (result.status === 'error') {
      const status = 'refresh-error';
      commit({ ...previous, actionResult: { action, status, error: result.error } });
      return status;
    }
    commit({ ...result, actionResult: { action, status: 'success' } });
    return 'success';
  } catch (error) {
    if (!pending) throw error;
    // Do not restore old rows/credits after a native target change, even before its event.
    const revision = await managementApi.checkTargetRevision().catch(() => undefined);
    if (previous.targetRevision === undefined || revision === previous.targetRevision)
      commit({ ...previous, actionResult: { action, status: 'error', error: error instanceof Error ? error.message : String(error) } });
    else commit(idleQuota());
    return 'error';
  } finally {
    pendingActions.delete(actionKey);
  }
}

export function resetCodexQuotaWithConfirmation(file: AuthFile, confirmReset: () => Promise<boolean>): Promise<QuotaActionOutcome> {
  if (!canResetCodexQuota(file, getQuotaCacheSnapshot()[quotaKey(file)] ?? idleQuota())) return Promise.resolve('cancelled');
  return runConfirmedQuotaAction(file, 'reset', confirmReset, consumeCodexResetCredit);
}

export function hasPendingClaudeReset(file: AuthFile): boolean {
  const operation = resetGrantOperations.inspect(`${getQuotaCacheSnapshot()[quotaKey(file)]?.targetRevision ?? 0}:${quotaKey(file)}`);
  return Boolean(operation && !operation.code);
}

export function canResetQuota(file: AuthFile, quota: QuotaState): boolean {
  if (providerForFile(file) !== 'claude') return canResetCodexQuota(file, quota);
  if (readBoolean(file, 'disabled') || quota.status === 'loading' || !normalizeAuthIndex(file.auth_index ?? file.authIndex)) return false;
  const operation = resetGrantOperations.inspect(`${quota.targetRevision ?? 0}:${quotaKey(file)}`);
  if (operation && !operation.code) return Date.now() - operation.createdAt < RETRY_WINDOW_MS;
  return Boolean(quota.claudeResetGrants && selectResetGrant(quota.claudeResetGrants, Date.now()));
}

export function resetQuotaWithConfirmation(file: AuthFile, confirmReset: () => Promise<boolean>): Promise<QuotaActionOutcome> {
  if (providerForFile(file) !== 'claude') return resetCodexQuotaWithConfirmation(file, confirmReset);
  if (!canResetQuota(file, getQuotaCacheSnapshot()[quotaKey(file)] ?? idleQuota())) return Promise.resolve('cancelled');
  return runConfirmedQuotaAction(file, 'reset', confirmReset, consumeClaudeResetCredit);
}
