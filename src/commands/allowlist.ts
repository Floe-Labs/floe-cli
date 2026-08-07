import { ApiError } from '../lib/api.js';
import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext, requireActiveAgent, resolveAgentRef, type DevContext } from '../lib/context.js';
import { parseDuration } from '../lib/duration.js';
import { bold, dim, green, kv, ok, printJson, sanitizeText, UsageError, warn } from '../lib/output.js';
import { table } from '../lib/table.js';
import { rawToUsd, usdToRaw } from '../lib/usdc.js';

/**
 * D1 merchant allowlist. Entries are ordinary policy rows (kind='api' for
 * hosts, kind='vendor' for payee wallets); the MODE decides which dimensions
 * the proxy enforces. Enforcement fails closed: a dimension turned on with
 * zero entries declines EVERY call on that dimension — the lockout advisory
 * from the API is surfaced loudly here for exactly that reason.
 */

type AllowlistMode = 'off' | 'host' | 'vendor' | 'both';

const MODES: AllowlistMode[] = ['off', 'host', 'vendor', 'both'];

/** Policy row fields the allowlist surface uses (see policy.ts for the full shape). */
interface AllowlistEntry {
  id: number;
  kind: string;
  matchKey: string | null;
  matchKind?: string | null;
  limitRaw: string;
  windowKind: string;
  windowSeconds: number | null;
  status: 'active' | 'expired' | 'revoked';
  label: string | null;
}

interface SetModeResponse {
  mode: AllowlistMode;
  warning?: { code: string; dimensions: Array<'host' | 'vendor'> };
}

export interface AllowlistFlags {
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
  agent?: string;
  host?: string;
  payee?: string;
  limit?: string;
  window?: string;
  label?: string;
}

async function targetAgent(
  ctx: DevContext,
  ref: string | undefined,
): Promise<{ id: string; name?: string }> {
  if (ref) {
    const agent = await resolveAgentRef(ctx, ref);
    return { id: String(agent.id), name: agent.name };
  }
  const active = requireActiveAgent(ctx.config);
  return { id: active.id, name: active.name };
}

const MODE_DESCRIPTIONS: Record<AllowlistMode, string> = {
  off: 'any vendor allowed (caps still enforced)',
  host: 'only allowlisted hosts',
  vendor: 'only allowlisted payee wallets',
  both: 'only allowlisted hosts AND payee wallets',
};

function formatSeconds(seconds: number): string {
  const units: Array<[number, string]> = [[604_800, 'w'], [86_400, 'd'], [3_600, 'h'], [60, 'm']];
  for (const [size, suffix] of units) {
    if (seconds >= size && seconds % size === 0) return `${seconds / size}${suffix}`;
  }
  return `${seconds}s`;
}

function describeWindow(p: { windowKind: string; windowSeconds: number | null }): string {
  if (p.windowKind === 'rolling') {
    return p.windowSeconds ? `${formatSeconds(p.windowSeconds)} rolling` : 'rolling';
  }
  return p.windowKind;
}

function lockoutWarning(dimension: 'host' | 'vendor'): string {
  const add = dimension === 'host' ? 'floe allowlist add --host .example.com --limit 5' : 'floe allowlist add --payee 0x… --limit 5';
  return (
    `${warn(bold(`Lockout: ${dimension} allowlisting is enforced with ZERO active entries.`))}\n` +
    `  Every call on the ${dimension} dimension will be DECLINED until you add one:\n` +
    `  ${add}\n`
  );
}

export async function allowlistShowCommand(flags: AllowlistFlags): Promise<void> {
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  const [{ mode }, { policies }] = await Promise.all([
    ctx.api.dev<{ mode: AllowlistMode }>('GET', `/v1/developer/agents/${agent.id}/allowlist-mode`),
    ctx.api.dev<{ policies: AllowlistEntry[] }>('GET', `/v1/developer/agents/${agent.id}/policies`),
  ]);
  const entries = policies.filter((p) => p.kind === 'api' || p.kind === 'vendor');

  if (flags.json) return printJson({ agentId: agent.id, mode, entries });

  process.stdout.write(`${bold(`Allowlist — ${agent.name ?? agent.id}`)}\n`);
  process.stdout.write(`${kv([['Mode', `${mode} ${dim(`— ${MODE_DESCRIPTIONS[mode]}`)}`]])}\n`);
  if (entries.length === 0) {
    process.stdout.write(`${dim('No entries. Add one: floe allowlist add --host .openai.com --limit 5')}\n`);
  } else {
    const rows = entries.map((p) => [
      String(p.id),
      p.kind === 'api' ? 'host' : 'payee',
      p.matchKey ? sanitizeText(p.matchKey) : dim('—'),
      rawToUsd(p.limitRaw),
      describeWindow(p),
      p.status === 'active' ? green('active') : dim(p.status),
    ]);
    process.stdout.write(`${table(['ID', 'DIM', 'MATCH', 'CAP', 'WINDOW', 'STATUS'], rows)}\n`);
  }
  const hasActive = (kind: string) => entries.some((p) => p.kind === kind && p.status === 'active');
  if ((mode === 'host' || mode === 'both') && !hasActive('api')) {
    process.stdout.write(lockoutWarning('host'));
  }
  if ((mode === 'vendor' || mode === 'both') && !hasActive('vendor')) {
    process.stdout.write(lockoutWarning('vendor'));
  }
}

export async function allowlistSetCommand(modeArg: string | undefined, flags: AllowlistFlags): Promise<void> {
  if (!modeArg || !MODES.includes(modeArg as AllowlistMode)) {
    throw new UsageError(`Usage: floe allowlist set off|host|vendor|both (got "${modeArg ?? ''}").`);
  }
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  const res = await ctx.api.dev<SetModeResponse>(
    'PUT',
    `/v1/developer/agents/${agent.id}/allowlist-mode`,
    { mode: modeArg },
  );

  if (flags.json) return printJson({ agentId: agent.id, ...res });

  process.stdout.write(
    `${ok(`Allowlist mode set to ${bold(res.mode)} for agent "${agent.name ?? agent.id}" — ${MODE_DESCRIPTIONS[res.mode]}.`)}\n`,
  );
  // The PUT persists the mode even when it locks the agent out — the API's
  // advisory is the only signal, so make it impossible to miss.
  if (res.warning?.code === 'no_active_entries') {
    for (const dimension of res.warning.dimensions) {
      process.stdout.write(lockoutWarning(dimension));
    }
  }
}

export async function allowlistAddCommand(flags: AllowlistFlags): Promise<void> {
  if (Boolean(flags.host) === Boolean(flags.payee)) {
    throw new UsageError('Pass exactly one of --host <hostname|.suffix> or --payee <0x…>.');
  }
  if (!flags.limit) {
    throw new UsageError(
      'Missing --limit <usd> — every allowlist entry is a spend cap (the API has no uncapped entries).',
    );
  }
  const limitRaw = usdToRaw(flags.limit);

  let kind: 'api' | 'vendor';
  let matchKey: string;
  let matchKind: 'host_exact' | 'host_suffix' | undefined;
  if (flags.host) {
    const host = flags.host.trim().toLowerCase();
    if (/^https?:\/\//.test(host) || host.includes('/') || host.includes(':')) {
      throw new UsageError('--host takes a bare hostname (no scheme, path, or port), e.g. api.openai.com or .openai.com');
    }
    // The proxy only suffix-matches dotted keys, so the shape decides the kind.
    matchKind = host.startsWith('.') ? 'host_suffix' : 'host_exact';
    if (matchKind === 'host_suffix' && host.slice(1).split('.').length < 2) {
      throw new UsageError(`"${host}" would allowlist an entire TLD — a suffix needs at least two labels, e.g. .openai.com`);
    }
    kind = 'api';
    matchKey = host;
  } else {
    const payee = flags.payee!.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(payee)) {
      throw new UsageError('--payee must be a 0x-prefixed 20-byte wallet address.');
    }
    kind = 'vendor';
    matchKey = payee;
  }

  // Default cap window mirrors the dashboard's allowlist form: 24h rolling.
  let windowKind: 'once' | 'rolling' = 'rolling';
  let windowSeconds: number | undefined = 86_400;
  if (flags.window === 'once') {
    windowKind = 'once';
    windowSeconds = undefined;
  } else if (flags.window !== undefined) {
    windowSeconds = parseDuration(flags.window);
  }

  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  let created: { policy: AllowlistEntry };
  try {
    created = await ctx.api.dev<{ policy: AllowlistEntry }>(
      'POST',
      `/v1/developer/agents/${agent.id}/policies`,
      { kind, matchKey, matchKind, limitRaw, windowKind, windowSeconds, label: flags.label },
    );
  } catch (err) {
    if (err instanceof ApiError && err.code === 'duplicate_active_policy') {
      throw new ApiError(
        `"${matchKey}" is already allowlisted — update its cap instead (\`floe policy update <id>\`) or remove it first.`,
        409,
        'duplicate_active_policy',
      );
    }
    throw err;
  }

  if (flags.json) return printJson({ agentId: agent.id, policy: created.policy });
  const p = created.policy;
  process.stdout.write(
    `${ok(`Allowlisted ${kind === 'api' ? 'host' : 'payee'} ${bold(sanitizeText(p.matchKey ?? matchKey))} (policy ${p.id}) — capped at ${rawToUsd(p.limitRaw)} per ${describeWindow(p)}`)}\n`,
  );
  process.stdout.write(`${dim('Enforced only when the mode covers this dimension — check: floe allowlist show')}\n`);
}

export async function allowlistRemoveCommand(arg: string | undefined, flags: AllowlistFlags): Promise<void> {
  if (!arg || !/^\d+$/.test(arg)) {
    throw new UsageError(`Invalid entry id "${arg ?? ''}" — a numeric policy id from \`floe allowlist show --json\`.`);
  }
  await confirmAction(`remove allowlist entry ${arg}`, arg, { yes: flags.yes });

  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  await ctx.api.dev<{ status: string }>('DELETE', `/v1/developer/agents/${agent.id}/policies/${arg}`);

  if (flags.json) return printJson({ agentId: agent.id, policyId: Number(arg), status: 'revoked' });
  process.stdout.write(`${ok(`Allowlist entry ${arg} removed.`)}\n`);
  process.stdout.write(
    `${dim('If this was the last entry on an enforced dimension, the agent is now locked out of it — check: floe allowlist show')}\n`,
  );
}

export const allowlistDef: CommandDef = {
  name: 'allowlist',
  summary: 'show | set | add | remove — merchant allowlist',
  usage: `Usage: floe allowlist [show] [--agent <ref>]
       floe allowlist set off|host|vendor|both [--agent <ref>]
       floe allowlist add --host <hostname|.suffix> | --payee <0x…>
                          --limit <usd> [--window <dur>|once] [--label <text>] [--agent <ref>]
       floe allowlist remove <entryId> [--agent <ref>]

Restrict which merchants an agent can pay. Entries are spend-capped policy
rows; the MODE picks which dimensions the proxy enforces:
  off      any vendor (default) — caps on entries still apply
  host     only allowlisted request hosts
  vendor   only allowlisted payee wallets (the 402's recipient)
  both     host AND payee must be allowlisted

Enforcement fails closed: turning a dimension on with zero entries declines
every call on it — the CLI warns loudly when that happens.

  show     Mode + entries for the agent.
  set      Switch the mode.
  add      Allowlist a host (api.openai.com exact, .openai.com suffix) or a
           payee wallet, capped at --limit per --window (default 24h rolling).
  remove   Delete an entry by id (asks for confirmation).
`,
  options: {
    agent: { type: 'string' },
    host: { type: 'string' },
    payee: { type: 'string' },
    limit: { type: 'string' },
    window: { type: 'string' },
    label: { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: AllowlistFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      yes: ctx.yes,
      agent: str(ctx, 'agent'),
      host: str(ctx, 'host'),
      payee: str(ctx, 'payee'),
      limit: str(ctx, 'limit'),
      window: str(ctx, 'window'),
      label: str(ctx, 'label'),
    };
    if (subcommand === 'set') {
      expectArgs(ctx, 2);
      await allowlistSetCommand(arg, flags);
    } else if (subcommand === 'add') {
      expectArgs(ctx, 1);
      await allowlistAddCommand(flags);
    } else if (subcommand === 'remove') {
      expectArgs(ctx, 2);
      await allowlistRemoveCommand(arg, flags);
    } else if (subcommand === undefined || subcommand === 'show') {
      expectArgs(ctx, 1);
      await allowlistShowCommand(flags);
    } else {
      throw new UsageError(`Unknown allowlist subcommand "${subcommand}". Use: show, set, add, remove.`);
    }
  },
};
