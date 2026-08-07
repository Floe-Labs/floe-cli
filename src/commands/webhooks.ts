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

/** Mirrors the API's allowed webhook events — typos fail before I/O. */
const ALLOWED_EVENTS = [
  'loan.health_warning',
  'loan.expiry_warning',
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
] as const;

const ALLOWED_SCOPES = ['global', 'wallet', 'loan'] as const;

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
}

function requireWebhookId(raw: string | undefined, verb: string): string {
  if (!raw) throw new UsageError(`Usage: floe webhooks ${verb} <id>`);
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`Webhook id must be numeric (got "${raw}") — see \`floe webhooks list\`.`);
  }
  return raw;
}

/** The API's bare 404 body is just {error:"Not found"} — name the webhook instead. */
async function withWebhook<T>(id: string, call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new ApiError(`Webhook ${id} not found.`, 404, err.code, 'List webhooks with `floe webhooks list`.');
    }
    throw err;
  }
}

function parseEvents(raw: string | undefined): string[] {
  if (!raw) {
    throw new UsageError(
      `create requires --events <e1,e2,…>. Valid events:\n  ${ALLOWED_EVENTS.join('\n  ')}`,
    );
  }
  const events = [...new Set(raw.split(',').map((e) => e.trim()).filter(Boolean))];
  if (events.length === 0) throw new UsageError('--events must name at least one event.');
  const unknown = events.filter((e) => !(ALLOWED_EVENTS as readonly string[]).includes(e));
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown event(s): ${unknown.join(', ')}. Valid events:\n  ${ALLOWED_EVENTS.join('\n  ')}`,
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
  try {
    new URL(url);
  } catch {
    throw new UsageError(`Invalid webhook URL "${url}".`);
  }
  const events = parseEvents(flags.events);
  const scope = flags.scope ?? 'global';
  const scopeValue = flags.scopeValue;
  if (!(ALLOWED_SCOPES as readonly string[]).includes(scope)) {
    throw new UsageError(`Unknown --scope "${scope}". Supported: global, wallet, loan.`);
  }
  if (scope === 'global' && scopeValue) {
    throw new UsageError('--scope global does not take a --scope-value.');
  }
  if (scope === 'wallet' && (!scopeValue || !/^0x[a-fA-F0-9]{40}$/.test(scopeValue))) {
    throw new UsageError('--scope wallet requires --scope-value <0x… Ethereum address>.');
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

  const stats = Object.entries(deliveryStats);
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
    const result = await api.dev<DispatchOutcome>(
      'POST',
      `/v1/developer/webhooks/${id}/deliveries/${encodeURIComponent(flags.retry)}/retry`,
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

export const webhooksDef: CommandDef = {
  name: 'webhooks',
  summary: 'list | create | get | pause | enable | delete | test | rotate-secret | deliveries',
  usage: `Usage: floe webhooks [list]
       floe webhooks create <url> --events <e1,e2,…> [--scope global|wallet|loan --scope-value <v>] [--description <text>]
       floe webhooks get <id>
       floe webhooks pause <id> | enable <id>
       floe webhooks delete <id>
       floe webhooks test <id>
       floe webhooks rotate-secret <id>
       floe webhooks deliveries <id> [--limit <1-100>] [--retry <deliveryId>]

Signed event deliveries to your endpoint (HMAC-SHA256 over "<timestamp>.<body>",
headers X-Floe-Signature / X-Floe-Timestamp / X-Floe-Delivery-Id).

  list                 All webhooks on your developer account (max 10)
  create <url>         Register an endpoint — the whsec_… signing secret is
                       shown exactly once at creation
  get <id>             One webhook + delivery success/failure counts
  pause | enable <id>  Toggle deliveries without losing the endpoint config
  delete <id>          Remove the webhook and stop all deliveries
  test <id>            Send a signed test event; exits 1 if the delivery fails
  rotate-secret <id>   Mint a new whsec_… (shown once) — the old secret stops
                       verifying immediately
  deliveries <id>      Recent delivery attempts; --retry <deliveryId> re-sends
                       one with a fresh signature (exits 1 on failure)

Events (--events, comma-separated):
  loan.health_warning  loan.expiry_warning  loan.liquidated  loan.repaid
  agent.created  agent.suspended  key.created  key.rotated
  x402.first_settlement  provider_key.created  provider_key.updated
  provider_key.deleted

Scopes: global (default) · wallet --scope-value 0x… · loan --scope-value <loanId>
`,
  options: {
    events: { type: 'string' },
    scope: { type: 'string' },
    'scope-value': { type: 'string' },
    description: { type: 'string' },
    limit: { type: 'string' },
    retry: { type: 'string' },
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
    };
    if (subcommand === undefined || subcommand === 'list') {
      expectArgs(ctx, 1);
      await webhooksListCommand(flags);
    } else if (subcommand === 'create') {
      if (!arg) {
        throw new UsageError(
          'Usage: floe webhooks create <url> --events <e1,e2,…> [--scope global|wallet|loan --scope-value <v>]',
        );
      }
      expectArgs(ctx, 2);
      await webhooksCreateCommand(arg, flags);
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
    } else {
      throw new UsageError(
        `Unknown webhooks subcommand "${subcommand}". Use: list, create, get, pause, enable, delete, test, rotate-secret, deliveries.`,
      );
    }
  },
};
