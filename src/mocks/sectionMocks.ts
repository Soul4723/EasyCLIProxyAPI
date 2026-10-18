import { overviewMock } from '../sections/overview/mock';
import { providersMock } from '../sections/providers/mock';
import { quotaMock } from '../sections/quota/mock';
import { usageMock } from '../sections/usage/mock';
import { agentsMock } from '../sections/agents/mock';
import { pluginsMock } from '../sections/plugins/mock';
import { settingsMock } from '../sections/settings/mock';
import type { SectionMockFactory } from './sectionMockTypes';

/**
 * Per-section browser-mock handlers. A section adds commands/management routes in its own
 * `src/sections/<name>/mock.ts` (never in browserMockRuntime.ts). Handlers run after the plugin mock and
 * before the shared switch; return `{ handled: false }` to fall through.
 */
export const sectionMocks: readonly SectionMockFactory[] = [
  overviewMock, providersMock, quotaMock, usageMock, agentsMock, pluginsMock, settingsMock,
];
