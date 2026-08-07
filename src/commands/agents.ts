import { ApiError } from '../lib/api.js';
import { expectArgs, flag, str, type CommandDef } from '../lib/command.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext, resolveAgentRef } from '../lib/context.js';
import { bold, dim, green, kv, ok, printJson, sanitizeText, UsageError, warn } from '../lib/output.js';
import { table } from '../lib/table.js';
import type { CreateAgentResponse, SerializedAgent } from '../lib/types.js';
import { rawToUsd, usdToRaw } from '../lib/usdc.js';

export interface AgentsFlags {
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
}

// Delegation terms are REQUIRED by POST /v1/developer/agents even for
// wallet/PAYG agents (the operator grant is installed at provisioning so the
// optional credit-line upgrade works later). Same defaults as init.ts.
const DEFAULT_MAX_RATE_BPS = 1000;
const DEFAULT_EXPIRY_SECONDS = 31_536_000;

/** Mirrors createAgentSchema.name in the API so bad names fail pre-network. */
const AGENT_NAME = /^[A-Za-z0-9 _-]{1,64}$/;

/** GET /v1/developer/agents/rollup (routes/developer/console-gaps/fleet.ts). */
interface AgentRollupRow {
  id: string | number;
  name: string;
  status: string;
  balanceRaw: string;
  spend30dRaw: string;
  phone: string | null;
  keysCount: number;
}

/** GET /v1/developer/agents/:id (base agent + dashboard extras). */
interface AgentDetailResponse {
  agent: SerializedAgent;
  creditUsed: string;
  recentTransactionCount24h: number;
  sessionSpend?: { limitRaw: string | null; startedAtUnix: number | null };
}

/** GET /v1/developer/agents/:id/gateway-usage. */
interface GatewayUsageResponse {
  totalCalls: number;
  totalCostRaw: string;
  byModel: Array<{ model: string; rail: string; calls: number; costRaw: string }>;
}

/** GET /v1/developer/agents/:id/reputation (404 no_reputation_yet → null). */
interface ReputationResponse {
  score: number;
  band: string;
  confidence: number;
  modelVersion: string;
  computedAt: string;
  collateralMultiplierBps: number;
}

/** PATCH /v1/developer/agents/:id/status. */
interface AgentStatusResponse {
  id: string | number;
  status: string;
  suspendedReason: string | null;
}

/** POST /v1/developer/agents/:id/close (winddown result). */
interface CloseAgentResponse {
  status: string;
  loansRepaid?: number;
  loansRemaining?: number;
  repayTxHashes?: string[];
  transferTxHash?: string;
  usdcTransferred?: string;
}

const isMachineAgent = (activeId: string | undefined, id: string | number) =>
  activeId !== undefined && String(id) === activeId;

export async function agentsListCommand(rollup: boolean, flags: AgentsFlags): Promise<void> {
  const ctx = await devContext(flags);
  const activeId = ctx.config.activeAgentId;

  if (rollup) {
    const res = await ctx.api.dev<{ agents: AgentRollupRow[] }>('GET', '/v1/developer/agents/rollup');
    if (flags.json) return printJson(res);
    if (res.agents.length === 0) {
      process.stdout.write(`No agents yet. Create one: ${bold('floe agents create <name>')}\n`);
      return;
    }
    const rows = res.agents.map((a) => [
      `${isMachineAgent(activeId, a.id) ? green('●') : ' '} ${sanitizeText(a.name)}`,
      sanitizeText(String(a.id)),
      sanitizeText(a.status),
      rawToUsd(a.balanceRaw),
      rawToUsd(a.spend30dRaw),
      a.phone ? sanitizeText(a.phone) : dim('—'),
      String(a.keysCount),
    ]);
    process.stdout.write(
      `${table(['agent', 'id', 'status', 'balance', '30d spend', 'phone', 'keys'], rows)}\n`,
    );
    if (activeId) process.stdout.write(`${dim('● = the agent this machine uses')}\n`);
    return;
  }

  const res = await ctx.api.dev<{ agents: SerializedAgent[] }>('GET', '/v1/developer/agents');
  if (flags.json) return printJson(res);
  if (res.agents.length === 0) {
    process.stdout.write(`No agents yet. Create one: ${bold('floe agents create <name>')}\n`);
    return;
  }
  const rows = res.agents.map((a) => [
    `${isMachineAgent(activeId, a.id) ? green('●') : ' '} ${sanitizeText(a.name)}`,
    sanitizeText(String(a.id)),
    a.status === 'suspended'
      ? `${sanitizeText(a.status)}${a.suspendedReason ? dim(` (${sanitizeText(a.suspendedReason)})`) : ''}`
      : sanitizeText(a.status),
    sanitizeText(a.fundingMode),
    a.createdAt ? a.createdAt.slice(0, 10) : '—',
  ]);
  process.stdout.write(`${table(['agent', 'id', 'status', 'funding', 'created'], rows)}\n`);
  if (activeId) process.stdout.write(`${dim('● = the agent this machine uses')}\n`);
  process.stdout.write(`${dim('Balances and 30d spend: floe agents list --rollup')}\n`);
}

export async function agentsGetCommand(
  ref: string | undefined,
  usage: boolean,
  flags: AgentsFlags,
): Promise<void> {
  const ctx = await devContext(flags);
  const resolved = await resolveAgentRef(ctx, ref);
  const detail = await ctx.api.dev<AgentDetailResponse>('GET', `/v1/developer/agents/${resolved.id}`);

  let gatewayUsage: GatewayUsageResponse | undefined;
  let reputation: ReputationResponse | null | undefined;
  if (usage) {
    [gatewayUsage, reputation] = await Promise.all([
      ctx.api.dev<GatewayUsageResponse>('GET', `/v1/developer/agents/${resolved.id}/gateway-usage`),
      ctx.api
        .dev<ReputationResponse>('GET', `/v1/developer/agents/${resolved.id}/reputation`)
        .catch((err: unknown) => {
          // 404 = no_reputation_yet (too little history); 503 = score service
          // not configured on this deployment. Both are states, not errors —
          // the rest of the detail view must still render.
          if (err instanceof ApiError && (err.status === 404 || err.status === 503)) return null;
          throw err;
        }),
    ]);
  }

  if (flags.json) {
    return printJson({ ...detail, ...(usage ? { usage: gatewayUsage, reputation } : {}) });
  }

  const a = detail.agent;
  process.stdout.write(`${bold(sanitizeText(a.name))} ${dim(sanitizeText(String(a.id)))}\n`);
  const rows: Array<[string, string]> = [
    [
      'Status',
      a.status === 'suspended' && a.suspendedReason
        ? `${sanitizeText(a.status)} ${dim(`(${sanitizeText(a.suspendedReason)})`)}`
        : sanitizeText(a.status),
    ],
    ['Funding', a.fundingMode === 'wallet' ? 'wallet (pay-as-you-go)' : sanitizeText(a.fundingMode)],
    ['Wallet', sanitizeText(a.agentWalletAddress)],
    ['Credit limit', rawToUsd(a.creditLimit)],
    ['Credit used', rawToUsd(detail.creditUsed)],
    ['Session limit', a.sessionSpendLimitRaw ? rawToUsd(a.sessionSpendLimitRaw) : dim('not set')],
    ['Self-service', a.selfServiceLocked ? 'locked (tighten-only)' : 'unlocked'],
    ['Calls (24h)', String(detail.recentTransactionCount24h)],
    ['Created', a.createdAt ? a.createdAt.slice(0, 10) : '—'],
  ];
  if (usage && gatewayUsage) {
    rows.push([
      'Gateway usage',
      `${gatewayUsage.totalCalls} call${gatewayUsage.totalCalls === 1 ? '' : 's'} · ${rawToUsd(gatewayUsage.totalCostRaw)} total`,
    ]);
    rows.push([
      'Reputation',
      reputation
        ? `${reputation.score} (${sanitizeText(reputation.band)}) · collateral ×${reputation.collateralMultiplierBps / 10_000}`
        : '—',
    ]);
  }
  process.stdout.write(`${kv(rows)}\n`);
  if (usage && gatewayUsage && gatewayUsage.byModel.length > 0) {
    const modelRows = gatewayUsage.byModel.map((m) => [
      sanitizeText(m.model),
      sanitizeText(m.rail),
      String(m.calls),
      rawToUsd(m.costRaw),
    ]);
    process.stdout.write(`${table(['model', 'rail', 'calls', 'cost'], modelRows)}\n`);
  }
}

export async function agentsCreateCommand(
  name: string,
  creditLimit: string | undefined,
  flags: AgentsFlags,
): Promise<void> {
  // Validation precedes I/O: amount + name shape fail before any request.
  const borrowLimitRaw = creditLimit === undefined ? undefined : usdToRaw(creditLimit);
  if (!AGENT_NAME.test(name)) {
    throw new UsageError(
      'Agent names are 1–64 characters of letters, digits, spaces, underscores, or hyphens.',
    );
  }
  const ctx = await devContext(flags);

  let created: CreateAgentResponse;
  try {
    created = await ctx.api.dev<CreateAgentResponse>('POST', '/v1/developer/agents', {
      name,
      maxRateBps: DEFAULT_MAX_RATE_BPS,
      expirySeconds: DEFAULT_EXPIRY_SECONDS,
      ...(borrowLimitRaw !== undefined ? { borrowLimitRaw } : {}),
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'limit_exceeded') {
      throw new ApiError(
        'Agent cap reached — close an unused agent first (`floe agents close <name>`).',
        409,
        'limit_exceeded',
      );
    }
    if (err instanceof ApiError && err.code === 'name_conflict') {
      throw new ApiError(
        `An agent named "${name}" already exists. Pick a different name.`,
        409,
        'name_conflict',
      );
    }
    throw err;
  }

  if (flags.json) {
    return printJson({
      agentId: created.agentId,
      name,
      status: created.status,
      privyWalletAddress: created.privyWalletAddress,
      delegationTxHash: created.delegationTxHash,
      welcomeCreditTxHash: created.welcomeCreditTxHash,
      ...(borrowLimitRaw !== undefined ? { borrowLimitRaw } : {}),
    });
  }
  process.stdout.write(
    `${ok(`Agent ${bold(name)} created ${dim(sanitizeText(String(created.agentId)))}`)}\n`,
  );
  const rows: Array<[string, string]> = [['Status', sanitizeText(created.status)]];
  if (borrowLimitRaw !== undefined) rows.push(['Credit limit', rawToUsd(borrowLimitRaw)]);
  if (created.privyWalletAddress) rows.push(['Wallet', sanitizeText(created.privyWalletAddress)]);
  process.stdout.write(`${kv(rows)}\n`);
  if (created.welcomeCreditTxHash) {
    process.stdout.write(`${ok('Welcome credit deposited.')}\n`);
  }
  process.stdout.write(`${dim(`Point this machine at it: floe use ${name}`)}\n`);
}

export async function agentsStatusCommand(
  ref: string,
  target: 'suspended' | 'active',
  flags: AgentsFlags,
): Promise<void> {
  const ctx = await devContext(flags);
  const agent = await resolveAgentRef(ctx, ref);
  const res = await ctx.api.dev<AgentStatusResponse>(
    'PATCH',
    `/v1/developer/agents/${agent.id}/status`,
    { status: target },
  );
  if (flags.json) return printJson(res);
  const name = sanitizeText(agent.name);
  if (target === 'suspended') {
    process.stdout.write(
      `${ok(`Agent ${bold(name)} paused — the agent can no longer spend.`)}\n` +
        `${dim(`Every call is refused until you run: floe agents resume ${name}`)}\n`,
    );
  } else {
    process.stdout.write(`${ok(`Agent ${bold(name)} resumed — it can spend again.`)}\n`);
  }
}

export async function agentsCloseCommand(ref: string, flags: AgentsFlags): Promise<void> {
  const ctx = await devContext(flags);
  // Confirm before ANY network call — resolveAgentRef fetches the fleet, and a
  // refused destructive verb must leave zero requests behind it.
  await confirmAction(
    `close agent "${ref}" — repay its loans and sweep remaining funds to your developer wallet`,
    ref,
    { yes: flags.yes },
  );
  const agent = await resolveAgentRef(ctx, ref);
  const res = await ctx.api.dev<CloseAgentResponse>('POST', `/v1/developer/agents/${agent.id}/close`);
  const wasMachineAgent = isMachineAgent(ctx.config.activeAgentId, agent.id);

  if (flags.json) {
    return printJson({ agentId: agent.id, ...res, wasMachineAgent });
  }
  if (res.status === 'closed') {
    process.stdout.write(`${ok(`Agent ${bold(sanitizeText(agent.name))} closed.`)}\n`);
  } else {
    process.stdout.write(
      `${warn(`Wind-down status: ${sanitizeText(res.status)} — ${res.loansRemaining ?? 0} loan(s) remaining.`)}\n`,
    );
  }
  const rows: Array<[string, string]> = [];
  if (res.loansRepaid !== undefined) rows.push(['Loans repaid', String(res.loansRepaid)]);
  if (res.usdcTransferred !== undefined) rows.push(['Swept to you', rawToUsd(res.usdcTransferred)]);
  if (res.transferTxHash) rows.push(['Sweep tx', sanitizeText(res.transferTxHash)]);
  if (rows.length > 0) process.stdout.write(`${kv(rows)}\n`);
  if (wasMachineAgent) {
    process.stdout.write(
      `${warn('This machine pointed at the closed agent — pick another with `floe use <agent>`.')}\n`,
    );
  }
}

export async function agentsLockCommand(
  mode: 'show' | 'on' | 'off',
  ref: string | undefined,
  flags: AgentsFlags,
): Promise<void> {
  const ctx = await devContext(flags);
  const agent = await resolveAgentRef(ctx, ref);
  const name = sanitizeText(agent.name);

  if (mode === 'show') {
    const res = await ctx.api.dev<{ locked: boolean }>(
      'GET',
      `/v1/developer/agents/${agent.id}/self-service-lock`,
    );
    if (flags.json) return printJson({ agentId: agent.id, locked: res.locked });
    process.stdout.write(
      `Self-service lock for ${bold(name)}: ${res.locked ? bold('locked') : 'off'}\n` +
        `${dim(
          res.locked
            ? 'The agent\'s own key can only tighten its guardrails. Unlock: floe agents lock --off'
            : 'The agent\'s own key may loosen its guardrails. Tighten-only mode: floe agents lock --on',
        )}\n`,
    );
    return;
  }

  const locked = mode === 'on';
  const res = await ctx.api.dev<{ locked: boolean }>(
    'PUT',
    `/v1/developer/agents/${agent.id}/self-service-lock`,
    { locked },
  );
  if (flags.json) return printJson({ agentId: agent.id, locked: res.locked });
  process.stdout.write(
    locked
      ? `${ok(`Self-service locked for ${bold(name)} — its own key can only tighten guardrails now.`)}\n`
      : `${ok(`Self-service lock removed for ${bold(name)}.`)}\n`,
  );
}

export const agentsDef: CommandDef = {
  name: 'agents',
  summary: 'list | get | create | pause | resume | close | lock — agent fleet',
  usage: `Usage: floe agents [list] [--rollup]
       floe agents get [agent] [--usage]
       floe agents create <name> [--credit-limit <usd>]
       floe agents pause <agent>
       floe agents resume <agent>
       floe agents close <agent> [--yes]
       floe agents lock [--on|--off] [--agent <agent>]

Manage your agent fleet. <agent> is a name or id; ● marks this machine's agent.
  list                All agents; --rollup adds balance, 30d spend, phone, keys
  get [agent]         Agent detail (default: this machine's agent);
                      --usage folds in gateway usage and reputation
  create <name>       Create a pay-as-you-go agent; --credit-limit <usd> sets
                      the on-chain borrow ceiling for a later credit line
  pause <agent>       Kill-switch: every next call is refused (no confirmation)
  resume <agent>      Re-enable a paused agent
  close <agent>       DESTRUCTIVE: repays loans, sweeps funds, closes for good
  lock                Show the self-service lock (tighten-only mode);
                      --on / --off set it, --agent targets another agent
`,
  options: {
    rollup: { type: 'boolean' },
    usage: { type: 'boolean' },
    'credit-limit': { type: 'string' },
    agent: { type: 'string' },
    on: { type: 'boolean' },
    off: { type: 'boolean' },
  },
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: AgentsFlags = { apiUrl: ctx.apiUrl, json: ctx.json, yes: ctx.yes };
    if (subcommand === undefined || subcommand === 'list') {
      expectArgs(ctx, 1);
      await agentsListCommand(flag(ctx, 'rollup'), flags);
    } else if (subcommand === 'get') {
      expectArgs(ctx, 2);
      await agentsGetCommand(arg, flag(ctx, 'usage'), flags);
    } else if (subcommand === 'create') {
      if (!arg) throw new UsageError('Usage: floe agents create <name> [--credit-limit <usd>]');
      expectArgs(ctx, 2);
      await agentsCreateCommand(arg, str(ctx, 'credit-limit'), flags);
    } else if (subcommand === 'pause' || subcommand === 'resume') {
      if (!arg) throw new UsageError(`Usage: floe agents ${subcommand} <agent>`);
      expectArgs(ctx, 2);
      await agentsStatusCommand(arg, subcommand === 'pause' ? 'suspended' : 'active', flags);
    } else if (subcommand === 'close') {
      if (!arg) throw new UsageError('Usage: floe agents close <agent> [--yes]');
      expectArgs(ctx, 2);
      await agentsCloseCommand(arg, flags);
    } else if (subcommand === 'lock') {
      expectArgs(ctx, 1);
      const on = flag(ctx, 'on');
      const off = flag(ctx, 'off');
      if (on && off) throw new UsageError('Pass either --on or --off, not both.');
      await agentsLockCommand(on ? 'on' : off ? 'off' : 'show', str(ctx, 'agent'), flags);
    } else {
      throw new UsageError(
        `Unknown agents subcommand "${subcommand}". Use: list, get, create, pause, resume, close, lock.`,
      );
    }
  },
};
