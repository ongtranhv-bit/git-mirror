import { spawn } from 'node:child_process';
import { AppError } from './errors.js';
import { redactSecrets } from './logger.js';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  allowFailure?: boolean;
  errorCode?: string;
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
        }, options.timeoutMs)
      : undefined;
    timer?.unref();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(
        new AppError(options.errorCode ?? 'PROCESS_START_FAILED', `Failed to start ${command}: ${redactSecrets(error.message)}`, {
          retryable: true,
          cause: error,
        }),
      );
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const exitCode = code ?? 1;
      const result = { stdout, stderr, exitCode };
      if (exitCode === 0 || options.allowFailure) {
        resolve(result);
        return;
      }
      const combined = redactSecrets(`${stderr}\n${stdout}`.trim());
      reject(
        new AppError(
          timedOut ? 'PROCESS_TIMEOUT' : options.errorCode ?? 'PROCESS_FAILED',
          timedOut ? `${command} timed out after ${options.timeoutMs}ms.` : `${command} exited with code ${exitCode}: ${combined}`,
          {
            retryable: timedOut || /timed out|connection reset|could not resolve|temporarily unavailable|non-fast-forward|fetch first|failed to push some refs/i.test(combined),
            context: { command, exitCode, args: args.map(sanitizeArgument) },
          },
        ),
      );
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function sanitizeArgument(argument: string): string {
  if (/authorization|token|secret|password|pat=/i.test(argument)) return '[REDACTED]';
  return redactSecrets(argument);
}
