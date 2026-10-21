/**
 * Pure model of the credentials list: file record -> CredentialRow, the 5-state status mapping, summaries and filters.
 * No React and no I/O so bun tests cover it. Status vocabulary is the kit's (Quota-only states are not produced here).
 */
import { providerInfo } from '../../../ui/providers';
import { authFileRequestStats } from '../../../services/authFileRequests';
import {
  authFileCooldownResetIndex,
  authFileIdentities,
  authFileName,
  isOAuthCredentialFile,
  isRuntimeOnlyAuthFile,
  normalizeOAuthProvider,
  parseAuthFilePriority,
} from '../../../services/authFiles';
import {
  authFileHealth,
  normalizeAuthFileCooldowns,
  summarizeAuthFileCooldowns,
  type AuthFileHealth,
} from '../../../services/authFileHealth';
import { readString } from '../../../services/managementApi';
import { codexMetadataFor } from '../../../services/quotaMetadata';
import { quotaProviderForFile } from '../../../services/quotaService';

export type AuthFile = Record<string, unknown>;

export type CredentialStatus = 'available' | 'cooldown' | 'disabled' | 'expired' | 'error';

export const CREDENTIAL_STATUSES: readonly CredentialStatus[] = ['available', 'cooldown', 'disabled', 'expired', 'error'];

/** Buckets shown by the status filter: every status plus "problems" (cooldown, expired and error together). */
export type CredentialStatusFilter = 'all' | CredentialStatus | 'problems';
export const PROBLEM_STATUSES: readonly CredentialStatus[] = ['cooldown', 'expired', 'error'];

export type CredentialRow = {
  /** Unique list key (file name plus auth index when the core supplies one). */
  key: string;
  /** Raw file name: the request key. Display it through `<Masked/>`. */
  name: string;
  /** Normalized brand id: codex claude antigravity kimi xai devin meta gemini vertex … */
  provider: string;
  identity: string;
  identities: string[];
  plan: string;
  status: CredentialStatus;
  /** Includes warning/error health states and active cooldowns for the Problems filter. */
  problem: boolean;
  /** Cooldown time left / the core's status message, already privacy-neutral text (callers mask). */
  statusDetail?: string;
  /** Epoch ms when the earliest active cooldown ends; set only for `cooldown`. */
  cooldownUntilMs?: number;
  disabled: boolean;
  runtimeOnly: boolean;
  /** OAuth credential files can be toggled, edited and deleted; runtime/API entries cannot. */
  editable: boolean;
  priority: number;
  requests?: { ok: number; fail: number };
  /** Provider id the Quota page can query for this file, if any (drives the "Quota →" link). */
  quotaProvider: string | null;
  authIndex?: string;
  file: AuthFile;
};

export type CredentialSnapshot = { files: AuthFile[]; receivedAtMs: number; observedAt?: string };

const EXPIRED_REASONS = new Set([
  'authFiles.health.reason.tokenExpired',
  'authFiles.health.reason.invalidGrant',
  'authFiles.health.reason.unauthorized',
]);
const EXPIRED_MESSAGE = /expired|invalid[_ -]?grant|unauthori[sz]ed|re-?auth|sign in again|login again/i;

/** Brand id for a credential file: kit provider id when known, otherwise the normalized raw type. */
export function credentialBrand(file: AuthFile): string {
  const raw = normalizeOAuthProvider(readString(file, 'provider', 'type', 'account_type'));
  if (!raw) return 'other';
  const info = providerInfo(raw);
  return info.id === 'other' ? raw : info.id;
}

function isExpired(health: AuthFileHealth): boolean {
  if (EXPIRED_REASONS.has(health.label)) return true;
  return health.tone === 'error' && EXPIRED_MESSAGE.test(health.message);
}

/**
 * disabled > expired (sign-in needed) > cooldown (an active restriction timer) > error > available.
 * A quota-exhausted credential usually reports status "error" with a cooldown timer: that reads as cooldown.
 */
export function credentialStatus(
  file: AuthFile,
  receivedAtMs: number,
  nowMs: number,
  observedAt?: string,
): { status: CredentialStatus; detail?: string; cooldownUntilMs?: number } {
  const health = authFileHealth(file);
  if (health.disabled) return { status: 'disabled' };
  if (isExpired(health)) return { status: 'expired', detail: health.message || undefined };
  const cooldown = summarizeAuthFileCooldowns(normalizeAuthFileCooldowns(file.cooldowns, receivedAtMs, observedAt), nowMs);
  if (cooldown.active.length > 0) {
    return {
      status: 'cooldown',
      detail: health.message || undefined,
      cooldownUntilMs: nowMs + cooldown.earliestSeconds * 1000,
    };
  }
  if (health.tone === 'error') return { status: 'error', detail: health.message || undefined };
  return { status: 'available' };
}

export function credentialPlan(file: AuthFile): string {
  const explicit = readString(file, 'plan_type', 'plan');
  if (explicit) return explicit;
  return credentialBrand(file) === 'codex' ? codexMetadataFor(file).plan ?? '' : '';
}

export function buildCredentialRow(file: AuthFile, snapshot: Pick<CredentialSnapshot, 'receivedAtMs' | 'observedAt'>, nowMs: number): CredentialRow {
  const name = authFileName(file);
  const authIndex = authFileCooldownResetIndex(file);
  const identities = authFileIdentities(file);
  const status = credentialStatus(file, snapshot.receivedAtMs, nowMs, snapshot.observedAt);
  const health = authFileHealth(file);
  const stats = authFileRequestStats(file);
  const hasTotals = stats.success !== null || stats.failure !== null;
  return {
    key: authIndex ? `${name}#${authIndex}` : name,
    name,
    provider: credentialBrand(file),
    identity: readString(file, 'email', 'account', 'label') || readString(file, 'project_id', 'projectId'),
    identities,
    plan: credentialPlan(file),
    status: status.status,
    problem: status.status === 'cooldown' || status.status === 'expired' || status.status === 'error'
      || health.tone === 'warning' || health.tone === 'error',
    statusDetail: status.detail,
    cooldownUntilMs: status.cooldownUntilMs,
    disabled: status.status === 'disabled',
    runtimeOnly: isRuntimeOnlyAuthFile(file),
    editable: isOAuthCredentialFile(file),
    priority: parseAuthFilePriority(file.priority) ?? 0,
    requests: hasTotals ? { ok: stats.success ?? 0, fail: stats.failure ?? 0 } : undefined,
    quotaProvider: quotaProviderForFile(file),
    authIndex,
    file,
  };
}

export function buildCredentialRows(snapshot: CredentialSnapshot, nowMs: number): CredentialRow[] {
  return snapshot.files.map((file) => buildCredentialRow(file, snapshot, nowMs));
}

export type StatusCounts = Record<CredentialStatus, number>;
export type BrandSummary = { total: number; byStatus: StatusCounts };

export const emptyStatusCounts = (): StatusCounts => ({ available: 0, cooldown: 0, disabled: 0, expired: 0, error: 0 });

export function summarizeByBrand(rows: readonly CredentialRow[]): Map<string, BrandSummary> {
  const summary = new Map<string, BrandSummary>();
  for (const row of rows) {
    const entry = summary.get(row.provider) ?? { total: 0, byStatus: emptyStatusCounts() };
    entry.total += 1;
    entry.byStatus[row.status] += 1;
    summary.set(row.provider, entry);
  }
  return summary;
}

export type CredentialFilterValue = { query: string; provider: string; status: CredentialStatusFilter };
export const defaultCredentialFilter: CredentialFilterValue = { query: '', provider: 'all', status: 'all' };

export function matchesStatus(row: CredentialRow, status: CredentialStatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'problems') return row.problem;
  return row.status === status;
}

export function filterCredentials(
  rows: readonly CredentialRow[],
  { query, provider, status }: Partial<CredentialFilterValue>,
): CredentialRow[] {
  const needle = (query ?? '').trim().toLowerCase();
  return rows.filter((row) => {
    if (provider && provider !== 'all' && row.provider !== provider) return false;
    if (status && !matchesStatus(row, status)) return false;
    if (!needle) return true;
    return [row.name, providerInfo(row.provider).name, row.identity, row.plan, readString(row.file, 'note'), readString(row.file, 'prefix')]
      .join(' ').toLowerCase().includes(needle);
  });
}

/** Rows per status filter chip for a list already narrowed by provider/search (so chip counts stay consistent). */
export function statusFilterCounts(rows: readonly CredentialRow[]): Record<CredentialStatusFilter, number> {
  const counts = emptyStatusCounts();
  rows.forEach((row) => { counts[row.status] += 1; });
  return {
    all: rows.length,
    ...counts,
    problems: rows.filter((row) => row.problem).length,
  };
}

export function providerFilterCounts(rows: readonly CredentialRow[]): Array<{ provider: string; count: number }> {
  const counts = new Map<string, number>();
  rows.forEach((row) => counts.set(row.provider, (counts.get(row.provider) ?? 0) + 1));
  return [...counts]
    .map(([provider, count]) => ({ provider, count }))
    .sort((left, right) => right.count - left.count || providerInfo(left.provider).name.localeCompare(providerInfo(right.provider).name));
}

/** Request mini-bar proportions; null when the core reported no totals. */
export function requestShare(requests: CredentialRow['requests']): { okPct: number; failPct: number } | null {
  if (!requests) return null;
  const total = requests.ok + requests.fail;
  if (total === 0) return { okPct: 0, failPct: 0 };
  return { okPct: (requests.ok / total) * 100, failPct: (requests.fail / total) * 100 };
}
