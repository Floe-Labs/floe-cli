import { spawn } from 'node:child_process';
import { ApiError } from '../lib/api.js';
import { expectArgs, flag, str, type CommandDef } from '../lib/command.js';
import { DASHBOARD_URL } from '../lib/config.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext, requireActiveAgent, resolveAgentRef, type DevContext } from '../lib/context.js';
import { bold, dim, kv, ok, printJson, sanitizeText, UsageError } from '../lib/output.js';
import { table } from '../lib/table.js';
import type { SerializedAgent } from '../lib/types.js';
import { rawToUsd, usdToRaw } from '../lib/usdc.js';

/**
 * Offramp: USDC → fiat via Coinbase (CDP). The agent-path leg 1 (agent →
 * Main Wallet) is fully server-signed; the CLI's job is to start the order,
 * surface the Coinbase pay link when the order reaches `awaiting_form`, and
 * track it to `completed`.
 */

export interface CashoutFlags {
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
  agent?: string;
  amount?: string;
  limit?: string;
  cursor?: string;
  open?: boolean;
}

// Order shape as serialized by the offramp API.
interface OfframpOrderView {
  ref: string;
  sourceKind: string;
  agentId: number | null;
  status: string;
  devEoaAddress: string | null;
  agentWalletAddress: string | null;
  requestedAmountRaw: string;
  finalAmountRaw: string | null;
  fiatEstimate: string | null;
  cdpDepositAddress: string | null;
  leg1TxHash: string | null;
  leg2TxHash: string | null;
  failureReason: string | null;
  asset: string;
  chain: string;
  createdAt: string | null;
  updatedAt: string | null;
}

interface OfframpOrderResponse {
  order: OfframpOrderView;
  sessionToken?: string | null;
  payUrl?: string | null;
}

interface OfframpListResponse {
  orders: OfframpOrderView[];
  nextCursor: number | null;
}

/** One line of truth per state — money copy must say what moves next. */
const STATUS_HELP: Record<string, string> = {
  created: 'order created — no funds have moved yet',
  leg1_pending: 'USDC is moving agent → Main Wallet (server-signed, nothing to do)',
  awaiting_form: 'Coinbase needs your bank details — open the pay link',
  awaiting_send: `waiting for the final USDC send to Coinbase — finish it in the dashboard (${DASHBOARD_URL})`,
  sent: 'USDC sent to Coinbase — payout in progress',
  processing: 'Coinbase is converting to fiat and paying out',
  completed: 'paid out to your bank — done',
  failed: 'failed — no further funds will move',
  expired: 'expired before completion — no further funds will move',
  cancelled: 'cancelled — no further funds will move',
};

// Duplicated in funds.ts (deliberately — command files only depend on lib/).
// Unlike init.ts's copy the URL here is network-sourced, so only https: opens
// and no shell is involved: cmd.exe would parse & | ^ in the URL as command
// separators and expand %VAR%.
function openInBrowser(url: string): void {
  let protocol: string | undefined;
  try {
    protocol = new URL(url).protocol;
  } catch {
    // Unparseable — fall through to the guard.
  }
  if (protocol !== 'https:') return; // The link is already printed as text.
  const isWin = process.platform === 'win32';
  const cmd = process.platform === 'darwin' ? 'open' : isWin ? 'rundll32' : 'xdg-open';
  const args = isWin ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    // Best-effort — headless boxes without a browser opener just get the URL in text.
  });
  child.unref();
}

/** The offramp API keys agents by their numeric row id. */
function numericAgentId(agent: SerializedAgent): number {
  const id = Number(agent.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(`Agent id "${agent.id}" is not numeric — the offramp API cannot address it.`, 0);
  }
  return id;
}

function statusLine(status: string): string {
  const clean = sanitizeText(status);
  const help = STATUS_HELP[clean];
  return help ? `${clean} — ${help}` : clean;
}

function printPayUrl(payUrl: string, open: boolean): void {
  const url = sanitizeText(payUrl);
  process.stdout.write(
    `\nEnter your bank details with Coinbase:\n\n  ${bold(url)}\n\n` +
      `${dim('The link is single-use and expires in about 5 minutes — `floe cashout status <ref>` mints a fresh one.')}\n`,
  );
  if (open) openInBrowser(url);
}

function remapOfframpError(err: unknown): never {
  if (err instanceof ApiError) {
    if (err.code === 'withdrawal_exceeds_user_balance') {
      throw new ApiError(err.message, err.status, err.code,
        'The $3 welcome credit is spend-only — it can never be cashed out.');
    }
    if (err.code === 'wrong_status') {
      throw new ApiError(err.message, err.status, err.code,
        'Orders can only be cancelled while created or awaiting_form — once USDC heads to Coinbase it cannot be stopped.');
    }
  }
  throw err as Error;
}

// ─── start ─────────────────────────────────────────────────────────────

export async function cashoutStartCommand(flags: CashoutFlags): Promise<void> {
  if (!flags.amount) {
    throw new UsageError('Usage: floe cashout start [--agent <ref>] --amount <usd>');
  }
  const amountRaw = usdToRaw(flags.amount);
  const ctx = await devContext(flags);
  const target = targetRef(ctx, flags.agent);
  await confirmAction(
    `cash out ${rawToUsd(amountRaw)} from agent "${target}" to your bank via Coinbase`,
    target,
    { yes: flags.yes },
  );

  const agent = await resolveAgentRef(ctx, flags.agent);
  let res: OfframpOrderResponse;
  try {
    res = await ctx.api.dev<OfframpOrderResponse>('POST', '/v1/offramp/start', {
      sourceKind: 'agent_wallet',
      agentId: numericAgentId(agent),
      amountRaw,
    });
  } catch (err) {
    remapOfframpError(err);
  }

  if (flags.json) return printJson(res);

  const order = res.order;
  const ref = sanitizeText(order.ref);
  process.stdout.write(
    `${ok(`Cashout started — order ${bold(ref)}`)}\n${kv([
      ['Amount', `${rawToUsd(order.requestedAmountRaw)} USDC leaving agent "${sanitizeText(agent.name)}"`],
      ['Status', statusLine(order.status)],
    ])}\n`,
  );
  if (res.payUrl) {
    printPayUrl(res.payUrl, flags.open === true);
  } else {
    process.stdout.write(
      `${dim(`Track it: floe cashout status ${ref} — when it reaches awaiting_form you get a Coinbase link for your bank details.`)}\n`,
    );
  }
  process.stdout.write(
    `${dim('Cashing out is final once the USDC reaches Coinbase; cancel is possible only while status is created or awaiting_form.')}\n`,
  );
}

function targetRef(ctx: DevContext, ref: string | undefined): string {
  if (ref) return ref;
  const active = requireActiveAgent(ctx.config);
  return active.name ?? active.id;
}

// ─── list ──────────────────────────────────────────────────────────────

export async function cashoutListCommand(flags: CashoutFlags): Promise<void> {
  const params = new URLSearchParams();
  if (flags.limit !== undefined) {
    const n = Number(flags.limit);
    if (!Number.isInteger(n) || n <= 0) {
      throw new UsageError(`--limit must be a positive integer (got "${flags.limit}").`);
    }
    params.set('limit', String(n));
  }
  if (flags.cursor !== undefined) {
    if (!/^\d+$/.test(flags.cursor)) {
      throw new UsageError(`--cursor must be a non-negative integer (got "${flags.cursor}").`);
    }
    params.set('cursor', flags.cursor);
  }
  const ctx = await devContext(flags);
  const qs = params.toString();
  const { orders, nextCursor } = await ctx.api.dev<OfframpListResponse>(
    'GET',
    `/v1/offramp/orders${qs ? `?${qs}` : ''}`,
  );

  if (flags.json) return printJson({ orders, nextCursor });

  if (orders.length === 0) {
    process.stdout.write(`No cashouts yet. Start one: ${bold('floe cashout start --amount <usd>')}\n`);
    return;
  }
  const rows = orders.map((o) => [
    sanitizeText(o.ref),
    (o.createdAt ?? '').slice(0, 10) || '—',
    rawToUsd(o.finalAmountRaw ?? o.requestedAmountRaw),
    sanitizeText(o.status),
  ]);
  process.stdout.write(`${table(['REF', 'DATE', 'AMOUNT', 'STATUS'], rows)}\n`);
  if (nextCursor !== null && nextCursor !== undefined) {
    process.stdout.write(`${dim(`More available: floe cashout list --cursor ${nextCursor}`)}\n`);
  }
}

// ─── status ────────────────────────────────────────────────────────────

export async function cashoutStatusCommand(ref: string, flags: CashoutFlags): Promise<void> {
  const ctx = await devContext(flags);
  const res = await ctx.api.dev<OfframpOrderResponse>(
    'GET',
    `/v1/offramp/orders/${encodeURIComponent(ref)}`,
  );

  if (flags.json) return printJson(res);

  const o = res.order;
  const rows: Array<[string, string]> = [
    ['Order', sanitizeText(o.ref)],
    ['Status', statusLine(o.status)],
    ['Amount', `${rawToUsd(o.requestedAmountRaw)} USDC`],
  ];
  if (o.finalAmountRaw && o.finalAmountRaw !== o.requestedAmountRaw) {
    rows.push(['Final amount', `${rawToUsd(o.finalAmountRaw)} USDC`]);
  }
  if (o.fiatEstimate) rows.push(['Est. payout', `$${sanitizeText(o.fiatEstimate)}`]);
  if (o.agentId !== null) rows.push(['Agent', String(o.agentId)]);
  if (o.leg1TxHash) rows.push(['Leg 1 tx', sanitizeText(o.leg1TxHash)]);
  if (o.leg2TxHash) rows.push(['Leg 2 tx', sanitizeText(o.leg2TxHash)]);
  if (o.status === 'failed' && o.failureReason) {
    rows.push(['Failure', sanitizeText(o.failureReason)]);
  }
  rows.push(['Created', (o.createdAt ?? '').slice(0, 10) || '—']);
  process.stdout.write(`${bold('Cashout order')}\n${kv(rows)}\n`);
  if (res.payUrl) printPayUrl(res.payUrl, flags.open === true);
}

// ─── cancel ────────────────────────────────────────────────────────────

export async function cashoutCancelCommand(ref: string, flags: CashoutFlags): Promise<void> {
  const ctx = await devContext(flags);
  await confirmAction(`cancel cashout order ${ref}`, ref, { yes: flags.yes });
  let res: OfframpOrderResponse;
  try {
    res = await ctx.api.dev<OfframpOrderResponse>(
      'POST',
      `/v1/offramp/orders/${encodeURIComponent(ref)}/cancel`,
    );
  } catch (err) {
    remapOfframpError(err);
  }

  if (flags.json) return printJson({ cancelled: true, order: res.order });

  process.stdout.write(
    `${ok(`Cashout ${sanitizeText(res.order.ref)} cancelled.`)}\n` +
      `${dim('Nothing was sent to Coinbase. Funds already moved out of the agent (leg 1) stay in your Main Wallet.')}\n`,
  );
}

// ─── def ───────────────────────────────────────────────────────────────

export const cashoutDef: CommandDef = {
  name: 'cashout',
  summary: 'start | list | status | cancel — cash out USDC to fiat',
  usage: `Usage: floe cashout start [--agent <ref>] --amount <usd> [--open]
       floe cashout list [--limit <n>] [--cursor <c>]
       floe cashout status <ref> [--open]
       floe cashout cancel <ref>

Cash agent USDC out to your bank via Coinbase. Leg 1 (agent → Main Wallet)
is server-signed and starts immediately; when the order reaches
awaiting_form, Coinbase collects your bank details through a pay link.
  start    Begin a cashout from an agent's balance
  list     Order history (paginated — --cursor pages older orders)
  status   One order's state; re-mints a fresh pay link while awaiting_form
  cancel   Abort an order — only while status is created or awaiting_form;
           once the USDC is sent to Coinbase it cannot be stopped

Flags:
  --agent <ref>   Agent name or id (default: this machine's active agent)
  --amount <usd>  Amount in USD, e.g. 10 or 2.50
  --limit <n>     Orders per page (default 25)
  --cursor <c>    Pagination cursor from a previous list (--json: nextCursor)
  --open          Open the Coinbase pay link in your browser
  --json / --yes  Machine output / skip confirmation
`,
  options: {
    agent: { type: 'string' },
    amount: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
    open: { type: 'boolean' },
  },
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: CashoutFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      yes: ctx.yes,
      agent: str(ctx, 'agent'),
      amount: str(ctx, 'amount'),
      limit: str(ctx, 'limit'),
      cursor: str(ctx, 'cursor'),
      open: flag(ctx, 'open'),
    };
    if (subcommand === 'start') {
      expectArgs(ctx, 1);
      await cashoutStartCommand(flags);
    } else if (subcommand === 'list') {
      expectArgs(ctx, 1);
      await cashoutListCommand(flags);
    } else if (subcommand === 'status') {
      if (!arg) throw new UsageError('Usage: floe cashout status <ref> — see `floe cashout list` for refs.');
      expectArgs(ctx, 2);
      await cashoutStatusCommand(arg, flags);
    } else if (subcommand === 'cancel') {
      if (!arg) throw new UsageError('Usage: floe cashout cancel <ref> — see `floe cashout list` for refs.');
      expectArgs(ctx, 2);
      await cashoutCancelCommand(arg, flags);
    } else {
      throw new UsageError(
        `Unknown cashout subcommand "${subcommand ?? ''}". Use: start, list, status <ref>, cancel <ref>.`,
      );
    }
  },
};
