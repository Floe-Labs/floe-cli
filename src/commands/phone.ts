import { ApiError, type FloeApi } from '../lib/api.js';
import { expectArgs, flag, str, type CommandDef } from '../lib/command.js';
import type { AgentEntry } from '../lib/config.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext, requireActiveAgent, resolveAgentRef, type DevContext } from '../lib/context.js';
import { bold, dim, green, kv, ok, printJson, sanitizeText, UsageError, yellow } from '../lib/output.js';
import { isInteractive } from '../lib/prompt.js';
import { table } from '../lib/table.js';
import { rawToUsd } from '../lib/usdc.js';

/**
 * Floe Phone — number provisioning + telephony on the developer plane,
 * covering both the per-agent surface and the account-wide fleet view.
 */

export interface PhoneFlags {
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
  agent?: string;
  areaCode?: string;
  number?: string;
  all?: boolean;
  limit?: string;
  days?: string;
  to?: string;
  mode?: string;
  prompt?: string;
  greeting?: string;
  voice?: string;
  model?: string;
  webhookUrl?: string;
}

/** Phone-number shape as serialized by the API. */
interface PhoneNumberView {
  id: number;
  phoneNumber: string;
  status: string;
  areaCode: string | null;
  monthlyRentalRaw: string;
  nextRenewalAt: string | null;
  graceUntil: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  createdAt: string;
}

/** GET .../numbers/search result rows (carrier availability). */
interface AvailableNumberView {
  phoneNumber: string;
  friendlyName: string;
  locality: string | null;
  region: string | null;
}

/** GET /v1/developer/phone/numbers fleet rows (console-gaps/fleet.ts). */
interface FleetNumberView {
  number: string;
  agentId: number;
  agentName: string;
  status: string;
  calls7d: number;
  spendMtdRaw: string;
}

/** GET .../numbers/:numberId/calls rows (carrier call history). */
interface CallView {
  id: string;
  direction: string;
  from: string;
  to: string;
  status: string;
  durationSeconds: number;
  startedAt: string | null;
  endedAt: string | null;
}

/** GET .../numbers/:numberId/usage — ledger telephony spend. */
interface NumberUsageResponse {
  number: { id: number; phoneNumber: string };
  days: number;
  totalRaw: string;
  daily: Array<{ day: string; totalRaw: string; requests: number }>;
}

/** GET|PATCH /v1/developer/agents/:id/voice. */
interface VoiceSettings {
  voiceMode: 'hosted' | 'webhook';
  voiceConfig: {
    systemPrompt?: string;
    beginMessage?: string;
    voice?: string;
    model?: string;
    webhookUrl?: string;
  };
}

interface TestCallResponse {
  callId: string;
  from: string;
  to: string;
  status: string;
}

interface CapabilitiesResponse {
  capabilities?: { telephony?: boolean };
}

/**
 * The agent a subcommand targets: --agent resolves against the fleet by
 * id-then-name; omitted → this machine's active agent straight from config
 * (no network round-trip). Same pattern as keys.ts.
 */
async function targetAgent(
  ctx: DevContext,
  ref: string | undefined,
): Promise<{ id: string } & AgentEntry> {
  if (!ref) return requireActiveAgent(ctx.config);
  const agent = await resolveAgentRef(ctx, ref);
  return { ...ctx.config.agents?.[agent.id], id: String(agent.id), name: agent.name };
}

/**
 * Phone routes 503 when the API deployment has no telephony configured
 * (missing carrier credentials, unseeded floe/phone rates, or media gateway
 * off). Translate that into a clear note; the public capabilities probe
 * confirms whether the surface is off deliberately.
 */
async function withTelephony<T>(api: FloeApi, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) {
      let message = 'Floe Phone is not configured on this API deployment.';
      try {
        const caps = await api.public<CapabilitiesResponse>('GET', '/v1/capabilities');
        if (caps.capabilities?.telephony === false) {
          message =
            'This API deployment has telephony disabled (GET /v1/capabilities reports telephony: false).';
        } else if (caps.capabilities?.telephony === true) {
          message =
            'Live calling is enabled but number provisioning is not fully configured on this deployment (carrier credentials or phone rates missing).';
        }
      } catch {
        // Best-effort probe — the 503 explanation stands on its own.
      }
      throw new ApiError(message, 503, err.code ?? 'telephony_unavailable',
        'Point --api-url at a deployment with Floe Phone enabled (production has it).');
    }
    throw err;
  }
}

const US_AREA_CODE = /^[2-9]\d{2}$/;
const US_E164 = /^\+1\d{10}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

function requireAreaCode(raw: string): void {
  if (!US_AREA_CODE.test(raw)) {
    throw new UsageError(`Invalid US area code "${raw}" — 3 digits, 2xx–9xx (e.g. 415).`);
  }
}

function requireNumberId(raw: string): void {
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(
      `Invalid number id "${raw}" — number ids are numeric (see \`floe phone list --json\`).`,
    );
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new UsageError('--limit must be an integer between 1 and 100.');
  }
  return n;
}

function parseDays(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    throw new UsageError('--days must be an integer between 1 and 365.');
  }
  return n;
}

const date = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '—');

/** Carrier timestamps come back in mixed formats (ISO or RFC2822) — normalize. */
function callTime(raw: string | null): string {
  if (!raw) return '—';
  const d = new Date(raw);
  return Number.isNaN(d.getTime())
    ? sanitizeText(raw)
    : d.toISOString().replace('T', ' ').slice(0, 16);
}

function statusCell(status: string): string {
  const s = sanitizeText(status);
  if (s === 'active') return green(s);
  if (s === 'released') return dim(s);
  return yellow(s);
}

const clip = (s: string, max = 80): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// ── search ────────────────────────────────────────────────────────────────

export async function phoneSearchCommand(flags: PhoneFlags): Promise<void> {
  if (flags.areaCode !== undefined) requireAreaCode(flags.areaCode);
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  const query = flags.areaCode !== undefined ? `?areaCode=${flags.areaCode}` : '';
  const { numbers } = await withTelephony(ctx.api, () =>
    ctx.api.dev<{ numbers: AvailableNumberView[] }>(
      'GET',
      `/v1/developer/agents/${agent.id}/numbers/search${query}`,
    ),
  );

  if (flags.json) return printJson({ agentId: agent.id, numbers });

  if (numbers.length === 0) {
    process.stdout.write(
      `No purchasable numbers found${flags.areaCode ? ` in area code ${flags.areaCode}` : ''} — try another area code.\n`,
    );
    return;
  }
  process.stdout.write(
    `${bold(`Available US numbers — agent "${sanitizeText(agent.name ?? agent.id)}"`)}\n`,
  );
  const rows = numbers.map((n) => [
    sanitizeText(n.phoneNumber),
    sanitizeText(n.friendlyName),
    [n.locality, n.region].filter((p): p is string => Boolean(p)).map(sanitizeText).join(', ') ||
      dim('—'),
  ]);
  process.stdout.write(`${table(['Number', 'Friendly name', 'Location'], rows)}\n`);
  process.stdout.write(`${dim('Buy one exactly: floe phone buy --number <e164>')}\n`);
}

// ── buy ───────────────────────────────────────────────────────────────────

export async function phoneBuyCommand(flags: PhoneFlags): Promise<void> {
  // Validation precedes I/O.
  if (flags.number !== undefined && flags.areaCode !== undefined) {
    throw new UsageError('Pass --number <e164> (exact, from search) OR --area-code <c>, not both.');
  }
  // The carrier picks a number by area code or exact E.164 — there is no
  // "any US number" purchase (the API refuses with 400 area_code_required).
  if (flags.number === undefined && flags.areaCode === undefined) {
    throw new UsageError(
      'An area code is required: pass --area-code <c> (3-digit US area code, e.g. 415), or --number <e164> from `floe phone search`.',
    );
  }
  if (flags.number !== undefined && !US_E164.test(flags.number)) {
    throw new UsageError(
      `Invalid --number "${flags.number}" — US E.164, e.g. +14155550123 (find one with \`floe phone search\`).`,
    );
  }
  if (flags.areaCode !== undefined) requireAreaCode(flags.areaCode);

  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  const agentName = agent.name ?? agent.id;
  const what = flags.number ?? `a number in area code ${flags.areaCode}`;
  // Money moves at purchase: the first month's rental is debited immediately.
  await confirmAction(
    `buy ${what} for agent "${agentName}" — the first month's rental debits the agent balance now`,
    flags.number ?? agentName,
    { yes: flags.yes },
  );

  const body: Record<string, unknown> = {};
  if (flags.number !== undefined) body.phoneNumber = flags.number;
  if (flags.areaCode !== undefined) body.areaCode = flags.areaCode;

  let res: Response;
  try {
    res = await withTelephony(ctx.api, () =>
      ctx.api.devRaw('POST', `/v1/developer/agents/${agent.id}/numbers`, body),
    );
  } catch (err) {
    // The shared error mapper already surfaces the phone routes' `detail`
    // sentence; the common codes get CLI-specific next steps on top.
    if (err instanceof ApiError && err.code === 'number_exists') {
      throw new ApiError(
        `Agent "${agentName}" already has a live phone number — one per agent. Release it first: floe phone release <numberId> (ids: \`floe phone list --json\`).`,
        err.status,
        err.code,
      );
    }
    if (err instanceof ApiError && err.code === 'no_numbers_available') {
      throw new ApiError(
        flags.number
          ? `${flags.number} is no longer available — run \`floe phone search\` again.`
          : `No US numbers available in area code ${flags.areaCode} — try another area code.`,
        err.status,
        err.code,
      );
    }
    if (err instanceof ApiError && err.code === 'insufficient_balance') {
      throw new ApiError(
        `The agent balance can't cover the first month's rental — fund agent "${agentName}", then retry.`,
        err.status,
        err.code,
      );
    }
    throw err;
  }
  const { number } = (await res.json()) as { number: PhoneNumberView };
  // The debit rides the response headers, like every metered call.
  const costRaw = res.headers.get('X-Floe-Cost-USDC') ?? '0';

  if (flags.json) {
    return printJson({ agentId: agent.id, number, costRaw, costUsd: rawToUsd(costRaw) });
  }
  process.stdout.write(
    `${ok(`Bought ${bold(sanitizeText(number.phoneNumber))} for agent "${sanitizeText(agentName)}" — ${bold(rawToUsd(costRaw))} first month`)}\n`,
  );
  const rows: Array<[string, string]> = [
    ['Number id', String(number.id)],
    ['Monthly rental', rawToUsd(number.monthlyRentalRaw)],
    ['Renews', date(number.nextRenewalAt)],
  ];
  process.stdout.write(`${kv(rows)}\n`);
  process.stdout.write(`${dim('Callers reach the agent now — tune it with: floe phone voice set')}\n`);
}

// ── list ──────────────────────────────────────────────────────────────────

export async function phoneListCommand(flags: PhoneFlags): Promise<void> {
  const ctx = await devContext(flags);

  if (flags.all) {
    // Fleet view: every live number you own + 7d calls + month-to-date spend.
    const { numbers } = await ctx.api.dev<{ numbers: FleetNumberView[] }>(
      'GET',
      '/v1/developer/phone/numbers',
    );
    if (flags.json) return printJson({ numbers });
    if (numbers.length === 0) {
      process.stdout.write(`No phone numbers across your fleet. Buy one: ${bold('floe phone buy')}\n`);
      return;
    }
    const rows = numbers.map((n) => [
      sanitizeText(n.number),
      sanitizeText(n.agentName),
      statusCell(n.status),
      String(n.calls7d),
      rawToUsd(n.spendMtdRaw),
    ]);
    process.stdout.write(`${bold('Fleet phone numbers')}\n`);
    process.stdout.write(
      `${table(['Number', 'Agent', 'Status', 'Calls (7d)', 'Spend (MTD)'], rows)}\n`,
    );
    return;
  }

  const agent = await targetAgent(ctx, flags.agent);
  const { numbers } = await ctx.api.dev<{ numbers: PhoneNumberView[] }>(
    'GET',
    `/v1/developer/agents/${agent.id}/numbers`,
  );
  if (flags.json) return printJson({ agentId: agent.id, numbers });
  if (numbers.length === 0) {
    process.stdout.write(
      `No phone numbers for agent "${sanitizeText(agent.name ?? agent.id)}". Buy one: ${bold('floe phone buy')}\n`,
    );
    return;
  }
  const rows = numbers.map((n) => [
    String(n.id),
    sanitizeText(n.phoneNumber),
    statusCell(n.status),
    n.status === 'released' ? dim(date(n.releasedAt)) : date(n.nextRenewalAt),
    rawToUsd(n.monthlyRentalRaw),
  ]);
  process.stdout.write(`${bold(`Phone numbers — ${sanitizeText(agent.name ?? agent.id)}`)}\n`);
  process.stdout.write(`${table(['ID', 'Number', 'Status', 'Renews/Released', 'Monthly'], rows)}\n`);
}

// ── release ───────────────────────────────────────────────────────────────

export async function phoneReleaseCommand(numberId: string, flags: PhoneFlags): Promise<void> {
  requireNumberId(numberId);
  // Releasing is irreversible, so the confirmation types the E.164 back —
  // which needs a read first. Refuse non-interactive callers BEFORE that
  // read so a script without --yes never touches the network.
  if (!flags.yes && !isInteractive()) {
    throw new UsageError(
      `Refusing to release number ${numberId} without confirmation — re-run with --yes.`,
    );
  }
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);

  let detail: { number: PhoneNumberView };
  try {
    detail = await ctx.api.dev<{ number: PhoneNumberView }>(
      'GET',
      `/v1/developer/agents/${agent.id}/numbers/${numberId}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new ApiError(
        `Number ${numberId} not found on agent "${agent.name ?? agent.id}" — list ids with \`floe phone list --json\`.`,
        404,
        'not_found',
      );
    }
    throw err;
  }
  const e164 = detail.number.phoneNumber;
  if (detail.number.status === 'released') {
    if (flags.json) {
      return printJson({ released: true, alreadyReleased: true, agentId: agent.id, number: detail.number });
    }
    process.stdout.write(`${sanitizeText(e164)} is already released — nothing to do.\n`);
    return;
  }

  const safeE164 = sanitizeText(e164);
  await confirmAction(
    `release ${safeE164} — IRREVERSIBLE, the number cannot be recovered`,
    safeE164,
    { yes: flags.yes },
  );
  const { number } = await ctx.api.dev<{ number: PhoneNumberView }>(
    'DELETE',
    `/v1/developer/agents/${agent.id}/numbers/${numberId}`,
  );

  if (flags.json) return printJson({ released: true, agentId: agent.id, number });
  process.stdout.write(
    `${ok(`Released ${bold(sanitizeText(number.phoneNumber))} — callers can no longer reach the agent on it.`)}\n`,
  );
  process.stdout.write(`${dim('Rental renewals stop; the number returns to the carrier pool.')}\n`);
}

// ── calls ─────────────────────────────────────────────────────────────────

export async function phoneCallsCommand(numberId: string, flags: PhoneFlags): Promise<void> {
  requireNumberId(numberId);
  const limit = parseLimit(flags.limit);
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  // The route returns the carrier's recent history without pagination
  // params — --limit trims client-side.
  const { calls } = await withTelephony(ctx.api, () =>
    ctx.api.dev<{ calls: CallView[] }>(
      'GET',
      `/v1/developer/agents/${agent.id}/numbers/${numberId}/calls`,
    ),
  );
  const shown = calls.slice(0, limit);

  if (flags.json) {
    return printJson({
      agentId: agent.id,
      numberId: Number(numberId),
      limit,
      count: shown.length,
      totalFetched: calls.length,
      calls: shown,
    });
  }
  if (shown.length === 0) {
    process.stdout.write(
      `No calls yet on number ${numberId}. Try: ${bold(`floe phone test-call ${numberId} --to <your-number>`)}\n`,
    );
    return;
  }
  const rows = shown.map((c) => [
    sanitizeText(c.direction),
    sanitizeText(c.from),
    sanitizeText(c.to),
    sanitizeText(c.status),
    `${c.durationSeconds}s`,
    callTime(c.startedAt),
  ]);
  process.stdout.write(`${table(['Direction', 'From', 'To', 'Status', 'Duration', 'Started'], rows)}\n`);
  if (calls.length > shown.length) {
    process.stdout.write(
      `${dim(`Showing ${shown.length} of ${calls.length} fetched — raise --limit for more.`)}\n`,
    );
  }
}

// ── usage ─────────────────────────────────────────────────────────────────

export async function phoneUsageCommand(numberId: string, flags: PhoneFlags): Promise<void> {
  requireNumberId(numberId);
  const days = parseDays(flags.days);
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  const query = days !== undefined ? `?days=${days}` : '';
  const usage = await withTelephony(ctx.api, () =>
    ctx.api.dev<NumberUsageResponse>(
      'GET',
      `/v1/developer/agents/${agent.id}/numbers/${numberId}/usage${query}`,
    ),
  );

  if (flags.json) return printJson({ agentId: agent.id, ...usage });

  process.stdout.write(
    `${bold(`Telephony spend — ${sanitizeText(usage.number.phoneNumber)} (last ${usage.days}d)`)}\n`,
  );
  process.stdout.write(`${kv([['Total', bold(rawToUsd(usage.totalRaw))]])}\n`);
  if (usage.daily.length > 0) {
    const rows = usage.daily.map((d) => [
      sanitizeText(d.day),
      rawToUsd(d.totalRaw),
      String(d.requests),
    ]);
    process.stdout.write(`${table(['Day', 'Spend', 'Charges'], rows)}\n`);
  } else {
    process.stdout.write(`${dim('No telephony charges in this window.')}\n`);
  }
}

// ── voice ─────────────────────────────────────────────────────────────────

function renderVoice(settings: VoiceSettings): string {
  const cfg = settings.voiceConfig ?? {};
  const rows: Array<[string, string]> = [
    [
      'Mode',
      settings.voiceMode === 'webhook'
        ? 'webhook — your backend answers each caller turn'
        : 'hosted — Floe runs the LLM leg',
    ],
    ['Prompt', cfg.systemPrompt ? clip(sanitizeText(cfg.systemPrompt)) : dim('(default)')],
    ['Greeting', cfg.beginMessage ? clip(sanitizeText(cfg.beginMessage)) : dim('(default)')],
    ['Voice', cfg.voice ? sanitizeText(cfg.voice) : dim('(default)')],
    ['Model', cfg.model ? sanitizeText(cfg.model) : dim('(default)')],
    ['Webhook URL', cfg.webhookUrl ? sanitizeText(cfg.webhookUrl) : dim('(not set)')],
  ];
  return kv(rows);
}

export async function phoneVoiceShowCommand(flags: PhoneFlags): Promise<void> {
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  const settings = await withTelephony(ctx.api, () =>
    ctx.api.dev<VoiceSettings>('GET', `/v1/developer/agents/${agent.id}/voice`),
  );
  if (flags.json) return printJson({ agentId: agent.id, ...settings });
  process.stdout.write(`${bold(`Voice settings — ${sanitizeText(agent.name ?? agent.id)}`)}\n`);
  process.stdout.write(`${renderVoice(settings)}\n`);
  process.stdout.write(`${dim('Change: floe phone voice set --mode hosted|webhook --prompt <p> …')}\n`);
}

export async function phoneVoiceSetCommand(flags: PhoneFlags): Promise<void> {
  // Field names verified against the API's voiceSettingsSchema
  // (routes/developer/numbers.ts): voiceMode, systemPrompt, beginMessage,
  // voice, model, webhookUrl. An empty string clears a field.
  if (flags.mode !== undefined && flags.mode !== 'hosted' && flags.mode !== 'webhook') {
    throw new UsageError(`Unknown --mode "${flags.mode}". Supported: hosted, webhook.`);
  }
  if (
    flags.webhookUrl !== undefined &&
    flags.webhookUrl !== '' &&
    !flags.webhookUrl.startsWith('https://')
  ) {
    throw new UsageError("--webhook-url must be https (or '' to clear it).");
  }
  const body: Record<string, string> = {};
  if (flags.mode !== undefined) body.voiceMode = flags.mode;
  if (flags.prompt !== undefined) body.systemPrompt = flags.prompt;
  if (flags.greeting !== undefined) body.beginMessage = flags.greeting;
  if (flags.voice !== undefined) body.voice = flags.voice;
  if (flags.model !== undefined) body.model = flags.model;
  if (flags.webhookUrl !== undefined) body.webhookUrl = flags.webhookUrl;
  if (Object.keys(body).length === 0) {
    throw new UsageError(
      'Nothing to set — pass at least one of --mode, --prompt, --greeting, --voice, --model, --webhook-url.',
    );
  }

  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  let settings: VoiceSettings;
  try {
    settings = await withTelephony(ctx.api, () =>
      ctx.api.dev<VoiceSettings>('PATCH', `/v1/developer/agents/${agent.id}/voice`, body),
    );
  } catch (err) {
    if (err instanceof ApiError && err.code === 'webhook_url_required') {
      throw new ApiError(
        'Webhook mode needs a webhook URL — add --webhook-url https://… (or set the mode back to hosted).',
        err.status,
        err.code,
      );
    }
    throw err;
  }

  if (flags.json) return printJson({ updated: true, agentId: agent.id, ...settings });
  process.stdout.write(
    `${ok(`Voice settings updated for agent "${sanitizeText(agent.name ?? agent.id)}" — takes effect on the next call.`)}\n`,
  );
  process.stdout.write(`${renderVoice(settings)}\n`);
}

// ── test-call ─────────────────────────────────────────────────────────────

export async function phoneTestCallCommand(numberId: string, flags: PhoneFlags): Promise<void> {
  requireNumberId(numberId);
  if (!flags.to) {
    throw new UsageError(
      'Usage: floe phone test-call <numberId> --to <e164> — the agent calls you at --to.',
    );
  }
  if (!E164.test(flags.to)) {
    throw new UsageError(`Invalid --to "${flags.to}" — E.164, e.g. +14155550123.`);
  }
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);
  // Call minutes are metered to the agent balance — money moves, so confirm.
  await confirmAction(
    `place a test call to ${flags.to} — call minutes debit the agent balance`,
    flags.to,
    { yes: flags.yes },
  );
  const result = await withTelephony(ctx.api, () =>
    ctx.api.dev<TestCallResponse>(
      'POST',
      `/v1/developer/agents/${agent.id}/numbers/${numberId}/test-call`,
      { toNumber: flags.to },
    ),
  );

  if (flags.json) return printJson({ agentId: agent.id, numberId: Number(numberId), ...result });
  process.stdout.write(
    `${ok(`Test call queued: ${bold(sanitizeText(result.from))} → ${bold(sanitizeText(result.to))}`)}\n`,
  );
  process.stdout.write(
    `${dim(`Call id ${sanitizeText(result.callId)} — your phone should ring shortly; minutes are metered to the agent.`)}\n`,
  );
}

// ── def ───────────────────────────────────────────────────────────────────

export const phoneDef: CommandDef = {
  name: 'phone',
  summary: 'search | buy | list | release | calls | usage | voice | test-call — Floe Phone',
  usage: `Usage: floe phone search [--area-code <c>] [--agent <name|id>]
       floe phone buy (--area-code <c> | --number <e164>) [--agent <name|id>] [--yes]
       floe phone list [--all] [--agent <name|id>]
       floe phone release <numberId> [--agent <name|id>] [--yes]
       floe phone calls <numberId> [--limit <n>] [--agent <name|id>]
       floe phone usage <numberId> [--days <n>] [--agent <name|id>]
       floe phone voice [show] [--agent <name|id>]
       floe phone voice set [--mode hosted|webhook] [--prompt <p>] [--greeting <g>]
                            [--voice <v>] [--model <m>] [--webhook-url <u>] [--agent <name|id>]
       floe phone test-call <numberId> --to <e164> [--agent <name|id>] [--yes]

Floe Phone: give an agent a real US phone number, metered on the same ledger.
Default agent: the one this machine uses (switch with \`floe use\`).
  search       Preview purchasable US local numbers (free); buy an exact one
               with buy --number
  buy          Buy a number in --area-code <c> (required; or an exact
               --number from search) and bind it to the agent — the FIRST
               MONTH'S RENTAL debits the agent balance immediately
               (confirms; --yes to skip)
  list         The agent's numbers, history included; --all shows every number
               across your fleet with 7-day calls and month-to-date spend
  release      Release a number permanently — IRREVERSIBLE; type the number
               back to confirm (--yes to skip)
  calls        Recent carrier call history (--limit trims, default 50)
  usage        Ledger telephony spend for a number (--days window, default 30)
  voice        show | set — the number's voice agent: hosted (Floe runs the
               LLM leg) or webhook (your backend answers). Pass '' to clear a
               field, e.g. --greeting ''
  test-call    The agent calls you at --to <e164> — call minutes are metered
               to the agent balance (confirms; --yes to skip)
`,
  options: {
    agent: { type: 'string' },
    'area-code': { type: 'string' },
    number: { type: 'string' },
    all: { type: 'boolean' },
    limit: { type: 'string' },
    days: { type: 'string' },
    to: { type: 'string' },
    mode: { type: 'string' },
    prompt: { type: 'string' },
    greeting: { type: 'string' },
    voice: { type: 'string' },
    model: { type: 'string' },
    'webhook-url': { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: PhoneFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      yes: ctx.yes,
      agent: str(ctx, 'agent'),
      areaCode: str(ctx, 'area-code'),
      number: str(ctx, 'number'),
      all: flag(ctx, 'all'),
      limit: str(ctx, 'limit'),
      days: str(ctx, 'days'),
      to: str(ctx, 'to'),
      mode: str(ctx, 'mode'),
      prompt: str(ctx, 'prompt'),
      greeting: str(ctx, 'greeting'),
      voice: str(ctx, 'voice'),
      model: str(ctx, 'model'),
      webhookUrl: str(ctx, 'webhook-url'),
    };
    if (subcommand === 'search') {
      expectArgs(ctx, 1);
      await phoneSearchCommand(flags);
    } else if (subcommand === 'buy') {
      expectArgs(ctx, 1);
      await phoneBuyCommand(flags);
    } else if (subcommand === undefined || subcommand === 'list') {
      expectArgs(ctx, 1);
      await phoneListCommand(flags);
    } else if (subcommand === 'release') {
      if (!arg) {
        throw new UsageError(
          'Usage: floe phone release <numberId> [--agent <name|id>] [--yes] — list ids with `floe phone list --json`.',
        );
      }
      expectArgs(ctx, 2);
      await phoneReleaseCommand(arg, flags);
    } else if (subcommand === 'calls') {
      if (!arg) {
        throw new UsageError(
          'Usage: floe phone calls <numberId> [--limit <n>] — list ids with `floe phone list --json`.',
        );
      }
      expectArgs(ctx, 2);
      await phoneCallsCommand(arg, flags);
    } else if (subcommand === 'usage') {
      if (!arg) {
        throw new UsageError(
          'Usage: floe phone usage <numberId> [--days <n>] — list ids with `floe phone list --json`.',
        );
      }
      expectArgs(ctx, 2);
      await phoneUsageCommand(arg, flags);
    } else if (subcommand === 'voice') {
      expectArgs(ctx, 2);
      if (arg === undefined || arg === 'show') {
        await phoneVoiceShowCommand(flags);
      } else if (arg === 'set') {
        await phoneVoiceSetCommand(flags);
      } else {
        throw new UsageError(`Unknown voice subcommand "${arg}". Use: voice show, voice set.`);
      }
    } else if (subcommand === 'test-call') {
      if (!arg) throw new UsageError('Usage: floe phone test-call <numberId> --to <e164>.');
      expectArgs(ctx, 2);
      await phoneTestCallCommand(arg, flags);
    } else {
      throw new UsageError(
        `Unknown phone subcommand "${subcommand}". Use: search, buy, list, release <numberId>, calls <numberId>, usage <numberId>, voice show|set, test-call <numberId>.`,
      );
    }
  },
};
