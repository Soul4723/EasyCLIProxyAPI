import { chooseUsageExportPath, invoke } from '../../services/usageApi';
import type { UsageEventPage, UsageQuery, UsageRecord } from './types';

export function usageEventsExportName(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `usage-events-${date.getFullYear()}-${month}-${day}.csv`;
}

/** CSV of full records (formula-injection safe, BOM for Excel). Ported from the old events view. */
export function usageEventsCsv(records: UsageRecord[]) {
  const headers = ['id', 'row_id', 'timestamp', 'api_key_display', 'api_key_remark', 'api_key_hash', 'source', 'source_display', 'provider', 'agent', 'model', 'alias', 'response_model', 'reasoning_effort', 'endpoint', 'failed', 'canceled', 'failure_status', 'failure_body', 'latency_ms', 'ttft_ms', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'total_tokens', 'estimated_cost_usd', 'pricing_model'];
  const csvCell = (value: string | number | boolean | null) => {
    const text = value == null ? '' : String(value);
    const safe = typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = records.map((r) => [r.id, r.row_id, r.timestamp, r.api_key_display, r.api_key_remark, r.api_key_hash, r.source, r.source_display, r.provider, r.agent ?? 'unknown', r.model, r.alias, r.response_model ?? '', r.reasoning_effort, r.endpoint, r.failed, r.canceled, r.failure_status, r.failure_body, r.latency_ms, r.ttft_ms, r.tokens.input_tokens, r.tokens.output_tokens, r.tokens.reasoning_tokens, r.tokens.cache_read_tokens, r.tokens.cache_creation_tokens, r.tokens.total_tokens, r.cost?.total ?? null, r.cost?.pricing_model ?? '']);
  return '﻿' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * Asks for a path, pages through every event matching `query`, writes the CSV via save_usage_events_export.
 * Resolves with the number of exported rows, or null when the save dialog was cancelled.
 */
export async function exportFilteredEvents(query: UsageQuery, dialog: { title: string; fileType: string }): Promise<number | null> {
  const path = await chooseUsageExportPath({ title: dialog.title, defaultPath: usageEventsExportName(), fileType: dialog.fileType });
  if (!path) return null;
  const items: UsageRecord[] = [];
  const pageSize = 5000;
  for (let page = 1; ; page += 1) {
    const exported = await invoke<UsageEventPage>('get_usage_events', { query: { ...query, page, page_size: pageSize } });
    if (exported.page !== page || exported.items.length === 0) break;
    items.push(...exported.items);
    if (items.length >= exported.total || page >= exported.totalPages) break;
  }
  await invoke('save_usage_events_export', { path, contents: usageEventsCsv(items) });
  return items.length;
}
