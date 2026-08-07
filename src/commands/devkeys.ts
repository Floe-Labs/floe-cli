import { ApiError } from '../lib/api.js';
import { expectArgs, flag, str, type CommandDef } from '../lib/command.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext } from '../lib/context.js';
import { bold, dim, ok, printJson, sanitizeText, UsageError, warn } from '../lib/output.js';
import { table } from '../lib/table.js';

/**
 * Developer (floe_live_…) key management. These are the account-level keys the
 * CLI itself signs in with — the API stores hashes only, so the CLI can never
 * tell which listed id matches this machine's stored key. Every subcommand
 * that could strand the machine says so instead of guessing.
 */

/** GET /v1/developer/keys row — prefix only, never the full key. */
interface DevKeySummary {
  id: number;
  keyPrefix: string;
  label: string | null;
  permissions: 'read' | 'read_write';
  lastUsedAt: string | null;
  createdAt: string;
}

/** POST /v1/developer/keys and …/:keyId/rotate — the raw key, returned exactly once. */
interface DevKeyMintResponse extends DevKeySummary {
  key: string;
}

export interface DevkeysFlags {
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
  label?: string;
  readOnly?: boolean;
}

export async function devkeysListCommand(flags: DevkeysFlags): Promise<void> {
  const ctx = await devContext(flags);
  const { keys } = await ctx.api.dev<{ keys: DevKeySummary[] }>('GET', '/v1/developer/keys');

  if (flags.json) return printJson({ keys });

  if (keys.length === 0) {
    process.stdout.write(`No developer keys. Mint one with ${bold('floe devkeys create')}.\n`);
    return;
  }
  process.stdout.write(`${bold('Developer keys (floe_live_…)')}\n`);
  const rows = keys.map((k) => [
    String(k.id),
    sanitizeText(k.keyPrefix),
    k.label ? sanitizeText(k.label) : dim('(no label)'),
    sanitizeText(k.permissions),
    k.lastUsedAt ? k.lastUsedAt.slice(0, 10) : dim('never'),
    k.createdAt.slice(0, 10),
  ]);
  process.stdout.write(`${table(['ID', 'KEY', 'LABEL', 'PERMISSIONS', 'LAST USED', 'CREATED'], rows)}\n`);
  process.stdout.write(
    `${dim('One of these signs this CLI in — the API stores hashes only, so it cannot say which.')}\n`,
  );
}

export async function devkeysCreateCommand(flags: DevkeysFlags): Promise<void> {
  const ctx = await devContext(flags);
  const body: Record<string, unknown> = {};
  if (flags.label !== undefined) body.label = flags.label;
  if (flags.readOnly) body.permissions = 'read';

  let minted: DevKeyMintResponse;
  try {
    minted = await ctx.api.dev<DevKeyMintResponse>('POST', '/v1/developer/keys', body);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'Limit exceeded') {
      throw new ApiError(
        'You already have the maximum number of developer keys. Revoke one with `floe devkeys revoke <keyId>` or replace one with `floe devkeys rotate <keyId>`.',
        err.status,
        err.code,
      );
    }
    throw err;
  }

  if (flags.json) {
    // The raw key is shown exactly once — here, for the caller that minted it.
    return printJson({
      created: true,
      id: minted.id,
      keyPrefix: minted.keyPrefix,
      key: minted.key,
      label: minted.label,
      permissions: minted.permissions,
    });
  }
  process.stdout.write(
    `${ok(`Developer key created → ${bold(sanitizeText(minted.keyPrefix))} ${dim(`(${sanitizeText(minted.permissions)})`)}`)}\n`,
  );
  process.stdout.write(`New key (shown once): ${bold(minted.key)}\n`);
  process.stdout.write(
    `${dim('Store it now — this machine keeps signing in with its current key. To sign a machine in with it: floe init --key <key>')}\n`,
  );
}

export async function devkeysRevokeCommand(keyId: string, flags: DevkeysFlags): Promise<void> {
  if (!/^\d+$/.test(keyId)) {
    throw new UsageError(`Invalid key id "${keyId}" — key ids are numeric (see \`floe devkeys --json\`).`);
  }
  const ctx = await devContext(flags);

  // The CLI cannot know which key id its own stored credential has (the API
  // returns hashed keys' prefixes only), so warn generically before
  // confirming. stderr, so --json stdout stays machine-readable.
  process.stderr.write(
    `${warn('If this is the key this machine signs in with, every floe command will 401 until you run `floe init` with a new key.')}\n`,
  );

  await confirmAction(`revoke developer key ${keyId}`, keyId, { yes: flags.yes });
  await ctx.api.dev<{ message?: string }>('DELETE', `/v1/developer/keys/${keyId}`);

  if (flags.json) return printJson({ revoked: true, keyId });
  process.stdout.write(`${ok(`Developer key ${keyId} revoked.`)}\n`);
}

export async function devkeysRotateCommand(keyId: string, flags: DevkeysFlags): Promise<void> {
  if (!/^\d+$/.test(keyId)) {
    throw new UsageError(`Invalid key id "${keyId}" — key ids are numeric (see \`floe devkeys --json\`).`);
  }
  const ctx = await devContext(flags);
  const rotated = await ctx.api.dev<DevKeyMintResponse>(
    'POST',
    `/v1/developer/keys/${keyId}/rotate`,
    {},
  );

  if (flags.json) {
    // The raw key is shown exactly once — here, for the caller that rotated it.
    return printJson({
      rotated: true,
      id: rotated.id,
      keyPrefix: rotated.keyPrefix,
      key: rotated.key,
      label: rotated.label,
      permissions: rotated.permissions,
    });
  }
  process.stdout.write(`${ok(`Developer key rotated → ${bold(sanitizeText(rotated.keyPrefix))}`)}\n`);
  process.stdout.write(`New key (shown once): ${bold(rotated.key)}\n`);
  process.stdout.write(`${dim('The old key is revoked — update whatever was using it.')}\n`);
  // The stored dev key lives in one slot per host (dev-key:<host>) with no id
  // recorded, so the CLI cannot verify whether the rotated key was this
  // machine's — say what to do if it was, instead of guessing.
  process.stdout.write(
    `${warn('If this machine was signed in with the rotated key, run `floe init --key <new key>` before the next command.')}\n`,
  );
  if (process.env.FLOE_API_KEY) {
    process.stdout.write(
      `${warn('FLOE_API_KEY is set and overrides the stored key — update it if it held the rotated key.')}\n`,
    );
  }
}

export const devkeysDef: CommandDef = {
  name: 'devkeys',
  summary: 'list | create | revoke | rotate — developer (floe_live_) keys',
  usage: `Usage: floe devkeys [list]
       floe devkeys create [--label <label>] [--read-only]
       floe devkeys revoke <keyId> [--yes]
       floe devkeys rotate <keyId>

Manage developer keys (floe_live_…) — the account-level keys the CLI and
dashboard sign in with.
  list             Every non-revoked developer key (prefix only)
  create           Mint a new key — shown once, never stored by the CLI.
                   --read-only mints a read-scoped key (default: read_write)
  revoke <keyId>   Revoke a key permanently — asks for confirmation (--yes to
                   skip). Revoking the key this machine uses strands it until
                   \`floe init\` is re-run with another key.
  rotate <keyId>   Atomic revoke + mint. The new key is shown once and NOT
                   stored — if this machine was using the old key, run
                   \`floe init --key <new key>\`.
`,
  options: {
    label: { type: 'string' },
    'read-only': { type: 'boolean' },
  },
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: DevkeysFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      yes: ctx.yes,
      label: str(ctx, 'label'),
      readOnly: flag(ctx, 'read-only'),
    };
    if (subcommand === 'create') {
      expectArgs(ctx, 1);
      await devkeysCreateCommand(flags);
    } else if (subcommand === 'revoke') {
      if (!arg) throw new UsageError('Usage: floe devkeys revoke <keyId> — list ids with `floe devkeys --json`.');
      expectArgs(ctx, 2);
      await devkeysRevokeCommand(arg, flags);
    } else if (subcommand === 'rotate') {
      if (!arg) throw new UsageError('Usage: floe devkeys rotate <keyId> — list ids with `floe devkeys --json`.');
      expectArgs(ctx, 2);
      await devkeysRotateCommand(arg, flags);
    } else if (subcommand === undefined || subcommand === 'list') {
      expectArgs(ctx, 1);
      await devkeysListCommand(flags);
    } else {
      throw new UsageError(
        `Unknown devkeys subcommand "${subcommand}". Use: list, create, revoke <keyId>, rotate <keyId>.`,
      );
    }
  },
};
