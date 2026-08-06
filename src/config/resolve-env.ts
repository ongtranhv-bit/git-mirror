import { AppError } from '../shared/errors.js';

const ENV_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export function interpolateEnvironment<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  return walk(value, env) as T;
}

function walk(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_PATTERN, (_match, name: string) => {
      const resolved = env[name];
      if (resolved === undefined) {
        throw new AppError('CONFIG_ENV_MISSING', `Environment variable ${name} is referenced but not set.`, {
          context: { envName: name },
        });
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, env)]));
  }
  return value;
}
