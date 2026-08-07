import { ApiError } from '../lib/api.js';
import { expectArgs, flag, str, type CommandDef } from '../lib/command.js';
import { devContext, resolveAgentRef } from '../lib/context.js';
import { bold, dim, kv, printJson, sanitizeText, UsageError } from '../lib/output.js';
import { table } from '../lib/table.js';
import { rawToUsd } from '../lib/usdc.js';

/**
 * Unified account activity feed — GET /v1/developer/activity. One
 * chronological union across x402 calls, onramp purchases/sweeps, wallet
 * transfers, and credit-facility loan events, keyset-paginated by an opaque
 * cursor. Read-only; the --json shape passes the API response through
 * unchanged so agents can script against it.
 */

/** Event discriminators — mirrors the API's ALL_EVENT_TYPES (activity.ts). */
const EVENT_TYPES = [
  'x402_call',
  'onramp_purchase',
  'onramp_sweep',
  'transfer_deposit',
  'transfer_withdrawal',
  'transfer_external',
  'facility_loan_match',
  'facility_loan_repay',
  'facility_loan_rollover',
  'facility_loan_failed',
] as const;
const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

interface ActivityEvent {
  /** "<source>:<row-id>" — stable across the union. */
  id: string;
  type: string;
  /** id 0 + "Developer wallet" for developer-level external transfers. */
  agent: { id: number | string; name: string; walletAddress: string };
  timestamp: string;
  status: string;
  /** Pre-formatted one-line summary (amounts included). */
  summary: string;
  /** Raw 6-dp USDC string; null for events with no amount. */
  amountRaw: string | null;
  txHash: string | null;
  /** Present only when ?expand=details was requested. */
  details?: Record<string, unknown>;
}

interface ActivityResponse {
  events: ActivityEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ActivityFlags {
  agent?: string;
  type?: string;
  since?: string;
  until?: string;
  key?: string;
  limit?: string;
  cursor?: string;
  expand?: boolean;
  apiUrl?: string;
  json?: boolean;
}

/** Validate every filter flag and build the query — before any I/O. */
function buildQuery(flags: ActivityFlags): URLSearchParams {
  const query = new URLSearchParams();
  if (flags.type !== undefined) {
    const requested = flags.type
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (requested.length === 0) {
      throw new UsageError('--type needs at least one event type.');
    }
    for (const t of requested) {
      if (!EVENT_TYPE_SET.has(t)) {
        throw new UsageError(`Unknown event type "${t}". Valid types: ${EVENT_TYPES.join(', ')}`);
      }
    }
    query.set('type', requested.join(','));
  }
  if (flags.since !== undefined) {
    if (Number.isNaN(Date.parse(flags.since))) {
      throw new UsageError(`--since must be an ISO 8601 timestamp (got "${flags.since}").`);
    }
    query.set('since', flags.since);
  }
  if (flags.until !== undefined) {
    if (Number.isNaN(Date.parse(flags.until))) {
      throw new UsageError(`--until must be an ISO 8601 timestamp (got "${flags.until}").`);
    }
    query.set('until', flags.until);
  }
  if (flags.cursor !== undefined) query.set('cursor', flags.cursor);
  if (flags.limit !== undefined) {
    if (!/^\d+$/.test(flags.limit) || Number(flags.limit) < 1 || Number(flags.limit) > 100) {
      throw new UsageError('--limit must be an integer between 1 and 100.');
    }
    query.set('limit', flags.limit);
  }
  if (flags.expand) query.set('expand', 'details');
  if (flags.key !== undefined) {
    if (!/^\d+$/.test(flags.key)) {
      throw new UsageError('--key takes the numeric key id — see `floe keys --json`.');
    }
    query.set('apiKeyId', flags.key);
  }
  return query;
}

function renderExpanded(events: ActivityEvent[]): void {
  for (const event of events) {
    const rows: Array<[string, string]> = [
      ['time', sanitizeText(event.timestamp).replace('T', ' ')],
      ['agent', sanitizeText(event.agent?.name ?? '')],
      ['type', sanitizeText(event.type)],
      ['status', sanitizeText(event.status)],
      ['summary', sanitizeText(event.summary)],
      ['amount', rawToUsd(event.amountRaw)],
    ];
    if (event.txHash) rows.push(['tx', sanitizeText(event.txHash)]);
    for (const [k, v] of Object.entries(event.details ?? {})) {
      const value = v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      rows.push([sanitizeText(k), sanitizeText(value)]);
    }
    process.stdout.write(`${bold(sanitizeText(event.id))}\n${kv(rows)}\n\n`);
  }
}

export async function activityCommand(flags: ActivityFlags): Promise<void> {
  const query = buildQuery(flags); // validation precedes I/O
  const ctx = await devContext(flags);

  let agentLabel: string | undefined;
  if (flags.agent !== undefined) {
    const agent = await resolveAgentRef(ctx, flags.agent);
    query.set('agentId', String(agent.id));
    agentLabel = agent.name ?? String(agent.id);
  }

  const qs = query.toString();
  let feed: ActivityResponse;
  try {
    feed = await ctx.api.dev<ActivityResponse>('GET', `/v1/developer/activity${qs ? `?${qs}` : ''}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // The API 404s both for an unknown/unowned key id and for an account
      // with zero agents — say which one this run can actually mean.
      throw new ApiError(
        flags.key !== undefined
          ? `API key ${flags.key} not found on this account.`
          : 'No agents on this account yet — run `floe init` first.',
        404,
        err.code,
      );
    }
    throw err;
  }

  if (flags.json) return printJson(feed);

  const scope = agentLabel ? ` · ${sanitizeText(agentLabel)}` : '';
  if (feed.events.length === 0) {
    process.stdout.write(
      agentLabel
        ? `No activity found for agent "${sanitizeText(agentLabel)}".\n`
        : 'No activity found.\n',
    );
    return;
  }
  process.stdout.write(
    `${bold(`Activity — ${feed.events.length} event${feed.events.length === 1 ? '' : 's'}${scope}`)}\n`,
  );
  if (flags.expand) {
    renderExpanded(feed.events);
  } else {
    const rows = feed.events.map((event) => [
      sanitizeText(event.timestamp).slice(0, 16).replace('T', ' '),
      sanitizeText(event.agent?.name ?? ''),
      sanitizeText(event.type),
      sanitizeText(event.status),
      sanitizeText(event.summary),
      rawToUsd(event.amountRaw),
    ]);
    process.stdout.write(`${table(['TIME', 'AGENT', 'TYPE', 'STATUS', 'DETAIL', 'AMOUNT'], rows)}\n`);
  }
  if (feed.hasMore && feed.nextCursor) {
    process.stdout.write(
      `${dim(`More available — next page: floe activity --cursor ${sanitizeText(feed.nextCursor)}`)}\n`,
    );
  }
}

export const activityDef: CommandDef = {
  name: 'activity',
  summary: 'Unified spend/activity feed with filters',
  usage: `Usage: floe activity [--agent <ref>] [--type <csv>] [--since <iso>] [--until <iso>]
                     [--key <keyId>] [--limit <n>] [--cursor <cursor>] [--expand]

The unified account activity feed, newest first: x402 calls, onramp
purchases/sweeps, wallet transfers, and credit-facility loan events.

  --agent <ref>      Narrow to one agent by name or id (default: all agents)
  --type <csv>       Narrow to event types, comma-separated. One or more of:
                       x402_call, onramp_purchase, onramp_sweep,
                       transfer_deposit, transfer_withdrawal, transfer_external,
                       facility_loan_match, facility_loan_repay,
                       facility_loan_rollover, facility_loan_failed
  --since <iso>      Events at or after this ISO 8601 timestamp
  --until <iso>      Events at or before this ISO 8601 timestamp
  --key <keyId>      Narrow to x402 calls made with one agent API key
                     (numeric id — see \`floe keys --json\`); implies x402_call only
  --limit <n>        Events per page, 1-100 (default 50)
  --cursor <cursor>  Resume from a previous page's nextCursor
  --expand           Per-event detail payloads (kv blocks; full JSON with --json)

--json emits { events, nextCursor, hasMore } exactly as the API returns them;
amountRaw stays a raw 6-decimal USDC string.
`,
  options: {
    agent: { type: 'string' },
    type: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
    key: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
    expand: { type: 'boolean' },
  },
  run: async (ctx) => {
    expectArgs(ctx, 0);
    await activityCommand({
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      agent: str(ctx, 'agent'),
      type: str(ctx, 'type'),
      since: str(ctx, 'since'),
      until: str(ctx, 'until'),
      key: str(ctx, 'key'),
      limit: str(ctx, 'limit'),
      cursor: str(ctx, 'cursor'),
      expand: flag(ctx, 'expand'),
    });
  },
};
