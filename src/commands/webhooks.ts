import { ApiError } from '../lib/api.js';
import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext } from '../lib/context.js';
import {
  bold,
  dim,
  green,
  kv,
  ok,
  printJson,
  red,
  sanitizeText,
  UsageError,
  warn,
  yellow,
} from '../lib/output.js';
import { table } from '../lib/table.js';

/**
 * Developer webhooks: signed event deliveries to your endpoint. All routes
 * live on the management plane (/v1/developer/webhooks*, floe_live_ key).
 * The whsec_… signing secret is returned by the API exactly once (create /
 * rotate-secret) and must therefore be printed exactly once, never swallowed.
 */

/**
 * Mirrors the API's webhook event catalog — typos fail before I/O. The server
 * catalog (`floe webhooks events`) is the source of truth; extend this list
 * when it grows.
 */
const ALLOWED_EVENTS = [
  'loan.health_warning',
  'loan.expiry_warning',
  'loan.overdue',
  'loan.liquidated',
  'loan.repaid',
  'agent.created',
  'agent.suspended',
  'key.created',
  'key.rotated',
  'x402.first_settlement',
  'provider_key.created',
  'provider_key.updated',
  'provider_key.deleted',
  'credit.warning',
  'credit.at_limit',
  'credit.recovered',
  'call.started',
  'call.ended',
  'call.report.ready',
  'call.recording.ready',
  'call.analyzed',
  'call.rejected',
  'phone.number.grace',
  'phone.number.released',
  'marketplace.job.completed',
  'marketplace.payment.settled',
  'marketplace.spend_cap.hit',
  'marketplace.tripwire.triggered',
  'marketplace.vendor.degraded',
  'marketplace.vendor.recovered',
] as const;

/** Wrap the catalog into indented help lines, 4 names per line. */
const EVENT_HELP_LINES = ALLOWED_EVENTS.reduce<string[][]>((lines, name, i) => {
  if (i % 4 === 0) lines.push([]);
  lines[lines.length - 1]!.push(name);
  return lines;
}, [])
  .map((group) => `  ${group.join('  ')}`)
  .join('\n');

const ALLOWED_SCOPES = ['global', 'wallet', 'agent', 'loan'] as const;

/** Mirrors the API's delivery status enum — the logs --status filter values. */
const DELIVERY_STATUSES = ['pending', 'retrying', 'success', 'failed'] as const;

/** wallet + agent scope values are wallet addresses — validated before I/O. */
const WALLET_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

interface WebhookView {
  id: number;
  url: string;
  events: string[];
  scope: string;
  scopeValue: string | null;
  active: boolean;
  description: string | null;
  /** PATCH responses omit it; list/get/create include it. */
  createdAt?: string | null;
}

interface CreatedWebhook extends WebhookView {
  /** Only returned at creation. */
  secret: string;
}

interface DeliveryView {
  id: number;
  deliveryId: string;
  event: string;
  statusCode: number | null;
  status: string;
  attempt: number;
  error: string | null;
  createdAt: string | null;
}

/** One row of GET /v1/developer/webhooks/events — the live catalog. */
interface CatalogEvent {
  name: string;
  title: string;
  description: string;
  category: string;
  scope: string;
}

/** One row of GET /v1/developer/webhook-deliveries — the account-wide log. */
interface AccountDeliveryView extends DeliveryView {
  webhookId: number;
  webhookUrl: string | null;
  agentWallet: string | null;
  correlationId: string | null;
}

interface AccountDeliveriesResponse {
  deliveries: AccountDeliveryView[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** POST …/test and …/retry both return this dispatch outcome. */
interface DispatchOutcome {
  success: boolean;
  statusCode?: number;
  error?: string;
  deliveryId: string;
}

export interface WebhooksFlags {
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
  events?: string;
  scope?: string;
  scopeValue?: string;
  description?: string;
  limit?: string;
  retry?: string;
  // logs filters
  endpoint?: string;
  event?: string;
  agent?: string;
  status?: string;
  from?: string;
  to?: string;
  id?: string;
  cursor?: string;
}

function requireWebhookId(raw: string | undefined, verb: string): string {
  if (!raw) throw new UsageError(`Usage: floe webhooks ${verb} <id>`);
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`Webhook id must be numeric (got "${raw}") — see \`floe webhooks list\`.`);
  }
  return raw;
}

/** The API's bare 404 body is just {error:"Not found"} — name the webhook instead.
 *  Retry's delivery-scoped 404 ({error:"Delivery not found"}) passes through untouched. */
async function withWebhook<T>(id: string, call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && err.code !== 'Delivery not found') {
      throw new ApiError(`Webhook ${id} not found.`, 404, err.code, 'List webhooks with `floe webhooks list`.');
    }
    throw err;
  }
}

/**
 * Mirrors the API's isSubscribableEvent (routes/developer/shared.ts): an
 * exact catalog name, '*' (everything), or a '<prefix>.*' wildcard that
 * covers at least one catalog event.
 */
function isSubscribableEvent(value: string): boolean {
  if (value === '*') return true;
  if ((ALLOWED_EVENTS as readonly string[]).includes(value)) return true;
  if (value.endsWith('.*')) {
    const prefix = value.slice(0, -1); // keep the trailing dot: 'call.'
    return ALLOWED_EVENTS.some((name) => name.startsWith(prefix));
  }
  return false;
}

function parseEvents(raw: string | undefined): string[] {
  if (!raw) {
    throw new UsageError(
      `create requires --events <e1,e2,…>. Valid events:\n  ${ALLOWED_EVENTS.join('\n  ')}`,
    );
  }
  const events = [...new Set(raw.split(',').map((e) => e.trim()).filter(Boolean))];
  if (events.length === 0) throw new UsageError('--events must name at least one event.');
  const unknown = events.filter((e) => !isSubscribableEvent(e));
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown event(s): ${unknown.join(', ')}. Valid events ('*' and '<prefix>.*' wildcards also accepted):\n  ${ALLOWED_EVENTS.join('\n  ')}\n` +
        'Live catalog with descriptions: floe webhooks events',
    );
  }
  return events;
}

/** Deliveries page size — the API clamps to [1, 100] (default 50). */
function parseLimit(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(`--limit must be a number (got "${raw}").`);
  const n = Number(raw);
  if (n < 1 || n > 100) throw new UsageError('--limit must be between 1 and 100.');
  return n;
}

/** whsec_… appears in output exactly once — here. Losing it means rotate-secret. */
function printSecretOnce(secret: string): void {
  process.stdout.write(
    `${warn('Signing secret (shown once — store it now):')}\n${bold(sanitizeText(secret))}\n` +
      `${dim('Verify deliveries: HMAC-SHA256 over "<timestamp>.<body>" with this secret — headers X-Floe-Signature / X-Floe-Timestamp.')}\n`,
  );
}

/** Shared outcome printer for test + retry. A failed delivery exits 1 so scripts can gate on it. */
function printDispatch(label: string, result: DispatchOutcome, json: boolean): void {
  if (json) {
    printJson(result);
  } else if (result.success) {
    process.stdout.write(
      `${ok(`${label} delivered — HTTP ${result.statusCode ?? '?'} ${dim(`(delivery ${sanitizeText(result.deliveryId)})`)}`)}\n`,
    );
  } else {
    const why =
      result.error !== undefined
        ? sanitizeText(result.error)
        : result.statusCode !== undefined
          ? `HTTP ${result.statusCode}`
          : 'unknown error';
    process.stdout.write(
      `${warn(`${label} failed — ${why} ${dim(`(delivery ${sanitizeText(result.deliveryId)})`)}`)}\n` +
        `${dim('Inspect attempts: floe webhooks deliveries <id>')}\n`,
    );
  }
  if (!result.success) process.exitCode = 1;
}

function summarizeEvents(events: string[]): string {
  if (events.length <= 3) return events.join(', ');
  return `${events.slice(0, 2).join(', ')} +${events.length - 2} more`;
}

const statusLabel = (active: boolean) => (active ? green('active') : yellow('paused'));

const shortWallet = (w: string): string => (w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w);

export async function webhooksListCommand(flags: WebhooksFlags): Promise<void> {
  const { api } = await devContext(flags);
  const { webhooks } = await api.dev<{ webhooks: WebhookView[] }>('GET', '/v1/developer/webhooks');

  if (flags.json) return printJson({ webhooks });

  if (webhooks.length === 0) {
    process.stdout.write(
      `No webhooks yet. Create one:\n  ${bold('floe webhooks create <url> --events loan.repaid,loan.liquidated')}\n`,
    );
    return;
  }
  const rows = webhooks.map((h) => [
    String(h.id),
    sanitizeText(h.url),
    sanitizeText(summarizeEvents(h.events)),
    sanitizeText(h.scope) + (h.scopeValue ? dim(`=${sanitizeText(h.scopeValue)}`) : ''),
    statusLabel(h.active),
    h.createdAt ? h.createdAt.slice(0, 10) : '—',
  ]);
  process.stdout.write(`${table(['ID', 'URL', 'EVENTS', 'SCOPE', 'STATUS', 'CREATED'], rows)}\n`);
}

export async function webhooksCreateCommand(url: string, flags: WebhooksFlags): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`Invalid webhook URL "${url}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(`Webhook URL must use http or https (got "${parsed.protocol}").`);
  }
  const events = parseEvents(flags.events);
  const scope = flags.scope ?? 'global';
  const scopeValue = flags.scopeValue;
  if (!(ALLOWED_SCOPES as readonly string[]).includes(scope)) {
    throw new UsageError(`Unknown --scope "${scope}". Supported: global, wallet, agent, loan.`);
  }
  if (scope === 'global' && scopeValue) {
    throw new UsageError('--scope global does not take a --scope-value.');
  }
  if (scope === 'wallet' && (!scopeValue || !WALLET_ADDRESS.test(scopeValue))) {
    throw new UsageError('--scope wallet requires --scope-value <0x… Ethereum address>.');
  }
  if (scope === 'agent' && (!scopeValue || !WALLET_ADDRESS.test(scopeValue))) {
    throw new UsageError('--scope agent requires --scope-value <0x… agent wallet address>.');
  }
  if (scope === 'loan' && (!scopeValue || !/^\d+$/.test(scopeValue))) {
    throw new UsageError('--scope loan requires --scope-value <numeric loan id>.');
  }

  const { api } = await devContext(flags);
  let created: { webhook: CreatedWebhook };
  try {
    created = await api.dev<{ webhook: CreatedWebhook }>('POST', '/v1/developer/webhooks', {
      url,
      events,
      scope,
      ...(scopeValue ? { scopeValue } : {}),
      ...(flags.description ? { description: flags.description } : {}),
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'Limit exceeded') {
      throw new ApiError(
        'You already have the maximum of 10 webhooks — delete one first: floe webhooks delete <id>.',
        err.status,
        err.code,
      );
    }
    throw err;
  }

  const { webhook } = created;
  if (flags.json) {
    // The secret is shown exactly once — in this response, for the caller that created it.
    return printJson({ webhook });
  }
  process.stdout.write(`${ok(`Webhook ${bold(String(webhook.id))} created → ${sanitizeText(webhook.url)}`)}\n`);
  process.stdout.write(
    `${kv([
      ['Events', sanitizeText(webhook.events.join(', '))],
      ['Scope', sanitizeText(webhook.scope) + (webhook.scopeValue ? ` = ${sanitizeText(webhook.scopeValue)}` : '')],
    ])}\n`,
  );
  printSecretOnce(webhook.secret);
}

export async function webhooksEventsCommand(flags: WebhooksFlags): Promise<void> {
  const { api } = await devContext(flags);
  let catalog: { events: CatalogEvent[] };
  try {
    catalog = await api.dev<{ events: CatalogEvent[] }>('GET', '/v1/developer/webhooks/events');
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new ApiError(
        'This API build predates the webhook event catalog endpoint.',
        404,
        err.code,
        'The Events list in `floe help webhooks` is still valid.',
      );
    }
    throw err;
  }

  if (flags.json) return printJson({ events: catalog.events });

  const rows = [...catalog.events]
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    .map((e) => [sanitizeText(e.category), sanitizeText(e.name), sanitizeText(e.description)]);
  process.stdout.write(`${table(['CATEGORY', 'EVENT', 'DESCRIPTION'], rows)}\n`);
  process.stdout.write(`${dim('Subscribe: floe webhooks create <url> --events <e1,e2,…>')}\n`);
}

export async function webhooksGetCommand(id: string, flags: WebhooksFlags): Promise<void> {
  const { api } = await devContext(flags);
  const { webhook, deliveryStats } = await withWebhook(
    id,
    api.dev<{ webhook: WebhookView; deliveryStats: Record<string, number> }>(
      'GET',
      `/v1/developer/webhooks/${id}`,
    ),
  );

  if (flags.json) return printJson({ webhook, deliveryStats });

  // `total` is an aggregate, not a delivery status, and zero-count statuses
  // are noise — the API's dense stats shape would otherwise make the
  // 'none yet' empty state unreachable.
  const stats = Object.entries(deliveryStats).filter(
    ([status, count]) => status !== 'total' && count > 0,
  );
  const rows: Array<[string, string]> = [
    ['URL', sanitizeText(webhook.url)],
    ['Events', sanitizeText(webhook.events.join(', '))],
    ['Scope', sanitizeText(webhook.scope) + (webhook.scopeValue ? ` = ${sanitizeText(webhook.scopeValue)}` : '')],
    ['Status', statusLabel(webhook.active)],
    ['Description', webhook.description ? sanitizeText(webhook.description) : dim('(none)')],
    ['Created', webhook.createdAt ? webhook.createdAt.slice(0, 10) : '—'],
    [
      'Deliveries',
      stats.length > 0
        ? stats.map(([status, count]) => `${count} ${sanitizeText(status)}`).join(' · ')
        : dim('none yet'),
    ],
  ];
  process.stdout.write(`${bold(`Webhook ${webhook.id}`)}\n${kv(rows)}\n`);
}

export async function webhooksSetActiveCommand(
  id: string,
  active: boolean,
  flags: WebhooksFlags,
): Promise<void> {
  const { api } = await devContext(flags);
  const { webhook } = await withWebhook(
    id,
    api.dev<{ webhook: WebhookView }>('PATCH', `/v1/developer/webhooks/${id}`, { active }),
  );

  if (flags.json) return printJson({ webhook });
  if (active) {
    process.stdout.write(`${ok(`Webhook ${bold(String(webhook.id))} enabled — deliveries resume.`)}\n`);
  } else {
    process.stdout.write(
      `${ok(`Webhook ${bold(String(webhook.id))} paused.`)}\n` +
        `${dim(`Deliveries stop until you re-enable: floe webhooks enable ${webhook.id}`)}\n`,
    );
  }
}

export async function webhooksDeleteCommand(id: string, flags: WebhooksFlags): Promise<void> {
  const { api } = await devContext(flags);
  await confirmAction(`delete webhook ${id}`, id, { yes: flags.yes });
  await withWebhook(id, api.dev<{ message: string }>('DELETE', `/v1/developer/webhooks/${id}`));

  if (flags.json) return printJson({ deleted: true, id: Number(id) });
  process.stdout.write(`${ok(`Webhook ${bold(id)} deleted — all deliveries stopped.`)}\n`);
}

export async function webhooksTestCommand(id: string, flags: WebhooksFlags): Promise<void> {
  const { api } = await devContext(flags);
  const result = await withWebhook(
    id,
    api.dev<DispatchOutcome>('POST', `/v1/developer/webhooks/${id}/test`, {}),
  );
  printDispatch('Test event', result, flags.json === true);
}

export async function webhooksRotateSecretCommand(id: string, flags: WebhooksFlags): Promise<void> {
  const { api } = await devContext(flags);
  const { secret } = await withWebhook(
    id,
    api.dev<{ secret: string }>('POST', `/v1/developer/webhooks/${id}/rotate-secret`, {}),
  );

  if (flags.json) {
    // Shown exactly once — the old secret already stopped verifying server-side.
    return printJson({ rotated: true, id: Number(id), secret });
  }
  process.stdout.write(
    `${ok(`Secret rotated for webhook ${bold(id)}.`)}\n` +
      `${dim('The old secret stops verifying immediately — update your endpoint now.')}\n`,
  );
  printSecretOnce(secret);
}

export async function webhooksDeliveriesCommand(id: string, flags: WebhooksFlags): Promise<void> {
  const { api } = await devContext(flags);

  if (flags.retry) {
    if (flags.limit !== undefined) {
      throw new UsageError('--limit does not apply to --retry; pass one or the other.');
    }
    const result = await withWebhook(
      id,
      api.dev<DispatchOutcome>(
        'POST',
        `/v1/developer/webhooks/${id}/deliveries/${encodeURIComponent(flags.retry)}/retry`,
      ),
    );
    printDispatch('Retry', result, flags.json === true);
    return;
  }

  const limit = flags.limit ? parseLimit(flags.limit) : undefined;
  const { deliveries } = await withWebhook(
    id,
    api.dev<{ deliveries: DeliveryView[] }>(
      'GET',
      `/v1/developer/webhooks/${id}/deliveries${limit !== undefined ? `?limit=${limit}` : ''}`,
    ),
  );
  const effectiveLimit = limit ?? 50; // API default page size

  if (flags.json) return printJson({ webhookId: Number(id), limit: effectiveLimit, deliveries });

  if (deliveries.length === 0) {
    process.stdout.write(
      `No deliveries yet for webhook ${id}. Send one: ${bold(`floe webhooks test ${id}`)}\n`,
    );
    return;
  }
  const rows = deliveries.map((d) => [
    sanitizeText(d.deliveryId),
    sanitizeText(d.event),
    d.status === 'success' ? green('success') : red(sanitizeText(d.status)),
    d.statusCode !== null && d.statusCode !== undefined ? String(d.statusCode) : '—',
    String(d.attempt),
    d.createdAt ? d.createdAt.slice(0, 16).replace('T', ' ') : '—',
  ]);
  process.stdout.write(`${table(['DELIVERY', 'EVENT', 'STATUS', 'HTTP', 'ATTEMPT', 'AT'], rows)}\n`);
  if (deliveries.length >= effectiveLimit) {
    process.stdout.write(
      `${dim(`Showing ${deliveries.length} — older deliveries may exist; raise --limit (max 100).`)}\n`,
    );
  }
  process.stdout.write(`${dim(`Re-send one: floe webhooks deliveries ${id} --retry <deliveryId>`)}\n`);
}

/** Validate every logs filter and build the query — before any I/O. */
function buildLogsQuery(flags: WebhooksFlags): URLSearchParams {
  const query = new URLSearchParams();
  if (flags.endpoint !== undefined) {
    if (!/^\d+$/.test(flags.endpoint)) {
      throw new UsageError(
        `--endpoint takes the numeric webhook id (got "${flags.endpoint}") — see \`floe webhooks list\`.`,
      );
    }
    query.set('endpoint', flags.endpoint);
  }
  if (flags.event !== undefined) {
    if (!(ALLOWED_EVENTS as readonly string[]).includes(flags.event)) {
      throw new UsageError(
        `Unknown --event "${flags.event}". Live catalog: floe webhooks events`,
      );
    }
    query.set('event', flags.event);
  }
  if (flags.agent !== undefined) {
    if (!WALLET_ADDRESS.test(flags.agent)) {
      throw new UsageError(`--agent takes an agent wallet address (0x…, got "${flags.agent}").`);
    }
    query.set('agent', flags.agent);
  }
  if (flags.status !== undefined) {
    if (!(DELIVERY_STATUSES as readonly string[]).includes(flags.status)) {
      throw new UsageError(
        `Unknown --status "${flags.status}". Supported: ${DELIVERY_STATUSES.join(', ')}.`,
      );
    }
    query.set('status', flags.status);
  }
  for (const [name, raw] of [
    ['from', flags.from],
    ['to', flags.to],
  ] as const) {
    if (raw !== undefined) {
      const parsed = Date.parse(raw);
      if (Number.isNaN(parsed)) {
        throw new UsageError(`--${name} must be an ISO 8601 timestamp (got "${raw}").`);
      }
      query.set(name, new Date(parsed).toISOString());
    }
  }
  // Opaque server-side matcher: a session/correlation id or a delivery id.
  if (flags.id !== undefined) query.set('id', flags.id);
  if (flags.cursor !== undefined) query.set('cursor', flags.cursor);
  if (flags.limit !== undefined) query.set('limit', String(parseLimit(flags.limit)));
  return query;
}

export async function webhooksLogsCommand(flags: WebhooksFlags): Promise<void> {
  const query = buildLogsQuery(flags); // validation precedes I/O
  const { api } = await devContext(flags);
  const qs = query.toString();
  const feed = await api.dev<AccountDeliveriesResponse>(
    'GET',
    `/v1/developer/webhook-deliveries${qs ? `?${qs}` : ''}`,
  );

  if (flags.json) {
    return printJson({ deliveries: feed.deliveries, nextCursor: feed.nextCursor, hasMore: feed.hasMore });
  }

  if (feed.deliveries.length === 0) {
    process.stdout.write(
      `No deliveries found. Widen the filters, or send a test event: ${bold('floe webhooks test <id>')}\n`,
    );
    return;
  }
  const rows = feed.deliveries.map((d) => [
    d.createdAt ? d.createdAt.slice(0, 16).replace('T', ' ') : '—',
    d.webhookId !== null && d.webhookId !== undefined
      ? `#${d.webhookId}`
      : d.webhookUrl
        ? sanitizeText(d.webhookUrl)
        : '—',
    sanitizeText(d.event),
    d.correlationId
      ? sanitizeText(d.correlationId)
      : d.agentWallet
        ? shortWallet(sanitizeText(d.agentWallet))
        : '—',
    String(d.attempt),
    d.statusCode !== null && d.statusCode !== undefined ? String(d.statusCode) : '—',
    d.status === 'success' ? green('success') : red(sanitizeText(d.status)),
  ]);
  process.stdout.write(
    `${table(['AT', 'ENDPOINT', 'EVENT', 'AGENT/SESSION', 'ATTEMPT', 'HTTP', 'STATUS'], rows)}\n`,
  );
  // No auto-follow: the caller decides whether to page — unbounded loops break scripts.
  if (feed.hasMore && feed.nextCursor) {
    // Repeat the active filters in the hint — a bare --cursor would silently
    // continue into the UNFILTERED account-wide log.
    const repeatFlags = [...query.entries()]
      .filter(([name]) => name !== 'cursor')
      .map(([name, value]) => `--${name} ${sanitizeText(value)} `)
      .join('');
    process.stdout.write(
      `${dim(`More available — next page: floe webhooks logs ${repeatFlags}--cursor ${sanitizeText(feed.nextCursor)}`)}\n`,
    );
  }
  process.stdout.write(
    `${dim('Re-send a delivery: floe webhooks deliveries <endpoint> --retry <deliveryId> (ids via --json)')}\n`,
  );
}

export const webhooksDef: CommandDef = {
  name: 'webhooks',
  summary: 'list | create | events | get | pause | enable | delete | test | rotate-secret | deliveries | logs',
  usage: `Usage: floe webhooks [list]
       floe webhooks create <url> --events <e1,e2,…> [--scope global|wallet|agent|loan --scope-value <v>] [--description <text>]
       floe webhooks events
       floe webhooks get <id>
       floe webhooks pause <id> | enable <id>
       floe webhooks delete <id>
       floe webhooks test <id>
       floe webhooks rotate-secret <id>
       floe webhooks deliveries <id> [--limit <1-100>] [--retry <deliveryId>]
       floe webhooks logs [--endpoint <id>] [--event <event>] [--agent <0x…>]
                          [--status <status>] [--from <iso>] [--to <iso>]
                          [--id <search>] [--limit <1-100>] [--cursor <cursor>]

Signed event deliveries to your endpoint (HMAC-SHA256 over "<timestamp>.<body>",
headers X-Floe-Signature / X-Floe-Timestamp / X-Floe-Delivery-Id).

  list                 All webhooks on your developer account (max 10)
  create <url>         Register an endpoint — the whsec_… signing secret is
                       shown exactly once at creation
  events               The live event catalog (category, name, description)
  get <id>             One webhook + delivery success/failure counts
  pause | enable <id>  Toggle deliveries without losing the endpoint config
  delete <id>          Remove the webhook and stop all deliveries
  test <id>            Send a signed test event; exits 1 if the delivery fails
  rotate-secret <id>   Mint a new whsec_… (shown once) — the old secret stops
                       verifying immediately
  deliveries <id>      Recent delivery attempts; --retry <deliveryId> re-sends
                       one with a fresh signature (exits 1 on failure)
  logs                 Account-wide delivery log across all webhooks, newest
                       first; --id matches a session or delivery id; paginate
                       with --cursor (no auto-follow)

Events (--events, comma-separated; '*' or '<prefix>.*' wildcards, e.g. call.*,
also accepted; live list: floe webhooks events):
${EVENT_HELP_LINES}

Scopes: global (default) · wallet --scope-value 0x… · agent --scope-value 0x…
        loan --scope-value <loanId>
`,
  options: {
    events: { type: 'string' },
    scope: { type: 'string' },
    'scope-value': { type: 'string' },
    description: { type: 'string' },
    limit: { type: 'string' },
    retry: { type: 'string' },
    endpoint: { type: 'string' },
    event: { type: 'string' },
    agent: { type: 'string' },
    status: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    id: { type: 'string' },
    cursor: { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: WebhooksFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      yes: ctx.yes,
      events: str(ctx, 'events'),
      scope: str(ctx, 'scope'),
      scopeValue: str(ctx, 'scope-value'),
      description: str(ctx, 'description'),
      limit: str(ctx, 'limit'),
      retry: str(ctx, 'retry'),
      endpoint: str(ctx, 'endpoint'),
      event: str(ctx, 'event'),
      agent: str(ctx, 'agent'),
      status: str(ctx, 'status'),
      from: str(ctx, 'from'),
      to: str(ctx, 'to'),
      id: str(ctx, 'id'),
      cursor: str(ctx, 'cursor'),
    };
    if (subcommand === undefined || subcommand === 'list') {
      expectArgs(ctx, 1);
      await webhooksListCommand(flags);
    } else if (subcommand === 'create') {
      if (!arg) {
        throw new UsageError(
          'Usage: floe webhooks create <url> --events <e1,e2,…> [--scope global|wallet|agent|loan --scope-value <v>]',
        );
      }
      expectArgs(ctx, 2);
      await webhooksCreateCommand(arg, flags);
    } else if (subcommand === 'events') {
      expectArgs(ctx, 1);
      await webhooksEventsCommand(flags);
    } else if (subcommand === 'get') {
      expectArgs(ctx, 2);
      await webhooksGetCommand(requireWebhookId(arg, 'get'), flags);
    } else if (subcommand === 'pause') {
      expectArgs(ctx, 2);
      await webhooksSetActiveCommand(requireWebhookId(arg, 'pause'), false, flags);
    } else if (subcommand === 'enable') {
      expectArgs(ctx, 2);
      await webhooksSetActiveCommand(requireWebhookId(arg, 'enable'), true, flags);
    } else if (subcommand === 'delete') {
      expectArgs(ctx, 2);
      await webhooksDeleteCommand(requireWebhookId(arg, 'delete'), flags);
    } else if (subcommand === 'test') {
      expectArgs(ctx, 2);
      await webhooksTestCommand(requireWebhookId(arg, 'test'), flags);
    } else if (subcommand === 'rotate-secret') {
      expectArgs(ctx, 2);
      await webhooksRotateSecretCommand(requireWebhookId(arg, 'rotate-secret'), flags);
    } else if (subcommand === 'deliveries') {
      expectArgs(ctx, 2);
      await webhooksDeliveriesCommand(requireWebhookId(arg, 'deliveries'), flags);
    } else if (subcommand === 'logs') {
      expectArgs(ctx, 1);
      await webhooksLogsCommand(flags);
    } else {
      throw new UsageError(
        `Unknown webhooks subcommand "${subcommand}". Use: list, create, events, get, pause, enable, delete, test, rotate-secret, deliveries, logs.`,
      );
    }
  },
};
