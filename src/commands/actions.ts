import { expectArgs, str, type CommandDef } from '../lib/command.js';
import type { AgentEntry } from '../lib/config.js';
import { devContext, requireActiveAgent, resolveAgentRef, type DevContext } from '../lib/context.js';
import { bold, dim, green, kv, ok, printJson, red, sanitizeText, UsageError, yellow } from '../lib/output.js';
import { table } from '../lib/table.js';
import { rawToUsd } from '../lib/usdc.js';

/**
 * `floe actions` — outcome-linked spend attribution.
 *
 * Calls tagged with an X-Floe-Action-Id header roll up here: cost per action
 * joined with caller-reported outcomes ("what did each decision cost, and did
 * it work?"). Floe never judges quality — status/score/note are reported by
 * you, verbatim, and a re-report overwrites the previous one.
 */

/** Valid --status values — mirror of the API's reportOutcomeSchema. */
const OUTCOME_STATUSES = ['success', 'failure', 'partial', 'unknown'] as const;

interface ActionOutcomeView {
  status: string;
  scoreBps: number | null;
  note: string | null;
  reportCount: number;
  reportedAt: string;
}

/** One rollup entry from GET /agents/:id/actions. spentRaw is a 6-dp USDC integer string. */
interface ActionRollupEntry {
  actionId: string;
  calls: number;
  spentRaw: string;
  firstSeen: string | null;
  lastSeen: string | null;
  outcome: ActionOutcomeView | null;
}

interface ReportOutcomeResponse {
  actionId: string;
  outcome: ActionOutcomeView;
}

export interface ActionsFlags {
  apiUrl?: string;
  json?: boolean;
  agent?: string;
  limit?: string;
  status?: string;
  score?: string;
  note?: string;
}

/**
 * The agent a subcommand targets: --agent resolves against the fleet by
 * id-then-name; omitted → this machine's active agent straight from config
 * (no network round-trip). Same contract as keys.ts.
 */
async function targetAgent(
  ctx: DevContext,
  ref: string | undefined,
): Promise<{ id: string } & AgentEntry> {
  if (!ref) return requireActiveAgent(ctx.config);
  const agent = await resolveAgentRef(ctx, ref);
  return { ...ctx.config.agents?.[agent.id], id: String(agent.id), name: agent.name };
}

/** Server clamps to 1..500 silently — fail loudly client-side instead. */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`Invalid --limit "${raw}" — pass a whole number between 1 and 500.`);
  }
  const limit = Number(raw);
  if (limit < 1 || limit > 500) {
    throw new UsageError('--limit must be between 1 and 500.');
  }
  return limit;
}

/**
 * Mirror of the API's action-id normalization (actionIdFromHeader): trimmed,
 * lowercased, ≤128 chars — so `floe actions report` addresses the same id the
 * gateway stored for the X-Floe-Action-Id header.
 */
function normalizeActionId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!id) throw new UsageError('Action id must not be empty.');
  if (id.length > 128) {
    throw new UsageError('Action ids are at most 128 characters.');
  }
  return id;
}

function styleStatus(status: string): string {
  const clean = sanitizeText(status);
  if (status === 'success') return green(clean);
  if (status === 'failure') return red(clean);
  if (status === 'partial') return yellow(clean);
  return dim(clean);
}

/** "9550" bps → "95.5%" — display only, never money. */
const bpsToPercent = (bps: number): string => `${bps / 100}%`;

function outcomeCell(outcome: ActionOutcomeView | null): string {
  if (!outcome) return dim('—');
  const score = outcome.scoreBps !== null ? ` ${bpsToPercent(outcome.scoreBps)}` : '';
  return `${styleStatus(outcome.status)}${score}`;
}

export async function actionsListCommand(flags: ActionsFlags): Promise<void> {
  const limit = parseLimit(flags.limit);
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);

  const query = limit !== undefined ? `?limit=${limit}` : '';
  const { actions } = await ctx.api.dev<{ actions: ActionRollupEntry[] }>(
    'GET',
    `/v1/developer/agents/${agent.id}/actions${query}`,
  );

  if (flags.json) return printJson({ agentId: agent.id, actions });

  if (actions.length === 0) {
    process.stdout.write(
      `No tagged actions yet for agent "${sanitizeText(agent.name ?? agent.id)}".\n` +
        `${dim('Send an X-Floe-Action-Id header on gateway/proxy calls — every tagged call rolls up here.')}\n`,
    );
    return;
  }

  process.stdout.write(`${bold(`Actions — ${sanitizeText(agent.name ?? agent.id)}`)}\n`);
  const rows = actions.map((a) => [
    sanitizeText(a.actionId),
    String(a.calls),
    rawToUsd(a.spentRaw),
    outcomeCell(a.outcome),
    a.lastSeen
      ? sanitizeText(a.lastSeen).slice(0, 10)
      : a.outcome
        ? sanitizeText(a.outcome.reportedAt).slice(0, 10)
        : dim('—'),
  ]);
  process.stdout.write(`${table(['ACTION', 'CALLS', 'COST', 'OUTCOME', 'LAST SEEN'], rows)}\n`);
  process.stdout.write(
    `${dim(`Showing ${actions.length} action${actions.length === 1 ? '' : 's'} (most recent first). Report an outcome: floe actions report <actionId> --status <s>`)}\n`,
  );
}

export async function actionsReportCommand(actionIdArg: string, flags: ActionsFlags): Promise<void> {
  // Validation precedes I/O — bad ids, statuses, scores and notes fail before any call.
  const actionId = normalizeActionId(actionIdArg);
  const status = flags.status;
  if (!status) {
    throw new UsageError(`--status is required: ${OUTCOME_STATUSES.join(' | ')}`);
  }
  if (!(OUTCOME_STATUSES as readonly string[]).includes(status)) {
    throw new UsageError(
      `Invalid --status "${status}". Valid statuses: ${OUTCOME_STATUSES.join(', ')}.`,
    );
  }
  let scoreBps: number | undefined;
  if (flags.score !== undefined) {
    if (!/^\d+$/.test(flags.score) || Number(flags.score) > 10_000) {
      throw new UsageError(
        `Invalid --score "${flags.score}" — basis points: a whole number from 0 to 10000 (10000 = perfect).`,
      );
    }
    scoreBps = Number(flags.score);
  }
  if (flags.note !== undefined && flags.note.length > 500) {
    throw new UsageError('--note is limited to 500 characters.');
  }

  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);

  const body: Record<string, unknown> = { status };
  if (scoreBps !== undefined) body.scoreBps = scoreBps;
  if (flags.note !== undefined) body.note = flags.note;

  const result = await ctx.api.dev<ReportOutcomeResponse>(
    'POST',
    `/v1/developer/agents/${agent.id}/actions/${encodeURIComponent(actionId)}/outcome`,
    body,
  );

  if (flags.json) return printJson({ agentId: agent.id, ...result });

  process.stdout.write(
    `${ok(`Outcome recorded for action "${bold(sanitizeText(result.actionId))}" on agent "${sanitizeText(agent.name ?? agent.id)}"`)}\n`,
  );
  const rows: Array<[string, string]> = [['Status', styleStatus(result.outcome.status)]];
  if (result.outcome.scoreBps !== null) {
    rows.push(['Score', `${bpsToPercent(result.outcome.scoreBps)} (${result.outcome.scoreBps} bps)`]);
  }
  if (result.outcome.note !== null) rows.push(['Note', sanitizeText(result.outcome.note)]);
  rows.push(['Reports', String(result.outcome.reportCount)]);
  process.stdout.write(`${kv(rows)}\n`);
  if (result.outcome.reportCount > 1) {
    process.stdout.write(`${dim('Re-reports overwrite: this outcome replaced the previous one.')}\n`);
  }
}

export const actionsDef: CommandDef = {
  name: 'actions',
  summary: 'list | report — cost-per-action rollups and outcomes',
  usage: `Usage: floe actions [list] [--limit <n>] [--agent <name|id>]
       floe actions report <actionId> --status <status>
                           [--score <bps>] [--note <text>] [--agent <name|id>]

Cost-per-action rollups and outcome reporting (the eval view). Tag gateway or
x402 proxy calls with an X-Floe-Action-Id header; every tagged call's settled
cost rolls up under that action id. Default agent: the one this machine uses.

  list              Cost per action joined with reported outcomes.
                    --limit <n>   distinct actions to fetch, 1-500 (default 100)
  report <id>       Report (or overwrite) the outcome for one action. Floe
                    never judges quality — these fields are yours, verbatim:
                    --status  success | failure | partial | unknown  (required)
                    --score   0-10000 basis points (10000 = perfect)
                    --note    free text, up to 500 characters
`,
  options: {
    limit: { type: 'string' },
    agent: { type: 'string' },
    status: { type: 'string' },
    score: { type: 'string' },
    note: { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: ActionsFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      agent: str(ctx, 'agent'),
      limit: str(ctx, 'limit'),
      status: str(ctx, 'status'),
      score: str(ctx, 'score'),
      note: str(ctx, 'note'),
    };
    if (subcommand === 'report') {
      if (!arg) {
        throw new UsageError(
          'Usage: floe actions report <actionId> --status <success|failure|partial|unknown> — list ids with `floe actions`.',
        );
      }
      expectArgs(ctx, 2);
      await actionsReportCommand(arg, flags);
    } else if (subcommand === undefined || subcommand === 'list') {
      expectArgs(ctx, 1);
      await actionsListCommand(flags);
    } else {
      throw new UsageError(
        `Unknown actions subcommand "${subcommand}". Use: list, report <actionId>.`,
      );
    }
  },
};
