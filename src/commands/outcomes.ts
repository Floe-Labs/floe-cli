import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { devContext, type DevContext } from '../lib/context.js';
import { bold, dim, green, kv, ok, printJson, red, sanitizeText, UsageError, warn, yellow } from '../lib/output.js';
import { table } from '../lib/table.js';

/**
 * `floe outcomes` — what a task PRODUCED, under /v1/developer/outcomes.
 *
 * The mirror of `floe interactions`: that one is what a task COST, this is what
 * it produced. Joined, they are cost-per-outcome — the number a contract is
 * priced against.
 *
 * NOT `floe actions`. That is the per-action QUALITY signal (status + score)
 * feeding the quality throttle and never reaching an invoice. This is the
 * billable claim. They share a word and nothing else.
 *
 * DISCOVERY IS BY THE CALL. `list --task/--interaction/--customer/--kind` is
 * the front door, because an operator asking "what did this campaign produce?"
 * has no `oev_…` yet. The event id from an emit response or a webhook is the
 * shortcut, not the entry point — which is why every write also accepts
 * --task/--interaction and resolves the id itself.
 */

const STATUSES = ['reported', 'confirmed', 'disputed', 'void', 'reversed'] as const;
const SOURCES = ['agent', 'operator', 'orchestrator', 'client', 'floe'] as const;

const EVENT_ID_RE = /^oev_[0-9a-f]{16}$/;
const INTERACTION_ID_RE = /^int_[0-9a-f]{16}$/;

interface Binding {
  interactionId: string | null;
  customerId: string | null;
  campaignId: string | null;
  matchedVia: string | null;
  unresolvedReason: string | null;
}

interface Evidence {
  externalSystem: string | null;
  externalRef: string | null;
  note: string | null;
  redactedAt: string | null;
}

interface ClaimRow {
  eventId: string;
  outcomeKind: string;
  status: string;
  quantity: number;
  occurredAt: string;
  confirmedAt: string | null;
  source: string;
  assertedBy: string;
  identifier: { vendor: string; kind: string; identifier: string };
  binding: Binding;
  evidence: Evidence;
  billedInPeriodId: number | null;
}

interface ListResponse {
  outcomes: ClaimRow[];
  nextCursor: string | null;
  hasMore: boolean;
  range: { since: string; until: string };
  historyFloor: string | null;
  historyClamped: boolean;
}

interface Predecessor {
  eventId: string;
  status: string;
  quantity: number;
  source: string;
  assertedBy: string;
  occurredAt: string;
  confirmedAt: string | null;
  supersededAt: string | null;
  billedInPeriodId: number | null;
}

interface DetailResponse {
  requested: string;
  isHead: boolean;
  outcome: ClaimRow;
  predecessors: Predecessor[];
}

/** The write routes answer with the agent-shaped serializer (no binding, no
 *  assertedBy), so every write re-fetches the detail to print the real head. */
interface WriteResponse {
  outcome: { eventId: string };
}

export interface OutcomesFlags {
  apiUrl?: string;
  json?: boolean;
  task?: string;
  interaction?: string;
  customer?: string;
  campaign?: string;
  kind?: string;
  status?: string;
  source?: string;
  since?: string;
  until?: string;
  limit?: string;
  cursor?: string;
  quantity?: string;
  reason?: string;
  externalSystem?: string;
  externalRef?: string;
  duplicateOf?: string;
  idempotencyKey?: string;
}

// ─── Shared validation ─────────────────────────────────────────────────────

function oneOf(value: string | undefined, allowed: readonly string[], flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw new UsageError(`${flag} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

/** Filters validated against the API's closed sets so a typo fails before the
 *  round-trip rather than as a 400. */
function readQuery(flags: OutcomesFlags): URLSearchParams {
  const q = new URLSearchParams();
  if (flags.since) q.set('since', flags.since);
  if (flags.until) q.set('until', flags.until);
  if (flags.task) q.set('taskId', flags.task);
  if (flags.interaction) {
    if (!INTERACTION_ID_RE.test(flags.interaction)) {
      throw new UsageError('--interaction must look like int_<16 hex> (see `floe interactions list`).');
    }
    q.set('interactionId', flags.interaction);
  }
  if (flags.customer) q.set('customerId', flags.customer);
  if (flags.campaign) q.set('campaignId', flags.campaign);
  if (flags.kind) q.set('outcomeKind', flags.kind);
  const source = oneOf(flags.source, SOURCES, '--source');
  if (source) q.set('source', source);
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

// ─── Rendering ─────────────────────────────────────────────────────────────

const stamp = (iso: string | null): string => (iso ? sanitizeText(iso.replace('T', ' ').slice(0, 16)) : dim('—'));

function statusCell(status: string): string {
  const clean = sanitizeText(status);
  if (status === 'confirmed') return green(clean);
  if (status === 'reported') return yellow(clean);
  if (status === 'disputed' || status === 'reversed') return red(clean);
  return dim(clean);
}

/** The call, or the named reason there isn't one. An unbound claim is never
 *  rendered as a blank: a claim nothing can bill has to be visible. */
function callCell(b: Binding): string {
  if (b.interactionId) return sanitizeText(b.interactionId);
  return b.unresolvedReason ? yellow(sanitizeText(b.unresolvedReason)) : yellow('unbound');
}

function printListFooter(res: ListResponse): void {
  const lines = [
    dim(`Window: ${sanitizeText(res.range.since)} → ${sanitizeText(res.range.until)} (half-open, on when the outcome HAPPENED)`),
  ];
  if (res.historyClamped && res.historyFloor) {
    lines.push(
      warn(
        `History clamped to ${sanitizeText(res.historyFloor)} by your plan — earlier claims exist but are not readable on this plan.`,
      ),
    );
  }
  if (res.hasMore && res.nextCursor) {
    lines.push(dim(`More pages: re-run with --cursor ${sanitizeText(res.nextCursor)}`));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printClaim(res: DetailResponse): void {
  const c = res.outcome;
  process.stdout.write(`${bold(`Claim ${sanitizeText(c.eventId)}`)}\n`);
  if (!res.isHead) {
    process.stdout.write(
      `${dim(`${sanitizeText(res.requested)} was corrected — this is the current head of that chain.`)}\n`,
    );
  }

  const rows: Array<[string, string]> = [
    ['Kind', sanitizeText(c.outcomeKind)],
    ['Status', statusCell(c.status)],
    ['Quantity', String(c.quantity)],
    ['Occurred', stamp(c.occurredAt)],
    ['Confirmed', c.confirmedAt ? stamp(c.confirmedAt) : dim('not yet — a reported claim is not billable')],
    ['Source', sanitizeText(c.source)],
    ['Asserted by', sanitizeText(c.assertedBy)],
    ['Identity', sanitizeText(`${c.identifier.vendor}:${c.identifier.kind}:${c.identifier.identifier}`)],
    ['Call', callCell(c.binding)],
  ];
  if (c.binding.matchedVia) rows.push(['Matched via', sanitizeText(c.binding.matchedVia)]);
  if (c.binding.customerId) rows.push(['Client', sanitizeText(c.binding.customerId)]);
  if (c.binding.campaignId) rows.push(['Campaign', sanitizeText(c.binding.campaignId)]);
  if (c.evidence.redactedAt) {
    rows.push(['Evidence', dim(`redacted ${stamp(c.evidence.redactedAt)} — the claim survives, the reference does not`)]);
  } else {
    if (c.evidence.externalSystem) {
      rows.push(['Evidence', sanitizeText(`${c.evidence.externalSystem}:${c.evidence.externalRef ?? '—'}`)]);
    }
    if (c.evidence.note) rows.push(['Note', sanitizeText(c.evidence.note)]);
  }
  if (c.billedInPeriodId !== null) {
    rows.push(['Billed in period', `${c.billedInPeriodId} ${dim('— frozen; correct it with a reversal in the next open period')}`]);
  }
  process.stdout.write(`${kv(rows)}\n`);

  if (res.predecessors.length > 0) {
    process.stdout.write(`\n${bold('Chain')} ${dim('(what this claim corrected, newest first)')}\n`);
    process.stdout.write(
      `${table(
        ['CLAIM', 'STATUS', 'QTY', 'SOURCE', 'ASSERTED BY', 'SUPERSEDED'],
        res.predecessors.map((p) => [
          sanitizeText(p.eventId),
          statusCell(p.status),
          String(p.quantity),
          sanitizeText(p.source),
          sanitizeText(p.assertedBy),
          stamp(p.supersededAt),
        ]),
      )}\n`,
    );
  }
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function outcomesListCommand(flags: OutcomesFlags): Promise<void> {
  const q = readQuery(flags); // validation precedes I/O
  const { api } = await devContext(flags);
  const res = await api.dev<ListResponse>('GET', withQuery('/v1/developer/outcomes', q));

  if (flags.json) return printJson(res);

  if (res.outcomes.length === 0) {
    process.stdout.write('No outcome claims in this window.\n');
    printListFooter(res);
    return;
  }

  const rows = res.outcomes.map((c) => [
    stamp(c.occurredAt),
    sanitizeText(c.eventId),
    sanitizeText(c.outcomeKind),
    statusCell(c.status),
    String(c.quantity),
    callCell(c.binding),
    c.binding.customerId ? sanitizeText(c.binding.customerId) : dim('—'),
    sanitizeText(c.source),
  ]);
  process.stdout.write(`${bold('Outcome claims')}\n`);
  process.stdout.write(
    `${table(['OCCURRED', 'CLAIM', 'KIND', 'STATUS', 'QTY', 'CALL', 'CLIENT', 'SOURCE'], rows)}\n`,
  );
  process.stdout.write(
    `${dim('Only CONFIRMED claims rate. A reported claim is a statement; confirming it is what makes it billable.')}\n`,
  );
  printListFooter(res);
}

export async function outcomesGetCommand(eventId: string, flags: OutcomesFlags): Promise<void> {
  const id = requireEventId(eventId);
  const { api } = await devContext(flags);
  const res = await api.dev<DetailResponse>('GET', `/v1/developer/outcomes/${id}`);
  if (flags.json) return printJson(res);
  printClaim(res);
}

// ─── Resolving which claim a write acts on ─────────────────────────────────

function requireEventId(raw: string): string {
  const id = raw.trim();
  if (!EVENT_ID_RE.test(id)) {
    throw new UsageError('Claim id must look like oev_<16 hex> — list them with `floe outcomes list`.');
  }
  return id;
}

/**
 * A write names ONE claim. Either you pass its id, or you name the call and the
 * kind and this resolves it.
 *
 * MORE THAN ONE CURRENT CLAIM OF THAT KIND IS REFUSED, never guessed. Two
 * claims of one kind on one call is precisely the collision case: one meeting
 * reported twice, or two meetings booked once. The system cannot tell, a human
 * must, and picking one here would bury the very ambiguity the finding exists
 * to surface. Resolve it with `floe outcomes confirm-distinct`, or void the
 * duplicate by its own id.
 */
async function resolveClaimId(
  arg: string | undefined,
  flags: OutcomesFlags,
  ctx: DevContext,
): Promise<string> {
  if (arg) return requireEventId(arg);

  if (!flags.task && !flags.interaction) {
    throw new UsageError(
      'Name the claim: pass its oev_ id, or --task <id> / --interaction <int_id> with --kind <kind>.',
    );
  }
  if (!flags.kind) {
    throw new UsageError('--kind is required when naming a claim by --task or --interaction.');
  }

  const q = readQuery({ ...flags, limit: undefined, cursor: undefined });
  // Only claims that can still be acted on — a voided claim is not a candidate.
  q.set('status', 'reported,confirmed,disputed');
  // TWO IS ENOUGH TO ANSWER THE ONLY QUESTION HERE: is this claim unique?
  // Asking for one more than that also closes the paging hole — reading a
  // default-sized first page and trusting a lone row would let a second
  // matching claim sit on the next cursor while this silently picked one.
  // `hasMore` is therefore treated as a further claim that simply cannot be
  // named, not as a detail to page through.
  q.set('limit', '2');
  const res = await ctx.api.dev<ListResponse>('GET', withQuery('/v1/developer/outcomes', q));

  const named = flags.task
    ? `task "${sanitizeText(flags.task)}"`
    : `call ${sanitizeText(flags.interaction ?? '')}`;

  if (res.outcomes.length === 0) {
    throw new UsageError(
      `No current "${sanitizeText(flags.kind)}" claim on ${named}. List what is there: floe outcomes list --kind ${sanitizeText(flags.kind)}.`,
    );
  }
  if (res.outcomes.length > 1 || res.hasMore) {
    const ids = res.outcomes.map((c) => c.eventId).join(', ');
    const count = res.hasMore
      ? `At least ${res.outcomes.length}`
      : String(res.outcomes.length);
    throw new UsageError(
      `${count} current "${sanitizeText(flags.kind)}" claims on ${named} `
      + `(${sanitizeText(ids)}${res.hasMore ? ', and more' : ''}). `
      + 'That is a collision — one outcome reported twice, or two genuine outcomes — and this command will not pick one. '
      + 'Name the claim by its own id, or resolve the conflict with `floe outcomes confirm-distinct`.',
    );
  }
  return res.outcomes[0]!.eventId;
}

/** Deterministic by default, so a retried command REPLAYS instead of writing a
 *  second claim. The server treats a repeated key as a no-op. */
const idempotencyFor = (verb: string, eventId: string, flags: OutcomesFlags): string =>
  flags.idempotencyKey ?? `cli:${verb}:${eventId}`;

/** Every write re-fetches: the write routes answer with the agent-shaped
 *  serializer, which carries no binding and no assertedBy. */
async function printHead(ctx: DevContext, eventId: string, flags: OutcomesFlags): Promise<void> {
  const res = await ctx.api.dev<DetailResponse>('GET', `/v1/developer/outcomes/${eventId}`);
  if (flags.json) return printJson(res);
  printClaim(res);
}

// ─── Writes ────────────────────────────────────────────────────────────────

export async function outcomesConfirmCommand(arg: string | undefined, flags: OutcomesFlags): Promise<void> {
  if (flags.quantity !== undefined) {
    const quantity = Number(flags.quantity);
    // `outcome_events.quantity` is a 32-bit int, so anything above its ceiling
    // fails inside the database rather than at the boundary — a 500 for what
    // is plainly a bad request.
    //
    // That ceiling also subsumes the float problem: `Number()` rounds silently
    // past 2^53, so "9007199254740993" would be POSTed as …992, a billable
    // quantity the operator never typed — but 2^53 is far above 2^31, so an
    // explicit `Number.isSafeInteger` check could never be the clause that
    // fires. One bound, not two.
    if (!/^\d+$/.test(flags.quantity) || quantity < 1 || quantity > 2_147_483_647) {
      throw new UsageError('--quantity must be a whole number from 1 to 2147483647.');
    }
  }
  if (flags.externalRef && !flags.externalSystem) {
    throw new UsageError('--external-ref requires --external-system (the reference needs a namespace to mean anything).');
  }

  const ctx = await devContext(flags);
  const eventId = await resolveClaimId(arg, flags, ctx);

  const body: Record<string, unknown> = { idempotencyKey: idempotencyFor('confirm', eventId, flags) };
  if (flags.quantity !== undefined) body.quantity = Number(flags.quantity);
  if (flags.externalSystem) body.externalSystem = flags.externalSystem;
  if (flags.externalRef) body.externalRef = flags.externalRef;
  if (flags.reason) body.note = flags.reason;

  const res = await ctx.api.dev<WriteResponse>('POST', `/v1/developer/outcomes/${eventId}/confirm`, body);
  if (!flags.json) {
    process.stdout.write(`${ok(`Confirmed ${sanitizeText(eventId)} — the claim is now billable`)}\n`);
  }
  await printHead(ctx, res.outcome.eventId, flags);
}

export async function outcomesVoidCommand(arg: string | undefined, flags: OutcomesFlags): Promise<void> {
  // Before any network call: retiring a claim removes money from an invoice,
  // and a reason that has to be reconstructed later is a reason nobody wrote.
  if (!flags.reason) {
    throw new UsageError('--reason is required — voiding a claim retires billable money, and the reason is recorded with it.');
  }
  if (flags.duplicateOf) requireEventId(flags.duplicateOf);

  const ctx = await devContext(flags);
  const eventId = await resolveClaimId(arg, flags, ctx);

  const body: Record<string, unknown> = {
    idempotencyKey: idempotencyFor('void', eventId, flags),
    note: flags.reason,
  };
  if (flags.duplicateOf) body.duplicateOfEventId = flags.duplicateOf;

  const res = await ctx.api.dev<WriteResponse>('POST', `/v1/developer/outcomes/${eventId}/void`, body);
  if (!flags.json) {
    process.stdout.write(`${ok(`Voided ${sanitizeText(eventId)}`)}\n`);
    if (!flags.duplicateOf) {
      process.stdout.write(
        `${dim('No --duplicate-of given, so this is recorded as a retirement rather than a proven duplicate. Set it only when an identical external reference or idempotency key PROVES the duplication.')}\n`,
      );
    }
  }
  await printHead(ctx, res.outcome.eventId, flags);
}

export async function outcomesConfirmDistinctCommand(flags: OutcomesFlags): Promise<void> {
  if (!flags.interaction) {
    throw new UsageError('--interaction <int_id> is required — a collision belongs to one call.');
  }
  if (!INTERACTION_ID_RE.test(flags.interaction)) {
    throw new UsageError('--interaction must look like int_<16 hex> (see `floe interactions list`).');
  }
  if (!flags.kind) {
    throw new UsageError('--kind is required — a collision is two claims of the SAME kind on one call.');
  }

  const { api } = await devContext(flags);
  const body: Record<string, unknown> = {
    interactionId: flags.interaction,
    outcomeKind: flags.kind,
  };
  if (flags.reason) body.note = flags.reason;

  const res = await api.dev<{ resolved: string; claimsRating: string }>(
    'POST',
    '/v1/developer/outcomes/collisions/confirm-distinct',
    body,
  );
  if (flags.json) return printJson(res);

  process.stdout.write(
    `${ok(`Resolved as two real outcomes on ${sanitizeText(flags.interaction)} — both "${sanitizeText(flags.kind)}" claims rate`)}\n`,
  );
  process.stdout.write(`${kv([['Finding', sanitizeText(res.resolved)], ['Claims rating', sanitizeText(res.claimsRating)]])}\n`);
  process.stdout.write(
    `${dim(`Each claim keeps its own evidence trail rather than collapsing into one row. If instead one was a duplicate, void it: floe outcomes void <oev_id> --reason "duplicate" --duplicate-of <oev_id>`)}\n`,
  );
}

export const outcomesDef: CommandDef = {
  name: 'outcomes',
  summary: 'list | get | confirm | void | confirm-distinct — what a task produced',
  usage: `Usage: floe outcomes list             [filters] [--cursor <c>]
       floe outcomes get              <oev_id>
       floe outcomes confirm          <oev_id | --task <id> --kind <k>> [--quantity <n>]
                                      [--external-system <s> --external-ref <r>] [--reason <text>]
       floe outcomes void             <oev_id | --task <id> --kind <k>> --reason <text>
                                      [--duplicate-of <oev_id>]
       floe outcomes confirm-distinct --interaction <int_id> --kind <k> [--reason <text>]

An outcome claim is what a task PRODUCED — a booked meeting, a qualified lead,
a resolution — bound to the call its costs are on. Joined with what the task
cost, that is cost-per-outcome. (\`floe interactions\` is the cost half.)

NOT \`floe actions\`, which is the per-action quality signal and never reaches
an invoice. They share a word and nothing else.

  list              Claims by CALL — the front door. Keyset-paginated
  get               One claim, plus the chain it corrected. A corrected id
                    still resolves: you get the current head and are told so
  confirm           Make a reported claim billable. Only operator/client
                    confirmations rate
  void              Retire a claim. --reason is required
  confirm-distinct  Two claims of one kind on one call are BOTH real —
                    the other resolution is voiding one as a proven duplicate

DISCOVERY IS BY THE CALL: --task, --interaction, --customer, --campaign,
--kind. The oev_ id from an emit response or a webhook is the shortcut.

Every write also accepts --task/--interaction with --kind instead of an id. If
more than one current claim of that kind is on the call, the command REFUSES
rather than picking one — that is a collision, and it is a human's call.

Filters: --since --until --task --interaction --customer --campaign --kind
--status <csv> --source --limit --cursor
`,
  options: {
    task: { type: 'string' },
    interaction: { type: 'string' },
    customer: { type: 'string' },
    campaign: { type: 'string' },
    kind: { type: 'string' },
    status: { type: 'string' },
    source: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
    quantity: { type: 'string' },
    reason: { type: 'string' },
    'external-system': { type: 'string' },
    'external-ref': { type: 'string' },
    'duplicate-of': { type: 'string' },
    'idempotency-key': { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: OutcomesFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      task: str(ctx, 'task'),
      interaction: str(ctx, 'interaction'),
      customer: str(ctx, 'customer'),
      campaign: str(ctx, 'campaign'),
      kind: str(ctx, 'kind'),
      status: str(ctx, 'status'),
      source: str(ctx, 'source'),
      since: str(ctx, 'since'),
      until: str(ctx, 'until'),
      limit: str(ctx, 'limit'),
      cursor: str(ctx, 'cursor'),
      quantity: str(ctx, 'quantity'),
      reason: str(ctx, 'reason'),
      externalSystem: str(ctx, 'external-system'),
      externalRef: str(ctx, 'external-ref'),
      duplicateOf: str(ctx, 'duplicate-of'),
      idempotencyKey: str(ctx, 'idempotency-key'),
    };

    if (subcommand === undefined || subcommand === 'list') {
      expectArgs(ctx, 1);
      await outcomesListCommand(flags);
    } else if (subcommand === 'get') {
      expectArgs(ctx, 2);
      if (!arg) throw new UsageError('Usage: floe outcomes get <oev_id>.');
      await outcomesGetCommand(arg, flags);
    } else if (subcommand === 'confirm') {
      expectArgs(ctx, 2);
      await outcomesConfirmCommand(arg, flags);
    } else if (subcommand === 'void') {
      expectArgs(ctx, 2);
      await outcomesVoidCommand(arg, flags);
    } else if (subcommand === 'confirm-distinct') {
      expectArgs(ctx, 1);
      await outcomesConfirmDistinctCommand(flags);
    } else {
      throw new UsageError(
        `Unknown outcomes subcommand "${subcommand}". Use: list, get <oev_id>, confirm, void, confirm-distinct.`,
      );
    }
  },
};
