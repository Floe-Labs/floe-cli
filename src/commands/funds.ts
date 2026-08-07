import { spawn } from 'node:child_process';
import { ApiError, type FloeApi } from '../lib/api.js';
import { expectArgs, flag, str, type CommandDef } from '../lib/command.js';
import { DASHBOARD_URL } from '../lib/config.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext, requireActiveAgent, resolveAgentRef, type DevContext } from '../lib/context.js';
import { bold, dim, kv, ok, printJson, sanitizeText, UsageError, warn } from '../lib/output.js';
import { table } from '../lib/table.js';
import type { BalancesResponse, ProfileResponse, SerializedAgent } from '../lib/types.js';
import { rawToUsd, usdToRaw } from '../lib/usdc.js';

/**
 * Money movement. Every verb here runs on the developer plane — the
 * /v1/transfers/* and /v1/onramp/* routes authenticate the developer key and
 * refuse agent keys by design (an agent must not be able to move its own
 * funding around). Withdrawals and moves are server-signed (Privy /
 * EIP-3009): the CLI never holds a private key.
 */

export interface FundsFlags {
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
  agent?: string;
  amount?: string;
  from?: string;
  to?: string;
  limit?: string;
  recovery?: boolean;
  open?: boolean;
}

// ─── Local response shapes (only the fields the CLI reads) ───

interface PrepareTransferResponse {
  transferId: string;
  direction: string;
  fromAddress: string;
  toAddress: string;
  amountRaw: string;
  availableRaw?: string;
  nextAction?: string;
}

interface ExecuteTransferResponse {
  transferId: string;
  status: string;
  txHash: string | null;
}

interface TransferRow {
  id: string;
  agentId: string;
  counterpartyAgentId?: string | null;
  direction: string;
  fromAddress: string;
  toAddress: string;
  amountRaw: string;
  status: string;
  txHash?: string | null;
  failureReason?: string | null;
  createdAt: string | null;
}

interface FundingResponse {
  agentId: number | string;
  depositAddress: string;
  network: string;
  chainId: number;
  token: string;
  tokenContract: string;
  forwardingEnabled: boolean;
  spendableBalance: string;
  warnings?: string[];
  dashboardUrl?: string;
}

interface OnrampGeoResponse {
  country: string | null;
  mode: 'hosted' | 'headless';
}

interface OnrampSessionTokenResponse {
  sessionToken: string;
  correlationId: string;
  onrampId: number | null;
  nonCustodialAddress: string;
  agentWalletAddress: string | null;
}

interface OnrampSessionRow {
  id: number;
  status: string;
  sweepStatus: string;
  mode: string | null;
  fiatAmount: string | null;
  cryptoAmount: string | null;
  createdAt: string | null;
}

const COINBASE_BUY_URL = 'https://pay.coinbase.com/buy/select-asset';
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 120_000;

const DIRECTION_LABEL: Record<string, string> = {
  to_agent: 'deposit → agent',
  from_agent: 'agent → Main Wallet',
  agent_to_agent: 'agent → agent',
  embedded_to_external: 'Main Wallet → external',
};

// Same pattern as init.ts (deliberately copied, not imported — command files
// only depend on lib/).
function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
  child.on('error', () => {
    // Best-effort — headless boxes without a browser opener just get the URL in text.
  });
  child.unref();
}

/** The transfers/onramp APIs key agents by their numeric row id. */
function numericAgentId(agent: SerializedAgent): number {
  const id = Number(agent.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(`Agent id "${agent.id}" is not numeric — the transfers API cannot address it.`, 0);
  }
  return id;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 100) {
    // The API clamps to 100 silently — validating here keeps the row count honest.
    throw new UsageError(`--limit must be an integer from 1 to 100 (got "${value}").`);
  }
  return n;
}

function shortAddr(addr: string): string {
  const s = sanitizeText(addr);
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

/** What the human types back to confirm, before any network call happens. */
function targetRef(ctx: DevContext, ref: string | undefined): string {
  if (ref) return ref;
  const active = requireActiveAgent(ctx.config);
  return active.name ?? active.id;
}

/** Remap the transfer guards to actionable hints; rethrow everything else. */
function remapTransferError(err: unknown): never {
  if (err instanceof ApiError) {
    if (err.code === 'withdrawal_exceeds_user_balance') {
      throw new ApiError(err.message, err.status, err.code,
        'The $3 welcome credit is spend-only — it can never be withdrawn or moved between agents.');
    }
    if (err.code === 'withdrawal_exceeds_available') {
      throw new ApiError(err.message, err.status, err.code,
        'Some funds are reserved for in-flight API calls — retry once they settle (usually under a minute).');
    }
    if (err.code === 'Insufficient balance') {
      throw new ApiError(err.message, err.status, err.code, 'See each wallet\'s balance with `floe status`.');
    }
  }
  throw err as Error;
}

/** Two-step server-signed transfer: prepare reserves the row, execute broadcasts. */
async function prepareAndExecute(
  api: FloeApi,
  body: Record<string, unknown>,
): Promise<{ prepared: PrepareTransferResponse; executed: ExecuteTransferResponse }> {
  let prepared: PrepareTransferResponse;
  try {
    prepared = await api.dev<PrepareTransferResponse>('POST', '/v1/transfers/prepare', body);
  } catch (err) {
    remapTransferError(err);
  }
  const executed = await api.dev<ExecuteTransferResponse>(
    'POST',
    `/v1/transfers/${encodeURIComponent(prepared.transferId)}/execute`,
  );
  return { prepared, executed };
}

// ─── withdraw ──────────────────────────────────────────────────────────

export async function fundsWithdrawCommand(flags: FundsFlags): Promise<void> {
  if (!flags.amount) {
    throw new UsageError('Usage: floe funds withdraw [--agent <ref>] --amount <usd>');
  }
  const amountRaw = usdToRaw(flags.amount);
  const ctx = await devContext(flags);
  const target = targetRef(ctx, flags.agent);
  await confirmAction(
    `withdraw ${rawToUsd(amountRaw)} from agent "${target}" to your Main Wallet`,
    target,
    { yes: flags.yes },
  );

  const agent = await resolveAgentRef(ctx, flags.agent);
  const { prepared, executed } = await prepareAndExecute(ctx.api, {
    direction: 'from_agent',
    agentId: numericAgentId(agent),
    amountRaw,
  });

  if (flags.json) {
    return printJson({
      transferId: prepared.transferId,
      direction: prepared.direction,
      amountRaw: prepared.amountRaw,
      fromAddress: prepared.fromAddress,
      toAddress: prepared.toAddress,
      status: executed.status,
      txHash: executed.txHash ?? null,
    });
  }
  const name = sanitizeText(agent.name);
  process.stdout.write(
    `${ok(`Withdrawal broadcast — ${bold(rawToUsd(prepared.amountRaw))} leaving agent "${name}" for your Main Wallet`)}\n` +
      `${kv([
        ['Transfer', sanitizeText(prepared.transferId)],
        ['From', `${shortAddr(prepared.fromAddress)} (agent)`],
        ['To', `${shortAddr(prepared.toAddress)} (your Main Wallet)`],
        ['Status', sanitizeText(executed.status)],
        ['Tx', executed.txHash ? sanitizeText(executed.txHash) : dim('(not broadcast yet)')],
      ])}\n` +
      `${dim('On-chain transfers are irreversible once confirmed. History: floe funds list')}\n`,
  );
}

// ─── move ──────────────────────────────────────────────────────────────

export async function fundsMoveCommand(flags: FundsFlags): Promise<void> {
  if (!flags.from || !flags.to || !flags.amount) {
    throw new UsageError('Usage: floe funds move --from <ref> --to <ref> --amount <usd>');
  }
  const amountRaw = usdToRaw(flags.amount);
  const ctx = await devContext(flags);
  await confirmAction(
    `move ${rawToUsd(amountRaw)} from agent "${flags.from}" to agent "${flags.to}"`,
    flags.from,
    { yes: flags.yes },
  );

  const { agents } = await ctx.api.dev<{ agents: SerializedAgent[] }>('GET', '/v1/developer/agents');
  const source = await resolveAgentRef(ctx, flags.from, agents);
  const dest = await resolveAgentRef(ctx, flags.to, agents);
  if (source.id === dest.id) {
    throw new UsageError('Source and destination are the same agent — nothing to move.');
  }
  const { prepared, executed } = await prepareAndExecute(ctx.api, {
    direction: 'agent_to_agent',
    agentId: numericAgentId(source),
    toAgentId: numericAgentId(dest),
    amountRaw,
  });

  if (flags.json) {
    return printJson({
      transferId: prepared.transferId,
      direction: prepared.direction,
      amountRaw: prepared.amountRaw,
      fromAgentId: source.id,
      toAgentId: dest.id,
      fromAddress: prepared.fromAddress,
      toAddress: prepared.toAddress,
      status: executed.status,
      txHash: executed.txHash ?? null,
    });
  }
  process.stdout.write(
    `${ok(`Move broadcast — ${bold(rawToUsd(prepared.amountRaw))} from agent "${sanitizeText(source.name)}" to agent "${sanitizeText(dest.name)}"`)}\n` +
      `${kv([
        ['Transfer', sanitizeText(prepared.transferId)],
        ['Status', sanitizeText(executed.status)],
        ['Tx', executed.txHash ? sanitizeText(executed.txHash) : dim('(not broadcast yet)')],
      ])}\n` +
      `${dim('On-chain transfers are irreversible once confirmed. History: floe funds list')}\n`,
  );
}

// ─── list ──────────────────────────────────────────────────────────────

export async function fundsListCommand(flags: FundsFlags): Promise<void> {
  const limit = parseLimit(flags.limit);
  const ctx = await devContext(flags);
  const params = new URLSearchParams();
  if (flags.agent !== undefined) {
    const agent = await resolveAgentRef(ctx, flags.agent);
    params.set('agentId', String(agent.id));
  }
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString();
  const { transfers } = await ctx.api.dev<{ transfers: TransferRow[] }>(
    'GET',
    `/v1/transfers${qs ? `?${qs}` : ''}`,
  );

  if (flags.json) return printJson({ transfers });

  if (transfers.length === 0) {
    process.stdout.write(
      `No transfers yet. ${bold('floe funds topup')} adds money; ${bold('floe funds withdraw')} takes it out.\n`,
    );
    return;
  }
  const rows = transfers.map((t) => [
    (t.createdAt ?? '').slice(0, 10) || '—',
    DIRECTION_LABEL[t.direction] ?? sanitizeText(t.direction),
    rawToUsd(t.amountRaw),
    sanitizeText(t.status),
    t.txHash ? `${sanitizeText(t.txHash).slice(0, 10)}…` : dim('(no tx)'),
  ]);
  process.stdout.write(`${table(['DATE', 'DIRECTION', 'AMOUNT', 'STATUS', 'TX'], rows)}\n`);
  // The API defaults to 50 and caps at 100 — a full page means more may exist.
  if (transfers.length === (limit ?? 50)) {
    process.stdout.write(`${dim(`Showing the newest ${transfers.length} — more may be available with --limit.`)}\n`);
  }
}

// ─── address ───────────────────────────────────────────────────────────

export async function fundsAddressCommand(flags: FundsFlags): Promise<void> {
  const ctx = await devContext(flags);
  const agent = await resolveAgentRef(ctx, flags.agent);
  let funding: FundingResponse;
  try {
    funding = await ctx.api.dev<FundingResponse>(
      'GET',
      `/v1/developer/agents/${encodeURIComponent(agent.id)}/funding`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.code === 'agent_not_provisioned') {
      throw new ApiError(err.message, err.status, err.code,
        'Provisioning usually completes within a minute of agent creation — retry shortly.');
    }
    throw err;
  }

  if (flags.json) return printJson(funding);

  const name = sanitizeText(agent.name);
  process.stdout.write(
    `${bold(`Deposit address — agent "${name}"`)}\n${kv([
      ['Address', bold(sanitizeText(funding.depositAddress))],
      ['Network', `${sanitizeText(funding.network)} (chainId ${funding.chainId})`],
      ['Token', `${sanitizeText(funding.token)} · ${sanitizeText(funding.tokenContract)}`],
      ['Spendable', rawToUsd(funding.spendableBalance)],
    ])}\n` +
      `Send USDC on Base from any wallet or exchange to this address to top up the agent.\n` +
      (funding.forwardingEnabled
        ? `${dim("Inbound deposits are auto-forwarded into the agent's spending wallet — they become spendable on their own, no further step needed.")}\n`
        : `${dim('Deposits are credited to the agent once they land on-chain.')}\n`),
  );
  for (const w of funding.warnings ?? []) {
    process.stdout.write(`${warn(sanitizeText(w))}\n`);
  }
}

// ─── topup ─────────────────────────────────────────────────────────────

type WatchOutcome =
  | { kind: 'received'; deltaRaw: bigint }
  | { kind: 'timeout' }
  | { kind: 'interrupted' };

/**
 * Poll the developer balance until it rises above the pre-checkout baseline.
 * Ctrl-C stops the watch (never the purchase) — the SIGINT handler flips a
 * flag and wakes the sleep, and is always removed on the way out.
 */
async function watchForDeposit(api: FloeApi, baselineRaw: bigint): Promise<WatchOutcome> {
  let interrupted = false;
  let wake: (() => void) | undefined;
  const onSigint = (): void => {
    interrupted = true;
    wake?.();
  };
  process.on('SIGINT', onSigint);
  try {
    const startedAt = Date.now();
    for (;;) {
      try {
        const balances = await api.dev<BalancesResponse>('GET', '/v1/developer/balances');
        const current = BigInt(balances.developerWalletBalanceRaw);
        if (current > baselineRaw) return { kind: 'received', deltaRaw: current - baselineRaw };
      } catch {
        // Transient API error mid-watch — keep polling until the deadline.
      }
      if (interrupted) return { kind: 'interrupted' };
      const elapsed = Date.now() - startedAt;
      if (elapsed >= POLL_TIMEOUT_MS) return { kind: 'timeout' };
      if (elapsed > 0) {
        process.stdout.write(`${dim(`  still waiting… ${Math.round(elapsed / 1000)}s`)}\n`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POLL_INTERVAL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
        if (interrupted) wake();
      });
      if (interrupted) return { kind: 'interrupted' };
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

export async function fundsTopupCommand(flags: FundsFlags): Promise<void> {
  let presetRaw: string | undefined;
  if (flags.amount !== undefined) presetRaw = usdToRaw(flags.amount);
  // The onramp API takes fiat as a plain USD number; derived from the
  // validated raw string so "abc" never reaches the network.
  const presetFiat = presetRaw !== undefined ? Number(presetRaw) / 1e6 : undefined;

  const ctx = await devContext(flags);
  const geo = await ctx.api.dev<OnrampGeoResponse>('GET', '/v1/onramp/geo');
  if (geo.mode !== 'hosted') {
    throw new ApiError(
      'Card top-ups in your region use identity verification the CLI cannot collect.',
      409,
      'headless_region',
      `Use the dashboard instead: ${DASHBOARD_URL} → your agent → Add funds.`,
    );
  }

  const [profile, agent] = await Promise.all([
    ctx.api.dev<ProfileResponse>('GET', '/v1/developer/profile'),
    resolveAgentRef(ctx, flags.agent),
  ]);

  // Baseline BEFORE the checkout link exists — the watch below compares
  // against this to detect the purchase landing.
  const balances = await ctx.api.dev<BalancesResponse>('GET', '/v1/developer/balances');
  const baselineRaw = BigInt(balances.developerWalletBalanceRaw);

  const session = await ctx.api.dev<OnrampSessionTokenResponse>('POST', '/v1/onramp/session-token', {
    destinationKind: 'external',
    destinationAddress: profile.developer.walletAddress,
    agentId: numericAgentId(agent),
    ...(presetFiat !== undefined ? { presetFiatAmount: presetFiat } : {}),
  });

  const url = new URL(COINBASE_BUY_URL);
  url.searchParams.set('sessionToken', session.sessionToken);
  url.searchParams.set('defaultAsset', 'USDC');
  url.searchParams.set('defaultNetwork', 'base');
  if (presetFiat !== undefined) url.searchParams.set('presetFiatAmount', String(presetFiat));
  url.searchParams.set('partnerUserRef', session.correlationId);
  const checkoutUrl = url.toString();

  if (flags.json) {
    // Scripts get the link and poll on their own schedule — no watch here.
    return printJson({
      checkoutUrl,
      correlationId: session.correlationId,
      onrampId: session.onrampId,
      agentId: agent.id,
      baselineRaw: baselineRaw.toString(),
    });
  }

  const name = sanitizeText(agent.name);
  process.stdout.write(
    `Buy USDC with a card — finish the purchase at Coinbase:\n\n  ${bold(checkoutUrl)}\n\n` +
      `${dim(`The USDC lands in your Main Wallet (${shortAddr(profile.developer.walletAddress)}), not directly in agent "${name}" —`)}\n` +
      `${dim(`move it to the agent from the dashboard (${DASHBOARD_URL}), or send it on to the agent's`)}\n` +
      `${dim('deposit address (floe funds address).')}\n`,
  );
  if (flags.open) openInBrowser(checkoutUrl);

  process.stdout.write(
    `${dim('Watching your Main Wallet for the funds — up to 2 minutes; Ctrl-C stops watching (the purchase itself is unaffected)…')}\n`,
  );
  const outcome = await watchForDeposit(ctx.api, baselineRaw);
  if (outcome.kind === 'received') {
    process.stdout.write(`${ok(`Received ${bold(rawToUsd(outcome.deltaRaw))} in your Main Wallet.`)}\n`);
    process.stdout.write(
      `${dim(`Next: move it into agent "${name}" from the dashboard, or fund the agent directly — floe funds address.`)}\n`,
    );
  } else if (outcome.kind === 'timeout') {
    process.stdout.write(
      `${warn('No deposit detected yet — card purchases can take a few minutes to settle.')}\n` +
        `${dim('Check later with floe status; completed purchases still waiting to be moved appear under floe funds sessions --recovery.')}\n`,
    );
  } else {
    process.stdout.write(
      `${dim('Stopped watching. If you completed the purchase it still arrives in the background — check floe status later.')}\n`,
    );
  }
}

// ─── sessions ──────────────────────────────────────────────────────────

export async function fundsSessionsCommand(flags: FundsFlags): Promise<void> {
  const limit = parseLimit(flags.limit);
  const ctx = await devContext(flags);
  const params = new URLSearchParams();
  if (flags.recovery) params.set('recoveryOnly', 'true');
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString();
  const { sessions } = await ctx.api.dev<{ sessions: OnrampSessionRow[] }>(
    'GET',
    `/v1/onramp/sessions${qs ? `?${qs}` : ''}`,
  );

  if (flags.json) return printJson({ sessions, recoveryOnly: flags.recovery === true });

  if (sessions.length === 0) {
    process.stdout.write(
      flags.recovery
        ? `${ok('No stranded card purchases — every completed top-up has been fully processed.')}\n`
        : `No card top-ups yet. Start one: ${bold('floe funds topup')}\n`,
    );
    return;
  }
  const rows = sessions.map((s) => [
    (s.createdAt ?? '').slice(0, 10) || '—',
    s.fiatAmount
      ? `$${sanitizeText(s.fiatAmount)}`
      : s.cryptoAmount
        ? `${sanitizeText(s.cryptoAmount)} USDC`
        : '—',
    sanitizeText(s.status),
    sanitizeText(s.sweepStatus),
    sanitizeText(s.mode ?? '—'),
  ]);
  process.stdout.write(`${table(['DATE', 'AMOUNT', 'STATUS', 'SWEEP', 'MODE'], rows)}\n`);
  if (flags.recovery) {
    process.stdout.write(
      `${warn('These purchases completed, but the USDC is still sitting in your Main Wallet — it was never moved into an agent.')}\n` +
        `${dim(`Finish moving it in the dashboard: ${DASHBOARD_URL}`)}\n`,
    );
  }
}

// ─── def ───────────────────────────────────────────────────────────────

export const fundsDef: CommandDef = {
  name: 'funds',
  summary: 'withdraw | move | list | address | topup | sessions — move money',
  usage: `Usage: floe funds withdraw [--agent <ref>] --amount <usd>
       floe funds move --from <ref> --to <ref> --amount <usd>
       floe funds list [--agent <ref>] [--limit <n>]
       floe funds address [--agent <ref>]
       floe funds topup [--agent <ref>] [--amount <usd>] [--open]
       floe funds sessions [--recovery] [--limit <n>]

Move money between your agents, your Main Wallet, and a card. All transfers
are server-signed — the CLI never holds a private key.
  withdraw   Agent → your Main Wallet (the $3 welcome credit always stays)
  move       Agent → another of your agents
  list       Transfer history
  address    The agent's USDC deposit address — top it up from any wallet or
             exchange; inbound USDC becomes spendable automatically
  topup      Buy USDC with a card via Coinbase: prints a checkout link, then
             watches your Main Wallet for the funds (Ctrl-C stops watching)
  sessions   Card-purchase history; --recovery shows completed purchases whose
             funds still sit in your Main Wallet

Flags:
  --agent <ref>   Agent name or id (default: this machine's active agent)
  --from <ref>    move: source agent
  --to <ref>      move: destination agent
  --amount <usd>  Amount in USD, e.g. 5 or 0.50
  --limit <n>     Rows to fetch
  --recovery      sessions: only purchases not yet moved into an agent
  --open          topup: also open the checkout link in your browser
  --json          Machine-readable output (topup: prints the link, no watching)
  --yes           Skip the confirmation prompt (withdraw / move)
`,
  options: {
    agent: { type: 'string' },
    amount: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    limit: { type: 'string' },
    recovery: { type: 'boolean' },
    open: { type: 'boolean' },
  },
  run: async (ctx) => {
    const [subcommand] = ctx.args;
    const flags: FundsFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      yes: ctx.yes,
      agent: str(ctx, 'agent'),
      amount: str(ctx, 'amount'),
      from: str(ctx, 'from'),
      to: str(ctx, 'to'),
      limit: str(ctx, 'limit'),
      recovery: flag(ctx, 'recovery'),
      open: flag(ctx, 'open'),
    };
    if (subcommand === 'withdraw') {
      expectArgs(ctx, 1);
      await fundsWithdrawCommand(flags);
    } else if (subcommand === 'move') {
      expectArgs(ctx, 1);
      await fundsMoveCommand(flags);
    } else if (subcommand === 'list') {
      expectArgs(ctx, 1);
      await fundsListCommand(flags);
    } else if (subcommand === 'address') {
      expectArgs(ctx, 1);
      await fundsAddressCommand(flags);
    } else if (subcommand === 'topup') {
      expectArgs(ctx, 1);
      await fundsTopupCommand(flags);
    } else if (subcommand === 'sessions') {
      expectArgs(ctx, 1);
      await fundsSessionsCommand(flags);
    } else {
      throw new UsageError(
        `Unknown funds subcommand "${subcommand ?? ''}". Use: withdraw, move, list, address, topup, sessions.`,
      );
    }
  },
};
