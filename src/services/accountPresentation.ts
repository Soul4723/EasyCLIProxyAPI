import {
  authFileIdentities,
  isOAuthCredentialFile,
  isRuntimeOnlyAuthFile,
  normalizeOAuthProvider,
} from './authFiles';
import { authFileHealth } from './authFileHealth';
import { normalizeAuthIndex, readString } from './managementApi';
import { providerForFile, quotaKey, type AuthFile, type QuotaState } from './quotaService';

/** A measurement describes one quota window, never whole-account readiness. */
export type QuotaMeasurement = 'unavailable' | 'exhausted' | 'remaining';

/**
 * Pure projection of an already obtained credential and its quota snapshot.
 * No fetch, clock, credential decoding, deduplication, or readiness inference.
 * Text and identities remain unmasked, matching authFiles; renderers must apply
 * the existing privacy mask and localize missing labels at render time.
 */
export function deriveAccountPresentation(file: AuthFile, quota?: QuotaState) {
  const name = readString(file, 'name');
  const rawProvider = readString(file, 'provider', 'type', 'account_type');
  const rows = (quota?.rows ?? []).map((row) => {
    // Reject invalid measurements instead of manufacturing an exhausted window.
    const value = row.remainingPercent;
    const remainingPercent = value !== null && Number.isFinite(value) && value >= 0 && value <= 100
      ? value : null;
    const measurement: QuotaMeasurement = remainingPercent === null ? 'unavailable'
      : remainingPercent === 0 ? 'exhausted' : 'remaining';
    return {
      label: row.label,
      remainingPercent,
      quotaAvailable: row.quotaAvailable,
      measurement,
      reset: row.reset,
      resetAtMs: row.resetAtMs,
      detail: row.detail,
    };
  });

  return {
    // Unnamed entries have no safe synthesized key: don't merge them by label.
    key: name ? quotaKey(file) : null,
    source: {
      name,
      authIndex: normalizeAuthIndex(file.auth_index ?? file.authIndex),
      source: readString(file, 'source'),
      runtimeOnly: isRuntimeOnlyAuthFile(file),
      oauthCredentialFile: isOAuthCredentialFile(file),
    },
    label: readString(file, 'email', 'account', 'label') || name || null,
    identities: authFileIdentities(file),
    provider: {
      raw: rawProvider,
      id: normalizeOAuthProvider(rawProvider) || null,
      // Null means unsupported/unidentified by the existing quota loader, not
      // an invalid credential. OAuth and quota aliases intentionally differ.
      quotaProvider: providerForFile(file),
    },
    health: authFileHealth(file),
    quota: {
      status: quota?.status ?? 'unfetched',
      rows,
      // Counts preserve mixed windows without inventing one account percentage.
      measurements: {
        unavailable: rows.filter((row) => row.measurement === 'unavailable').length,
        exhausted: rows.filter((row) => row.measurement === 'exhausted').length,
        remaining: rows.filter((row) => row.measurement === 'remaining').length,
      },
      error: quota?.error,
      fetchedAt: quota?.fetchedAt,
      plan: quota?.plan,
      creditBalance: quota?.creditBalance,
      creditsUnlimited: quota?.creditsUnlimited,
    },
  };
}
