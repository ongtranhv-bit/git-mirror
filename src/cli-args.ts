export interface ParsedArgs {
  command: string;
  positionals: string[];
  options: Record<string, string | boolean>;
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? 'help';
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const [rawKey, inline] = value.slice(2).split('=', 2);
    if (!rawKey) continue;
    if (inline !== undefined) options[rawKey] = inline;
    else if (argv[index + 1] && !argv[index + 1]?.startsWith('--')) {
      options[rawKey] = argv[index + 1] ?? '';
      index += 1;
    } else options[rawKey] = true;
  }
  return { command, positionals, options };
}

export function isHelpRequest(parsed: ParsedArgs): boolean {
  return parsed.command === 'help'
    || parsed.command === '--help'
    || parsed.command === '-h'
    || parsed.options.help === true;
}
