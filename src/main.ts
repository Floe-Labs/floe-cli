import { parseArgs } from 'node:util';
import { registry, SECTIONS } from './commands/index.js';
import { ApiError } from './lib/api.js';
import { GLOBAL_OPTIONS, type CommandContext, type CommandDef, type OptionValue } from './lib/command.js';
import { bold, cyan, errDim, errRed, sanitizeText, UsageError } from './lib/output.js';
import { cliVersion } from './lib/version.js';

function renderHelp(): string {
  const lines: string[] = [
    `${bold('floe')} — the Floe platform CLI: agents, keys, budgets, and metered calls`,
    '',
    bold('USAGE'),
    '  floe <command> [flags]',
    '  floe help <command>',
  ];
  const width = Math.max(...[...registry.keys()].map((n) => n.length));
  for (const section of SECTIONS) {
    lines.push('', bold(section.title));
    for (const def of section.commands) {
      lines.push(`  ${cyan(def.name.padEnd(width))}  ${def.summary}`);
    }
  }
  lines.push(
    '',
    bold('GLOBAL FLAGS'),
    '  --json           Machine-readable output',
    '  --yes            Skip confirmation prompts (destructive/money commands)',
    '  --api-url <url>  Override the API base (default: https://credit-api.floelabs.xyz)',
    '  --version        Print the CLI version',
    '  --help           This help (or per-command usage after a command)',
    '',
    bold('ENVIRONMENT'),
    '  FLOE_API_KEY     Developer key (floe_live_…) — overrides the keychain',
    '  FLOE_AGENT_KEY   Agent key (floe_…) — overrides the keychain',
    '  FLOE_API_URL     API base URL',
    '',
    bold('EXIT CODES'),
    '  0 ok · 1 error · 2 usage · 4 auth · 5 payment/budget',
    '',
    `Get started:  ${bold('npx @floelabs/cli init')}`,
    '',
  );
  return lines.join('\n');
}

function commandHint(def: CommandDef): string {
  return errDim(`Run \`floe help ${def.name}\` for usage.`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [name, ...rest] = argv;

  if (!name || name === '--help' || name === '-h' || name === 'help') {
    if (name === 'help' && rest[0]) {
      const target = registry.get(rest[0]);
      if (!target) {
        process.stderr.write(`${errRed('error:')} unknown command "${rest[0]}"\n\n${renderHelp()}`);
        process.exitCode = 2;
        return;
      }
      process.stdout.write(target.usage);
      return;
    }
    process.stdout.write(renderHelp());
    return;
  }
  if (name === '--version' || name === '-v') {
    process.stdout.write(`floe-cli/${cliVersion()}\n`);
    return;
  }

  const def = registry.get(name);
  if (!def) {
    process.stderr.write(`${errRed('error:')} unknown command "${name}"\n\n${renderHelp()}`);
    process.exitCode = 2;
    return;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { ...GLOBAL_OPTIONS, version: { type: 'boolean' }, ...def.options },
    });
  } catch (err) {
    process.stderr.write(`${errRed('error:')} ${(err as Error).message}\n${commandHint(def)}\n`);
    process.exitCode = 2;
    return;
  }

  const { positionals } = parsed;
  const values = parsed.values as Record<string, OptionValue>;
  if (values.version === true) {
    process.stdout.write(`floe-cli/${cliVersion()}\n`);
    return;
  }
  if (values.help === true) {
    process.stdout.write(def.usage);
    return;
  }

  const ctx: CommandContext = {
    args: positionals,
    values,
    json: values.json === true,
    yes: values.yes === true,
    apiUrl: typeof values['api-url'] === 'string' ? values['api-url'] : undefined,
  };

  try {
    await def.run(ctx);
  } catch (err) {
    // Error text can embed network-sourced strings (API messages, agent
    // names) — sanitize before it reaches the terminal.
    if (err instanceof UsageError) {
      process.stderr.write(`${errRed('error:')} ${sanitizeText(err.message)}\n${commandHint(def)}\n`);
      process.exitCode = 2;
      return;
    }
    if (err instanceof ApiError) {
      process.stderr.write(`${errRed('error:')} ${sanitizeText(err.message)}\n`);
      if (err.hint) process.stderr.write(`${errDim(`hint: ${sanitizeText(err.hint)}`)}\n`);
      process.exitCode = err.exitCode;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${errRed('error:')} ${sanitizeText(message)}\n`);
    process.exitCode = 1;
  }
}
