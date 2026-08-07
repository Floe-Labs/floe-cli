import { ApiError } from '../lib/api.js';
import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext, requireActiveAgent, resolveAgentRef } from '../lib/context.js';
import { bold, dim, kv, ok, printJson, sanitizeText, UsageError } from '../lib/output.js';
import { rawToUsd, usdToRaw } from '../lib/usdc.js';

export interface CreditFlags {
  agent?: string;
  deposit?: string;
  maxLtv?: string;
  maxRate?: string;
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
}

/** GET /v1/developer/agents/:id/credit-line-bounds. */
interface CreditLineBoundsResponse {
  minLtvBps: number;
  maxLtvBps: number;
  maxRateBpsCap: number;
  agentMaxRateBps: number | null;
  walletBalanceRaw: string;
  spendableBalanceRaw: string;
  paymentSignerWalletAddress: string | null;
  fundingMode: 'wallet' | 'credit_line';
  /** Wallet-mode spendable balance (ledger available); null for credit_line agents. */
  fundedSpendableRaw: string | null;
  fundedPendingRaw: string | null;
  inFlightLoan: { loanId: string; status: string; registerTxHash: string | null } | null;
  activeLoan: {
    loanId: string;
    onChainLoanId: string | null;
    principalRaw: string;
    collateralAmountRaw: string | null;
    rateBps: number | null;
    startTime: string | null;
    registerTxHash: string | null;
    matchTxHash: string | null;
  } | null;
  closePreview: {
    collateralRaw: string;
    principalRaw: string;
    spentRaw: string;
    interestRaw: string;
    earlyRepaymentFeeRaw: string;
    totalToRepayRaw: string;
    estimatedRefundRaw: string;
  } | null;
}

/** POST /v1/developer/agents/:id/open-credit-line (201). */
interface OpenCreditLineResponse {
  loanId: string;
  borrowIntentHash: string | null;
  approveTxHash: string | null;
  registerTxHash: string;
  principalRaw: string;
  collateralAmountRaw: string;
  rateBps: number;
  status: string;
}

/** Basis-point flag: a positive integer within the API's schema bounds. */
function parseBps(value: string | undefined, flagName: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new UsageError(`--${flagName} must be an integer number of basis points (1–${max}).`);
  }
  const bps = Number.parseInt(trimmed, 10);
  if (bps < 1 || bps > max) {
    throw new UsageError(`--${flagName} must be between 1 and ${max} basis points.`);
  }
  return bps;
}

export async function creditBoundsCommand(flags: CreditFlags): Promise<void> {
  const ctx = await devContext(flags);
  const agent = await resolveAgentRef(ctx, flags.agent);
  const bounds = await ctx.api.dev<CreditLineBoundsResponse>(
    'GET',
    `/v1/developer/agents/${agent.id}/credit-line-bounds`,
  );

  if (flags.json) return printJson({ agentId: agent.id, agentName: agent.name, ...bounds });

  process.stdout.write(
    `${bold(`Credit line — ${sanitizeText(agent.name)}`)} ${dim(sanitizeText(String(agent.id)))}\n`,
  );
  const rows: Array<[string, string]> = [
    [
      'Funding mode',
      bounds.fundingMode === 'wallet' ? 'wallet (pay-as-you-go)' : sanitizeText(bounds.fundingMode),
    ],
    // Wallet mode spends the funded ledger balance; credit_line mode spends
    // the borrowed USDC sitting on the payment signer.
    [
      'Spendable',
      bounds.fundingMode === 'wallet'
        ? rawToUsd(bounds.fundedSpendableRaw)
        : rawToUsd(bounds.spendableBalanceRaw),
    ],
  ];
  if (bounds.fundedPendingRaw && bounds.fundedPendingRaw !== '0') {
    rows.push(['Activating', `${rawToUsd(bounds.fundedPendingRaw)} ${dim('(deposit being forwarded)')}`]);
  }
  rows.push(['Deposit wallet', rawToUsd(bounds.walletBalanceRaw)]);
  rows.push(['LTV bounds', `${bounds.minLtvBps}–${bounds.maxLtvBps} bps`]);
  rows.push([
    'Max rate',
    `${bounds.agentMaxRateBps ?? '—'} bps ${dim(`(cap ${bounds.maxRateBpsCap})`)}`,
  ]);
  if (bounds.activeLoan) {
    rows.push([
      'Credit line',
      `active — principal ${rawToUsd(bounds.activeLoan.principalRaw)} @ ${bounds.activeLoan.rateBps ?? '—'} bps ${dim(`(loan ${sanitizeText(bounds.activeLoan.loanId)})`)}`,
    ]);
  } else if (bounds.inFlightLoan) {
    rows.push([
      'Credit line',
      `opening — loan ${sanitizeText(bounds.inFlightLoan.loanId)} ${dim(`(${sanitizeText(bounds.inFlightLoan.status)})`)}`,
    ]);
  } else {
    rows.push(['Credit line', dim('none — open one: floe credit open --deposit <usd>')]);
  }
  if (bounds.closePreview) {
    rows.push([
      'Close refund est.',
      `${rawToUsd(bounds.closePreview.estimatedRefundRaw)} ${dim(`(repays ${rawToUsd(bounds.closePreview.totalToRepayRaw)})`)}`,
    ]);
  }
  process.stdout.write(`${kv(rows)}\n`);
}

export async function creditOpenCommand(flags: CreditFlags): Promise<void> {
  if (!flags.deposit) {
    throw new UsageError(
      'floe credit open requires --deposit <usd> (the USDC collateral to lock).',
    );
  }
  // Validation precedes I/O: amount and bps bounds fail before any request.
  const depositRaw = usdToRaw(flags.deposit);
  const maxLtvBps = parseBps(flags.maxLtv, 'max-ltv', 9500);
  const maxRateBps = parseBps(flags.maxRate, 'max-rate', 10000);

  const ctx = await devContext(flags);
  // Confirm before ANY network call (resolveAgentRef fetches the fleet). The
  // typed-back target is the --agent ref as given, or the configured agent.
  const active = flags.agent ? undefined : requireActiveAgent(ctx.config);
  const target = flags.agent ?? active?.name ?? active?.id ?? '';
  await confirmAction(
    `open a credit line for agent "${target}" — deposit ${rawToUsd(depositRaw)} USDC as collateral and borrow against it`,
    target,
    { yes: flags.yes },
  );

  const agent = await resolveAgentRef(ctx, flags.agent);
  let result: OpenCreditLineResponse;
  try {
    result = await ctx.api.dev<OpenCreditLineResponse>(
      'POST',
      `/v1/developer/agents/${agent.id}/open-credit-line`,
      {
        depositRaw,
        ...(maxLtvBps !== undefined ? { maxLtvBps } : {}),
        ...(maxRateBps !== undefined ? { maxRateBps } : {}),
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.code === 'existing_active_credit_line') {
      throw new ApiError(
        `Agent "${agent.name}" already has a credit line in flight or active — check \`floe credit bounds\`.`,
        409,
        'existing_active_credit_line',
      );
    }
    throw err;
  }

  if (flags.json) return printJson({ agentId: agent.id, ...result });
  process.stdout.write(
    `${ok(`Credit line opening for ${bold(sanitizeText(agent.name))} — ${rawToUsd(result.collateralAmountRaw)} deposited as collateral`)}\n`,
  );
  process.stdout.write(
    `${kv([
      ['Loan', sanitizeText(result.loanId)],
      ['Principal', rawToUsd(result.principalRaw)],
      ['Rate', `${result.rateBps} bps`],
      ['Status', sanitizeText(result.status)],
      ['Register tx', sanitizeText(result.registerTxHash)],
    ])}\n`,
  );
  process.stdout.write(
    `${dim('The loan matches asynchronously — watch it with: floe credit bounds')}\n`,
  );
}

export const creditDef: CommandDef = {
  name: 'credit',
  summary: 'bounds | open — credit-line inspection and opt-in open',
  usage: `Usage: floe credit [bounds] [--agent <agent>]
       floe credit open --deposit <usd> [--max-ltv <bps>] [--max-rate <bps>]
                        [--agent <agent>] [--yes]

Inspect and open the optional USDC credit line that backs an agent's spend.
  bounds     Protocol bounds (LTV/rate), wallet + spendable balances, and any
             in-flight or active credit-line loan for the agent
  open       Deposit USDC collateral and open a same-token credit line
             (money-moving — asks for confirmation; --yes to skip)

Flags:
  --agent <agent>     Target agent by name or id (default: this machine's agent)
  --deposit <usd>     USDC to lock as collateral (required for open)
  --max-ltv <bps>     Max loan-to-value in basis points (1–9500)
  --max-rate <bps>    Max interest rate in basis points (1–10000)
`,
  options: {
    agent: { type: 'string' },
    deposit: { type: 'string' },
    'max-ltv': { type: 'string' },
    'max-rate': { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand] = ctx.args;
    const flags: CreditFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      yes: ctx.yes,
      agent: str(ctx, 'agent'),
      deposit: str(ctx, 'deposit'),
      maxLtv: str(ctx, 'max-ltv'),
      maxRate: str(ctx, 'max-rate'),
    };
    if (subcommand === 'open') {
      expectArgs(ctx, 1);
      await creditOpenCommand(flags);
    } else if (subcommand === undefined || subcommand === 'bounds') {
      expectArgs(ctx, 1);
      await creditBoundsCommand(flags);
    } else {
      throw new UsageError(`Unknown credit subcommand "${subcommand}". Use: bounds, open.`);
    }
  },
};
