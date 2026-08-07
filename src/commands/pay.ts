import { readFileSync } from 'node:fs';
import { ApiError, FloeApi } from '../lib/api.js';
import { expectArgs, flag, str, type CommandDef } from '../lib/command.js';
import { readConfig, resolveApiUrl } from '../lib/config.js';
import { agentContext } from '../lib/context.js';
import { resolveAgentKey } from '../lib/keychain.js';
import { bold, cyan, dim, kv, ok, printJson, sanitizeText, UsageError } from '../lib/output.js';
import { rawToUsd } from '../lib/usdc.js';
import { cliVersion } from '../lib/version.js';
import { readStdin } from './chat.js';

/**
 * The x402 metered proxy: POST /v1/proxy/fetch relays the call, fronts the
 * payment when the vendor answers 402, and reports the all-in charge in
 * X-Floe-Cost-USDC. Idempotency-Key / X-Floe-Task-Id / X-Floe-Action-Id ride
 * as HEADERS on the proxy request (the body carries only url/method/headers/
 * body) — FloeApi has no per-request header hook, so this command performs
 * its own fetch with the same credential, User-Agent, and error conventions.
 *
 * Response semantics, from the proxy source: a relayed upstream response —
 * any status — always carries X-Floe-Payment (paid | passthrough); the
 * proxy's own refusals (insufficient funds, blocked destination, policy)
 * never do. So: marker present → print upstream status + body + cost;
 * marker absent and not ok → ApiError (a 402 exits 5).
 */

// Mirrors ALLOWED_METHODS in the proxy route.
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/** Human mode truncates huge vendor bodies; --json always passes them through. */
const MAX_HUMAN_BODY = 2_000;

interface CheckResponse {
  x402: boolean;
  status: number;
  message?: string;
  x402Version?: number;
  payment?: { amount: string; asset: string; payTo: string; network: string };
}

export interface PayFlags {
  apiUrl?: string;
  json?: boolean;
  method?: string;
  data?: string;
  headers: string[];
  task?: string;
  action?: string;
  idempotencyKey?: string;
  check?: boolean;
}

function parseHeaderFlags(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf(':');
    if (idx <= 0) {
      throw new UsageError(`Invalid --header "${pair}" — use the form "Name: value".`);
    }
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) throw new UsageError(`Invalid --header "${pair}" — the header name is empty.`);
    out[name] = value;
  }
  return out;
}

async function resolveData(data: string | undefined): Promise<string | undefined> {
  if (data === undefined) return undefined;
  if (data === '-') return readStdin('request body');
  if (data.startsWith('@')) {
    const path = data.slice(1);
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new UsageError(
        `Cannot read --data file "${path}" — ${code === 'ENOENT' ? 'no such file' : (err as Error).message}.`,
      );
    }
  }
  return data;
}

async function checkCommand(url: string, flags: PayFlags): Promise<void> {
  // The pre-flight probe is unauthenticated (rate-limited by IP) — it works
  // signed-out, so resolve the API URL without demanding a credential.
  const apiUrl = resolveApiUrl(flags.apiUrl, readConfig());
  const api = new FloeApi(apiUrl);
  const result = await api.public<CheckResponse>(
    'GET',
    `/v1/proxy/check?url=${encodeURIComponent(url)}`,
  );

  if (flags.json) return printJson(result);

  if (!result.x402) {
    process.stdout.write(
      `${ok(`No x402 payment required (upstream answered ${result.status})`)}\n`,
    );
    process.stdout.write(`${dim('floe pay would relay this call as a free passthrough.')}\n`);
    return;
  }
  if (!result.payment) {
    process.stdout.write(
      `${sanitizeText(result.message ?? 'The URL returned 402 but its payment terms could not be read.')}\n`,
    );
    return;
  }
  process.stdout.write(`${ok(`x402 payment required — ${bold(rawToUsd(result.payment.amount))} per call`)}\n`);
  const rows: Array<[string, string]> = [
    ['price', bold(rawToUsd(result.payment.amount))],
    ['pay to', sanitizeText(result.payment.payTo)],
    ['network', sanitizeText(result.payment.network)],
    ['asset', sanitizeText(result.payment.asset)],
  ];
  process.stdout.write(`${kv(rows)}\n`);
}

/** Mirror of FloeApi's error mapping for the one route it cannot serve. */
async function proxyRefusal(res: Response): Promise<ApiError> {
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  let hint: string | undefined;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const err = body.error;
    if (typeof err === 'string') {
      code = err;
      message = typeof body.message === 'string' ? body.message : err;
    } else if (err && typeof err === 'object') {
      const oai = err as Record<string, unknown>;
      if (typeof oai.message === 'string') message = oai.message;
      if (typeof oai.code === 'string') code = oai.code;
    }
    const next = body.next as Record<string, unknown> | undefined;
    if (next && typeof next.hint === 'string') hint = next.hint;
  } catch {
    // Non-JSON refusal body — keep the status-line message.
  }
  if (res.status === 429 && !hint) {
    const retryAfter = res.headers.get('Retry-After');
    hint = retryAfter ? `Rate limited — retry in ${retryAfter}s.` : 'Rate limited — retry shortly.';
  }
  return new ApiError(message, res.status, code, hint);
}

export async function payCommand(url: string, flags: PayFlags): Promise<void> {
  // Validation precedes I/O.
  try {
    new URL(url);
  } catch {
    throw new UsageError(`Invalid URL "${url}".`);
  }

  if (flags.check) return checkCommand(url, flags);

  const extraHeaders = parseHeaderFlags(flags.headers);
  const method = (flags.method ?? (flags.data !== undefined ? 'POST' : 'GET')).toUpperCase();
  if (!METHODS.has(method)) {
    throw new UsageError(
      `Unsupported method "${method}". The proxy allows: ${[...METHODS].join(', ')}.`,
    );
  }
  const data = await resolveData(flags.data);

  // agentContext validates the credential exists (same 401 as every agent
  // command); the raw key is then re-resolved for the manual fetch below.
  const { apiUrl, config } = await agentContext(flags);
  const agentKey = await resolveAgentKey(apiUrl, config.activeAgentId, config);
  if (!agentKey) {
    throw new ApiError(
      'No agent key found. Run `floe init` first (or set FLOE_AGENT_KEY).',
      401,
      'missing_credential',
    );
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${agentKey}`,
    'Content-Type': 'application/json',
    'User-Agent': `floe-cli/${cliVersion()}`,
  };
  if (flags.idempotencyKey !== undefined) headers['Idempotency-Key'] = flags.idempotencyKey;
  if (flags.task !== undefined) headers['X-Floe-Task-Id'] = flags.task;
  if (flags.action !== undefined) headers['X-Floe-Action-Id'] = flags.action;

  const proxyBody: Record<string, unknown> = { url, method };
  if (Object.keys(extraHeaders).length > 0) proxyBody.headers = extraHeaders;
  if (data !== undefined) proxyBody.body = data;

  let res: Response;
  try {
    res = await fetch(`${apiUrl}/v1/proxy/fetch`, {
      method: 'POST',
      headers,
      body: JSON.stringify(proxyBody),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'failed';
    throw new ApiError(`Request to ${apiUrl}/v1/proxy/fetch ${reason}: ${(err as Error).message}`, 0);
  }

  const payment = res.headers.get('X-Floe-Payment');
  if (!payment && !res.ok) throw await proxyRefusal(res);

  const costRaw = res.headers.get('X-Floe-Cost-USDC') ?? '0';
  const replayed = res.headers.get('X-Floe-Idempotent-Replay') === 'true';
  const text = await res.text();

  if (flags.json) {
    let parsedBody: unknown = text;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      // Not JSON — pass the raw string through.
    }
    return printJson({
      status: res.status,
      payment: payment ?? null,
      replayed,
      costRaw,
      costUsd: rawToUsd(costRaw),
      body: parsedBody,
    });
  }

  const paidNote = payment === 'paid' ? `paid ${rawToUsd(costRaw)}` : `passthrough, ${rawToUsd(costRaw)}`;
  process.stdout.write(`${ok(`${bold(String(res.status))} from ${cyan(sanitizeText(new URL(url).host))} (${paidNote})`)}\n`);
  if (replayed) process.stdout.write(`${dim('idempotent replay — served from the proxy cache, not re-charged')}\n`);
  const shown = text.length > MAX_HUMAN_BODY ? text.slice(0, MAX_HUMAN_BODY) : text;
  if (shown) process.stdout.write(`${sanitizeText(shown)}\n`);
  if (text.length > MAX_HUMAN_BODY) {
    process.stdout.write(
      `${dim(`(truncated — ${MAX_HUMAN_BODY} of ${text.length} chars shown; use --json for the full body)`)}\n`,
    );
  }
}

export const payDef: CommandDef = {
  name: 'pay',
  summary: 'Call any x402 vendor through the metered proxy',
  usage: `Usage: floe pay <url> [flags]

Call an x402 vendor through the metered proxy: Floe fronts the payment when
the vendor answers 402, relays the response, and prints the upstream status,
body, and all-in cost (X-Floe-Cost-USDC). Free URLs pass through at $0.

Flags:
  --check                  Pre-flight only: report whether the URL requires
                           x402 payment and its price (unauthenticated, free)
  --method <verb>          HTTP method: GET, POST, PUT, PATCH, DELETE, HEAD
                           (default GET, or POST when --data is given)
  --data <json|@file|->    Request body: inline string, @file, or "-" (stdin)
  --header "K: V"          Header forwarded to the vendor (repeatable)
  --task <id>              Attribute spend to a task (X-Floe-Task-Id)
  --action <id>            Attribute spend to an action (X-Floe-Action-Id)
  --idempotency-key <k>    Safe-retry key — a replay returns the cached
                           response instead of paying twice
`,
  options: {
    check: { type: 'boolean' },
    method: { type: 'string' },
    data: { type: 'string' },
    header: { type: 'string', multiple: true },
    task: { type: 'string' },
    action: { type: 'string' },
    'idempotency-key': { type: 'string' },
  },
  run: async (ctx) => {
    const [url] = ctx.args;
    if (!url) throw new UsageError('Usage: floe pay <url> [flags] — run `floe help pay`.');
    expectArgs(ctx, 1);
    const headerValues = ctx.values.header;
    await payCommand(url, {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      method: str(ctx, 'method'),
      data: str(ctx, 'data'),
      headers: Array.isArray(headerValues)
        ? headerValues.filter((v): v is string => typeof v === 'string')
        : [],
      task: str(ctx, 'task'),
      action: str(ctx, 'action'),
      idempotencyKey: str(ctx, 'idempotency-key'),
      check: flag(ctx, 'check'),
    });
  },
};
