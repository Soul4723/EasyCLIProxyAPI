import { describe, expect, test } from 'bun:test';
import { latestCheckText, type Translate } from '../src/sections/settings/updates/model';

const t: Translate = (key) => key;

describe('app and core latest check display', () => {
  test('only an active request displays checking, including retries with cached data', () => {
    expect(latestCheckText(true, '', '', t)).toBe('sec.settings.updates.checking');
    expect(latestCheckText(true, '', 'v1.0.0', t)).toBe('sec.settings.updates.checking');
  });
  test('an unstarted or reset check is not checked, not detecting', () => {
    expect(latestCheckText(false, '', '', t)).toBe('sec.settings.updates.notChecked');
  });
  test.each(['All application version check sources failed', 'GitCode fallback is not configured for this build'])('terminal failure: %s', (reason) => {
    expect(latestCheckText(false, reason, '', t)).toBe('sec.settings.updates.checkFailed');
    expect(latestCheckText(false, reason, 'v1.0.0', t)).toBe('sec.settings.updates.checkFailed');
  });
  test.each(['v1.0.0', 'v2.0.0'])('successful up-to-date or available result: %s', (version) => {
    expect(latestCheckText(false, '', version, t)).toBe(version);
  });
  test('retry can transition from failed through checking to success', () => {
    expect([
      latestCheckText(false, 'unreachable', '', t),
      latestCheckText(true, '', '', t),
      latestCheckText(false, '', 'v2.0.0', t),
    ]).toEqual(['sec.settings.updates.checkFailed', 'sec.settings.updates.checking', 'v2.0.0']);
  });
});
