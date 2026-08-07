import { UsageError } from './output.js';

/**
 * Command registry contract. Each noun (init, agents, policy, …) is one module
 * in src/commands/ exporting a CommandDef; main.ts parses argv[0], looks the
 * noun up, and re-parses the rest with that command's own options — so flags
 * never collide across nouns and `floe help <noun>` always has real usage text.
 */

export type OptionValue = string | boolean | Array<string | boolean> | undefined;

export interface CommandContext {
  /** Positionals after the command name (subcommand and its args). */
  args: string[];
  values: Record<string, OptionValue>;
  json: boolean;
  yes: boolean;
  apiUrl?: string;
}

export interface CommandOption {
  type: 'string' | 'boolean';
  multiple?: boolean;
}

export interface CommandDef {
  name: string;
  /** One-liner for the top-level HELP listing. */
  summary: string;
  /** Full usage block printed by `floe help <name>`, `--help`, and usage errors. */
  usage: string;
  options: Record<string, CommandOption>;
  run(ctx: CommandContext): Promise<void>;
}

/** Flags accepted by every command; merged over each def's own options. */
export const GLOBAL_OPTIONS: Record<string, CommandOption> = {
  json: { type: 'boolean' },
  yes: { type: 'boolean' },
  help: { type: 'boolean' },
  'api-url': { type: 'string' },
};

/**
 * Commands must consume every positional — extra arguments are a typo, and a
 * typo must never silently reach a state-changing command.
 */
export function expectArgs(ctx: CommandContext, max: number): void {
  if (ctx.args.length > max) {
    throw new UsageError(`Unexpected argument "${ctx.args[max]}".`);
  }
}

export function str(ctx: CommandContext, name: string): string | undefined {
  const v = ctx.values[name];
  return typeof v === 'string' ? v : undefined;
}

export function flag(ctx: CommandContext, name: string): boolean {
  return ctx.values[name] === true;
}
