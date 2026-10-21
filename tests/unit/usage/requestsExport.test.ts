import { describe, expect, test } from 'bun:test';
import { usageEventsCsv } from '../../../src/sections/usage/RequestsExport';
import type { UsageRecord } from '../../../src/sections/usage/types';

describe('usage events CSV source privacy', () => {
  test('exports the backend-masked source and stable identifier, not the raw key', () => {
    const maskedSource = 'sk-s••••cdef · #deadbeef';
    const csv = usageEventsCsv([
      {
        id: 'request-1',
        timestamp: '2026-10-20T00:00:00Z',
        source: maskedSource,
        source_display: 'sk-s••••cdef',
        tokens: {
          input_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_tokens: 0,
        },
      } as UsageRecord,
    ]);

    expect(csv).toContain(`"${maskedSource}"`);
    expect(csv).not.toContain('sk-source-secret-1234567890abcdef');
  });
});
