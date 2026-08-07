import { ApiError } from '../lib/api.js';
import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { withAgentEntry, writeConfig, type AgentEntry } from '../lib/config.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext, requireActiveAgent, resolveAgentRef, type DevContext } from '../lib/context.js';
import { parseDuration } from '../lib/duration.js';
import { agentKeyAccount, setSecret } from '../lib/keychain.js';
import { bold, dim, green, kv, ok, printJson, sanitizeText, UsageError, warn } from '../lib/output.js';
import type { AgentKeySummary, MintKeyResponse } from '../lib/types.js';
import { rawToUsd, usdToRaw } from '../lib/usdc.js';

export interface KeysFlags {
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
  label?: string;
  budget?: string;
  window?: string;
  agent?: string;
}

/**
 * The agent a subcommand targets: --agent resolves against the fleet by
 * id-then-name; omitted → this machine's active agent straight from config
 * (no network round-trip). The config entry rides along either way so the
 * machine-key checks (keyId/keyPrefix) work for any resolvable agent.
 */
async function targetAgent(
  ctx: DevContext,
  ref: string | undefined,
): Promise<{ id: string } & AgentEntry> {
  if (!ref) return requireActiveAgent(ctx.config);
  const agent = await resolveAgentRef(ctx, ref);
  return { ...ctx.config.agents?.[agent.id], id: String(agent.id), name: agent.name };
}

export async function keysListCommand(flags: KeysFlags): Promise<void> {
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  const { keys } = await ctx.api.dev<{ keys: AgentKeySummary[] }>(
    'GET',
    `/v1/developer/agents/${agent.id}/keys`,
  );

  if (flags.json) return printJson({ agentId: agent.id, keys });

  if (keys.length === 0) {
    process.stdout.write(`No keys for agent "${agent.name}". Run ${bold('floe init --new-key')}.\n`);
    return;
  }
  process.stdout.write(`${bold(`Agent keys — ${agent.name ?? agent.id}`)}\n`);
  const rows: Array<[string, string]> = keys.map((k) => {
    const marker = k.id === agent.keyId ? green('● ') : '  ';
    const budget = k.budget
      ? `${rawToUsd(k.budget.remainingRaw)} / ${rawToUsd(k.budget.limitRaw)} left`
      : dim('no budget');
    const used = k.lastUsedAt ? `last used ${k.lastUsedAt.slice(0, 10)}` : 'never used';
    return [`${marker}${k.keyPrefix}`, `${k.label ?? dim('(no label)')} · ${k.permissions} · ${budget} · ${dim(used)}`];
  });
  process.stdout.write(`${kv(rows)}\n`);
  if (agent.keyId) process.stdout.write(`${dim('● = the key this machine uses')}\n`);
}

export async function keysCreateCommand(flags: KeysFlags): Promise<void> {
  // Validation precedes I/O — bad amounts and windows fail before any call.
  if (flags.window !== undefined && flags.budget === undefined) {
    throw new UsageError(
      '--window only applies with --budget: floe keys create --budget <usd> --window <dur>',
    );
  }
  const budgetRaw = flags.budget !== undefined ? usdToRaw(flags.budget) : undefined;
  const windowSeconds = flags.window !== undefined ? parseDuration(flags.window) : undefined;
  if (windowSeconds !== undefined && windowSeconds < 60) {
    throw new UsageError('--window must be at least 60s — the API rejects shorter budget windows.');
  }

  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);

  const body: Record<string, unknown> = {};
  if (flags.label !== undefined) body.label = flags.label;
  if (budgetRaw !== undefined) body.budgetRaw = budgetRaw;
  if (windowSeconds !== undefined) body.windowSeconds = windowSeconds;

  let minted: MintKeyResponse;
  try {
    minted = await ctx.api.dev<MintKeyResponse>('POST', `/v1/developer/agents/${agent.id}/keys`, body);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'limit_exceeded') {
      throw new ApiError(
        `Agent "${agent.name ?? agent.id}" already has the maximum number of API keys. Revoke one with \`floe keys revoke <keyId>\` or replace one with \`floe keys rotate <keyId>\`.`,
        err.status,
        'limit_exceeded',
      );
    }
    throw err;
  }

  if (flags.json) {
    // The raw key is shown exactly once — here, for the caller that minted it.
    return printJson({
      created: true,
      agentId: agent.id,
      id: minted.id,
      keyPrefix: minted.keyPrefix,
      key: minted.key,
      label: minted.label,
      permissions: minted.permissions,
      budget: minted.budget ?? null,
    });
  }
  process.stdout.write(
    `${ok(`Key created for agent "${sanitizeText(agent.name ?? agent.id)}" → ${bold(sanitizeText(minted.keyPrefix))}`)}\n`,
  );
  process.stdout.write(`New key (shown once): ${bold(minted.key)}\n`);
  if (minted.budget) {
    process.stdout.write(
      `${dim(`Budget: ${rawToUsd(minted.budget.limitRaw)} per rolling ${flags.window ?? '30d (default)'}`)}\n`,
    );
  }
  process.stdout.write(
    `${dim('This machine keeps using its current key — give this one to the workload that needs it.')}\n`,
  );
}

export async function keysRevokeCommand(keyId: string, flags: KeysFlags): Promise<void> {
  if (!/^\d+$/.test(keyId)) {
    throw new UsageError(`Invalid key id "${keyId}" — key ids are numeric (see \`floe keys --json\`).`);
  }
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);

  // The config records which key this machine minted for the agent — warn
  // before the confirmation so revoking your own credential is a choice,
  // never a surprise. (stderr, so --json stdout stays machine-readable.)
  const isMachineKey = agent.keyId !== undefined && String(agent.keyId) === keyId;
  if (isMachineKey) {
    process.stderr.write(
      `${warn(`This machine uses key ${keyId} (${agent.keyPrefix ?? 'floe_…'}) — after revoking it, sign back in with \`floe init --new-key\` or \`floe keys rotate\`.`)}\n`,
    );
  }

  await confirmAction(`revoke key ${keyId} on agent "${agent.name ?? agent.id}"`, keyId, {
    yes: flags.yes,
  });
  await ctx.api.dev<{ message?: string }>(
    'DELETE',
    `/v1/developer/agents/${agent.id}/keys/${keyId}`,
  );

  if (flags.json) {
    return printJson({ revoked: true, agentId: agent.id, keyId, wasMachineKey: isMachineKey });
  }
  process.stdout.write(`${ok(`Key ${keyId} revoked on agent "${sanitizeText(agent.name ?? agent.id)}".`)}\n`);
  if (isMachineKey) {
    process.stdout.write(
      `${warn('That was this machine\'s key — run `floe init --new-key` before the next agent call.')}\n`,
    );
  }
}

export async function keysRotateCommand(keyId: string | undefined, flags: KeysFlags): Promise<void> {
  const ctx = await devContext(flags);
  const { config, apiUrl } = ctx;
  const agent = await targetAgent(ctx, flags.agent);
  const target = keyId ?? agent.keyId;
  if (target === undefined) {
    throw new UsageError('No key to rotate. Pass a key id (see `floe keys --json`) or run `floe init` first.');
  }

  const rotated = await ctx.api.dev<MintKeyResponse>(
    'POST',
    `/v1/developer/agents/${agent.id}/keys/${target}/rotate`,
    {},
  );

  // "This machine's key" = the key config records for the TARGET agent. Ids
  // are numbers from the API but strings from argv — compare canonically.
  const isThisMachinesKey =
    !keyId || (agent.keyId !== undefined && String(agent.keyId) === String(keyId));
  let storedLocally = false;
  if (isThisMachinesKey) {
    try {
      await setSecret(agentKeyAccount(apiUrl, agent.id), rotated.key);
      writeConfig(
        withAgentEntry(config, agent.id, { keyId: rotated.id, keyPrefix: rotated.keyPrefix }),
      );
      storedLocally = true;
    } catch (err) {
      // The old key is already revoked server-side — never swallow the
      // replacement. Surface it once so the user can store it by hand.
      process.stderr.write(
        `${warn('Could not save the new key locally — copy it now (shown once):')}\n${bold(rotated.key)}\n` +
          `${dim(`Reason: ${(err as Error).message}`)}\n`,
      );
    }
  }

  if (flags.json) {
    // The raw key is shown exactly once — here, for the caller that rotated it.
    return printJson({ rotated: true, id: rotated.id, keyPrefix: rotated.keyPrefix, key: rotated.key, storedLocally });
  }
  process.stdout.write(`${ok(`Key rotated → ${bold(rotated.keyPrefix)}`)}\n`);
  if (storedLocally) {
    process.stdout.write(`${dim('New key stored in your keychain; the old key is revoked.')}\n`);
    if (process.env.FLOE_AGENT_KEY) {
      process.stdout.write(
        `${warn(`FLOE_AGENT_KEY is set and overrides the keychain — update it to the new key:`)}\n${bold(rotated.key)}\n`,
      );
    }
  } else if (!isThisMachinesKey) {
    process.stdout.write(`New key (shown once): ${bold(rotated.key)}\n${dim('The old key is revoked — update whatever was using it.')}\n`);
  }
}

export const keysDef: CommandDef = {
  name: 'keys',
  summary: 'list | create | revoke | rotate — agent runtime keys',
  usage: `Usage: floe keys [list] [--agent <name|id>]
       floe keys create [--label <label>] [--budget <usd> [--window <dur>]] [--agent <name|id>]
       floe keys revoke <keyId> [--agent <name|id>] [--yes]
       floe keys rotate [keyId] [--agent <name|id>]

Manage agent runtime keys (floe_…). Default agent: the one this machine uses;
--agent <name|id> targets another one.
  list             Every key on the agent; ● marks the key this machine uses
  create           Mint an additional key — shown once, never stored here; does
                   NOT change which key this machine uses. --budget <usd> caps
                   its spend; --window <dur> sets the rolling period
                   (e.g. 24h, 7d; min 60s, default 30d)
  revoke <keyId>   Revoke a key permanently — asks for confirmation (--yes to skip)
  rotate [keyId]   Replace a key atomically — the old key is revoked server-side.
                   Defaults to the key this machine recorded for the agent; that
                   key's replacement is stored locally.
`,
  options: {
    label: { type: 'string' },
    budget: { type: 'string' },
    window: { type: 'string' },
    agent: { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: KeysFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      yes: ctx.yes,
      label: str(ctx, 'label'),
      budget: str(ctx, 'budget'),
      window: str(ctx, 'window'),
      agent: str(ctx, 'agent'),
    };
    if (subcommand === 'create') {
      expectArgs(ctx, 1);
      await keysCreateCommand(flags);
    } else if (subcommand === 'revoke') {
      if (!arg) throw new UsageError('Usage: floe keys revoke <keyId> [--agent <name|id>] — list ids with `floe keys --json`.');
      expectArgs(ctx, 2);
      await keysRevokeCommand(arg, flags);
    } else if (subcommand === 'rotate') {
      expectArgs(ctx, 2);
      await keysRotateCommand(arg, flags);
    } else if (subcommand === undefined || subcommand === 'list') {
      expectArgs(ctx, 1);
      await keysListCommand(flags);
    } else {
      throw new UsageError(
        `Unknown keys subcommand "${subcommand}". Use: list, create, revoke <keyId>, rotate [keyId].`,
      );
    }
  },
};
