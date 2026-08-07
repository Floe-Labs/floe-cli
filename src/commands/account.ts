import { expectArgs, type CommandDef } from '../lib/command.js';
import { devContext } from '../lib/context.js';
import { bold, dim, kv, ok, printJson, sanitizeText, UsageError } from '../lib/output.js';
import type { ProfileResponse } from '../lib/types.js';

/**
 * Account identity — who this developer key belongs to. `show` reads the
 * profile; `rename` PATCHes the account display name (the ONE profile field
 * the CLI writes — everything else on PATCH /me is dashboard-only wallet
 * binding, and the server rejects it for non-Privy sessions anyway).
 */

interface UpdateMeResponse {
  developer: {
    walletAddress?: string;
    displayName: string | null;
    accountId: string | null;
  };
}

export interface AccountFlags {
  apiUrl?: string;
  json?: boolean;
}

export async function accountShowCommand(flags: AccountFlags): Promise<void> {
  const { api } = await devContext(flags);
  const profile = await api.dev<ProfileResponse>('GET', '/v1/developer/profile');

  if (flags.json) return printJson(profile);

  const dev = profile.developer;
  const active = profile.agents.filter((a) => a.status === 'active').length;
  const rows: Array<[string, string]> = [
    ['Name', dev.displayName ? sanitizeText(dev.displayName) : dim('(unnamed)')],
    ['Account ID', dev.accountId ?? dim('—')],
    ['Role', dev.role ? sanitizeText(dev.role) : dim('—')],
    ['Wallet', sanitizeText(dev.walletAddress)],
    ['Email', dev.email ? sanitizeText(dev.email) : dim('—')],
    ['Created', dev.createdAt.slice(0, 10)],
    ['Agents', `${profile.agents.length} (${active} active)`],
  ];
  process.stdout.write(`${bold('Account')}\n${kv(rows)}\n`);
  if (!dev.displayName) {
    process.stdout.write(`${dim('Name it: floe account rename <name>')}\n`);
  }
}

export async function accountRenameCommand(name: string, flags: AccountFlags): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new UsageError('Account name must be 1–100 characters.');
  }
  const { api } = await devContext(flags);
  const result = await api.dev<UpdateMeResponse>('PATCH', '/v1/developer/me', {
    displayName: trimmed,
  });

  if (flags.json) return printJson(result);
  const shown = result.developer.displayName ?? trimmed;
  process.stdout.write(`${ok(`Account renamed to ${bold(sanitizeText(shown))}`)}\n`);
}

export const accountDef: CommandDef = {
  name: 'account',
  summary: 'show | rename — account identity',
  usage: `Usage: floe account [show]
       floe account rename <name>

Your developer account (shared with teammates — see \`floe team\`).
  show           Identity: name, opaque account id, your role, wallet, agent count
  rename <name>  Set the account display name (owner or admin only, 1–100 chars)
`,
  options: {},
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: AccountFlags = { apiUrl: ctx.apiUrl, json: ctx.json };
    if (subcommand === 'rename') {
      if (!arg) {
        throw new UsageError('Usage: floe account rename <name> — quote names with spaces.');
      }
      expectArgs(ctx, 2);
      await accountRenameCommand(arg, flags);
    } else if (subcommand === undefined || subcommand === 'show') {
      expectArgs(ctx, 1);
      await accountShowCommand(flags);
    } else {
      throw new UsageError(`Unknown account subcommand "${subcommand}". Use: show, rename <name>.`);
    }
  },
};
