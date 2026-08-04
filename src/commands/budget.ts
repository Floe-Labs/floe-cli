import { ApiError, FloeApi } from '../lib/api.js';
import { readConfig, resolveApiUrl, type CliConfig } from '../lib/config.js';
import { resolveDevKey } from '../lib/keychain.js';
import { bold, dim, kv, ok, printJson, UsageError } from '../lib/output.js';
import type { AgentKeySummary, KeyBudgetView, SpendLimitResponse } from '../lib/types.js';
import { rawToUsd, usdToRaw } from '../lib/usdc.js';

export interface BudgetFlags {
  per?: string;
  task?: string;
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

async function requireContext(flags: BudgetFlags): Promise<{ api: FloeApi; config: CliConfig; apiUrl: string }> {
  const config = readConfig();
  const apiUrl = resolveApiUrl(flags.apiUrl, config);
  const devKey = await resolveDevKey(apiUrl);
  if (!devKey) {
    throw new ApiError('Not signed in. Run `floe init` first.', 401, 'missing_credential');
  }
  if (!config.agentId) {
    throw new UsageError('No agent configured on this machine. Run `floe init` first.');
  }
  return { api: new FloeApi(apiUrl, devKey), config, apiUrl };
}

export async function budgetShowCommand(flags: BudgetFlags): Promise<void> {
  const { api, config } = await requireContext(flags);
  const [spendLimit, { keys }] = await Promise.all([
    api.dev<SpendLimitResponse>('GET', `/v1/developer/agents/${config.agentId}/spend-limit`),
    api.dev<{ keys: AgentKeySummary[] }>('GET', `/v1/developer/agents/${config.agentId}/keys`),
  ]);
  const activeKey = keys.find((k) => k.id === config.keyId) ?? keys[0];

  if (flags.json) {
    printJson({ agentId: config.agentId, spendLimit, keyBudget: activeKey?.budget ?? null, keyId: activeKey?.id ?? null });
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
  process.stdout.write(`${bold(`Budgets — ${config.agentName ?? config.agentId}`)}\n${kv(rows)}\n`);
  process.stdout.write(`${dim('Set one: floe budget set <usd> [--per day|task]')}\n`);
}

export async function budgetSetCommand(amount: string, flags: BudgetFlags): Promise<void> {
  const { api, config } = await requireContext(flags);
  const limitRaw = usdToRaw(amount);
  const per = flags.per;

  if (per === undefined) {
    const result = await api.dev<SpendLimitResponse>(
      'PUT',
      `/v1/developer/agents/${config.agentId}/spend-limit`,
      { limitRaw },
    );
    if (flags.json) return printJson({ scope: 'total', ...result });
    process.stdout.write(
      `${ok(`Total spend limit set: ${bold(rawToUsd(limitRaw))} for agent "${config.agentName}"`)}\n` +
        `${dim('The window starts now; spend past it is refused. Clear with: floe budget clear')}\n`,
    );
    return;
  }

  if (per === 'day') {
    if (!config.keyId) {
      throw new UsageError('No agent key on record for a per-day key budget. Run `floe init` first.');
    }
    const result = await api.dev<{ budget: KeyBudgetView }>(
      'PUT',
      `/v1/developer/agents/${config.agentId}/keys/${config.keyId}/budget`,
      { budgetRaw: limitRaw, windowSeconds: 86_400 },
    );
    if (flags.json) return printJson({ scope: 'day', keyId: config.keyId, ...result });
    process.stdout.write(
      `${ok(`Daily budget set: ${bold(rawToUsd(limitRaw))} per rolling 24h on key ${config.keyPrefix ?? config.keyId}`)}\n`,
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
      `/v1/developer/agents/${config.agentId}/policies`,
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
  const { api, config } = await requireContext(flags);
  if (flags.per === 'day') {
    if (!config.keyId) throw new UsageError('No agent key on record. Run `floe init` first.');
    await api.dev('DELETE', `/v1/developer/agents/${config.agentId}/keys/${config.keyId}/budget`);
    if (flags.json) return printJson({ scope: 'day', cleared: true });
    process.stdout.write(`${ok('Daily key budget cleared.')}\n`);
    return;
  }
  if (flags.per !== undefined) {
    throw new UsageError('budget clear supports the total cap (no flag) or --per day.');
  }
  await api.dev('DELETE', `/v1/developer/agents/${config.agentId}/spend-limit`);
  if (flags.json) return printJson({ scope: 'total', cleared: true });
  process.stdout.write(`${ok('Total spend limit cleared.')}\n`);
}
