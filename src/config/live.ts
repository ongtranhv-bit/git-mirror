import { stableHash } from '../shared/paths.js';
import type { AppConfig } from '../types.js';

export interface ConfigSnapshot {
  config: AppConfig;
  configHash: string;
  loadedAt: number;
}

export class LiveConfig {
  private current: ConfigSnapshot;

  constructor(config: AppConfig, configHash?: string, loadedAt: number = Date.now()) {
    this.current = { config, configHash: configHash ?? stableHash(JSON.stringify(config)), loadedAt };
  }

  get(): AppConfig {
    return this.current.config;
  }

  getSnapshot(): ConfigSnapshot {
    return this.current;
  }

  swap(config: AppConfig, configHash?: string, loadedAt: number = Date.now()): ConfigSnapshot {
    const previous = this.current;
    this.current = { config, configHash: configHash ?? stableHash(JSON.stringify(config)), loadedAt };
    return previous;
  }
}

export function configHash(config: AppConfig): string {
  return stableHash(JSON.stringify(config));
}
