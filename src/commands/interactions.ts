import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { devContext } from '../lib/context.js';
import { bold, cyan, dim, green, kv, printJson, sanitizeText, UsageError, warn, yellow } from '../lib/output.js';
import { table } from '../lib/table.js';
import { rawToUsd } from '../lib/usdc.js';

/**
 * `floe interactions` — the call (or job) as ONE object, under
 * /v1/developer/interactions.
 *
 * An interaction is one AI TASK: every vendor leg of that task — telephony,
 * STT, LLM, TTS, tools — joined into a single row. It is the unit of COGS.
 * `floe actuals` answers "what did each vendor charge me"; this answers "what
 * did THIS task cost me, and where did the money go".
 *
 * ── THE TWO RULES THIS RENDERER MUST NOT BREAK ──────────────────────────────
 *
 * 1. A PARTIAL TOTAL IS NEVER PRINTED AS A COMPLETE ONE. `totalRaw` is null
 *    (not zero) until every leg is exact/period-rate/invoiced and USD; the
 *    server's own `totalLabel` prints in its place with `totalBlockedBy`
 *    naming why. Same for `paidRaw` and `costPerMinuteRaw`, whose blockers the
 *    server names in `costPerMinuteBlockedBy`.
 *
 * 2. VENDOR COST AND THE FLOE CHARGE ARE DIFFERENT CLAIMS. A Floe-carried leg
 *    (keyless, Floe Phone, x402) carries no vendor bill of yours — that is
 *    Floe's COGS — but you did pay Floe for it. That charge rides in its own
 *    column and is never folded into the reconciled vendor figures. PAID is
 *    the two together, and the server nulls it while the vendor half is still
 *    partial.
 *
 * Money crosses the wire as raw 6-dp USDC integer text and is formatted only
 * at the point of display (`rawToUsd`); nothing here parses it into a float.
 */

// ─── Wire shapes ───────────────────────────────────────────────────────────

interface SubtotalBlock {
  composition: {
    exact: number;
    periodRate: number;
    invoiced: number;
    pending: number;
    manual: number;
    groupLegs: number;
  };
  exactRaw: string;
  periodRateRaw: string;
  invoicedRaw: string;
  groupsRaw: string;
  groupCount: number;
  adjustmentsRaw: string;
  totalRaw: string | null;
  totalBlockedBy: string[];
  totalLabel: string | null;
  nonUsd: boolean;
}

/** What Floe charged for the legs it carried, and the two halves together. */
interface FloeChargeBlock {
  /** Null — not zero — when Floe carried nothing on this task. */
  floeChargeRaw: string | null;
  floeChargeRequests: number;
  /** Null while the vendor half is still a lower bound. */
  paidRaw: string | null;
}

interface KindCell {
  legs: number;
  costRaw: string | null;
  partial: boolean;
}

interface InteractionRow extends SubtotalBlock, FloeChargeBlock {
  interactionId: string;
  channel: string;
  direction: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  agentId: string | null;
  customerId: string | null;
  campaignId: string | null;
  outcome: string | null;
  legCount: number;
  floeCarriedLegCount: number;
  vendors: string[];
  byKind: Record<string, KindCell>;
  /** Which leg kind dominates this task's cost — "what blew this call up". */
  topKind: { kind: string; costRaw: string; partial: boolean } | null;
  marginRaw: string | null;
  marginPartial: boolean;
  marginBps: number | null;
}

interface Resolution {
  legs: { total: number; bound: number; unresolved: number; unswept: number };
  unresolvedByReason: Record<string, number>;
  resolutionBps: number | null;
}

/** Per-call cost spread over the window. Percentiles are computed over each
 *  call's LOWER BOUND, so `lowerBound` decides how they may be described. */
interface Distribution {
  calls: number;
  partialCalls: number;
  lowerBound: boolean;
  p50Raw: string | null;
  p95Raw: string | null;
  maxRaw: string | null;
}

interface RangeTotals {
  perStatus: Record<string, { count: number; costRaw: string }> | null;
  unsupportedFilters: string[];
  legs: number;
  totalRaw: string | null;
  totalBlockedBy: string[];
  totalLabel: string | null;
}

interface RangeEcho {
  range: { since: string; until: string };
  costOwnerNote: string;
  resolution: Resolution | null;
  historyFloor: string | null;
  historyClamped: boolean;
  nextCursor: string | null;
  hasMore: boolean;
}

interface ListResponse extends RangeEcho {
  interactions: InteractionRow[];
  orderBy: string;
  /** Null on cursor pages and under channel/outcome filters the aggregate
   *  cannot honour — absent, never a wider figure wearing a narrow label. */
  subtotals: RangeTotals | null;
  distribution: Distribution | null;
}

interface Leg {
  legId: number;
  vendor: string;
  legKind: string;
  occurredAt: string;
  captureSource: string;
  attemptOutcome: string;
  matchedVia: string | null;
  units: Record<string, string>;
  reconciliationStatus: string;
  statusReason: string | null;
  costOwner: string;
  costRaw: string | null;
  currency: string;
  costScope: string;
}

interface DetailResponse extends SubtotalBlock, FloeChargeBlock {
  interactionId: string;
  /** Set (and different) only when the id you asked for was merged away. */
  requestedId: string | null;
  channel: string;
  direction: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  agentId: string | null;
  customerId: string | null;
  campaignId: string | null;
  outcome: string | null;
  costOwnerNote: string;
  legs: Leg[];
  links: Array<{ vendor: string; identifierKind: string; identifier: string; createdAt: string }>;
  byKind: Record<string, KindCell>;
  historyFloor: string | null;
}

interface RollupRow extends SubtotalBlock {
  key: string;
  legCount: number;
  interactionCount: number;
  /** Interactions with no start or no end — they contribute no duration. */
  openInteractions: number;
  durationMs: number;
  costPerMinuteRaw: string | null;
  costPerMinuteBlockedBy: string[];
  vendors: string[];
}

interface RollupsResponse extends RangeEcho {
  by: string;
  rollups: RollupRow[];
}

// ─── Local mirrors of the API's closed sets (fail before I/O) ──────────────

const STATUSES = ['pending', 'manual', 'exact', 'period-rate', 'invoiced'] as const;
const CHANNELS = ['voice', 'chat', 'email', 'video', 'job', 'sms'] as const;
const OUTCOMES = ['success', 'failure', 'partial', 'unknown'] as const;
const ORDERS = ['started', 'cost'] as const;
const ROLLUP_DIMENSIONS = ['customer', 'campaign', 'agent', 'channel', 'outcome'] as const;

const PUBLIC_ID_RE = /^int_[0-9a-f]{16}$/;

// ─── Cells ─────────────────────────────────────────────────────────────────

/** The one place a total is rendered. Null means the server refused to claim
 *  a figure — print its label and reasons, never a zero or a partial sum. */
function totalCell(totalRaw: string | null, label: string | null, blockedBy: string[]): string {
  if (totalRaw !== null) return bold(rawToUsd(totalRaw));
  const why = blockedBy.length > 0 ? ` ${dim(`(${blockedBy.map(sanitizeText).join(', ')})`)}` : '';
  return `${yellow(sanitizeText(label ?? 'partial — lower bound'))}${why}`;
}

function statusCell(status: string): string {
  switch (status) {
    case 'exact':
      return green('exact');
    case 'period-rate':
      return cyan('period-rate');
    case 'invoiced':
      return bold('invoiced');
    case 'pending':
      return yellow('pending');
    case 'manual':
      return dim('manual');
    default:
      return sanitizeText(status);
  }
}

function durationCell(ms: number | null): string {
  if (ms === null) return dim('—');
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** "llm $0.28" — the culprit leg. A partial kind is a lower bound and says so. */
function topKindCell(top: InteractionRow['topKind']): string {
  if (top === null) return dim('—');
  const cost = rawToUsd(top.costRaw);
  return `${sanitizeText(top.kind)} ${top.partial ? yellow(`≥${cost}`) : cost}`;
}

const stamp = (iso: string | null): string =>
  iso === null ? dim('—') : sanitizeText(iso.slice(0, 19).replace('T', ' '));

const unitsCell = (units: Record<string, string>): string => {
  const entries = Object.entries(units ?? {});
  if (entries.length === 0) return dim('—');
  return entries.map(([k, v]) => `${sanitizeText(k)}=${sanitizeText(String(v))}`).join(' ');
};

/** The charge column. Null = Floe carried nothing here, which is not "$0". */
const chargeCell = (raw: string | null): string => (raw === null ? dim('—') : rawToUsd(raw));

// ─── Shared blocks ─────────────────────────────────────────────────────────

/** Vendor cost, what Floe charged, and the two together — kept apart. */
function moneyLines(s: SubtotalBlock & FloeChargeBlock): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Exact', `${rawToUsd(s.exactRaw)} ${dim(`(${s.composition.exact} legs)`)}`],
    [
      'Period-rate',
      `${cyan(rawToUsd(s.periodRateRaw))} ${dim(`(${s.composition.periodRate} legs — vendor's realized rate, not per-request)`)}`,
    ],
    ['Invoiced', `${rawToUsd(s.invoicedRaw)} ${dim(`(${s.composition.invoiced} legs)`)}`],
  ];
  if (s.composition.pending > 0) {
    rows.push(['Pending', dim(`${s.composition.pending} legs — no cost published yet`)]);
  }
  if (s.composition.manual > 0) {
    rows.push(['Manual', dim(`${s.composition.manual} legs — no vendor API publishes these`)]);
  }
  if (s.groupCount > 0) {
    rows.push([
      'Group-scoped',
      `${rawToUsd(s.groupsRaw)} ${dim(`(${s.groupCount} groups / ${s.composition.groupLegs} legs)`)}`,
    ]);
  }
  rows.push(['Vendor cost', totalCell(s.totalRaw, s.totalLabel, s.totalBlockedBy)]);
  if (s.floeChargeRaw !== null) {
    rows.push([
      'Floe charge',
      `${rawToUsd(s.floeChargeRaw)} ${dim(`(${s.floeChargeRequests} Floe-carried requests — not vendor cost of yours)`)}`,
    ]);
  }
  rows.push([
    'Paid total',
    s.paidRaw !== null
      ? bold(rawToUsd(s.paidRaw))
      : `${yellow('partial — lower bound')} ${dim('(the vendor half is not a total yet)')}`,
  ]);
  return rows;
}

function printResolution(resolution: Resolution | null): void {
  if (!resolution) return;
  const { legs, unresolvedByReason, resolutionBps } = resolution;
  const pct = resolutionBps === null ? 'n/a' : `${(resolutionBps / 100).toFixed(1)}%`;
  const lines = [
    dim(
      `Legs bound to a task: ${legs.bound}/${legs.total} (${pct}) · unresolved ${legs.unresolved} · not yet swept ${legs.unswept}`,
    ),
  ];
  const reasons = Object.entries(unresolvedByReason);
  if (reasons.length > 0) {
    lines.push(
      dim(`Unresolved because: ${reasons.map(([r, n]) => `${sanitizeText(r)}=${n}`).join(' · ')}`),
    );
  }
  lines.push(
    dim(
      'Unresolved and unswept legs are absent from every figure above — this is leg RESOLUTION, not the Coverage Score.',
    ),
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printRangeFooter(res: RangeEcho): void {
  const lines = [
    dim(`Window: ${sanitizeText(res.range.since)} → ${sanitizeText(res.range.until)} (half-open)`),
  ];
  if (res.historyClamped && res.historyFloor) {
    lines.push(
      warn(
        `History clamped to ${sanitizeText(res.historyFloor)} by your plan — earlier tasks exist but are not readable on this plan.`,
      ),
    );
  }
  lines.push(dim(sanitizeText(res.costOwnerNote)));
  if (res.hasMore && res.nextCursor) {
    lines.push(dim(`More pages: re-run with --cursor ${sanitizeText(res.nextCursor)}`));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

// ─── Query building ────────────────────────────────────────────────────────

export interface InteractionFlags {
  apiUrl?: string;
  json?: boolean;
  since?: string;
  until?: string;
  customer?: string;
  campaign?: string;
  agent?: string;
  vendor?: string;
  channel?: string;
  outcome?: string;
  status?: string;
  order?: string;
  by?: string;
  limit?: string;
  cursor?: string;
}

function oneOf(value: string | undefined, allowed: readonly string[], flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw new UsageError(`${flag} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

/** Filters shared by list and rollups, validated against the API's closed sets
 *  so a typo fails before the round-trip rather than as a 400. */
function readQuery(flags: InteractionFlags): URLSearchParams {
  const q = new URLSearchParams();
  if (flags.since) q.set('since', flags.since);
  if (flags.until) q.set('until', flags.until);
  if (flags.customer) q.set('customerId', flags.customer);
  if (flags.campaign) q.set('campaignId', flags.campaign);
  if (flags.agent) q.set('agentId', flags.agent);
  if (flags.vendor) q.set('vendor', flags.vendor);
  const outcome = oneOf(flags.outcome, OUTCOMES, '--outcome');
  if (outcome) q.set('outcome', outcome);
  if (flags.status) {
    const parts = flags.status.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = parts.filter((p) => !(STATUSES as readonly string[]).includes(p));
    if (bad.length > 0) {
      throw new UsageError(
        `Unknown status ${bad.map((b) => `"${b}"`).join(', ')}. Use a comma-separated subset of: ${STATUSES.join(', ')}.`,
      );
    }
    q.set('status', parts.join(','));
  }
  if (flags.limit) {
    if (!/^\d+$/.test(flags.limit) || Number(flags.limit) < 1) {
      throw new UsageError('--limit must be a positive integer (server caps it at 500).');
    }
    q.set('limit', flags.limit);
  }
  if (flags.cursor) q.set('cursor', flags.cursor);
  return q;
}

const withQuery = (path: string, q: URLSearchParams): string => {
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
};

// ─── list ──────────────────────────────────────────────────────────────────

export async function interactionsListCommand(flags: InteractionFlags): Promise<void> {
  const q = readQuery(flags); // validation precedes I/O
  const channel = oneOf(flags.channel, CHANNELS, '--channel');
  if (channel) q.set('channel', channel);
  const order = oneOf(flags.order, ORDERS, '--order');
  if (order) q.set('orderBy', order);

  const { api } = await devContext(flags);
  const res = await api.dev<ListResponse>('GET', withQuery('/v1/developer/interactions', q));

  if (flags.json) return printJson(res);

  if (res.interactions.length === 0) {
    process.stdout.write('No tasks with captured cost in this window.\n');
    printRangeFooter(res);
    return;
  }

  const rows = res.interactions.map((r) => [
    stamp(r.startedAt),
    sanitizeText(r.interactionId),
    sanitizeText(r.channel),
    r.customerId ? sanitizeText(r.customerId) : dim('—'),
    durationCell(r.durationMs),
    String(r.legCount),
    topKindCell(r.topKind),
    totalCell(r.totalRaw, r.totalLabel, r.totalBlockedBy),
    chargeCell(r.floeChargeRaw),
    r.paidRaw !== null ? bold(rawToUsd(r.paidRaw)) : yellow('partial'),
  ]);
  process.stdout.write(
    `${bold(res.orderBy === 'cost' ? 'Cost per task — most expensive first' : 'Cost per task')}\n`,
  );
  process.stdout.write(
    `${table(
      ['STARTED', 'TASK', 'CHANNEL', 'CLIENT', 'DURATION', 'LEGS', 'TOP LEG', 'VENDOR COST', 'FLOE CHARGE', 'PAID'],
      rows,
    )}\n`,
  );
  process.stdout.write(
    `${dim('VENDOR COST is what your vendors billed you; FLOE CHARGE is what Floe charged for the legs it carried (keyless, Floe Phone, x402). They are different claims and are never added into one number — PAID is the server\'s own sum of the two, and reads "partial" until the vendor half is a real total.')}\n`,
  );
  if (res.orderBy === 'cost') {
    process.stdout.write(
      `${dim('Ordered by each task\'s currently-costed lower bound: a task whose priciest leg is still pending can rank lower than it eventually will.')}\n`,
    );
  }

  if (res.distribution && res.distribution.calls > 0) {
    const d = res.distribution;
    const qualify = (raw: string | null): string =>
      raw === null ? dim('—') : d.lowerBound ? `${yellow('≥')}${rawToUsd(raw)}` : rawToUsd(raw);
    process.stdout.write(`\n${bold('Cost per task across the window')}\n`);
    process.stdout.write(
      `${kv([
        ['Tasks', String(d.calls)],
        ['p50', qualify(d.p50Raw)],
        ['p95', qualify(d.p95Raw)],
        ['Max', qualify(d.maxRaw)],
      ])}\n`,
    );
    if (d.lowerBound) {
      process.stdout.write(
        `${dim(`${d.partialCalls} of ${d.calls} tasks are not fully costed yet and entered at their lower bound — read these as "at least", not "exactly".`)}\n`,
      );
    }
  }

  if (res.subtotals) {
    process.stdout.write(`\n${bold('Range vendor cost')} ${dim('(whole window, not this page)')}\n`);
    process.stdout.write(
      `${kv([
        ['Legs', String(res.subtotals.legs)],
        ['Total', totalCell(res.subtotals.totalRaw, res.subtotals.totalLabel, res.subtotals.totalBlockedBy)],
      ])}\n`,
    );
    if (res.subtotals.unsupportedFilters.length > 0) {
      process.stdout.write(
        `${warn(`Range totals ignore these filters: ${res.subtotals.unsupportedFilters.map(sanitizeText).join(', ')} — the rows are filtered, the range block is not.`)}\n`,
      );
    }
  }
  printResolution(res.resolution);
  printRangeFooter(res);
}

// ─── show ──────────────────────────────────────────────────────────────────

export async function interactionsShowCommand(id: string, flags: InteractionFlags): Promise<void> {
  if (!PUBLIC_ID_RE.test(id)) {
    throw new UsageError(`Invalid task id "${id}" — ids look like int_0123456789abcdef (see \`floe interactions list\`).`);
  }
  const { api } = await devContext(flags);
  const res = await api.dev<DetailResponse>('GET', `/v1/developer/interactions/${id}`);

  if (flags.json) return printJson(res);

  process.stdout.write(`${bold(`Task ${sanitizeText(res.interactionId)}`)}\n`);
  if (res.requestedId) {
    process.stdout.write(
      `${dim(`${sanitizeText(res.requestedId)} was merged into this task — same call, one row.`)}\n`,
    );
  }
  process.stdout.write(
    `${kv([
      ['Channel', `${sanitizeText(res.channel)}${res.direction ? dim(` (${sanitizeText(res.direction)})`) : ''}`],
      ['Started', stamp(res.startedAt)],
      ['Duration', durationCell(res.durationMs)],
      ['Client', res.customerId ? sanitizeText(res.customerId) : dim('—')],
      ['Campaign', res.campaignId ? sanitizeText(res.campaignId) : dim('—')],
      ['Agent', res.agentId ? sanitizeText(res.agentId) : dim('—')],
      ['Outcome', res.outcome ? sanitizeText(res.outcome) : dim('—')],
    ])}\n`,
  );

  process.stdout.write(`\n${bold('Where the money went')}\n`);
  const kindRows = Object.entries(res.byKind).map(([kind, cell]) => [
    sanitizeText(kind),
    String(cell.legs),
    cell.costRaw !== null ? rawToUsd(cell.costRaw) : yellow('partial — a leg is not costed yet'),
  ]);
  if (kindRows.length > 0) {
    process.stdout.write(`${table(['LEG KIND', 'LEGS', 'COST'], kindRows)}\n`);
  }

  process.stdout.write(`\n${bold('Legs')}\n`);
  const legRows = res.legs.map((leg) => [
    stamp(leg.occurredAt),
    sanitizeText(leg.vendor),
    sanitizeText(leg.legKind),
    unitsCell(leg.units),
    // A Floe-carried leg has no reconciliation of YOURS to report.
    leg.costOwner === 'developer' ? statusCell(leg.reconciliationStatus) : dim('floe-carried'),
    leg.costRaw !== null ? rawToUsd(leg.costRaw) : dim('—'),
  ]);
  process.stdout.write(`${table(['OCCURRED', 'VENDOR', 'KIND', 'UNITS', 'STATUS', 'COST'], legRows)}\n`);
  process.stdout.write(
    `${dim("A Floe-carried leg's cost cell is blank on purpose: one Floe charge can pay for several legs, so it is reported once for the task below — never split across them.")}\n`,
  );

  process.stdout.write(`\n${bold('What this task cost you')}\n`);
  process.stdout.write(`${kv(moneyLines(res))}\n`);

  if (res.links.length > 0) {
    process.stdout.write(
      `${dim(`Joined on: ${res.links.map((l) => `${sanitizeText(l.identifierKind)}=${sanitizeText(l.identifier)}`).join(' · ')}`)}\n`,
    );
  }
  process.stdout.write(`${dim(sanitizeText(res.costOwnerNote))}\n`);
}

// ─── rollups ───────────────────────────────────────────────────────────────

export async function interactionsRollupsCommand(flags: InteractionFlags): Promise<void> {
  const by = oneOf(flags.by ?? 'customer', ROLLUP_DIMENSIONS, '--by')!;
  const q = readQuery(flags);
  q.set('by', by);
  const { api } = await devContext(flags);
  const res = await api.dev<RollupsResponse>(
    'GET',
    withQuery('/v1/developer/interactions/rollups', q),
  );

  if (flags.json) return printJson(res);

  if (res.rollups.length === 0) {
    process.stdout.write(`No tasks to roll up by ${sanitizeText(by)} in this window.\n`);
    printRangeFooter(res);
    return;
  }

  process.stdout.write(`${bold(`Cost per minute by ${sanitizeText(res.by)}`)}\n`);
  const rows = res.rollups.map((row) => [
    sanitizeText(row.key),
    String(row.interactionCount),
    durationCell(row.durationMs),
    totalCell(row.totalRaw, row.totalLabel, row.totalBlockedBy),
    row.costPerMinuteRaw !== null
      ? bold(`${rawToUsd(row.costPerMinuteRaw)}/min`)
      : `${yellow('—')} ${dim(`(${row.costPerMinuteBlockedBy.map(sanitizeText).join(', ') || 'unknown'})`)}`,
  ]);
  process.stdout.write(
    `${table([res.by.toUpperCase(), 'TASKS', 'DURATION', 'VENDOR COST', 'COST/MIN'], rows)}\n`,
  );
  process.stdout.write(
    `${dim('$/min is stated only when the cost is a real total AND every task in the row has closed. Otherwise the row names what blocked it — an unknown-duration $/min is unknowable, not a lower bound.')}\n`,
  );
  const open = res.rollups.reduce((n, r) => n + r.openInteractions, 0);
  if (open > 0) {
    process.stdout.write(
      `${dim(`${open} task(s) have no end time yet and contribute no duration — DURATION is the closed-task span.`)}\n`,
    );
  }
  printResolution(res.resolution);
  printRangeFooter(res);
}

// ─── Command definition ────────────────────────────────────────────────────

export const interactionsDef: CommandDef = {
  name: 'interactions',
  summary: 'list | show | rollups — what one task (call or job) actually cost',
  usage: `Usage: floe interactions list    [filters] [--order started|cost] [--cursor <c>]
       floe interactions show    <int_id>
       floe interactions rollups --by <customer|campaign|agent|channel|outcome> [filters]

A task is ONE unit of work — a call, or a non-call job — with every vendor leg
it spent money on joined into one row: telephony, STT, LLM, TTS, tools. This is
the unit of COGS. (\`floe actuals\` is the same money sliced by VENDOR.)

  list     Recent tasks with duration, the culprit leg, and cost. --order cost
           gives the outlier list: which calls are eating the margin
  show     One task opened up: every leg, its units and status, the per-kind
           breakdown, and what the task cost you
  rollups  Cost and COST PER MINUTE by client / campaign / agent / channel /
           outcome

TWO KINDS OF MONEY, NEVER ADDED BY THIS CLI:
  VENDOR COST   what YOUR vendors billed you, reconciled to their own records
  FLOE CHARGE   what Floe charged for legs it carried (keyless, Floe Phone,
                x402). Those legs carry no vendor bill of yours
  PAID          the server's sum of the two — "partial" until the vendor half
                is a real total

A total prints only when every leg is exact/period-rate/invoiced and USD.
Otherwise the row prints the server's label and the blocking reasons — never a
zero, never a partial sum wearing a total's clothes. \`pending\` on a recent
task is the STEADY STATE: some vendors only publish cost on the next-day batch.

Filters: --since --until --customer --campaign --agent --vendor --outcome
--status <csv> --limit --cursor  (list also takes --channel)
`,
  options: {
    since: { type: 'string' },
    until: { type: 'string' },
    customer: { type: 'string' },
    campaign: { type: 'string' },
    agent: { type: 'string' },
    vendor: { type: 'string' },
    channel: { type: 'string' },
    outcome: { type: 'string' },
    status: { type: 'string' },
    order: { type: 'string' },
    by: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: InteractionFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      since: str(ctx, 'since'),
      until: str(ctx, 'until'),
      customer: str(ctx, 'customer'),
      campaign: str(ctx, 'campaign'),
      agent: str(ctx, 'agent'),
      vendor: str(ctx, 'vendor'),
      channel: str(ctx, 'channel'),
      outcome: str(ctx, 'outcome'),
      status: str(ctx, 'status'),
      order: str(ctx, 'order'),
      by: str(ctx, 'by'),
      limit: str(ctx, 'limit'),
      cursor: str(ctx, 'cursor'),
    };

    if (subcommand === undefined || subcommand === 'list') {
      expectArgs(ctx, 1);
      await interactionsListCommand(flags);
    } else if (subcommand === 'show') {
      expectArgs(ctx, 2);
      if (!arg) throw new UsageError('Usage: floe interactions show <int_id>.');
      await interactionsShowCommand(arg, flags);
    } else if (subcommand === 'rollups') {
      expectArgs(ctx, 1);
      await interactionsRollupsCommand(flags);
    } else {
      throw new UsageError(
        `Unknown interactions subcommand "${subcommand}". Use: list, show <int_id>, rollups.`,
      );
    }
  },
};
