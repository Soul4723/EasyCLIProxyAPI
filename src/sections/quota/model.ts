// Pure presentation model for the quota section: turns credentials + cached quota snapshots into accounts,
// statuses, windows and provider groups. No fetching, no React, no clock reads (callers pass `now`).
import { translate, type AppLocale } from '../../i18n';
import { authFileHealth, normalizeAuthFileCooldowns, summarizeAuthFileCooldowns, type AuthFileCooldown } from '../../services/authFileHealth';
import { authFileIdentities, authFileName, parseAuthFilePriority } from '../../services/authFiles';
import { normalizeAuthIndex, readString } from '../../services/managementApi';
import { hasPendingClaudeReset } from '../../services/quotaActions';
import {
  providerForFile, quotaKey, quotaResetExpiries,
  type AuthFile, type QuotaProvider, type QuotaRow, type QuotaState,
} from '../../services/quotaService';
import { quotaResetInstant } from '../../services/quotaTime';
import type { CredentialStatus } from '../../ui';

export const PROVIDER_ORDER: readonly QuotaProvider[] = ['claude', 'codex', 'antigravity', 'xai', 'kimi', 'devin'];
/** Quota data older than this is drawn striped ("stale"). */
export const STALE_AFTER_MS = 30 * 60_000;
/** A banked reset expiring sooner than this gets a "use soon" hint. */
export const USE_SOON_MS = 24 * 3_600_000;
const FIVE_HOURS_MS = 5 * 3_600_000;
const WEEK_MS = 7 * 24 * 3_600_000;

export type WindowKind = '5h' | 'weekly' | 'other';

export type WindowView = {
  id: string;
  kind: WindowKind;
  /** Provider label as returned by the quota service (full text; shown in titles). */
  rawLabel: string;
  /** Text before the 5h/weekly part, such as a model group ("Code review "). Empty for the plain windows. */
  prefix: string;
  leftPct: number | null;
  /** Antigravity bucket that is untouched (shown as "Quota available" instead of 100%). */
  quotaAvailable?: boolean;
  resetAtMs?: number;
  resetText?: string;
  detail?: string;
  /** Model group the window belongs to (Antigravity), with the service's description of it. */
  groupLabel?: string;
  groupDescription?: string;
  /** Window name without the group, as returned by the quota service. */
  windowLabel?: string;
};

export type BankedResets = {
  provider: 'codex' | 'claude';
  count: number;
  /** ISO expiry strings, soonest first. */
  expiries: string[];
  soonestExpiryMs?: number;
  useSoon: boolean;
  pendingClaude: boolean;
};

export type AccountCooldown = {
  active: Array<{ record: AuthFileCooldown; remainingSeconds: number }>;
  credentialWide: boolean;
  modelCount: number;
  earliestSeconds: number;
};

export type QuotaAccount = {
  key: string;
  file: AuthFile;
  provider: QuotaProvider;
  fileName: string;
  authIndex: string;
  /** Email or account label; never used for requests. */
  label: string;
  identities: string[];
  plan: string;
  status: CredentialStatus;
  /** Short human reason for error/expired/cooldown (already-localized text from the service, or empty). */
  statusDetail: string;
  disabled: boolean;
  /** True for file credentials: only these can be enabled/disabled through the management API. */
  toggleable: boolean;
  priority: number;
  quota: QuotaState;
  windows: WindowView[];
  /** Bottleneck of the 5h/weekly windows (or of all windows if neither is present); null when nothing is known. */
  effectiveLeftPct: number | null;
  nextResetMs?: number;
  fetchedAt?: number;
  stale: boolean;
  loading: boolean;
  banked: BankedResets | null;
  cooldown: AccountCooldown;
  creditBalance?: string;
  creditsUnlimited?: boolean;
  /** Provider quota windows could be read; false for accounts that cannot be queried at all. */
  canFetch: boolean;
};

export type ProviderGroup = {
  provider: QuotaProvider;
  accounts: QuotaAccount[];
  /** Mean of the effective remaining % across accounts that have data and are enabled; null if none. */
  leftPct: number | null;
  enabled: number;
  total: number;
  fetched: number;
  nextResetMs?: number;
  counts: Partial<Record<CredentialStatus, number>>;
};

export type CooldownInput = { receivedAtMs: number; observedAt?: string };

const baseLabels = (locale: AppLocale) => ({
  fiveHour: [translate(locale, 'quota.service.window.fiveHour'), translate(locale, 'quota.service.limit.fiveHours')],
  weekly: [
    translate(locale, 'quota.service.window.sevenDay'), translate(locale, 'quota.service.limit.week'),
    translate(locale, 'quota.service.weekly'),
  ],
});

/** Splits a window label into a known 5h/weekly base plus an optional prefix, using the active locale's strings. */
export function classifyWindow(row: QuotaRow, now: number, locale: AppLocale): { kind: WindowKind; prefix: string } {
  const label = row.label.trim();
  const bases = baseLabels(locale);
  for (const base of bases.fiveHour) {
    if (base && label.endsWith(base)) return { kind: '5h', prefix: label.slice(0, label.length - base.length).trim() };
  }
  for (const base of bases.weekly) {
    if (base && label.endsWith(base)) return { kind: 'weekly', prefix: label.slice(0, label.length - base.length).trim() };
  }
  if (/\b(5|five)[\s-]?(h|hr|hour)/i.test(label)) return { kind: '5h', prefix: '' };
  if (/\b(7|seven)[\s-]?day|\bweek/i.test(label)) return { kind: 'weekly', prefix: '' };
  if (row.resetAtMs !== undefined && Number.isFinite(row.resetAtMs)) {
    const ahead = row.resetAtMs - now;
    if (ahead > 0 && ahead <= FIVE_HOURS_MS + 60_000) return { kind: '5h', prefix: label };
    if (ahead > 0 && ahead <= WEEK_MS + 3_600_000) return { kind: 'weekly', prefix: label };
  }
  return { kind: 'other', prefix: '' };
}

const validPct = (value: number | null) =>
  value !== null && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;

export function windowsOf(quota: QuotaState, now: number, locale: AppLocale): WindowView[] {
  return quota.rows.map((row, index) => {
    const { kind, prefix } = classifyWindow(row, now, locale);
    return {
      id: `${index}:${row.label}`,
      kind,
      rawLabel: row.label,
      prefix,
      leftPct: validPct(row.remainingPercent),
      quotaAvailable: row.quotaAvailable,
      resetAtMs: row.resetAtMs,
      resetText: row.reset,
      detail: row.detail,
      groupLabel: row.groupLabel,
      groupDescription: row.groupDescription,
      windowLabel: row.windowLabel,
    };
  });
}

export function effectiveLeft(windows: WindowView[]): number | null {
  const core = windows.filter((window) => window.kind !== 'other' && window.prefix === '' && window.leftPct !== null);
  const pool = core.length ? core : windows.filter((window) => window.leftPct !== null);
  if (!pool.length) return null;
  return Math.min(...pool.map((window) => window.leftPct as number));
}

const EXPIRED_RE = /expired|invalid[_ ]grant|unauthori[sz]ed|\b401\b/i;

export function deriveStatus(args: {
  disabled: boolean;
  healthTone: 'success' | 'warning' | 'error' | 'neutral' | 'info';
  healthMessage: string;
  quota: QuotaState;
  windows: WindowView[];
  cooldownActive: boolean;
}): { status: CredentialStatus; detail: string } {
  const { quota, windows } = args;
  if (args.disabled) return { status: 'disabled', detail: '' };
  const errorText = [args.healthMessage, quota.status === 'error' ? quota.error ?? '' : ''].join(' ');
  if (EXPIRED_RE.test(errorText) && (args.healthTone === 'error' || quota.status === 'error')) {
    return { status: 'expired', detail: args.healthMessage || quota.error || '' };
  }
  if (args.cooldownActive) return { status: 'cooldown', detail: '' };
  if (args.healthTone === 'error') return { status: 'error', detail: args.healthMessage };
  if (quota.status === 'error') return { status: 'error', detail: quota.error ?? '' };
  if (quota.status !== 'success' || windows.length === 0) {
    return { status: 'notFetched', detail: '' };
  }
  const known = windows.map((window) => window.leftPct).filter((value): value is number => value !== null);
  if (known.some((value) => value <= 0)) return { status: 'exhausted', detail: '' };
  const effective = effectiveLeft(windows);
  if (effective !== null && effective < 20) return { status: 'limited', detail: '' };
  return { status: 'available', detail: '' };
}

function bankedOf(provider: QuotaProvider, file: AuthFile, quota: QuotaState, now: number): BankedResets | null {
  if (provider !== 'codex' && provider !== 'claude') return null;
  let count = 0;
  let expiries: string[] = [];
  if (provider === 'codex') {
    count = quota.resetCredits ?? 0;
    expiries = quotaResetExpiries(quota);
  } else {
    const grants = quota.claudeResetGrants?.grants ?? [];
    count = grants.reduce((sum, grant) => sum + (grant.usableNow || grant.resetsLeft > 0 ? Math.max(0, grant.resetsLeft) : 0), 0);
    expiries = grants.filter((grant) => grant.endsAt && grant.resetsLeft > 0)
      .map((grant) => grant.endsAt as string)
      .sort((a, b) => (quotaResetInstant(a) ?? Infinity) - (quotaResetInstant(b) ?? Infinity));
  }
  const pendingClaude = provider === 'claude' && hasPendingClaudeReset(file);
  if (count <= 0 && !pendingClaude) return null;
  const soonest = expiries.map((value) => quotaResetInstant(value)).find((value) => value !== undefined);
  return {
    provider, count, expiries, soonestExpiryMs: soonest,
    useSoon: soonest !== undefined && soonest > now && soonest - now < USE_SOON_MS,
    pendingClaude,
  };
}

export function buildAccount(
  file: AuthFile,
  quota: QuotaState,
  now: number,
  locale: AppLocale,
  cooldowns: CooldownInput,
): QuotaAccount | null {
  const provider = providerForFile(file);
  if (!provider) return null;
  const health = authFileHealth(file);
  const windows = windowsOf(quota, now, locale);
  const snapshot = normalizeAuthFileCooldowns(file.cooldowns, cooldowns.receivedAtMs, cooldowns.observedAt);
  const summary = summarizeAuthFileCooldowns(snapshot, now);
  const cooldown: AccountCooldown = {
    active: summary.active, credentialWide: summary.credentialWide,
    modelCount: summary.modelCount, earliestSeconds: summary.earliestSeconds,
  };
  const { status, detail } = deriveStatus({
    disabled: health.disabled, healthTone: health.tone, healthMessage: health.message,
    quota, windows, cooldownActive: cooldown.active.length > 0,
  });
  const resets = windows
    .filter((window) => window.resetAtMs !== undefined && window.resetAtMs > now && (window.leftPct ?? 100) < 100)
    .map((window) => window.resetAtMs as number);
  const fetchedAt = quota.fetchedAt;
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  const source = readString(file, 'source').toLowerCase();
  const name = authFileName(file);
  return {
    key: quotaKey(file),
    file,
    provider,
    fileName: name,
    authIndex,
    label: readString(file, 'email', 'account', 'label') || name,
    identities: authFileIdentities(file),
    plan: quota.plan || readString(file, 'plan_type', 'plan'),
    status,
    statusDetail: detail,
    disabled: health.disabled,
    toggleable: name.toLowerCase().endsWith('.json') && (!source || source === 'file') && !readString(file, 'runtime_only'),
    priority: parseAuthFilePriority(file.priority) ?? 0,
    quota,
    windows,
    effectiveLeftPct: effectiveLeft(windows),
    nextResetMs: resets.length ? Math.min(...resets) : undefined,
    fetchedAt,
    stale: quota.status === 'success' && fetchedAt !== undefined && now - fetchedAt > STALE_AFTER_MS,
    loading: quota.status === 'loading',
    banked: bankedOf(provider, file, quota, now),
    cooldown,
    creditBalance: quota.creditBalance,
    creditsUnlimited: quota.creditsUnlimited,
    canFetch: !health.disabled && Boolean(authIndex),
  };
}

export function groupAccounts(accounts: QuotaAccount[]): ProviderGroup[] {
  const byProvider = new Map<QuotaProvider, QuotaAccount[]>();
  accounts.forEach((account) => {
    byProvider.set(account.provider, [...(byProvider.get(account.provider) ?? []), account]);
  });
  return PROVIDER_ORDER.flatMap((provider) => {
    const list = byProvider.get(provider);
    if (!list) return [];
    const counted = list.filter((account) => !account.disabled && account.effectiveLeftPct !== null);
    const resets = list.map((account) => account.nextResetMs).filter((value): value is number => value !== undefined);
    const counts: ProviderGroup['counts'] = {};
    list.forEach((account) => { counts[account.status] = (counts[account.status] ?? 0) + 1; });
    return [{
      provider,
      accounts: list,
      leftPct: counted.length
        ? counted.reduce((sum, account) => sum + (account.effectiveLeftPct as number), 0) / counted.length
        : null,
      enabled: list.filter((account) => !account.disabled).length,
      total: list.length,
      fetched: list.filter((account) => account.quota.status === 'success').length,
      nextResetMs: resets.length ? Math.min(...resets) : undefined,
      counts,
    }];
  });
}

export function matchesSearch(account: QuotaAccount, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [account.fileName, account.label, account.plan, account.provider, ...account.identities]
    .some((value) => value.toLowerCase().includes(needle));
}

/** Stable order inside a group: needs-attention first is NOT applied; keep routing priority, then name. */
export function sortAccounts(accounts: QuotaAccount[]): QuotaAccount[] {
  return [...accounts].sort((a, b) => b.priority - a.priority
    || a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' }));
}

/** Accounts a user should look at: exhausted, cooling, expired or failing. */
export const NEEDS_ATTENTION: readonly CredentialStatus[] = ['exhausted', 'cooldown', 'expired', 'error'];
