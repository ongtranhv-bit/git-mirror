import { AppError } from '../shared/errors.js';
import type { CodespaceInfo, CodespaceLifecycle, CodespaceMachine, CreateCodespaceInput } from './types.js';

export interface FakeLifecycleOptions {
  login?: string;
  repositoryHead?: string;
  machines?: CodespaceMachine[];
  createFailure?: boolean;
  availableAfterGets?: number;
  stopFailure?: boolean;
}

export class FakeCodespaceLifecycle implements CodespaceLifecycle {
  readonly created: CodespaceInfo[] = [];
  readonly stopped: string[] = [];
  readonly deleted: string[] = [];
  private getCount = 0;

  constructor(private readonly options: FakeLifecycleOptions = {}) {}

  async getAuthenticatedUser(): Promise<{ login: string }> {
    return { login: this.options.login ?? 'test-user' };
  }

  async resolveRepositoryHead(_owner: string, _repo: string, _branch: string): Promise<string> {
    return this.options.repositoryHead ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  }

  async listMachines(_owner: string, _repo: string): Promise<CodespaceMachine[]> {
    return this.options.machines ?? [{ name: 'standardLinux' }];
  }

  async list(): Promise<CodespaceInfo[]> { return this.created.map((item) => ({ ...item })); }

  async create(input: CreateCodespaceInput): Promise<CodespaceInfo> {
    if (this.options.createFailure) throw new AppError('CODESPACE_CREATE_FAILED', 'Fake create failure.');
    const info: CodespaceInfo = {
      name: `fake-${this.created.length + 1}`,
      state: 'Queued',
      repository: `${input.owner}/${input.repo}`,
      branch: input.branch,
      ownerLogin: this.options.login ?? 'test-user',
      ...(input.machine ? { machine: input.machine } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
    };
    this.created.push(info);
    return info;
  }

  async get(name: string): Promise<CodespaceInfo> {
    const found = this.created.find((item) => item.name === name);
    if (!found) throw new AppError('CODESPACE_NOT_FOUND', `Fake Codespace ${name} not found.`);
    this.getCount += 1;
    const availableAfterGets = this.options.availableAfterGets ?? 1;
    const state = this.getCount >= availableAfterGets ? 'Available' : 'Starting';
    return { ...found, state };
  }

  async start(name: string): Promise<CodespaceInfo> {
    const info = await this.get(name);
    return { ...info, state: 'Starting' };
  }

  async stop(name: string): Promise<CodespaceInfo> {
    if (this.options.stopFailure) throw new AppError('CODESPACE_STOP_FAILED', 'Fake stop failure.');
    this.stopped.push(name);
    const found = this.created.find((item) => item.name === name);
    return found ? { ...found, state: 'Shutdown' } : { name, state: 'Shutdown', repository: 'unknown/unknown' };
  }

  async delete(name: string): Promise<void> {
    this.deleted.push(name);
  }
}
