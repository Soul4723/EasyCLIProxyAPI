import { createDataSource } from './dataSource';
import { dedupeAuthFiles, sortAuthFilesByPriority } from './authFiles';
import { managementApi, readString, responseList } from './managementApi';

export const credentialsSource = createDataSource({
  events: ['config-files-changed'],
  minIntervalMs: 1_000,
  load: async () => {
    const payload = await managementApi.get('/credentials');
    return {
      files: sortAuthFilesByPriority(dedupeAuthFiles(responseList(payload, 'files'))),
      receivedAtMs: Date.now(), observedAt: readString(payload, 'observed_at') || undefined,
    };
  },
});
