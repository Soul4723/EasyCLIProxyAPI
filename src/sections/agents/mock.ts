import type { SectionMockFactory } from '../../mocks/sectionMockTypes';

type MockSession = { id: string; title: string; cwd: string; modelProvider: string; archived: boolean; updatedAtMs: number; databasePath: string };

const SESSION_TITLES = [
  'Refactor the usage collector', 'Fix quota refresh race', 'Review legacy UI', 'Write migration notes', 'Debug OAuth callback',
  'Tune retry backoff', 'Add pagination to requests log', 'Explain the routing strategy', 'Port the plugin store', 'Investigate slow startup',
];

function manySessions(): MockSession[] {
  return Array.from({ length: 64 }, (_, index) => ({
    id: `mock-session-${index + 10}`,
    title: index % 9 === 8 ? '' : `${SESSION_TITLES[index % SESSION_TITLES.length]} #${index + 1}`,
    cwd: index % 7 === 6 ? '' : `/home/mock/projects/${['proxy', 'quota-router', 'dashboard', 'docs'][index % 4]}/packages/service-${index}`,
    modelProvider: ['cpa-gui', 'openai', 'deepseek'][index % 3],
    archived: index % 5 === 4,
    updatedAtMs: Date.now() - (index + 1) * 47 * 60_000,
    databasePath: '/home/mock/.codex/state_5.sqlite',
  }));
}

type MockBackup = {
  id: string; createdAt: string; fileCount: number; location: string;
  files: { path: string; exists: boolean | null; size: number | null }[]; restorable: boolean; error: string | null;
};

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

/**
 * Browser-mock handlers owned by the agents section (see src/mocks/sectionMocks.ts).
 * Sessions page states, chosen with `?mockSessions=`: `many` (67 sessions → pagination), `none` (empty), `warn`
 * (page with warnings) or `error` (list fails). Anything else falls through to the shared mock.
 * Config backups (list/create/delete) are kept in memory per client, seeded with one restorable and one broken version.
 */
export const agentsMock: SectionMockFactory = (host) => {
  const variant = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('mockSessions');
  let seeded = false;
  const backups = new Map<string, MockBackup[]>();
  const makeBackup = (client: string, id: string, createdAt: string, restorable = true): MockBackup => ({
    id, createdAt, fileCount: 2, location: `C:\\EasyCLIProxyAPI\\agent-backups\\${client}\\${id}`,
    files: restorable
      ? [{ path: 'settings.json', exists: true, size: 1_428 }, { path: 'models.json', exists: false, size: null }]
      : [{ path: 'settings.json', exists: null, size: null }],
    restorable, error: restorable ? null : 'Backup manifest is missing',
  });
  const backupsFor = (client: string) => {
    if (!backups.has(client)) backups.set(client, [makeBackup(client, 'seed-2', hoursAgo(5)), makeBackup(client, 'seed-1', hoursAgo(52), false)]);
    return backups.get(client)!;
  };
  return {
    handle(command, payload) {
      const client = String(payload.client ?? '');
      if (command === 'list_agent_config_backups') return { handled: true, value: { versions: backupsFor(client).map((item) => ({ ...item })) } };
      if (command === 'create_agent_config_backup') {
        backupsFor(client).unshift(makeBackup(client, `manual-${Date.now()}`, new Date().toISOString()));
        return { handled: true, value: null };
      }
      if (command === 'delete_agent_config_backup') {
        backups.set(client, backupsFor(client).filter((item) => item.id !== payload.id));
        return { handled: true, value: null };
      }
      if (command !== 'list_codex_sessions' || !variant) return { handled: false };
      if (variant === 'error') throw new Error('database is locked: state_5.sqlite');
      const sessions = host.codexSessions as MockSession[];
      if (variant === 'many') {
        if (!seeded) {
          seeded = true;
          sessions.push(...manySessions());
        }
        return { handled: false };
      }
      const request = (payload.request ?? {}) as { offset?: number; limit?: number };
      const offset = Math.max(0, Number(request.offset) || 0);
      const limit = Math.max(1, Number(request.limit) || 50);
      const rows = variant === 'none' ? [] : sessions;
      return {
        handled: true,
        value: {
          codexHome: '/home/mock/.codex',
          databasePaths: variant === 'none' ? [] : ['/home/mock/.codex/state_5.sqlite'],
          sessions: rows.slice(offset, offset + limit),
          totalCount: rows.length,
          offset,
          limit,
          hasMore: offset + limit < rows.length,
          warnings: variant === 'warn'
            ? ['Skipped /home/mock/.codex/sessions/2026/01/rollout-broken.jsonl: invalid JSON on line 3', 'Legacy database state.sqlite was ignored']
            : [],
        },
      };
    },
  };
};
