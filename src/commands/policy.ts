import { ApiError } from '../lib/api.js';
import { expectArgs, flag, str, type CommandDef } from '../lib/command.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext, requireActiveAgent, resolveAgentRef, type DevContext } from '../lib/context.js';
import { parseDuration } from '../lib/duration.js';
import { bold, dim, green, kv, ok, printJson, red, sanitizeText, UsageError, warn } from '../lib/output.js';
import { table } from '../lib/table.js';
import { rawToUsd, usdToRaw } from '../lib/usdc.js';

/**
 * Full spend-policy surface. `floe budget` stays the ergonomic shortcut for
 * the common caps; this command exposes everything the policy engine accepts:
 * per-task / per-host / per-payee caps, team (account-wide) policies, the
 * limit chain, and the side-effect-free dry-run resolver.
 */

/** agent_policies row as serialized by the API — only the fields the CLI uses. */
export interface PolicyRow {
  id: number;
  scope?: 'agent' | 'developer';
  kind: 'session' | 'task' | 'api' | 'vendor' | 'key';
  matchKey: string | null;
  matchKind?: 'host_exact' | 'host_suffix' | 'recipient' | null;
  limitRaw: string;
  windowKind: 'once' | 'rolling' | 'session';
  windowSeconds: number | null;
  expiresAt: number | null;
  action: 'block' | 'suspend_agent' | null;
  status: 'active' | 'expired' | 'revoked';
  label: string | null;
  createdAt: string | null;
}

interface AccountCapResponse {
  configured: boolean;
  limitRaw: string | null;
  spentRaw: string;
  windowKind: string | null;
  windowResetsAt: string | null;
}

interface PolicyDefaultsResponse {
  sessionLimitRaw: string | null;
  autoPauseEnabled: boolean;
  allowlistMode: string;
}

interface LimitChainRow {
  scope: 'agent' | 'developer' | 'balance';
  kind: string | null;
  label: string | null;
  policyId: number | null;
  matchKey: string | null;
  limitRaw: string;
  spentRaw: string;
  remainingRaw: string;
  windowKind: string | null;
  windowResetsAt: string | null;
}

interface LimitChainResponse {
  agentId: number | string;
  asOf: string;
  chain: LimitChainRow[];
}

interface ResolveResponse {
  decision: 'approve' | 'decline';
  effectiveRemainingRaw?: string;
  binding?: LimitChainRow;
  decline?: Record<string, unknown>;
}

export interface PolicyFlags {
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
  agent?: string;
  team?: boolean;
  includeRevoked?: boolean;
  kind?: string;
  limit?: string;
  match?: string;
  window?: string;
  action?: string;
  label?: string;
  host?: string;
  amount?: string;
  recipient?: string;
  task?: string;
  key?: string;
}

/** --agent resolves by name/id via the fleet; no flag targets the machine's active agent. */
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

function requirePolicyId(arg: string | undefined): string {
  if (!arg || !/^\d+$/.test(arg)) {
    throw new UsageError(`Invalid policy id "${arg ?? ''}" — a numeric id from \`floe policy list --json\`.`);
  }
  return arg;
}

function parseAction(value: string | undefined): 'block' | 'suspend_agent' | undefined {
  if (value === undefined) return undefined;
  if (value === 'block' || value === 'suspend_agent') return value;
  throw new UsageError(`Invalid --action "${value}". Supported: block (402 the call), suspend_agent (kill-switch).`);
}

/** "86400" → "24h" for human window rendering; falls back to raw seconds. */
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

/**
 * Map the --window flag to the API's windowKind/windowSeconds pair.
 * The API requires windowSeconds for rolling windows, so an omitted flag
 * defaults to a 24h rolling cap (the same default the dashboard uses);
 * session-kind team policies default to the session window instead.
 */
function windowFields(
  value: string | undefined,
  sessionKind: boolean,
): { windowKind: 'once' | 'rolling' | 'session'; windowSeconds?: number } {
  if (value === undefined) {
    return sessionKind ? { windowKind: 'session' } : { windowKind: 'rolling', windowSeconds: 86_400 };
  }
  if (value === 'once') {
    if (sessionKind) {
      throw new UsageError('session policies take a session window (default) or a rolling duration, not "once".');
    }
    return { windowKind: 'once' };
  }
  if (value === 'session') {
    if (!sessionKind) throw new UsageError('--window session is only valid for --kind session (--team).');
    return { windowKind: 'session' };
  }
  return { windowKind: 'rolling', windowSeconds: parseDuration(value) };
}

function policyTable(policies: PolicyRow[]): string {
  const header = ['ID', 'KIND', 'MATCH', 'LIMIT', 'WINDOW', 'ON BREACH', 'STATUS', 'LABEL'];
  const rows = policies.map((p) => [
    String(p.id),
    p.kind,
    p.matchKey ? sanitizeText(p.matchKey) : dim('—'),
    rawToUsd(p.limitRaw),
    describeWindow(p),
    p.action === 'suspend_agent' ? 'suspend' : 'block',
    p.status === 'active' ? green('active') : dim(p.status),
    p.label ? sanitizeText(p.label) : '',
  ]);
  return table(header, rows);
}

function summarizePolicy(p: PolicyRow): string {
  const match = p.matchKey ? ` "${sanitizeText(p.matchKey)}"` : '';
  return `${p.kind}${match} capped at ${bold(rawToUsd(p.limitRaw))} per ${describeWindow(p)}`;
}

/** Remap the API's duplicate-policy 409 into an actionable message. */
function remapCreateError(err: unknown): never {
  if (err instanceof ApiError && err.code === 'duplicate_active_policy') {
    throw new ApiError(
      `An active policy for that kind + match already exists — update it instead (\`floe policy update <id>\`) or revoke it first (\`floe policy revoke <id>\`).`,
      409,
      'duplicate_active_policy',
    );
  }
  throw err as Error;
}

export async function policyListCommand(flags: PolicyFlags): Promise<void> {
  const ctx = await devContext(flags);
  const query = flags.includeRevoked ? '?includeRevoked=true' : '';

  if (flags.team) {
    const [{ policies }, accountCap, defaults] = await Promise.all([
      ctx.api.dev<{ policies: PolicyRow[] }>('GET', `/v1/developer/policies${query}`),
      ctx.api.dev<AccountCapResponse>('GET', '/v1/developer/policies/account-cap'),
      ctx.api.dev<PolicyDefaultsResponse>('GET', '/v1/developer/policies/defaults'),
    ]);
    if (flags.json) return printJson({ scope: 'team', policies, accountCap, defaults });

    process.stdout.write(`${bold('Team policies — every agent on this account')}\n`);
    const capLine = accountCap.configured
      ? `${rawToUsd(accountCap.spentRaw)} spent of ${rawToUsd(accountCap.limitRaw)}` +
        (accountCap.windowKind ? ` ${dim(`(${accountCap.windowKind} window)`)}` : '')
      : dim('not configured');
    process.stdout.write(
      `${kv([
        ['Account cap', capLine],
        [
          'New-agent defaults',
          `session limit ${rawToUsd(defaults.sessionLimitRaw)} · auto-pause ${defaults.autoPauseEnabled ? 'on' : 'off'} · allowlist ${sanitizeText(defaults.allowlistMode)}`,
        ],
      ])}\n`,
    );
    if (policies.length === 0) {
      process.stdout.write(`${dim('No team policies. Create one: floe policy create --team --kind api --match .openai.com --limit 5')}\n`);
      return;
    }
    process.stdout.write(`${policyTable(policies)}\n`);
    return;
  }

  const agent = await targetAgent(ctx, flags.agent);
  const { policies } = await ctx.api.dev<{ policies: PolicyRow[] }>(
    'GET',
    `/v1/developer/agents/${agent.id}/policies${query}`,
  );
  if (flags.json) return printJson({ agentId: agent.id, policies });

  if (policies.length === 0) {
    process.stdout.write(
      `No policies for agent "${agent.name ?? agent.id}".\n${dim('Create one: floe policy create --kind api --match .openai.com --limit 5')}\n`,
    );
    return;
  }
  process.stdout.write(`${bold(`Policies — ${agent.name ?? agent.id}`)}\n${policyTable(policies)}\n`);
}

export async function policyCreateCommand(flags: PolicyFlags): Promise<void> {
  const team = flags.team === true;
  const kind = flags.kind;
  if (!kind) {
    throw new UsageError('Missing --kind. Agent policies: task, api, vendor; --team also allows session.');
  }
  const validKinds = team ? ['session', 'task', 'api', 'vendor'] : ['task', 'api', 'vendor'];
  if (!validKinds.includes(kind)) {
    throw new UsageError(
      team
        ? `Invalid --kind "${kind}". Team kinds: session, task, api, vendor.`
        : `Invalid --kind "${kind}". Agent kinds: task, api, vendor (the agent session cap is \`floe budget set\`).`,
    );
  }
  if (!flags.limit) throw new UsageError('Missing --limit <usd>.');
  const limitRaw = usdToRaw(flags.limit);

  let matchKey: string | undefined;
  let matchKind: 'host_exact' | 'host_suffix' | undefined;
  if (kind === 'session') {
    if (flags.match) throw new UsageError('session policies take no --match — they cap all spend.');
  } else {
    if (!flags.match) {
      const what = kind === 'task' ? 'task id' : kind === 'api' ? 'host or .suffix' : 'payee 0x address';
      throw new UsageError(`--kind ${kind} requires --match <${what}>.`);
    }
    matchKey = flags.match.toLowerCase();
    if (kind === 'api') {
      // The API's suffix matcher only honors dotted keys, so derive the
      // matchKind from the shape instead of exposing a footgun flag.
      matchKind = matchKey.startsWith('.') ? 'host_suffix' : 'host_exact';
    }
    if (kind === 'vendor' && !/^0x[a-f0-9]{40}$/.test(matchKey)) {
      throw new UsageError('vendor --match must be a 0x-prefixed 20-byte payee address.');
    }
  }
  const action = parseAction(flags.action);
  const win = windowFields(flags.window, kind === 'session');

  const body = {
    kind,
    matchKey,
    matchKind,
    limitRaw,
    windowKind: win.windowKind,
    windowSeconds: win.windowSeconds,
    action,
    label: flags.label,
  };

  const ctx = await devContext(flags);
  let created: { policy: PolicyRow };
  try {
    if (team) {
      created = await ctx.api.dev<{ policy: PolicyRow }>('POST', '/v1/developer/policies', body);
    } else {
      const agent = await targetAgent(ctx, flags.agent);
      created = await ctx.api.dev<{ policy: PolicyRow }>(
        'POST',
        `/v1/developer/agents/${agent.id}/policies`,
        body,
      );
    }
  } catch (err) {
    remapCreateError(err);
  }

  if (flags.json) return printJson({ scope: team ? 'team' : 'agent', policy: created.policy });
  process.stdout.write(`${ok(`Policy ${created.policy.id} created: ${summarizePolicy(created.policy)}`)}\n`);
  if (created.policy.action === 'suspend_agent') {
    process.stdout.write(`${dim('On breach the whole agent is suspended (kill-switch), not just the one call.')}\n`);
  }
}

export async function policyUpdateCommand(arg: string | undefined, flags: PolicyFlags): Promise<void> {
  const policyId = requirePolicyId(arg);
  const patch: { limitRaw?: string; windowSeconds?: number; action?: 'block' | 'suspend_agent'; label?: string } = {};
  if (flags.limit !== undefined) patch.limitRaw = usdToRaw(flags.limit);
  if (flags.window !== undefined) {
    if (flags.window === 'once' || flags.window === 'session') {
      throw new UsageError(
        "A policy's window kind can't be changed after creation — pass a duration (e.g. 24h) to change the rolling period, or revoke and recreate.",
      );
    }
    patch.windowSeconds = parseDuration(flags.window);
  }
  if (flags.action !== undefined) patch.action = parseAction(flags.action);
  if (flags.label !== undefined) patch.label = flags.label;
  if (Object.keys(patch).length === 0) {
    throw new UsageError('Nothing to update — pass --limit, --window, --action, or --label.');
  }

  const ctx = await devContext(flags);
  const path = flags.team
    ? `/v1/developer/policies/${policyId}`
    : `/v1/developer/agents/${(await targetAgent(ctx, flags.agent)).id}/policies/${policyId}`;
  const { policy } = await ctx.api.dev<{ policy: PolicyRow }>('PATCH', path, patch);

  if (flags.json) return printJson({ policy });
  process.stdout.write(`${ok(`Policy ${policy.id} updated: ${summarizePolicy(policy)}`)}\n`);
}

export async function policyRevokeCommand(arg: string | undefined, flags: PolicyFlags): Promise<void> {
  const policyId = requirePolicyId(arg);
  await confirmAction(`revoke policy ${policyId}`, policyId, { yes: flags.yes });

  const ctx = await devContext(flags);
  const path = flags.team
    ? `/v1/developer/policies/${policyId}`
    : `/v1/developer/agents/${(await targetAgent(ctx, flags.agent)).id}/policies/${policyId}`;
  await ctx.api.dev<{ status: string }>('DELETE', path);

  if (flags.json) return printJson({ policyId: Number(policyId), status: 'revoked' });
  process.stdout.write(`${ok(`Policy ${policyId} revoked.`)}\n`);
}

export async function policyResetCommand(arg: string | undefined, flags: PolicyFlags): Promise<void> {
  const policyId = requirePolicyId(arg);
  if (flags.team) {
    throw new UsageError('Team policies have no reset endpoint — only agent-scoped policies can be reset.');
  }
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  const { policy } = await ctx.api.dev<{ policy: PolicyRow }>(
    'POST',
    `/v1/developer/agents/${agent.id}/policies/${policyId}/reset`,
  );

  if (flags.json) return printJson({ policy });
  process.stdout.write(
    `${ok(`Policy ${policy.id} window restarted — spend counts from now against ${bold(rawToUsd(policy.limitRaw))}.`)}\n`,
  );
}

export async function policyChainCommand(flags: PolicyFlags): Promise<void> {
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  const res = await ctx.api.dev<LimitChainResponse>(
    'GET',
    `/v1/developer/agents/${agent.id}/limit-chain`,
  );
  if (flags.json) return printJson(res);

  process.stdout.write(
    `${bold(`Limit chain — ${agent.name ?? agent.id}`)} ${dim(`as of ${res.asOf.slice(0, 10)}`)}\n`,
  );
  const rows = res.chain.map((row) => [
    row.scope,
    row.kind ?? dim('—'),
    sanitizeText(row.matchKey ?? row.label ?? '—'),
    rawToUsd(row.remainingRaw),
    rawToUsd(row.limitRaw),
    row.windowResetsAt ? row.windowResetsAt.replace('T', ' ').slice(0, 16) : dim('—'),
  ]);
  process.stdout.write(`${table(['SCOPE', 'KIND', 'MATCH / LABEL', 'REMAINING', 'LIMIT', 'RESETS'], rows)}\n`);
  process.stdout.write(`${dim('Every live cap constraining this agent; the last row is the spendable balance.')}\n`);
}

export async function policyTestCommand(flags: PolicyFlags): Promise<void> {
  if (!flags.host) throw new UsageError('Missing --host <hostname> — the vendor host the call would hit.');
  if (!flags.amount) throw new UsageError('Missing --amount <usd> — the total charge to test.');
  const amountRaw = usdToRaw(flags.amount);
  if (flags.recipient !== undefined && !/^0x[a-fA-F0-9]{40}$/.test(flags.recipient)) {
    throw new UsageError('--recipient must be a 0x-prefixed 20-byte payee address.');
  }
  let keyId: number | undefined;
  if (flags.key !== undefined) {
    if (!/^\d+$/.test(flags.key)) {
      throw new UsageError('--key must be a numeric key id (see `floe keys --json`).');
    }
    keyId = Number(flags.key);
  }

  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  const res = await ctx.api.dev<ResolveResponse>('POST', `/v1/developer/agents/${agent.id}/resolve`, {
    host: flags.host,
    amountRaw,
    recipient: flags.recipient,
    taskId: flags.task,
    keyId,
  });
  if (flags.json) return printJson(res);

  if (res.decision === 'approve') {
    process.stdout.write(`${green('✓')} ${bold('ALLOW')} — this call would be admitted\n`);
    const b = res.binding;
    if (b) {
      const what =
        b.scope === 'balance'
          ? 'spendable balance'
          : `${b.scope} ${b.kind ?? 'policy'}${b.matchKey ? ` "${sanitizeText(b.matchKey)}"` : ''}${b.policyId != null ? ` (policy ${b.policyId})` : ''}`;
      process.stdout.write(
        `${kv([
          ['Deciding limit', what],
          ['Headroom', `${rawToUsd(b.remainingRaw)} of ${rawToUsd(b.limitRaw)}`],
        ])}\n`,
      );
    }
  } else {
    const decline = res.decline ?? {};
    const code = typeof decline.error === 'string' ? decline.error : 'declined';
    process.stdout.write(`${red('✗')} ${bold('DECLINE')} — ${sanitizeText(code)}\n`);
    const moneyFields = new Set(['available', 'required', 'spent', 'limit']);
    const rows: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(decline)) {
      if (key === 'error' || value === null || value === undefined) continue;
      rows.push([
        key,
        moneyFields.has(key) && typeof value === 'string' ? rawToUsd(value) : sanitizeText(String(value)),
      ]);
    }
    if (rows.length > 0) process.stdout.write(`${kv(rows)}\n`);
    if (code === 'host_not_allowlisted' || code === 'vendor_not_allowlisted') {
      process.stdout.write(`${warn('Add an allowlist entry (`floe allowlist add`) or relax the mode (`floe allowlist set off`).')}\n`);
    }
  }
  process.stdout.write(`${dim('Dry run — nothing was reserved or paid.')}\n`);
}

export const policyDef: CommandDef = {
  name: 'policy',
  summary: 'list | create | update | revoke | reset | chain | test — spend policies',
  usage: `Usage: floe policy [list] [--agent <ref> | --team] [--include-revoked]
       floe policy create --kind <task|api|vendor|session> --limit <usd> [--match <key>]
                          [--window <dur>|once] [--action block|suspend_agent]
                          [--label <text>] [--agent <ref> | --team]
       floe policy update <policyId> [--limit <usd>] [--window <dur>]
                          [--action block|suspend_agent] [--label <text>] [--agent <ref> | --team]
       floe policy revoke <policyId> [--agent <ref> | --team]
       floe policy reset <policyId> [--agent <ref>]
       floe policy chain [--agent <ref>]
       floe policy test --host <h> --amount <usd> [--recipient <0x…>] [--task <id>]
                        [--key <keyId>] [--agent <ref>]

Server-side spend caps enforced on every paid call. \`floe budget\` is the
shortcut for the common ones; this is the full surface. Policies target the
active agent, --agent <name|id>, or the whole account with --team.

  list     Active policies (--include-revoked adds history). --team also shows
           the account-wide cap and the defaults new agents inherit.
  create   --kind task    cap one task id            --match <task-id>
           --kind api     cap a host or suffix       --match api.host.com | .host.com
           --kind vendor  cap a payee wallet         --match 0x…
           --kind session account-wide cap           --team only, no --match
           --window is a rolling duration (24h, 7d) or "once" for a single-shot
           budget; default 24h rolling. --action suspend_agent makes a breach
           suspend the whole agent instead of declining one call.
  update   Change --limit, --window (rolling period), --action, or --label.
  revoke   Deactivate a policy permanently (asks for confirmation).
  reset    Restart an agent policy's window now (agent-scoped only).
  chain    Every live limit constraining the agent, ending in spendable balance.
  test     Dry-run a hypothetical call: ALLOW or DECLINE plus the deciding
           rule. Nothing is reserved or paid.
`,
  options: {
    agent: { type: 'string' },
    team: { type: 'boolean' },
    'include-revoked': { type: 'boolean' },
    kind: { type: 'string' },
    limit: { type: 'string' },
    match: { type: 'string' },
    window: { type: 'string' },
    action: { type: 'string' },
    label: { type: 'string' },
    host: { type: 'string' },
    amount: { type: 'string' },
    recipient: { type: 'string' },
    task: { type: 'string' },
    key: { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: PolicyFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      yes: ctx.yes,
      agent: str(ctx, 'agent'),
      team: flag(ctx, 'team'),
      includeRevoked: flag(ctx, 'include-revoked'),
      kind: str(ctx, 'kind'),
      limit: str(ctx, 'limit'),
      match: str(ctx, 'match'),
      window: str(ctx, 'window'),
      action: str(ctx, 'action'),
      label: str(ctx, 'label'),
      host: str(ctx, 'host'),
      amount: str(ctx, 'amount'),
      recipient: str(ctx, 'recipient'),
      task: str(ctx, 'task'),
      key: str(ctx, 'key'),
    };
    if (flags.agent && flags.team) {
      throw new UsageError('--agent and --team are mutually exclusive.');
    }
    if (subcommand === 'create') {
      expectArgs(ctx, 1);
      await policyCreateCommand(flags);
    } else if (subcommand === 'update') {
      expectArgs(ctx, 2);
      await policyUpdateCommand(arg, flags);
    } else if (subcommand === 'revoke') {
      expectArgs(ctx, 2);
      await policyRevokeCommand(arg, flags);
    } else if (subcommand === 'reset') {
      expectArgs(ctx, 2);
      await policyResetCommand(arg, flags);
    } else if (subcommand === 'chain') {
      expectArgs(ctx, 1);
      if (flags.team) throw new UsageError('policy chain is agent-scoped — drop --team.');
      await policyChainCommand(flags);
    } else if (subcommand === 'test') {
      expectArgs(ctx, 1);
      if (flags.team) throw new UsageError('policy test is agent-scoped — drop --team.');
      await policyTestCommand(flags);
    } else if (subcommand === undefined || subcommand === 'list') {
      expectArgs(ctx, 1);
      await policyListCommand(flags);
    } else {
      throw new UsageError(
        `Unknown policy subcommand "${subcommand}". Use: list, create, update, revoke, reset, chain, test.`,
      );
    }
  },
};
