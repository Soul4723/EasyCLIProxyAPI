import type { UsageTimelinePoint } from '../../services/usageTrend';

export type { UsageTimelinePoint };
/** One collected request (get_usage_events item). */
export type UsageRecord = {
  id: string;
  row_id: string;
  timestamp: string;
  latency_ms: number;
  ttft_ms: number | null;
  source: string;
  source_display: string;
  failed: boolean;
  canceled: boolean;
  failure_status: number;
  failure_body: string;
  provider: string;
  agent?: string;
  auth_type?: string;
  model: string;
  /** Model name reported by the upstream response, when available. */
  response_model?: string;
  cost?: { total: number; pricing_model: string } | null;
  alias: string;
  reasoning_effort: string;
  service_tier?: string;
  response_service_tier?: string;
  endpoint: string;
  api_key_hash: string;
  api_key_display: string;
  api_key_remark: string;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_tokens: number;
  };
};

export type UsageEventPage = {
  items: UsageRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type UsageCategory = {
  key: string;
  label: string;
  requests: number;
  failures: number;
  tokens: number;
};

export type UsageAnalysis = {
  models: UsageCategory[];
  providers: UsageCategory[];
  sources: UsageCategory[];
  apiKeys: UsageCategory[];
  upstreams?: (UsageCategory & { provider: string })[];
};

export type UsageRange = '4h' | '24h' | 'today' | '7d' | '30d' | 'all' | 'custom';

export type CollectorStatus = {
  state: 'waiting-core' | 'collecting' | 'error' | 'paused';
  connectionMode?: 'local' | 'remote';
  remoteOrigin?: string | null;
  targetRevision?: number;
  paused?: boolean;
  message: string;
  lastCollectedAt: string | null;
  totalRecords: number;
};

export type UsageOverview = {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  canceledCount: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  rpm: number;
  tpm: number;
  tps: number;
  tpsSampleCount: number;
  averageLatencyMs: number;
  cacheHitRate: number;
  estimatedCost: number;
  pricedRequests: number;
  timeline: UsageTimelinePoint[];
};

export type ModelPrice = {
  model: string;
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheCreation: number;
  promptConfigured: boolean;
  completionConfigured: boolean;
  cacheReadConfigured: boolean;
  cacheCreationConfigured: boolean;
  source: string;
  sourceModelId: string;
  updatedAtMs: number;
};

export type UsagePriceRow = {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  estimatedCost: number;
  price: ModelPrice | null;
};

export type UsagePricing = {
  rows: UsagePriceRow[];
  totalCost: number;
  totalRequests: number;
  pricedRequests: number;
  savedPrices: number;
};

export type UsageRepairResult = { scanned: number; repaired: number; deleted: number; backupPath: string | null };
export type UsageStorageSettings = { maxDatabaseSizeMb: number; databaseSizeBytes: number; totalRecords: number; deletedRecords: number };
export type ModelPriceSyncResult = { imported: number };
export type ModelPriceSyncPreview = { source: string; sourceUrl: string; matches: ModelPrice[]; unmatched: string[] };

/** Query object accepted by get_usage_overview / get_usage_events / get_usage_analysis / get_usage_pricing. */
export type UsageQuery = {
  agent?: string;
  start?: string;
  end?: string;
  model?: string;
  provider?: string;
  source?: string;
  upstream?: string;
  api_key_hash?: string;
  failed?: boolean;
  canceled?: boolean;
  page?: number;
  page_size?: number;
};
