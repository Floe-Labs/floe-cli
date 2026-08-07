import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { devContext, resolveAgentRef } from '../lib/context.js';
import { bold, dim, printJson, sanitizeText, UsageError } from '../lib/output.js';
import { table } from '../lib/table.js';
import { rawToUsd } from '../lib/usdc.js';

/**
 * Cross-source spend ledger — GET /v1/developer/ledger. One neutral money
 * view across Floe-carried spend (gateway rails, x402 proxy, Floe Phone) and
 * orchestrator-reconciled spend (Vapi/Retell/Bland), rolled up by the chosen
 * dimension. Read-only; --json passes the API response through unchanged.
 */

/** Valid groupBy dimensions — mirrors the API's GROUP_DIMENSIONS (ledger.ts). */
const GROUP_DIMENSIONS = ['source', 'customer', 'campaign', 'agent'] as const;
const GROUP_SET = new Set<string>(GROUP_DIMENSIONS);

interface LedgerRow {
  key: string;
  /** False = rows missing the tag (no customer/task id), regardless of the
   *  display label — filter on this, never on the label. */
  tagged: boolean;
  calls: number;
  costRaw: string;
  /** Orchestrator-reconciled share of this bucket. */
  reconciledRaw: string;
}

interface LedgerResponse {
  days: number;
  groupBy: string;
  totalRaw: string;
  rows: LedgerRow[];
}

export interface LedgerFlags {
  groupBy?: string;
  days?: string;
  agent?: string;
  apiUrl?: string;
  json?: boolean;
}

/** 1..90, matching the API's MAX_DAYS. */
function parseDays(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 90) {
    throw new UsageError('--days must be an integer between 1 and 90.');
  }
  return raw;
}

export async function ledgerCommand(flags: LedgerFlags): Promise<void> {
  // Validation precedes I/O.
  const groupBy = flags.groupBy ?? 'source';
  if (!GROUP_SET.has(groupBy)) {
    throw new UsageError(`Unknown --group-by "${groupBy}". Supported: ${GROUP_DIMENSIONS.join(', ')}.`);
  }
  const days = parseDays(flags.days);

  const ctx = await devContext(flags);
  const query = new URLSearchParams();
  query.set('groupBy', groupBy);
  if (days !== undefined) query.set('days', days);
  let agentLabel: string | undefined;
  if (flags.agent !== undefined) {
    const agent = await resolveAgentRef(ctx, flags.agent);
    query.set('agentId', String(agent.id));
    agentLabel = agent.name ?? String(agent.id);
  }
  const ledger = await ctx.api.dev<LedgerResponse>('GET', `/v1/developer/ledger?${query.toString()}`);

  if (flags.json) return printJson(ledger);

  const scope = agentLabel ? ` · agent ${sanitizeText(agentLabel)}` : '';
  process.stdout.write(`${bold(`Ledger — by ${sanitizeText(ledger.groupBy)} · last ${ledger.days} days${scope}`)}\n`);
  if (ledger.rows.length === 0) {
    process.stdout.write('No spend in this window.\n');
    return;
  }
  const rows = ledger.rows.map((row) => [
    row.tagged ? sanitizeText(row.key) : dim(`${sanitizeText(row.key)} (no tag)`),
    String(row.calls),
    rawToUsd(row.costRaw),
    rawToUsd(row.reconciledRaw),
  ]);
  process.stdout.write(`${table([groupBy.toUpperCase(), 'CALLS', 'SPEND', 'RECONCILED'], rows)}\n`);
  process.stdout.write(`Total: ${bold(rawToUsd(ledger.totalRaw))}\n`);
  process.stdout.write(
    `${dim('RECONCILED = orchestrator-ingested (Vapi/Retell/Bland) share of each bucket.')}\n`,
  );
}

export const ledgerDef: CommandDef = {
  name: 'ledger',
  summary: 'Cross-source spend ledger, grouped',
  usage: `Usage: floe ledger [--group-by source|customer|campaign|agent] [--days <n>] [--agent <ref>]

Cross-source spend ledger: one money view across Floe rails (gateway, x402
proxy, Floe Phone) and orchestrator-reconciled spend (Vapi/Retell/Bland),
rolled up by the chosen dimension.

  --group-by <dim>  source (default) | customer | campaign | agent.
                    customer/campaign group by the X-Floe-Customer-Id /
                    X-Floe-Task-Id tags on calls; untagged spend stays
                    visible as its own bucket.
  --days <n>        Window in days, 1-90 (default 30)
  --agent <ref>     Narrow to one agent by name or id (default: all agents)

--json emits { days, groupBy, totalRaw, rows } exactly as the API returns
them; costRaw/reconciledRaw stay raw 6-decimal USDC strings.
`,
  options: {
    'group-by': { type: 'string' },
    days: { type: 'string' },
    agent: { type: 'string' },
  },
  run: async (ctx) => {
    expectArgs(ctx, 0);
    await ledgerCommand({
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      groupBy: str(ctx, 'group-by'),
      days: str(ctx, 'days'),
      agent: str(ctx, 'agent'),
    });
  },
};
