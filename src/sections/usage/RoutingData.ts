import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { managementApi, normalizeAuthIndex, readString, responseList } from '../../services/managementApi';
import {
  authFileIdentities, authFileName, dedupeAuthFiles, normalizeOAuthProvider, parseAuthFilePriority, sortAuthFilesByPriority,
} from '../../services/authFiles';
import { authFileHealth, normalizeAuthFileCooldowns, summarizeAuthFileCooldowns } from '../../services/authFileHealth';
import { providerInfo, type CredentialStatus } from '../../ui';
import type { UsageEventPage, UsageRecord } from './types';

/** Subset of the CoreConfigSettings returned by get_core_config_settings that the routing tab shows. */
export type RoutingPolicy = {
  routingStrategy: string;
  routingSessionAffinity: boolean;
  routingSessionAffinityTtl: string;
  requestRetry: number;
  maxRetryCredentials: number;
  maxRetryInterval: number;
  disableCooling: boolean;
};

export type Candidate = {
  key: string;
  authIndex: string;
  /** Raw display text: email when present, otherwise the file name. Always render through <Masked/>. */
  label: string;
  labelIsFile: boolean;
  identities: string[];
  provider: string;
  priority: number;
  status: CredentialStatus;
  /** Absolute ms when the earliest active cooldown ends (status === 'cooldown'). */
  cooldownUntil: number | null;
  /** 1-based position inside its provider group in routing order. */
  rank: number;
};

export type CandidateGroup = { provider: string; items: Candidate[] };

export type Block<T> = { data: T | null; error: boolean; loading: boolean; reload: () => void };

/**
 * Loads one independent block. Reloads when `key` changes (a refresh tick); keeps the previous data while refetching
 * and ignores responses that arrive out of order.
 */
export function useBlock<T>(fetcher: () => Promise<T>, key: number): Block<T> {
  const [state, setState] = useState<{ data: T | null; error: boolean; loading: boolean }>({ data: null, error: false, loading: true });
  const request = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const load = useCallback(() => {
    const id = ++request.current;
    fetcherRef.current().then(
      (data) => { if (id === request.current) setState({ data, error: false, loading: false }); },
      () => { if (id === request.current) setState((s) => ({ data: s.data, error: true, loading: false })); },
    );
  }, []);
  useEffect(() => { load(); }, [load, key]);
  const reload = useCallback(() => { setState((s) => ({ ...s, loading: s.data === null })); load(); }, [load]);
  return { ...state, reload };
}

export const fetchPolicy = () => invoke<RoutingPolicy>('get_core_config_settings');

export const fetchEvents = () => invoke<UsageEventPage>('get_usage_events', { query: { page: 1, page_size: 50 } });

type CredentialSnapshot = { files: Record<string, unknown>[]; receivedAtMs: number; observedAt?: string };

export async function fetchCredentials(): Promise<CredentialSnapshot> {
  const payload = await managementApi.get('/credentials');
  const receivedAtMs = Date.now();
  const observedAt = readString(payload, 'observed_at', 'observedAt') || undefined;
  return { files: dedupeAuthFiles(responseList(payload, 'files')), receivedAtMs, observedAt };
}

const statusOf = (file: Record<string, unknown>, snapshot: CredentialSnapshot): { status: CredentialStatus; until: number | null } => {
  const health = authFileHealth(file);
  if (health.disabled) return { status: 'disabled', until: null };
  const cooldowns = normalizeAuthFileCooldowns(file.cooldowns, snapshot.receivedAtMs, snapshot.observedAt);
  const summary = summarizeAuthFileCooldowns(cooldowns, snapshot.receivedAtMs);
  if (summary.active.length) return { status: 'cooldown', until: snapshot.receivedAtMs + summary.earliestSeconds * 1000 };
  if (health.tone === 'error') return { status: 'error', until: null };
  if (health.tone === 'success') return { status: 'available', until: null };
  return { status: 'notFetched', until: null };
};

/** Credentials grouped by provider; inside a group in routing order (priority desc, then name). */
export function buildGroups(snapshot: CredentialSnapshot | null): CandidateGroup[] {
  if (!snapshot) return [];
  const byProvider = new Map<string, Record<string, unknown>[]>();
  for (const file of snapshot.files) {
    const provider = normalizeOAuthProvider(readString(file, 'provider', 'type')) || 'other';
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), file]);
  }
  return [...byProvider.entries()]
    .map(([provider, files]) => ({
      provider,
      items: sortAuthFilesByPriority(files).map((file, index): Candidate => {
        const email = readString(file, 'email').trim();
        const { status, until } = statusOf(file, snapshot);
        return {
          key: `${authFileName(file)}::${normalizeAuthIndex(file.auth_index ?? file.authIndex)}`,
          authIndex: normalizeAuthIndex(file.auth_index ?? file.authIndex),
          label: email || authFileName(file),
          labelIsFile: !email,
          identities: authFileIdentities(file),
          provider,
          priority: parseAuthFilePriority(file.priority) ?? 0,
          status,
          cooldownUntil: until,
          rank: index + 1,
        };
      }),
    }))
    .sort((a, b) => b.items.length - a.items.length || providerInfo(a.provider).name.localeCompare(providerInfo(b.provider).name));
}

/** Real records carry auth_index; `source` is accepted only when it equals a known credential index (browser mock fixtures). */
export const eventAuthIndex = (event: UsageRecord, known: { has: (index: string) => boolean }): string => {
  const direct = normalizeAuthIndex((event as UsageRecord & { auth_index?: string }).auth_index);
  if (direct) return direct;
  const source = normalizeAuthIndex(event.source);
  return known.has(source) ? source : '';
};

export type ServedBy = { key: string; label: string; labelIsFile: boolean; identities: string[]; provider: string; count: number };

/** Counts of recent events per serving account (matched by auth_index; falls back to the event's source label). */
export function serveCounts(events: UsageRecord[], groups: CandidateGroup[]): { byAuthIndex: Map<string, number>; rows: ServedBy[] } {
  const known = new Map<string, Candidate>();
  groups.forEach((g) => g.items.forEach((c) => { if (c.authIndex) known.set(c.authIndex, c); }));
  const byAuthIndex = new Map<string, number>();
  const rows = new Map<string, ServedBy>();
  for (const event of events) {
    const index = eventAuthIndex(event, known);
    const candidate = index ? known.get(index) : undefined;
    if (index) byAuthIndex.set(index, (byAuthIndex.get(index) ?? 0) + 1);
    const key = candidate ? `auth:${index}` : `src:${event.source_display || event.source}`;
    const row = rows.get(key) ?? {
      key,
      label: candidate?.label ?? (event.source_display || event.source),
      labelIsFile: candidate?.labelIsFile ?? false,
      identities: candidate?.identities ?? [],
      provider: candidate?.provider ?? event.provider,
      count: 0,
    };
    row.count += 1;
    rows.set(key, row);
  }
  return { byAuthIndex, rows: [...rows.values()].sort((a, b) => b.count - a.count) };
}

/** Event → serving candidate (by auth_index). */
export function useCandidateIndex(groups: CandidateGroup[]) {
  return useMemo(() => {
    const map = new Map<string, Candidate>();
    groups.forEach((g) => g.items.forEach((c) => { if (c.authIndex) map.set(c.authIndex, c); }));
    return map;
  }, [groups]);
}
