import { describe, expect, it } from 'bun:test';
import { agentsSubs, agentsSubsFor } from '../../../src/sections/agents/subs';

describe('agents sub-tabs by connection mode', () => {
  it('keeps Codex sessions in Local mode', () => {
    expect(agentsSubsFor(false).map((sub) => sub.id)).toEqual(['clients', 'sessions']);
    expect(agentsSubsFor(false)).toBe(agentsSubs);
  });
  it('hides Codex sessions in Remote mode and keeps the default tab', () => {
    expect(agentsSubsFor(true).map((sub) => sub.id)).toEqual(['clients']);
  });
});
