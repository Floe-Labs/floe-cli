import { expectArgs, flag, str, type CommandDef } from '../lib/command.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext, type DevContext } from '../lib/context.js';
import {
  bold,
  cyan,
  dim,
  green,
  kv,
  ok,
  printJson,
  sanitizeText,
  UsageError,
  warn,
  yellow,
} from '../lib/output.js';
import { askSecret, ask, isInteractive } from '../lib/prompt.js';
import { table } from '../lib/table.js';
import { rawToUsd } from '../lib/usdc.js';

/**
 * `floe actuals` — reconciled VENDOR cost (FLO-746), under
 * /v1/developer/actuals/* and /v1/developer/vendor-connections.
 *
 * NOT `floe vendors`: that verb already ships in 0.3.0 and means the
 * marketplace health probes — Floe's OWN upstream vendors. This command is
 * about the vendors YOUR account pays. Renaming the old one would break a
 * published CLI.
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
 *
 * A cost figure may only claim what its STATUS earns. The API already refuses
 * to send a dollar amount for `pending` and `manual` (costRaw is null), and it
 * refuses to add `exact` and `period-rate` into one number. This renderer must
 * not undo either:
 *
 *   - `exact` and `period-rate` are printed as SEPARATE subtotals and are
 *     never summed here. They are different claims: "the vendor stated this
 *     figure for this request" vs "we derived it from the vendor's own
 *     realized bucket rate". A reader who cannot tell them apart has been
 *     misled, so they also get different colours — period-rate is NEVER
 *     shown in exact's green.
 *   - A single total prints ONLY when the server sent `totalRaw`. Otherwise
 *     the server's own `totalLabel` ("partial — lower bound") prints in its
 *     place, with the blocking reasons. Never a zero, never a partial sum.
 *   - `costRaw: null` renders as `—`. `rawToUsd(null)` already does that; no
 *     call site may substitute $0.00.
 *
 * Floe-carried legs (cost_owner=platform) are absent from every response by
 * construction — that is Floe's COGS, and your cost for those legs is already
 * settled on the Floe ledger. Each read echoes `costOwnerNote` saying so.
 */

// ─── Wire shapes (as served by the developer API) ──────────────────────────

/** The five statuses. `reconciled` is deliberately not one of them. */
type ReconciliationStatus = 'pending' | 'manual' | 'exact' | 'period-rate' | 'invoiced';

interface SubtotalBlock {
  composition: {
    exact: number;
    periodRate: number;
    invoiced: number;
    pending: number;
    manual: number;
    groupLegs: number;
  };
  /** D4: separate claims, never added together — here or anywhere downstream. */
  exactRaw: string;
  periodRateRaw: string;
  invoicedRaw: string;
  groupsRaw: string;
  groupCount: number;
  adjustmentsRaw: string;
  /** Null unless every leg in scope is exact/period-rate/invoiced AND USD. */
  totalRaw: string | null;
  totalBlockedBy: string[];
  totalLabel: string | null;
  nonUsd: boolean;
}

/** The range-wide block from the SECOND aggregate query — never a page sum. */
interface RangeTotals {
  perStatus: Record<ReconciliationStatus, { count: number; costRaw: string }> | null;
  unsupportedFilters: string[];
  unstampedLegs: number;
  nonUsdLegs: number;
  groupScopeLegs: number;
  legs: number;
  totalRaw: string | null;
  totalBlockedBy: string[];
  totalLabel: string | null;
}

interface Leg {
  id: number;
  occurredAt: string;
  vendor: string;
  legKind: string;
  captureSource: string;
  vendorRequestId: string | null;
  units: Record<string, string>;
  unitsProvenance: string;
  status: ReconciliationStatus;
  grain: string;
  costScope: string;
  costRaw: string | null;
  currency: string;
  nonUsd: boolean;
  attribution: {
    state: string;
    agentId: string | null;
    customerId: string | null;
    taskId: string | null;
    campaignId: string | null;
  };
  provenance: {
    reason: string | null;
    vendorCostNative: string | null;
    vendorCostUnit: string | null;
    realizedRate: Record<string, string> | null;
  };
}

interface RangeEcho {
  range: { since: string; until: string };
  costOwnerNote: string;
  subtotals: RangeTotals;
  historyFloor: string | null;
  historyClamped: boolean;
  nextCursor: string | null;
  hasMore: boolean;
}

interface LegsResponse extends RangeEcho {
  legs: Leg[];
}

interface CallGroup extends SubtotalBlock {
  callKey: string;
  key: string;
  taskId: string | null;
  legCount: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
  vendors: string[];
  agentId: string | null;
  customerId: string | null;
  campaignId: string | null;
}

interface CallsResponse extends RangeEcho {
  calls: CallGroup[];
}

interface RollupRow extends SubtotalBlock {
  key: string;
  legCount: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
  vendors: string[];
}

interface RollupsResponse extends RangeEcho {
  by: string;
  rollups: RollupRow[];
}

interface Finding {
  id: number;
  kind: string;
  severity: 'info' | 'warn' | 'error';
  provider: string | null;
  entity: { type: string; id: string } | null;
  detail: Record<string, unknown> | null;
  openedAt: string;
  lastSeenAt: string;
  clearedAt: string | null;
  resolution: string | null;
}

interface FindingsResponse {
  findings: Finding[];
  nextCursor: string | null;
  hasMore: boolean;
  openCounts: Record<string, number>;
  historyFloor: string | null;
}

/** Masked connection row — the ONLY projection any connection read returns. */
interface ConnectionRow {
  id: number;
  vendor: string;
  name: string;
  kind: string;
  /** Non-secret per-kind mask. Identifiers verbatim, secrets elided. */
  credentialPublic: Record<string, string>;
  credentialUnreadable: boolean;
  status: 'unverified' | 'active' | 'degraded' | 'unauthorized' | 'disabled';
  enabled: boolean;
  capabilities: Record<string, string>;
  /** The ceiling status a leg served by this connection can EVER reach. */
  bestStatus: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  freshnessSlaMinutes: number;
  actualsSlaHours: number;
  scopesVerifiedAt: string | null;
  billingTimeZone: string;
  captureSince: string | null;
  createdAt: string;
}

interface ConnectorCatalogEntry {
  vendor: string;
  bestStatus: string;
  capabilities: string[];
  /** `'config'` ⇒ only the operator can know the vendor's billing zone. */
  billingTimeZone: string;
  billingTimeZoneDefault: string | null;
}

interface ConnectionsResponse {
  connections: ConnectionRow[];
  /** The form catalog: which fields each credential kind carries. */
  credentialFields: Record<string, string[]>;
  connectors: ConnectorCatalogEntry[];
}

interface VendorDocument {
  id: number;
  vendor: string;
  filename: string;
  byteSize: number | null;
  state: string;
  uploadStatus: string;
  parseStatus: string;
  footStatus: string;
  invoiceNumber: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  parsedTotalNative: string | null;
  currency: string | null;
  parseError: string | null;
  footedAt: string | null;
  createdAt: string;
}

interface DocumentsResponse {
  documents: VendorDocument[];
  /** False ⇒ this deployment has no bucket; only the inline CSV lane works. */
  objectLaneAvailable: boolean;
}

interface SignedUpload {
  url: string;
  method: 'PUT';
  /** Must be sent VERBATIM — GCS 403s on any divergence. */
  headers: Record<string, string>;
  expiresAt: string;
}

// ─── Local mirrors of the API's closed sets (fail before I/O) ──────────────

const STATUSES: readonly ReconciliationStatus[] = [
  'pending',
  'manual',
  'exact',
  'period-rate',
  'invoiced',
];

const ROLLUP_DIMENSIONS = ['customer', 'campaign', 'agent', 'vendor', 'time'] as const;

const FINDING_STATES = ['open', 'cleared', 'all'] as const;

/** `auto_cleared` is absent on purpose: it is the machine's verdict, and a
 *  human claiming it would erase the difference between "the condition went
 *  away" and "a person decided to live with it". */
const RESOLUTIONS = ['acknowledged', 'wont_fix', 'fixed'] as const;

const FOOT_STATUSES = ['unfooted', 'footed', 'disputed'] as const;

/**
 * Which credential fields are secret, mirroring the API's SECRET_FIELDS.
 *
 * The catalog on the wire says which fields a kind carries but not which are
 * secret, and prompting for a region with hidden input is user-hostile. An
 * UNKNOWN field is treated as secret: if the API grows a new secret field,
 * this CLI hides it automatically. The failure mode of the other default —
 * echoing a new secret to the terminal — is not one worth risking to save a
 * release.
 */
const SECRET_FIELDS = new Set([
  'apiKey',
  'authToken',
  'secretAccessKey',
  'privateKey',
  'clientSecret',
]);

const NON_SECRET_FIELDS = new Set([
  'accountSid',
  'accessKeyId',
  'region',
  'projectId',
  'clientEmail',
  'tenantId',
  'clientId',
  'subscriptionId',
]);

const isSecretField = (field: string): boolean =>
  SECRET_FIELDS.has(field) || !NON_SECRET_FIELDS.has(field);

/** The inline lane's cap (VENDOR_DOCUMENT_INLINE_MAX_BYTES). */
const INLINE_MAX_BYTES = 262_144;

// ─── Status rendering ──────────────────────────────────────────────────────

/**
 * One colour per status, and `period-rate` never borrows `exact`'s green.
 * A shared colour lets a fast reader bank period-rate as exact regardless of
 * the word next to it, which is the precise misreading this whole surface
 * exists to prevent.
 */
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

/** What each status is ALLOWED to claim. Lifted from the REBILLING_GUIDE
 *  permitted-phrasing table; these strings are the contract, not decoration. */
const STATUS_MEANING: Record<ReconciliationStatus, string> = {
  exact: "reconciled to the vendor's own per-request billing record",
  'period-rate':
    "priced at the vendor's own realized rate for that period — a real derivation, but NOT per-request precision",
  invoiced: "footed to the vendor's invoice",
  pending: "the vendor hasn't published this cost yet — units only, no dollar figure",
  manual: 'no vendor API publishes this — upload the invoice. Units only, no dollar figure',
};

/** The cost cell. `—` for pending/manual/group-scope/non-USD; a blank is
 *  "not resolved", never "zero". */
function costCell(leg: Leg): string {
  if (leg.costRaw !== null) return rawToUsd(leg.costRaw);
  if (leg.nonUsd && leg.provenance.vendorCostNative) {
    return dim(`${sanitizeText(leg.provenance.vendorCostNative)} ${sanitizeText(leg.currency)}`);
  }
  return dim('—');
}

function unitsCell(units: Record<string, string>): string {
  const entries = Object.entries(units);
  if (entries.length === 0) return dim('—');
  return entries.map(([k, v]) => `${sanitizeText(k)}=${sanitizeText(String(v))}`).join(' ');
}

/**
 * Print one subtotal block.
 *
 * `exact` and `period-rate` get their own lines and are NEVER added. The
 * single total prints only when the server produced one; otherwise its label
 * and the blocking reasons print where the number would have been.
 */
function subtotalLines(s: SubtotalBlock | RangeTotals): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if ('exactRaw' in s) {
    rows.push(['Exact', `${rawToUsd(s.exactRaw)} ${dim(`(${s.composition.exact} legs)`)}`]);
    rows.push([
      'Period-rate',
      `${cyan(rawToUsd(s.periodRateRaw))} ${dim(`(${s.composition.periodRate} legs — vendor's realized rate, not per-request)`)}`,
    ]);
    rows.push(['Invoiced', `${rawToUsd(s.invoicedRaw)} ${dim(`(${s.composition.invoiced} legs)`)}`]);
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
  } else if (s.perStatus) {
    for (const status of STATUSES) {
      const bucket = s.perStatus[status];
      if (!bucket || (bucket.count === 0 && bucket.costRaw === '0')) continue;
      // pending/manual carry no dollars — print the count alone. Printing
      // their costRaw ('0') would render $0.00 next to "pending", which is a
      // claim the status has not earned.
      const value =
        status === 'pending' || status === 'manual'
          ? dim(`${bucket.count} legs — no cost published`)
          : `${status === 'period-rate' ? cyan(rawToUsd(bucket.costRaw)) : rawToUsd(bucket.costRaw)} ${dim(`(${bucket.count} legs)`)}`;
      rows.push([status === 'period-rate' ? 'Period-rate' : titleCase(status), value]);
    }
  }

  if (s.totalRaw !== null) {
    rows.push(['Total', bold(rawToUsd(s.totalRaw))]);
  } else {
    const why =
      s.totalBlockedBy.length > 0
        ? ` ${dim(`(${s.totalBlockedBy.map(sanitizeText).join(', ')})`)}`
        : '';
    rows.push(['Total', `${yellow(sanitizeText(s.totalLabel ?? 'partial — lower bound'))}${why}`]);
  }
  return rows;
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The window + clamp + omission footer every read shares. */
function printRangeFooter(res: RangeEcho): void {
  const lines: string[] = [];
  lines.push(
    dim(`Window: ${sanitizeText(res.range.since)} → ${sanitizeText(res.range.until)} (half-open)`),
  );
  if (res.historyClamped && res.historyFloor) {
    lines.push(
      warn(
        `History clamped to ${sanitizeText(res.historyFloor)} by your plan — earlier legs exist but are not readable on this plan.`,
      ),
    );
  }
  if (res.subtotals.unsupportedFilters.length > 0) {
    lines.push(
      warn(
        `Range subtotals ignore these filters: ${res.subtotals.unsupportedFilters
          .map(sanitizeText)
          .join(', ')} — the page rows are filtered, the range block is not.`,
      ),
    );
  }
  lines.push(dim(sanitizeText(res.costOwnerNote)));
  if (res.hasMore && res.nextCursor) {
    lines.push(dim(`More pages: re-run with --cursor ${sanitizeText(res.nextCursor)}`));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * The coverage note voice-heavy accounts need before they draw a conclusion
 * from a low priced-leg share — it is a property of what vendors publish, not
 * a gap in the data.
 */
function printPendingManualNote(totals: RangeTotals): void {
  const pending = totals.perStatus?.pending?.count ?? 0;
  const manual = totals.perStatus?.manual?.count ?? 0;
  if (pending === 0 && manual === 0) return;
  const notes: string[] = [];
  if (pending > 0) {
    notes.push(
      `${pending} pending — the vendor hasn't published these costs yet. For a recent call this is the STEADY STATE, not a defect.`,
    );
  }
  if (manual > 0) {
    notes.push(
      `${manual} manual — no vendor API publishes these. Upload the invoice (\`floe actuals invoices upload\`).`,
    );
  }
  notes.push(
    'Voice-heavy accounts read a lower priced-leg share at launch — a property of what vendors publish, not a gap in the data.',
  );
  process.stdout.write(`${dim(notes.join('\n'))}\n`);
}

// ─── Query building ────────────────────────────────────────────────────────

export interface ActualsFlags {
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
  since?: string;
  until?: string;
  vendor?: string;
  customer?: string;
  agent?: string;
  campaign?: string;
  task?: string;
  status?: string;
  limit?: string;
  cursor?: string;
  by?: string;
  kind?: string;
  severity?: string;
  state?: string;
  resolution?: string;
  name?: string;
  'billing-tz'?: string;
  'capture-since'?: string;
  file?: string;
  'period-start'?: string;
  'period-end'?: string;
  'foot-status'?: string;
  dryRun?: boolean;
}

/** Shared read filters. Validated locally against the API's closed sets so a
 *  typo fails before the round-trip rather than as a 400. */
function readQuery(flags: ActualsFlags): URLSearchParams {
  const q = new URLSearchParams();
  if (flags.since) q.set('since', flags.since);
  if (flags.until) q.set('until', flags.until);
  if (flags.vendor) q.set('vendor', flags.vendor);
  if (flags.customer) q.set('customerId', flags.customer);
  if (flags.agent) q.set('agentId', flags.agent);
  if (flags.campaign) q.set('campaignId', flags.campaign);
  if (flags.task) q.set('taskId', flags.task);
  if (flags.status) {
    const parts = flags.status
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
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

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function actualsLegsCommand(flags: ActualsFlags): Promise<void> {
  const q = readQuery(flags); // validation precedes I/O
  const { api } = await devContext(flags);
  const res = await api.dev<LegsResponse>(
    'GET',
    withQuery('/v1/developer/actuals/legs', q),
  );

  if (flags.json) return printJson(res);

  if (res.legs.length === 0) {
    process.stdout.write('No captured vendor legs in this window.\n');
    printRangeFooter(res);
    return;
  }

  const rows = res.legs.map((leg) => [
    sanitizeText(leg.occurredAt.slice(0, 19).replace('T', ' ')),
    sanitizeText(leg.vendor),
    sanitizeText(leg.legKind),
    leg.vendorRequestId ? sanitizeText(leg.vendorRequestId) : dim('—'),
    unitsCell(leg.units),
    statusCell(leg.status),
    costCell(leg),
  ]);
  process.stdout.write(`${bold('Vendor cost legs')}\n`);
  process.stdout.write(
    `${table(['OCCURRED', 'VENDOR', 'LEG', 'VENDOR REQUEST ID', 'UNITS', 'STATUS', 'COST'], rows)}\n`,
  );
  process.stdout.write(`\n${bold('Range subtotals')} ${dim('(whole window, not this page)')}\n`);
  process.stdout.write(`${kv(subtotalLines(res.subtotals))}\n`);
  printPendingManualNote(res.subtotals);
  printRangeFooter(res);
}

export async function actualsCallsCommand(flags: ActualsFlags): Promise<void> {
  const q = readQuery(flags);
  const { api } = await devContext(flags);
  const res = await api.dev<CallsResponse>(
    'GET',
    withQuery('/v1/developer/actuals/calls', q),
  );

  if (flags.json) return printJson(res);

  if (res.calls.length === 0) {
    process.stdout.write('No calls with captured vendor legs in this window.\n');
    printRangeFooter(res);
    return;
  }

  process.stdout.write(`${bold('Cost by call')}\n`);
  const rows = res.calls.map((call) => [
    sanitizeText(call.callKey),
    String(call.legCount),
    call.vendors.map((v) => sanitizeText(v)).join(' '),
    // The composition line: what this call's total is MADE of. Without it a
    // reader cannot tell a complete call from a mostly-pending one.
    composition(call),
    call.totalRaw !== null
      ? bold(rawToUsd(call.totalRaw))
      : yellow(sanitizeText(call.totalLabel ?? 'partial — lower bound')),
  ]);
  process.stdout.write(`${table(['CALL', 'LEGS', 'VENDORS', 'COMPOSITION', 'TOTAL'], rows)}\n`);
  process.stdout.write(
    `${dim('A call shows one TOTAL only when every leg is exact/period-rate/invoiced and USD-denominated. Otherwise it is a labelled lower bound — never a partial sum.')}\n`,
  );
  process.stdout.write(`\n${bold('Range subtotals')}\n`);
  process.stdout.write(`${kv(subtotalLines(res.subtotals))}\n`);
  printPendingManualNote(res.subtotals);
  printRangeFooter(res);
}

/** `n exact / n period-rate / n pending / n manual` — the honesty line. */
function composition(s: SubtotalBlock): string {
  const parts: string[] = [];
  if (s.composition.exact > 0) parts.push(green(`${s.composition.exact} exact`));
  if (s.composition.periodRate > 0) parts.push(cyan(`${s.composition.periodRate} period-rate`));
  if (s.composition.invoiced > 0) parts.push(bold(`${s.composition.invoiced} invoiced`));
  if (s.composition.pending > 0) parts.push(yellow(`${s.composition.pending} pending`));
  if (s.composition.manual > 0) parts.push(dim(`${s.composition.manual} manual`));
  return parts.length > 0 ? parts.join(' / ') : dim('—');
}

export async function actualsRollupsCommand(flags: ActualsFlags): Promise<void> {
  const by = flags.by ?? 'customer';
  if (!(ROLLUP_DIMENSIONS as readonly string[]).includes(by)) {
    throw new UsageError(`--by must be one of: ${ROLLUP_DIMENSIONS.join(', ')}.`);
  }
  const q = readQuery(flags);
  q.set('by', by);
  const { api } = await devContext(flags);
  const res = await api.dev<RollupsResponse>(
    'GET',
    withQuery('/v1/developer/actuals/rollups', q),
  );

  if (flags.json) return printJson(res);

  if (res.rollups.length === 0) {
    process.stdout.write(`No vendor legs to roll up by ${sanitizeText(by)} in this window.\n`);
    printRangeFooter(res);
    return;
  }

  process.stdout.write(`${bold(`Vendor cost by ${sanitizeText(res.by)}`)}\n`);
  const rows = res.rollups.map((row) => [
    sanitizeText(row.key),
    String(row.legCount),
    // Separate columns, never one merged figure — see the file header.
    rawToUsd(row.exactRaw),
    cyan(rawToUsd(row.periodRateRaw)),
    row.totalRaw !== null
      ? bold(rawToUsd(row.totalRaw))
      : yellow(sanitizeText(row.totalLabel ?? 'partial — lower bound')),
  ]);
  process.stdout.write(
    `${table([res.by.toUpperCase(), 'LEGS', 'EXACT', 'PERIOD-RATE', 'TOTAL'], rows)}\n`,
  );
  process.stdout.write(
    `${dim('EXACT and PERIOD-RATE are different claims and are never added into one figure.')}\n`,
  );
  process.stdout.write(`\n${bold('Range subtotals')}\n`);
  process.stdout.write(`${kv(subtotalLines(res.subtotals))}\n`);
  printPendingManualNote(res.subtotals);
  printRangeFooter(res);
}

export async function actualsFindingsCommand(flags: ActualsFlags): Promise<void> {
  const state = flags.state ?? 'open';
  if (!(FINDING_STATES as readonly string[]).includes(state)) {
    throw new UsageError(`--state must be one of: ${FINDING_STATES.join(', ')}.`);
  }
  const q = new URLSearchParams({ state });
  if (flags.kind) q.set('kind', flags.kind);
  if (flags.severity) q.set('severity', flags.severity);
  if (flags.limit) q.set('limit', flags.limit);
  if (flags.cursor) q.set('cursor', flags.cursor);

  const { api } = await devContext(flags);
  const res = await api.dev<FindingsResponse>(
    'GET',
    withQuery('/v1/developer/actuals/findings', q),
  );

  if (flags.json) return printJson(res);

  if (res.findings.length === 0) {
    process.stdout.write(`No ${sanitizeText(state)} reconciliation findings.\n`);
    return;
  }

  const severityCell = (s: string): string =>
    s === 'error' ? yellow('error') : s === 'warn' ? yellow('warn') : dim('info');

  const rows = res.findings.map((f) => [
    String(f.id),
    severityCell(f.severity),
    sanitizeText(f.kind),
    f.provider ? sanitizeText(f.provider) : dim('—'),
    f.entity ? sanitizeText(`${f.entity.type}:${f.entity.id}`) : dim('—'),
    sanitizeText(f.openedAt.slice(0, 10)),
    f.clearedAt ? green(sanitizeText(f.resolution ?? 'cleared')) : dim('open'),
  ]);
  process.stdout.write(`${bold(`Reconciliation findings (${sanitizeText(state)})`)}\n`);
  process.stdout.write(
    `${table(['ID', 'SEVERITY', 'KIND', 'VENDOR', 'ENTITY', 'OPENED', 'STATE'], rows)}\n`,
  );
  const counts = Object.entries(res.openCounts).filter(([, n]) => n > 0);
  if (counts.length > 0) {
    process.stdout.write(
      `${dim(`Open by kind: ${counts.map(([k, n]) => `${sanitizeText(k)}=${n}`).join(' · ')}`)}\n`,
    );
  }
  if (res.hasMore && res.nextCursor) {
    process.stdout.write(`${dim(`More: --cursor ${sanitizeText(res.nextCursor)}`)}\n`);
  }
  process.stdout.write(`${dim('Detail: floe actuals findings --json')}\n`);
}

export async function actualsFindingsResolveCommand(
  id: string,
  flags: ActualsFlags,
): Promise<void> {
  const resolution = flags.resolution;
  if (!resolution || !(RESOLUTIONS as readonly string[]).includes(resolution)) {
    throw new UsageError(`--resolution is required: ${RESOLUTIONS.join(' | ')}.`);
  }
  const { api } = await devContext(flags);
  const res = await api.dev<{ finding: Finding }>(
    'POST',
    `/v1/developer/actuals/findings/${id}/resolve`,
    { resolution },
  );
  if (flags.json) return printJson(res);
  process.stdout.write(
    `${ok(`Finding #${res.finding.id} (${sanitizeText(res.finding.kind)}) resolved as ${bold(sanitizeText(resolution))}`)}\n`,
  );
  process.stdout.write(
    `${dim('A resolved finding stays resolved. If the condition recurs the engine opens a new one.')}\n`,
  );
}

// ─── Connections ───────────────────────────────────────────────────────────

export async function actualsConnectionsCommand(flags: ActualsFlags): Promise<void> {
  const { api } = await devContext(flags);
  const res = await api.dev<ConnectionsResponse>('GET', '/v1/developer/vendor-connections');

  if (flags.json) return printJson(res);

  if (res.connections.length === 0) {
    process.stdout.write(
      `No vendor billing connections. Connect one: ${bold('floe actuals connect --vendor <vendor> --name <label> --kind <kind>')}\n`,
    );
  } else {
    const statusCellFor = (row: ConnectionRow): string => {
      if (row.credentialUnreadable) return yellow('unreadable');
      if (!row.enabled) return dim('disabled');
      switch (row.status) {
        case 'active':
          return green('active');
        case 'unauthorized':
          return yellow('unauthorized');
        case 'degraded':
          return yellow('degraded');
        default:
          return dim(sanitizeText(row.status));
      }
    };
    const rows = res.connections.map((row) => [
      String(row.id),
      sanitizeText(row.vendor),
      sanitizeText(row.name),
      sanitizeText(row.kind),
      Object.entries(row.credentialPublic)
        .map(([k, v]) => `${sanitizeText(k)}=${sanitizeText(v)}`)
        .join(' ') || dim('—'),
      statusCellFor(row),
      // The ceiling: what a leg served by this connection can EVER reach.
      row.bestStatus ? statusCell(row.bestStatus) : dim('no connector'),
      row.lastSuccessAt ? sanitizeText(row.lastSuccessAt.slice(0, 10)) : dim('never'),
    ]);
    process.stdout.write(`${bold('Vendor billing connections')}\n`);
    process.stdout.write(
      `${table(['ID', 'VENDOR', 'NAME', 'KIND', 'CREDENTIAL', 'STATUS', 'BEST STATUS', 'LAST PULL'], rows)}\n`,
    );
    process.stdout.write(
      `${dim("BEST STATUS is the ceiling: the best a leg served by this connection can EVER reach. A `period-rate` connector will never produce `exact`.")}\n`,
    );
    for (const row of res.connections) {
      if (row.credentialUnreadable) {
        process.stdout.write(
          `${warn(`Connection #${row.id} (${sanitizeText(row.vendor)}): the sealed credential cannot be opened. Re-enter it with \`floe actuals connect --vendor ${sanitizeText(row.vendor)} --name ${JSON.stringify(row.name)} --kind ${sanitizeText(row.kind)}\`.`)}\n`,
        );
      }
    }
  }

  const catalog = res.connectors.map((c) => [
    sanitizeText(c.vendor),
    statusCell(c.bestStatus),
    c.capabilities.map((x) => sanitizeText(x)).join(' '),
    c.billingTimeZone === 'config'
      ? yellow('--billing-tz required')
      : dim(sanitizeText(c.billingTimeZoneDefault ?? c.billingTimeZone)),
  ]);
  if (catalog.length > 0) {
    process.stdout.write(`\n${bold('Available connectors')}\n`);
    process.stdout.write(`${table(['VENDOR', 'BEST STATUS', 'CAPABILITIES', 'BILLING ZONE'], catalog)}\n`);
  }
  process.stdout.write(
    `${dim(`Credential kinds: ${Object.entries(res.credentialFields).map(([k, f]) => `${k} (${f.join(', ')})`).join(' · ')}`)}\n`,
  );
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += String(chunk);
  return data.trim();
}

/**
 * Collect a multi-field vendor billing credential WITHOUT ever touching argv
 * or shell history.
 *
 * Interactive: one prompt per field the kind declares — hidden for secrets,
 * echoed for identifiers (recognising WHICH of two Twilio subaccounts a row is
 * is the whole point of the mask, so the operator must be able to see what
 * they typed).
 *
 * Scripts: a JSON object on stdin. A single-field kind additionally accepts a
 * bare token, matching `floe providers set` muscle memory.
 */
async function collectCredential(
  kind: string,
  fields: readonly string[],
): Promise<Record<string, string>> {
  if (isInteractive()) {
    const credential: Record<string, string> = {};
    process.stdout.write(
      `${dim(`Credential kind "${sanitizeText(kind)}" needs: ${fields.join(', ')}`)}\n`,
    );
    for (const field of fields) {
      const value = isSecretField(field)
        ? await askSecret(`  ${field} (hidden): `)
        : await ask(`  ${field}: `);
      if (!value) throw new UsageError(`"${field}" is required and cannot be empty.`);
      credential[field] = value;
    }
    return credential;
  }

  const raw = await readStdin();
  if (!raw) {
    throw new UsageError(
      `No credential provided. Interactively you are prompted per field; in scripts pipe a JSON object:\n` +
        `  printf '%s' '${JSON.stringify(Object.fromEntries(fields.map((f) => [f, '…'])))}' | floe actuals connect --vendor <vendor> --name <label> --kind ${kind}`,
    );
  }

  let parsed: unknown;
  if (raw.startsWith('{')) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new UsageError('Credential on stdin is not valid JSON.');
    }
  } else if (fields.length === 1) {
    parsed = { [fields[0]!]: raw };
  } else {
    throw new UsageError(
      `A "${kind}" credential has ${fields.length} fields (${fields.join(', ')}), so stdin must be a JSON object — a bare token is only accepted for single-field kinds.`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError('Credential on stdin must be a JSON object of field → value.');
  }
  const supplied = parsed as Record<string, unknown>;
  const credential: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of fields) {
    const value = supplied[field];
    if (typeof value !== 'string' || value.trim().length === 0) missing.push(field);
    else credential[field] = value;
  }
  if (missing.length > 0) {
    throw new UsageError(
      `A "${kind}" credential needs ${fields.join(', ')}. Missing: ${missing.join(', ')}.`,
    );
  }
  // Only declared fields are sent. The API projects onto the declared set
  // anyway; dropping extras here means a stray key never leaves this machine.
  return credential;
}

export async function actualsConnectCommand(flags: ActualsFlags): Promise<void> {
  const vendor = flags.vendor?.trim().toLowerCase();
  if (!vendor) throw new UsageError('--vendor is required (see `floe actuals connections`).');
  const name = flags.name?.trim();
  if (!name) {
    throw new UsageError(
      '--name is required — it labels this credential, and two subaccounts of the same vendor are two named rows.',
    );
  }

  const ctx = await devContext(flags);
  // The catalog is the source of truth for which fields a kind carries; a
  // hardcoded single-field form is exactly how a BYOK key ends up pasted into
  // a billing credential.
  const catalog = await ctx.api.dev<ConnectionsResponse>('GET', '/v1/developer/vendor-connections');

  const kinds = Object.keys(catalog.credentialFields);
  const kind = flags.kind?.trim();
  if (!kind || !kinds.includes(kind)) {
    throw new UsageError(`--kind is required: ${kinds.join(' | ')}.`);
  }
  const connector = catalog.connectors.find((c) => c.vendor === vendor);
  if (connector && connector.billingTimeZone === 'config' && !flags['billing-tz']) {
    throw new UsageError(
      `${vendor} cuts its billing buckets in the account's own timezone and exposes it through no API, so --billing-tz is required (e.g. --billing-tz America/Los_Angeles). An unchecked UTC assumption is a permanent silent coverage gap.`,
    );
  }

  const credential = await collectCredential(kind, catalog.credentialFields[kind]!);

  const body: Record<string, unknown> = { vendor, name, kind, credential };
  if (flags['billing-tz']) body.billingTimeZone = flags['billing-tz'];
  if (flags['capture-since']) body.captureSince = flags['capture-since'];

  const res = await ctx.api.dev<{ connection: ConnectionRow }>(
    'POST',
    '/v1/developer/vendor-connections',
    body,
  );
  const row = res.connection;

  if (flags.json) return printJson(res);

  process.stdout.write(
    `${ok(`Connected ${bold(sanitizeText(row.vendor))} billing credential "${sanitizeText(row.name)}" — connection #${row.id}`)}\n`,
  );
  process.stdout.write(
    `${kv([
      ['Kind', sanitizeText(row.kind)],
      [
        'Stored as',
        Object.entries(row.credentialPublic)
          .map(([k, v]) => `${sanitizeText(k)}=${sanitizeText(v)}`)
          .join(' ') || dim('—'),
      ],
      ['Status', dim(sanitizeText(row.status))],
      [
        'Best status',
        row.bestStatus
          ? `${statusCell(row.bestStatus)} ${dim(`— ${STATUS_MEANING[row.bestStatus as ReconciliationStatus] ?? 'the ceiling for legs served by this connection'}`)}`
          : yellow('no connector for this vendor — nothing will be pulled'),
      ],
      ['Billing zone', sanitizeText(row.billingTimeZone)],
    ])}\n`,
  );
  process.stdout.write(
    `${dim('The credential is sealed and never returned by any read — only the mask above. Floe asks for READ-ONLY billing scope; it never writes to your vendor account.')}\n`,
  );
  process.stdout.write(`${bold(`Next: floe actuals verify ${row.id}`)}\n`);
}

export async function actualsVerifyCommand(id: string, flags: ActualsFlags): Promise<void> {
  const { api } = await devContext(flags);
  const res = await api.dev<{
    connection: ConnectionRow;
    verification: { ok: boolean; reason: string | null; detail: string | null; discovered: unknown };
  }>('POST', `/v1/developer/vendor-connections/${id}/verify`);

  if (flags.json) return printJson(res);

  process.stdout.write(
    `${ok(`${bold(sanitizeText(res.connection.vendor))} connection #${res.connection.id} verified — status ${green(sanitizeText(res.connection.status))}`)}\n`,
  );
  if (res.verification.detail) {
    process.stdout.write(`${kv([['Detail', sanitizeText(res.verification.detail)]])}\n`);
  }
  if (res.verification.discovered) {
    process.stdout.write(
      `${kv([['Discovered', sanitizeText(JSON.stringify(res.verification.discovered))]])}\n`,
    );
  }
  process.stdout.write(
    `${dim('Verification proves a cheap read call succeeded now. Floe cannot inspect a vendor key\'s scope without calling the vendor, so this is advisory, not a scope guarantee.')}\n`,
  );
}

// ─── Invoices ──────────────────────────────────────────────────────────────

export async function actualsInvoicesListCommand(flags: ActualsFlags): Promise<void> {
  const footStatus = flags['foot-status'];
  if (footStatus && !(FOOT_STATUSES as readonly string[]).includes(footStatus)) {
    throw new UsageError(`--foot-status must be one of: ${FOOT_STATUSES.join(', ')}.`);
  }
  const q = new URLSearchParams();
  if (flags.vendor) q.set('vendor', flags.vendor);
  if (footStatus) q.set('footStatus', footStatus);
  if (flags.limit) q.set('limit', flags.limit);

  const { api } = await devContext(flags);
  const res = await api.dev<DocumentsResponse>(
    'GET',
    withQuery('/v1/developer/actuals/documents', q),
  );

  if (flags.json) return printJson(res);

  if (res.documents.length === 0) {
    process.stdout.write(
      `No vendor invoices uploaded. Add one: ${bold('floe actuals invoices upload --vendor <vendor> --file <path>')}\n`,
    );
  } else {
    const rows = res.documents.map((d) => [
      String(d.id),
      sanitizeText(d.vendor),
      sanitizeText(d.filename),
      sanitizeText(d.state),
      d.periodStart && d.periodEnd
        ? `${sanitizeText(d.periodStart.slice(0, 10))}→${sanitizeText(d.periodEnd.slice(0, 10))}`
        : dim('—'),
      d.parsedTotalNative
        ? `${sanitizeText(d.parsedTotalNative)} ${sanitizeText(d.currency ?? '')}`.trim()
        : dim('—'),
      d.footedAt ? green(sanitizeText(d.footedAt.slice(0, 10))) : dim(sanitizeText(d.footStatus)),
    ]);
    process.stdout.write(`${bold('Vendor invoices')}\n`);
    process.stdout.write(
      `${table(['ID', 'VENDOR', 'FILE', 'STATE', 'PERIOD', 'PARSED TOTAL', 'FOOTED'], rows)}\n`,
    );
  }
  if (!res.objectLaneAvailable) {
    process.stdout.write(
      `${dim('This deployment has no document bucket configured — only the inline CSV lane (≤256 KiB, text/csv) is available.')}\n`,
    );
  }
}

/** Content type from the extension. The server re-derives what it needs; this
 *  only has to be honest enough for the signed PUT to match. */
function contentTypeFor(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'csv') return 'text/csv';
  if (ext === 'json') return 'application/json';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'txt') return 'text/plain';
  return 'application/octet-stream';
}

export async function actualsInvoicesUploadCommand(flags: ActualsFlags): Promise<void> {
  const vendor = flags.vendor?.trim().toLowerCase();
  if (!vendor) throw new UsageError('--vendor is required.');
  const path = flags.file;
  if (!path) throw new UsageError('--file <path> is required.');

  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { basename } = await import('node:path');

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new UsageError(`Could not read ${path}: ${(err as Error).message}`);
  }
  const filename = basename(path);
  const contentType = contentTypeFor(filename);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const ctx = await devContext(flags);
  const period: Record<string, unknown> = {};
  if (flags['period-start']) period.periodStart = flags['period-start'];
  if (flags['period-end']) period.periodEnd = flags['period-end'];

  // The inline lane needs no bucket and is the one that always works, so a
  // small CSV goes straight down it. Anything else needs object storage.
  const inlineEligible = contentType === 'text/csv' && bytes.byteLength <= INLINE_MAX_BYTES;

  let result: { document: VendorDocument; duplicate: boolean; parse?: unknown };
  if (inlineEligible) {
    result = await ctx.api.dev('POST', '/v1/developer/actuals/documents', {
      vendor,
      filename,
      contentType,
      body: bytes.toString('utf8'),
      ...period,
    });
  } else {
    const minted = await ctx.api.dev<{
      document: VendorDocument;
      duplicate: boolean;
      upload: SignedUpload | null;
    }>('POST', '/v1/developer/actuals/documents/upload-url', {
      vendor,
      filename,
      contentType,
      sizeBytes: bytes.byteLength,
      sha256,
      ...period,
    });

    if (minted.upload) {
      // Raw fetch, NOT api.dev: this PUT goes to the storage host, and
      // FloeApi would attach the Floe developer key to a third-party origin.
      // The signed headers must be sent verbatim — the signature covers them.
      const put = await fetch(minted.upload.url, {
        method: minted.upload.method,
        headers: minted.upload.headers,
        body: new Uint8Array(bytes),
      });
      if (!put.ok) {
        throw new UsageError(
          `Upload to storage failed (HTTP ${put.status}). The signed URL expires at ${minted.upload.expiresAt}; re-run to mint a new one.`,
        );
      }
    }
    // Finalize re-downloads and recomputes the digest server-side — the
    // sha256 above is only a dedupe hint.
    result = await ctx.api.dev(
      'POST',
      `/v1/developer/actuals/documents/${minted.document.id}/finalize`,
    );
  }

  if (flags.json) return printJson(result);

  const doc = result.document;
  process.stdout.write(
    `${ok(`${result.duplicate ? 'Matched existing' : 'Uploaded'} ${bold(sanitizeText(doc.vendor))} invoice #${doc.id} — ${sanitizeText(doc.filename)}`)}\n`,
  );
  process.stdout.write(
    `${kv([
      ['State', sanitizeText(doc.state)],
      ['Parse', sanitizeText(doc.parseStatus)],
      [
        'Parsed total',
        doc.parsedTotalNative
          ? `${sanitizeText(doc.parsedTotalNative)} ${sanitizeText(doc.currency ?? '')}`.trim()
          : dim('—'),
      ],
    ])}\n`,
  );
  if (doc.parseError) {
    process.stdout.write(`${warn(`Parse error: ${sanitizeText(doc.parseError)}`)}\n`);
  }
  process.stdout.write(
    `${dim(`Review the lines, then foot it: floe actuals invoices foot ${doc.id} --dry-run`)}\n`,
  );
}

export async function actualsInvoicesFootCommand(id: string, flags: ActualsFlags): Promise<void> {
  const dryRun = flags.dryRun === true;
  const { api } = await devContext(flags);

  if (!dryRun) {
    // Footing rewrites stamps to `invoiced` and is not undone by re-running.
    // A human types the id back, or a script opts in with --yes.
    await confirmAction(
      `foot invoice ${id} — this writes invoiced stamps against the vendor's own invoice and is irreversible`,
      id,
      { yes: flags.yes },
    );
  }

  const res = await api.dev<{
    document: VendorDocument | null;
    foot: Record<string, unknown>;
    dryRun: boolean;
  }>('POST', `/v1/developer/actuals/documents/${id}/foot`, dryRun ? { dryRun: true } : {});

  if (flags.json) return printJson(res);

  const f = res.foot;
  const raw = (key: string): string => {
    const v = f[key];
    return typeof v === 'string' ? rawToUsd(v) : dim('—');
  };
  process.stdout.write(
    `${res.dryRun ? warn(`Dry run — nothing was written for invoice ${id}`) : ok(`Invoice ${id} footed`)}\n`,
  );
  process.stdout.write(
    `${kv([
      ['Mode', sanitizeText(String(f.mode ?? '—'))],
      ['Invoice total', raw('parsedTotalRaw')],
      ['Ledger total', raw('ledgerTotalRaw')],
      ['Variance', raw('varianceRaw')],
      ['Unexplained', raw('unexplainedRaw')],
      ['Stamps written', String(f.stampsWritten ?? 0)],
      ['Lines promoted', String(f.linesPromoted ?? 0)],
    ])}\n`,
  );
  process.stdout.write(
    `${dim("Footed legs read `invoiced` — \"footed to the vendor's invoice\" — and retain the status they held before the foot.")}\n`,
  );
  if (res.dryRun) {
    process.stdout.write(
      `${dim(`Run it for real: floe actuals invoices foot ${id}`)}\n`,
    );
  }
}

// ─── Command definition ────────────────────────────────────────────────────

export const actualsDef: CommandDef = {
  name: 'actuals',
  summary: 'legs | calls | rollups | findings | connect | invoices — reconciled vendor cost',
  usage: `Usage: floe actuals legs      [filters] [--cursor <c>]
       floe actuals calls     [filters] [--cursor <c>]
       floe actuals rollups   --by <customer|campaign|agent|vendor|time> [filters]
       floe actuals findings  [--state <open|cleared|all>] [--kind <k>] [--severity <s>]
       floe actuals findings resolve <id> --resolution <acknowledged|wont_fix|fixed>
       floe actuals connections
       floe actuals connect   --vendor <v> --name <label> --kind <kind>
                              [--billing-tz <IANA>] [--capture-since <iso>]
       floe actuals verify    <connection-id>
       floe actuals invoices  list [--vendor <v>] [--foot-status <unfooted|footed|disputed>]
       floe actuals invoices  upload --vendor <v> --file <path>
                              [--period-start <iso>] [--period-end <iso>]
       floe actuals invoices  foot <document-id> [--dry-run] [--yes]

What your VENDORS charged you, reconciled against their own billing records.
(For the health of Floe's marketplace vendors, that's \`floe vendors\`.)

Every cost carries a STATUS, and a status is a claim:

  exact        reconciled to the vendor's own per-request billing record
  period-rate  priced at the vendor's own realized rate for that period.
               A real derivation — NOT per-request precision, and never
               added to the exact figure
  invoiced     footed to the vendor's invoice
  pending      the vendor hasn't published this cost yet — units, no dollars
  manual       no vendor API publishes this — upload the invoice

WHEN A COST ARRIVES. Some legs can be costed the moment a call ends, others
only on the vendor's next-day batch. So \`pending\` on a recent call is the
STEADY STATE, not a defect.

COVERAGE READS LOW ON VOICE-HEAVY ACCOUNTS AT LAUNCH — a property of what
vendors publish, not a gap in the data.

  legs         Per-leg captured vendor cost, keyset-paginated
  calls        Server-side by-call rollup with a per-call composition line
  rollups      Totals by customer / campaign / agent / vendor / day
  findings     Open reconciliation findings (and \`resolve\` to seal one)
  connections  Your vendor billing credentials (masked) + the connector catalog
  connect      Store a read-only vendor BILLING credential. Never pass it as an
               argument: interactive runs prompt per field with secrets hidden;
               scripts pipe a JSON object on stdin —
                 printf '%s' "$JSON" | floe actuals connect --vendor twilio \\
                   --name main --kind basic_auth --billing-tz America/Los_Angeles
  verify       Prove a stored credential still reads (advisory, not a scope check)
  invoices     Upload, list and foot vendor invoices. Footing is irreversible
               and asks for confirmation — use --dry-run first

Filters (legs / calls / rollups): --since --until --vendor --customer --agent
--campaign --task --status <csv> --limit --cursor

Floe-carried legs are omitted entirely from every read: that is Floe's COGS,
and your cost for those legs is already exact on the Floe ledger.
`,
  options: {
    since: { type: 'string' },
    until: { type: 'string' },
    vendor: { type: 'string' },
    customer: { type: 'string' },
    agent: { type: 'string' },
    campaign: { type: 'string' },
    task: { type: 'string' },
    status: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
    by: { type: 'string' },
    kind: { type: 'string' },
    severity: { type: 'string' },
    state: { type: 'string' },
    resolution: { type: 'string' },
    name: { type: 'string' },
    'billing-tz': { type: 'string' },
    'capture-since': { type: 'string' },
    file: { type: 'string' },
    'period-start': { type: 'string' },
    'period-end': { type: 'string' },
    'foot-status': { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
  run: async (ctx) => {
    const [subcommand, arg, arg2] = ctx.args;
    const flags: ActualsFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      yes: ctx.yes,
      since: str(ctx, 'since'),
      until: str(ctx, 'until'),
      vendor: str(ctx, 'vendor'),
      customer: str(ctx, 'customer'),
      agent: str(ctx, 'agent'),
      campaign: str(ctx, 'campaign'),
      task: str(ctx, 'task'),
      status: str(ctx, 'status'),
      limit: str(ctx, 'limit'),
      cursor: str(ctx, 'cursor'),
      by: str(ctx, 'by'),
      kind: str(ctx, 'kind'),
      severity: str(ctx, 'severity'),
      state: str(ctx, 'state'),
      resolution: str(ctx, 'resolution'),
      name: str(ctx, 'name'),
      'billing-tz': str(ctx, 'billing-tz'),
      'capture-since': str(ctx, 'capture-since'),
      file: str(ctx, 'file'),
      'period-start': str(ctx, 'period-start'),
      'period-end': str(ctx, 'period-end'),
      'foot-status': str(ctx, 'foot-status'),
      dryRun: flag(ctx, 'dry-run'),
    };

    const requireId = (raw: string | undefined, verb: string, what: string): string => {
      if (!raw) throw new UsageError(`Usage: floe actuals ${verb} <${what}>.`);
      if (!/^\d+$/.test(raw)) {
        throw new UsageError(`Invalid ${what} "${raw}" — ids are numeric.`);
      }
      return raw;
    };

    if (subcommand === 'legs') {
      expectArgs(ctx, 1);
      await actualsLegsCommand(flags);
    } else if (subcommand === 'calls') {
      expectArgs(ctx, 1);
      await actualsCallsCommand(flags);
    } else if (subcommand === 'rollups') {
      expectArgs(ctx, 1);
      await actualsRollupsCommand(flags);
    } else if (subcommand === 'findings') {
      if (arg === 'resolve') {
        expectArgs(ctx, 3);
        await actualsFindingsResolveCommand(requireId(arg2, 'findings resolve', 'finding-id'), flags);
      } else {
        expectArgs(ctx, 1);
        await actualsFindingsCommand(flags);
      }
    } else if (subcommand === 'connections') {
      expectArgs(ctx, 1);
      await actualsConnectionsCommand(flags);
    } else if (subcommand === 'connect') {
      expectArgs(ctx, 1);
      await actualsConnectCommand(flags);
    } else if (subcommand === 'verify') {
      expectArgs(ctx, 2);
      await actualsVerifyCommand(requireId(arg, 'verify', 'connection-id'), flags);
    } else if (subcommand === 'invoices') {
      if (arg === 'upload') {
        expectArgs(ctx, 2);
        await actualsInvoicesUploadCommand(flags);
      } else if (arg === 'foot') {
        expectArgs(ctx, 3);
        await actualsInvoicesFootCommand(requireId(arg2, 'invoices foot', 'document-id'), flags);
      } else if (arg === undefined || arg === 'list') {
        expectArgs(ctx, 2);
        await actualsInvoicesListCommand(flags);
      } else {
        throw new UsageError(
          `Unknown invoices subcommand "${arg}". Use: list, upload, foot <document-id>.`,
        );
      }
    } else if (subcommand === undefined) {
      throw new UsageError(
        'Pick a view: legs, calls, rollups, findings, connections, connect, verify, invoices.',
      );
    } else {
      throw new UsageError(
        `Unknown actuals subcommand "${subcommand}". Use: legs, calls, rollups, findings, connections, connect, verify <id>, invoices.`,
      );
    }
  },
};
