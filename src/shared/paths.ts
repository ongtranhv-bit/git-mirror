import { createHash } from 'node:crypto';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { AppError } from './errors.js';

export function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function validateDestinationDirectory(directory: string): string {
  const trimmed = directory.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!trimmed) throw new AppError('CONFIG_PATH_INVALID', 'Destination directory cannot be empty.');
  if (isAbsolute(trimmed) || /^[A-Za-z]:\//.test(trimmed)) {
    throw new AppError('CONFIG_PATH_INVALID', `Destination directory must be relative: ${directory}`);
  }
  const segments = trimmed.split('/');
  if (segments.some((part) => part === '..' || part === '.' || part === '')) {
    throw new AppError('CONFIG_PATH_INVALID', `Destination directory contains unsafe segments: ${directory}`);
  }
  if (segments.includes('.git')) {
    throw new AppError('CONFIG_PATH_INVALID', `Destination directory cannot contain .git: ${directory}`);
  }
  return trimmed;
}

export function assertDirectoriesDoNotOverlap(entries: Array<{ id: string; directory: string }>): void {
  const normalized = entries.map((entry) => ({ ...entry, directory: validateDestinationDirectory(entry.directory) }));
  for (let index = 0; index < normalized.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < normalized.length; otherIndex += 1) {
      const left = normalized[index];
      const right = normalized[otherIndex];
      if (!left || !right) continue;
      if (
        left.directory === right.directory ||
        left.directory.startsWith(`${right.directory}/`) ||
        right.directory.startsWith(`${left.directory}/`)
      ) {
        throw new AppError(
          'CONFIG_PATH_OVERLAP',
          `Destination directories overlap: ${left.id}=${left.directory}, ${right.id}=${right.directory}`,
        );
      }
    }
  }
}

export function resolveInside(root: string, directory: string): string {
  const safeDirectory = validateDestinationDirectory(directory);
  const rootPath = resolve(root);
  const target = resolve(rootPath, normalize(safeDirectory));
  const rel = relative(rootPath, target);
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) {
    throw new AppError('PATH_TRAVERSAL', `Path escapes workspace: ${directory}`);
  }
  return target;
}

export function sanitizeRtdbKey(value: string): string {
  return Buffer.from(value).toString('base64url');
}
