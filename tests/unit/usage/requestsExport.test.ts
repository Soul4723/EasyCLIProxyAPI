import { describe, expect, test } from 'bun:test';
import { usageEventsCsv } from '../../../src/sections/usage/RequestsExport';
import type { UsageRecord } from '../../../src/sections/usage/types';

describe('usage events CSV source privacy', () => {
  test('exports the backend-masked source and stable identifier, not the raw key', () => {
    const maskedSource = 'sk-s••••cdef · #deadbeef';
    const csv = usageEventsCsv([
      { source: maskedSource, source_display: 'sk-s••••cdef' } as UsageRecord,
    ]);

    expect(csv).toContain(`"${maskedSource}"`);
    expect(csv).not.toContain('sk-source-secret-1234567890abcdef');
  });
});
