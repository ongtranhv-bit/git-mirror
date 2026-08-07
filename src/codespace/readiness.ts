import type { RtdbClient } from '../rtdb/client.js';
import type { RuntimeReadinessRecord } from './types.js';

export const DEFAULT_CODESPACE_BASE_PATH = '/sync/codespace';

export async function findReadyInstance(input: {
  client: RtdbClient;
  instancesPath: string;
  codespaceName: string;
  expectedCommitSha: string;
  freshnessMs: number;
  now?: number;
}): Promise<RuntimeReadinessRecord | undefined> {
  const all = await input.client.get<Record<string, RuntimeReadinessRecord>>(input.instancesPath);
  const now = input.now ?? Date.now();
  return Object.values(all ?? {}).find((item) =>
    item.codespaceName === input.codespaceName
    && item.status === 'ready'
    && item.rtdbConnected
    && item.listenerAttached
    && item.runtimeCommitSha === input.expectedCommitSha
    && now - item.heartbeatAt <= input.freshnessMs,
  );
}
