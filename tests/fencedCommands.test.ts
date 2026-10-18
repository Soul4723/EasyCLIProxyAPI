import { expect, test } from 'bun:test';
import { assertFencedArgs } from '../src/mocks/fencedCommands';

test('the browser mock rejects fenced commands without expectedRevision, as native argument parsing does', () => {
  expect(() => assertFencedArgs('start_oauth_login', { provider: 'codex' })).toThrow(/missing required key expectedRevision/);
  expect(() => assertFencedArgs('management_request', { request: { method: 'GET', path: '/config' } })).toThrow(/expectedRevision/);
  expect(() => assertFencedArgs('get_oauth_status', undefined)).toThrow(/expectedRevision/);
  expect(() => assertFencedArgs('start_oauth_login', { provider: 'codex', expectedRevision: 3 })).not.toThrow();
  expect(() => assertFencedArgs('management_request', { request: { expectedRevision: 0 } })).not.toThrow();
  expect(() => assertFencedArgs('get_core_status', {})).not.toThrow();
});
