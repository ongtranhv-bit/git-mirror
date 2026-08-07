import type { RtdbClient } from '../rtdb/client.js';
import { AppError } from '../shared/errors.js';
import type { ActiveCodespacePointer, RotationRecord } from './types.js';

export function rotationPaths(basePath = '/sync/codespace') {
  const base = basePath.replace(/\/$/, '');
  return {
    base,
    config: `${base}/config`,
    lock: `${base}/lock`,
    rotations: `${base}/rotations`,
    active: `${base}/active`,
    instances: `${base}/instances`,
    testRuns: `${base}/test-runs`,
  };
}

export async function getRotationRecord(client: RtdbClient, rotationsPath: string, rotationKey: string): Promise<RotationRecord | null> {
  return client.get<RotationRecord>(`${rotationsPath}/${rotationKey}`);
}

export async function putRotationRecord(client: RtdbClient, rotationsPath: string, record: RotationRecord): Promise<void> {
  await client.set(`${rotationsPath}/${record.rotationKey}`, record);
}

export async function promoteActive(input: {
  client: RtdbClient;
  activePath: string;
  previous?: ActiveCodespacePointer;
  next: ActiveCodespacePointer;
}): Promise<void> {
  const result = await input.client.transaction<ActiveCodespacePointer>(input.activePath, (current) => {
    if (input.previous) {
      if (!current || current.codespaceName !== input.previous.codespaceName || current.ownerLogin !== input.previous.ownerLogin) {
        return undefined;
      }
    } else if (current) {
      return undefined;
    }
    return input.next;
  });
  if (!result.committed) {
    throw new AppError('CODESPACE_ACTIVE_CHANGED', 'Active Codespace changed while rotation was running.');
  }
}
