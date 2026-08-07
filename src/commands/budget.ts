import { ApiError } from '../lib/api.js';
import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { devContext, requireActiveAgent, resolveAgentRef, type DevContext } from '../lib/context.js';
import type { AgentEntry } from '../lib/config.js';
import { parseDuration } from '../lib/duration.js';
import { bold, dim, kv, ok, printJson, sanitizeText, UsageError } from '../lib/output.js';
import type { AgentKeySummary, KeyBudgetView, SpendLimitResponse } from '../lib/types.js';
import { rawToUsd, usdToRaw } from '../lib/usdc.js';

export interface BudgetFlags {
  per?: string;
  task?: string;
  amount?: string;
  ttl?: string;
  agent?: string;
  apiUrl?: string;
  json?: boolean;
}

/**
 * Cap mapping — only what the API actually enforces:
 *   floe budget set 5              → agent session spend-limit (total cap)
 *   floe budget set 5 --per day    → this key's rolling 24h budget
 *   floe budget set 5 --per task --task <id> → once-window task policy
 * There is no per-call primitive server-side, so no --per call flag exists.
 */

async function requireContext(
  flags: BudgetFlags,
): Promise<DevContext & { agent: { id: string } & AgentEntry }> {
  const ctx = await devContext(flags);
  if (!flags.agent) return { ...ctx, agent: requireActiveAgent(ctx.config) };
  // --agent targets another agent; its config entry (if any) supplies the
  // machine-recorded keyId that --per day budgets act on.
  const resolved = await resolveAgentRef(ctx, flags.agent);
  const id = String(resolved.id);
  return { ...ctx, agent: { ...ctx.config.agents?.[id], id, name: resolved.name } };
}

export async function budgetShowCommand(flags: BudgetFlags): Promise<void> {
  const { api, agent } = await requireContext(flags);
  const [spendLimit, { keys }] = await Promise.all([
    api.dev<SpendLimitResponse>('GET', `/v1/developer/agents/${agent.id}/spend-limit`),
    api.dev<{ keys: AgentKeySummary[] }>('GET', `/v1/developer/agents/${agent.id}/keys`),
  ]);
  const activeKey = agent.keyId
    ? keys.find((k) => k.id === agent.keyId)
    : keys[0];

  if (flags.json) {
    printJson({ agentId: agent.id, spendLimit, keyBudget: activeKey?.budget ?? null, keyId: activeKey?.id ?? null });
    return;
  }

  const rows: Array<[string, string]> = [];
  rows.push([
    'Total (spend limit)',
    spendLimit.active
      ? `${rawToUsd(spendLimit.sessionRemainingRaw)} of ${rawToUsd(spendLimit.limitRaw)} remaining`
      : dim('not set'),
  ]);
  rows.push([
    `Key ${activeKey?.keyPrefix ?? ''}`,
    activeKey?.budget
      ? `${rawToUsd(activeKey.budget.remainingRaw)} of ${rawToUsd(activeKey.budget.limitRaw)} remaining ${dim(`(${activeKey.budget.windowKind})`)}`
      : dim('no budget'),
  ]);
  process.stdout.write(`${bold(`Budgets — ${agent.name ?? agent.id}`)}\n${kv(rows)}\n`);
  process.stdout.write(`${dim('Set one: floe budget set <usd> [--per day|task]')}\n`);
}

export async function budgetSetCommand(amount: string, flags: BudgetFlags): Promise<void> {
  const { api, agent } = await requireContext(flags);
  const limitRaw = usdToRaw(amount);
  const per = flags.per;

  if (per === undefined) {
    const result = await api.dev<SpendLimitResponse>(
      'PUT',
      `/v1/developer/agents/${agent.id}/spend-limit`,
      { limitRaw },
    );
    if (flags.json) return printJson({ scope: 'total', ...result });
    process.stdout.write(
      `${ok(`Total spend limit set: ${bold(rawToUsd(limitRaw))} for agent "${agent.name}"`)}\n` +
        `${dim('The window starts now; spend past it is refused. Clear with: floe budget clear')}\n`,
    );
    return;
  }

  if (per === 'day') {
    if (!agent.keyId) {
      throw new UsageError(
        `No key on record for agent "${agent.name ?? agent.id}" on this machine. ` +
          'Per-day budgets act on a specific key — list keys with `floe keys --agent <ref> --json`.',
      );
    }
    const result = await api.dev<{ budget: KeyBudgetView }>(
      'PUT',
      `/v1/developer/agents/${agent.id}/keys/${agent.keyId}/budget`,
      { budgetRaw: limitRaw, windowSeconds: 86_400 },
    );
    if (flags.json) return printJson({ scope: 'day', keyId: agent.keyId, ...result });
    process.stdout.write(
      `${ok(`Daily budget set: ${bold(rawToUsd(limitRaw))} per rolling 24h on key ${agent.keyPrefix ?? agent.keyId}`)}\n`,
    );
    return;
  }

  if (per === 'task') {
    if (!flags.task) {
      throw new UsageError(
        'Per-task budgets cap a specific task id: floe budget set <usd> --per task --task <task-id>\n' +
          'Then send X-Floe-Task-Id: <task-id> on the calls that belong to that task.',
      );
    }
    const result = await api.dev<{ policy: { id: string } }>(
      'POST',
      `/v1/developer/agents/${agent.id}/policies`,
      { kind: 'task', matchKey: flags.task, limitRaw, windowKind: 'once', label: `floe-cli task budget` },
    );
    if (flags.json) return printJson({ scope: 'task', task: flags.task, ...result });
    process.stdout.write(
      `${ok(`Task budget set: ${bold(rawToUsd(limitRaw))} total for task "${flags.task}"`)}\n` +
        `${dim(`Tag the task's calls with header X-Floe-Task-Id: ${flags.task}`)}\n`,
    );
    return;
  }

  throw new UsageError(`Unknown --per value "${per}". Supported: day, task (default: total cap).`);
}

export async function budgetClearCommand(flags: BudgetFlags): Promise<void> {
  const { api, agent } = await requireContext(flags);
  if (flags.per === 'day') {
    if (!agent.keyId) throw new UsageError('No agent key on record. Run `floe init` first.');
    await api.dev('DELETE', `/v1/developer/agents/${agent.id}/keys/${agent.keyId}/budget`);
    if (flags.json) return printJson({ scope: 'day', cleared: true });
    process.stdout.write(`${ok('Daily key budget cleared.')}\n`);
    return;
  }
  if (flags.per !== undefined) {
    throw new UsageError('budget clear supports the total cap (no flag) or --per day.');
  }
  await api.dev('DELETE', `/v1/developer/agents/${agent.id}/spend-limit`);
  if (flags.json) return printJson({ scope: 'total', cleared: true });
  process.stdout.write(`${ok('Total spend limit cleared.')}\n`);
}

/** POST /v1/developer/agents/:id/pre-borrow response (201). */
interface PreBorrowResponse {
  policyId: number;
  taskId: string;
  limitRaw: string;
  /** UNIX seconds. */
  expiresAt: number;
  expiresAtIso: string;
}

/**
 * Pre-authorize a task: a hold (once-window task policy) that caps what calls
 * tagged X-Floe-Task-Id may spend, expiring after --ttl (default 1h
 * server-side, max 24h). One active hold per task id.
 */
export async function budgetReserveCommand(flags: BudgetFlags): Promise<void> {
  if (!flags.task) {
    throw new UsageError('Usage: floe budget reserve --task <id> --amount <usd> [--ttl <dur>] [--agent <ref>]');
  }
  if (!flags.amount) throw new UsageError('Missing --amount <usd> — the size of the task hold.');
  const amountRaw = usdToRaw(flags.amount);
  let ttlSeconds: number | undefined;
  if (flags.ttl !== undefined) {
    ttlSeconds = parseDuration(flags.ttl);
    if (ttlSeconds > 86_400) {
      throw new UsageError('--ttl must be 24h or less — the API caps pre-borrow holds at 24h.');
    }
  }

  const ctx = await devContext(flags);
  const agent = flags.agent
    ? await resolveAgentRef(ctx, flags.agent)
    : requireActiveAgent(ctx.config);

  let result: PreBorrowResponse;
  try {
    result = await ctx.api.dev<PreBorrowResponse>(
      'POST',
      `/v1/developer/agents/${agent.id}/pre-borrow`,
      { taskId: flags.task, amountRaw, ttlSeconds },
    );
  } catch (err) {
    if (err instanceof ApiError && err.code === 'task_already_held') {
      throw new ApiError(
        `Task "${flags.task}" already has an active hold — wait for it to expire or revoke its policy (\`floe policy revoke <id>\`).`,
        409,
        'task_already_held',
      );
    }
    throw err;
  }

  if (flags.json) return printJson(result);
  process.stdout.write(
    `${ok(`Reserved ${bold(rawToUsd(result.limitRaw))} for task "${sanitizeText(result.taskId)}" (policy ${result.policyId})`)}\n` +
      `${dim(`Hold expires ${result.expiresAtIso}. Tag the task's calls with header X-Floe-Task-Id: ${sanitizeText(result.taskId)}`)}\n`,
  );
}

export const budgetDef: CommandDef = {
  name: 'budget',
  summary: 'show | set <usd> [--per day|task] | clear | reserve — cap agent spend',
  usage: `Usage: floe budget [show] [--agent <ref>]
       floe budget set <usd> [--per day|task [--task <id>]] [--agent <ref>]
       floe budget clear [--per day] [--agent <ref>]
       floe budget reserve --task <id> --amount <usd> [--ttl <dur>] [--agent <ref>]

Cap agent spend at the scopes the API enforces:
  set <usd>                        total session spend limit for the agent
  set <usd> --per day              rolling 24h budget on this machine's key
  set <usd> --per task --task <t>  one-shot cap for calls tagged X-Floe-Task-Id: <t>
  reserve --task <t> --amount <a>  pre-authorize a task: an expiring hold (default
                                   TTL 1h, max 24h) capping that task's spend

There is no --per call: the API has no per-call primitive.
`,
  options: {
    per: { type: 'string' },
    task: { type: 'string' },
    amount: { type: 'string' },
    ttl: { type: 'string' },
    agent: { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: BudgetFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      per: str(ctx, 'per'),
      task: str(ctx, 'task'),
      amount: str(ctx, 'amount'),
      ttl: str(ctx, 'ttl'),
      agent: str(ctx, 'agent'),
    };
    if (subcommand === 'reserve') {
      expectArgs(ctx, 1);
      await budgetReserveCommand(flags);
    } else if (subcommand === 'set') {
      if (!arg) throw new UsageError('Usage: floe budget set <usd> [--per day|task [--task <id>]]');
      expectArgs(ctx, 2);
      await budgetSetCommand(arg, flags);
    } else if (subcommand === 'clear') {
      expectArgs(ctx, 1);
      await budgetClearCommand(flags);
    } else if (subcommand === undefined || subcommand === 'show') {
      expectArgs(ctx, 1);
      await budgetShowCommand(flags);
    } else {
      throw new UsageError(`Unknown budget subcommand "${subcommand}". Use: show, set <usd>, clear, reserve.`);
    }
  },
};
