import type { UsageTimelinePoint } from '../../services/usageTrend';

export type { UsageTimelinePoint };
export type { UsageRecord, UsageEventPage } from '../../pages/UsageEventsView';
export type { UsageAnalysis, UsageCategory } from '../../pages/UsageAnalysisView';

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
