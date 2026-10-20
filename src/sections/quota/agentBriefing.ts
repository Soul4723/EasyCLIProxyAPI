// Publishes a masked copy of the quota cache for the agent briefing (`cpa-gui --brief`, docs/agent-briefing.md).
// Passive on purpose: it listens to the quota cache that the Quota and Overview pages already fill, makes no
// provider call and adds no timer while the cache is quiet. One IPC per debounced change, none when unchanged.
import { getCurrentLocale, type AppLocale } from '../../i18n';
import { credentialsSource } from '../../services/credentials';
import { normalizeAuthIndex, readString } from '../../services/managementApi';
import { invoke } from '../../services/platform';
import { maskIdentifier, maskSensitiveText } from '../../services/privacyMask';
import { getQuotaCacheSnapshot, subscribeQuotaCache } from '../../services/quotaCache';
import { providerForFile, quotaKey, type AuthFile, type QuotaState } from '../../services/quotaService';
import { authFileHealth } from '../../services/authFileHealth';
import { classifyWindow, isPlainWindowLabel } from './model';

export type BriefingWindow = {
  kind: '5h' | 'weekly' | 'other';
  /** Product or model group ("Code review", "7-day Opus window"); empty for the account's own 5h/weekly windows. */
  group: string;
  remainingPercent: number | null;
  resetAtMs?: number;
  available?: boolean;
};

export type BriefingAccount = {
  authIndex: string;
  provider: string;
  /** Masked like privacy mode; never the raw email or account id. */
  label: string;
  plan: string;
  disabled: boolean;
  fetchedAtMs?: number;
  creditBalance?: string;
  creditsUnlimited?: boolean;
  windows: BriefingWindow[];
};

const MAX_TEXT = 40;
const MAX_WINDOWS = 12;
const BALANCE = /^[A-Za-z0-9$€£¥.,\- ]{1,24}$/;

const clip = (value: string, max = MAX_TEXT) => value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

function windowsOf(quota: QuotaState, now: number, locale: AppLocale): BriefingWindow[] {
  return quota.rows.slice(0, MAX_WINDOWS).flatMap((row) => {
    const available = row.quotaAvailable === true;
    const percent = typeof row.remainingPercent === 'number' && Number.isFinite(row.remainingPercent)
      ? Math.max(0, Math.min(100, row.remainingPercent)) : null;
    if (percent === null && !available) return [];
    const { kind, prefix } = classifyWindow(row, now, locale);
    // Special pools ("Extra usage", "7-day Opus window", "Code review 5h") must not decide whether the account is exhausted.
    const plain = kind !== 'other' && prefix === '' && isPlainWindowLabel(row.label, locale);
    const group = clip(maskSensitiveText(plain ? '' : prefix || row.label));
    const reset = typeof row.resetAtMs === 'number' && Number.isFinite(row.resetAtMs) ? Math.round(row.resetAtMs) : undefined;
    return [{ kind, group, remainingPercent: percent, ...(reset === undefined ? {} : { resetAtMs: reset }), ...(available ? { available } : {}) }];
  });
}

/** Pure: sanitised, masked accounts that have a successful quota read. Raw identities, file names and keys never leave here. */
export function buildBriefingAccounts(
  files: readonly AuthFile[],
  quotas: Readonly<Record<string, QuotaState>>,
  now: number,
  locale: AppLocale,
): BriefingAccount[] {
  return files.flatMap((file) => {
    const provider = providerForFile(file);
    const quota = quotas[quotaKey(file)];
    const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
    if (!provider || !authIndex || !quota || quota.status !== 'success') return [];
    const windows = windowsOf(quota, now, locale);
    const identity = readString(file, 'email', 'account', 'label');
    const balance = quota.creditBalance?.trim();
    return [{
      authIndex,
      provider,
      label: identity ? clip(maskIdentifier(identity)) : '',
      plan: clip(quota.plan || readString(file, 'plan_type', 'plan'), 24),
      disabled: authFileHealth(file).disabled,
      ...(quota.fetchedAt ? { fetchedAtMs: quota.fetchedAt } : {}),
      ...(balance && BALANCE.test(balance) ? { creditBalance: balance } : {}),
      ...(quota.creditsUnlimited ? { creditsUnlimited: true } : {}),
      windows,
    }];
  });
}

export type PublisherDeps = {
  read: () => BriefingAccount[];
  publish: (accounts: BriefingAccount[]) => Promise<unknown>;
  /** Quiet period after the last cache change before publishing; a refresh of many accounts becomes one call. */
  debounceMs?: number;
  /** A refresh that never goes quiet still publishes at least this often. */
  maxWaitMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
};

export function createBriefingPublisher(deps: PublisherDeps) {
  const { read, publish } = deps;
  const debounceMs = deps.debounceMs ?? 2_000;
  const maxWaitMs = deps.maxWaitMs ?? 15_000;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;
  let timer: unknown;
  let firstChangeAt = 0;
  let lastPublished = '';
  let inFlight: Promise<void> | undefined;
  let pending = false;

  const run = async () => {
    timer = undefined;
    firstChangeAt = 0;
    const accounts = read();
    // An empty cache (startup, target switch) never replaces the last good briefing; its age tells agents how old it is.
    if (!accounts.length) return;
    const serialised = JSON.stringify(accounts);
    if (serialised === lastPublished) return;
    try {
      await publish(accounts);
      lastPublished = serialised;
    } catch {
      // The next change retries; a failed write costs nothing else.
    }
  };
  const drain = () => {
    if (inFlight) { pending = true; return inFlight; }
    inFlight = run().finally(() => {
      inFlight = undefined;
      if (pending) { pending = false; void drain(); }
    });
    return inFlight;
  };

  return {
    /** Call on every quota cache change. */
    notify() {
      const at = now();
      if (!firstChangeAt) firstChangeAt = at;
      if (timer !== undefined) clearTimer(timer);
      const wait = Math.max(0, Math.min(debounceMs, firstChangeAt + maxWaitMs - at));
      timer = setTimer(() => { void drain(); }, wait);
    },
    /** Publishes now if anything changed (tests, shutdown). */
    flush() {
      if (timer !== undefined) { clearTimer(timer); timer = undefined; }
      return drain();
    },
    dispose() {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}

/** Starts the publisher for the life of the document. Reads the credentials snapshot without subscribing to it, so it never causes a load. */
export function startAgentBriefing(timing: Pick<PublisherDeps, 'debounceMs' | 'maxWaitMs'> = {}) {
  const publisher = createBriefingPublisher({
    ...timing,
    read: () => buildBriefingAccounts(
      credentialsSource.getSnapshot().data?.files ?? [], getQuotaCacheSnapshot(), Date.now(), getCurrentLocale(),
    ),
    publish: (accounts) => invoke('agent_briefing_publish', { accounts }),
  });
  const stop = subscribeQuotaCache(() => publisher.notify());
  return () => { stop(); publisher.dispose(); };
}
