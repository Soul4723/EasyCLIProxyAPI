import { describe, expect, test } from 'bun:test';
import { formatBytes, formatCompactNumber, formatDurationParts, formatLatency, formatNumericDateTime24, formatPercent, formatShortDateTime, formatUsageNumber } from '../src/services/format';
import { translateUi } from '../src/ui/uiText';

describe('shared formatters preserve distinct display contracts', () => {
  test('translated durations retain units, flooring, zero and part limits', () => {
    const t = (key: Parameters<typeof translateUi>[1], vars?: Record<string, string | number>) => translateUi('en', key, vars);
    expect(formatDurationParts(6_480_000, t)).toBe('1h 48m');
    expect(formatDurationParts(3 * 86_400_000 + 6 * 3_600_000, t)).toBe('3d 6h');
    expect(formatDurationParts(22 * 60_000, t)).toBe('22m');
    expect(formatDurationParts(45_999, t)).toBe('45s');
    expect(formatDurationParts(0, t)).toBe('0s');
    expect(formatDurationParts(-1000, t)).toBe('0s');
    expect(formatDurationParts(6_480_000, t, 1)).toBe('1h');
    expect(formatDurationParts(3_601_000, t)).toBe('1h 1s');
    expect(formatDurationParts(6_480_000, (key, vars) => translateUi('ja', key, vars))).toBe('1時間 48分');
  });

  test('latency and compact counts do not adopt duration/Intl compact rules', () => {
    expect(formatLatency(842, 'en-US')).toBe('842 ms');
    expect(formatLatency(1_284, 'en-US')).toBe('1.28 s');
    expect(formatLatency(12_840, 'en-US')).toBe('12.8 s');
    expect(formatLatency(Number.NaN, 'en-US')).toBe('0 ms');
    expect(formatUsageNumber(999_950, 'en-US')).toBe('1M');
    expect(formatCompactNumber(1_000, 'ja')).toBe('1000');
    expect(formatUsageNumber(1_000, 'ja')).toBe('1K');
  });

  test('bytes and percentages retain rounding and invalid-value handling', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatPercent(42.25, 1, 'en-US')).toBe('42.3%');
    expect(formatPercent(42.25, 1, 'de')).toBe('42,3%');
  });

  test('merged date options retain local time and locale for every app locale', () => {
    const at = new Date(2026, 9, 19, 14, 5).getTime();
    expect(formatShortDateTime(at, 'en')).toBe('Oct 19, 02:05 PM');
    expect(formatNumericDateTime24(at, 'en')).toBe('10/19, 14:05');
    for (const locale of ['en', 'ja', 'zh-CN', 'zh-TW']) {
      expect(formatShortDateTime(at, locale)).toBe(new Intl.DateTimeFormat(locale, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }).format(at));
      expect(formatNumericDateTime24(at, locale)).toBe(new Intl.DateTimeFormat(locale, {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(at));
    }
  });
});
