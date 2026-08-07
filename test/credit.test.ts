import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;
let tmpSeq = 0;

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

const CONFIG = {
  apiUrl: 'https://api.test',
  activeAgentId: 'agent-1',
  agents: {
    'agent-1': { name: 'my-agent', wallet: '0xabc', keyId: 'key-1', keyPrefix: 'floe_ab12' },
  },
};

async function withConfig(fn: () => Promise<void>, config: unknown = CONFIG): Promise<void> {
  const dir = `${process.cwd()}/test/.tmp-credit-${process.pid}-${tmpSeq++}`;
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/floe`, { recursive: true });
  writeFileSync(`${dir}/floe/config.json`, JSON.stringify(config));
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  try {
    await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface SeenCall {
  method: string;
  path: string;
  body: unknown;
  auth: string | undefined;
}

type RouteHandler = (call: SeenCall) => { status?: number; body: unknown };

function stubFetch(routes: Record<string, RouteHandler>): SeenCall[] {
  const calls: SeenCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const call: SeenCall = {
        method: init?.method ?? 'GET',
        path: parsed.pathname,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      };
      calls.push(call);
      const handler = routes[`${call.method} ${call.path}`];
      if (!handler) {
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      }
      const { status = 200, body } = handler(call);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

const AGENT_1 = {
  id: 'agent-1',
  mode: 'managed',
  fundingMode: 'wallet',
  name: 'my-agent',
  status: 'active',
  suspendedReason: null,
  agentWalletAddress: '0xabc',
  privyWalletAddress: '0xdef',
  creditLimit: '1000000000',
  sessionSpendLimitRaw: null,
  selfServiceLocked: false,
  createdAt: '2026-08-01T00:00:00.000Z',
  closedAt: null,
};
const AGENT_2 = { ...AGENT_1, id: 'agent-2', name: 'other-agent', agentWalletAddress: '0xbbb' };

const FLEET = { body: { agents: [AGENT_1, AGENT_2] } };

const BOUNDS = {
  minLtvBps: 5000,
  maxLtvBps: 9500,
  maxRateBpsCap: 10000,
  agentMaxRateBps: 1000,
  walletBalanceRaw: '500000',
  spendableBalanceRaw: '0',
  paymentSignerWalletAddress: '0x5163',
  fundingMode: 'wallet',
  fundedSpendableRaw: '12000000',
  fundedPendingRaw: '3000000',
  inFlightLoan: null,
  activeLoan: null,
  closePreview: null,
};

describe('credit bounds', () => {
  it('reads the bounds for the machine agent and formats balances', async () => {
    await withConfig(async () => {
      const calls = stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'GET /v1/developer/agents/agent-1/credit-line-bounds': () => ({ body: BOUNDS }),
      });
      await main(['credit', 'bounds']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls.map((c) => c.path)).toEqual([
        '/v1/developer/agents',
        '/v1/developer/agents/agent-1/credit-line-bounds',
      ]);
      expect(calls[1]?.auth).toBe('Bearer floe_live_test');
      expect(stdout).toContain('$12.00'); // fundedSpendableRaw — the wallet-mode spendable read
      expect(stdout).toContain('$3.00'); // fundedPendingRaw (activating)
      expect(stdout).toContain('5000–9500 bps');
      expect(stdout).toContain('pay-as-you-go');
    });
  });

  it('--agent resolves the named agent', async () => {
    await withConfig(async () => {
      const calls = stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'GET /v1/developer/agents/agent-2/credit-line-bounds': () => ({
          body: {
            ...BOUNDS,
            fundingMode: 'credit_line',
            fundedSpendableRaw: null,
            fundedPendingRaw: null,
            spendableBalanceRaw: '7000000',
            activeLoan: {
              loanId: 'loan-9',
              onChainLoanId: '9',
              principalRaw: '10000000',
              collateralAmountRaw: '11000000',
              rateBps: 800,
              startTime: '2026-08-01T00:00:00.000Z',
              registerTxHash: '0xreg',
              matchTxHash: '0xmatch',
            },
          },
        }),
      });
      await main(['credit', 'bounds', '--agent', 'other-agent']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls[1]?.path).toBe('/v1/developer/agents/agent-2/credit-line-bounds');
      expect(stdout).toContain('$7.00'); // credit_line spendable = spendableBalanceRaw
      expect(stdout).toContain('active — principal $10.00 @ 800 bps');
    });
  });

  it('--json passes the bounds through with the agent id', async () => {
    await withConfig(async () => {
      stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'GET /v1/developer/agents/agent-1/credit-line-bounds': () => ({ body: BOUNDS }),
      });
      await main(['credit', 'bounds', '--json']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ agentId: 'agent-1', agentName: 'my-agent', ...BOUNDS });
    });
  });
});

describe('credit open', () => {
  const OPEN_RESULT = {
    loanId: 'loan-1',
    borrowIntentHash: null,
    approveTxHash: null,
    registerTxHash: '0xreg',
    principalRaw: '9000000',
    collateralAmountRaw: '10000000',
    rateBps: 1000,
    status: 'pending_on_chain',
  };

  it('refuses without --yes in non-interactive mode, before any network call', async () => {
    await withConfig(async () => {
      const calls = stubFetch({});
      await main(['credit', 'open', '--deposit', '10']);
      expect(process.exitCode).toBe(2);
      expect(stderr).toContain('--yes');
      expect(calls).toHaveLength(0);
    });
  });

  it('requires --deposit', async () => {
    await withConfig(async () => {
      const calls = stubFetch({});
      await main(['credit', 'open', '--yes']);
      expect(process.exitCode).toBe(2);
      expect(stderr).toContain('--deposit');
      expect(calls).toHaveLength(0);
    });
  });

  it('rejects a bad deposit amount before any network call', async () => {
    await withConfig(async () => {
      const calls = stubFetch({});
      await main(['credit', 'open', '--deposit', 'ten', '--yes']);
      expect(process.exitCode).toBe(2);
      expect(stderr).toContain('Invalid USD amount');
      expect(calls).toHaveLength(0);
    });
  });

  it('rejects out-of-range bps flags before any network call', async () => {
    await withConfig(async () => {
      const calls = stubFetch({});
      await main(['credit', 'open', '--deposit', '10', '--max-ltv', '99999', '--yes']);
      expect(process.exitCode).toBe(2);
      expect(stderr).toContain('--max-ltv');
      expect(calls).toHaveLength(0);
    });
  });

  it('with --yes POSTs depositRaw (and optional bps) to open-credit-line', async () => {
    await withConfig(async () => {
      const calls = stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'POST /v1/developer/agents/agent-1/open-credit-line': () => ({
          status: 201,
          body: OPEN_RESULT,
        }),
      });
      await main([
        'credit', 'open',
        '--deposit', '10',
        '--max-ltv', '9000',
        '--max-rate', '800',
        '--yes',
      ]);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'GET /v1/developer/agents',
        'POST /v1/developer/agents/agent-1/open-credit-line',
      ]);
      expect(calls[1]?.body).toEqual({ depositRaw: '10000000', maxLtvBps: 9000, maxRateBps: 800 });
      expect(stdout).toContain('loan-1');
      expect(stdout).toContain('$9.00'); // principal
      expect(stdout).toContain('floe credit bounds');
    });
  });

  it('--json returns the loan payload with the agent id', async () => {
    await withConfig(async () => {
      stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'POST /v1/developer/agents/agent-1/open-credit-line': () => ({
          status: 201,
          body: OPEN_RESULT,
        }),
      });
      await main(['credit', 'open', '--deposit', '10', '--yes', '--json']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ agentId: 'agent-1', ...OPEN_RESULT });
    });
  });

  it('remaps existing_active_credit_line to a friendly error', async () => {
    await withConfig(async () => {
      stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'POST /v1/developer/agents/agent-1/open-credit-line': () => ({
          status: 409,
          body: { error: 'existing_active_credit_line', detail: 'loan loan-7 in flight' },
        }),
      });
      await main(['credit', 'open', '--deposit', '10', '--yes']);
      expect(process.exitCode).toBe(1);
      expect(stderr).toContain('already has a credit line');
      expect(stderr).toContain('floe credit bounds');
    });
  });

  it('exits 5 on a 402 payment error', async () => {
    await withConfig(async () => {
      stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'POST /v1/developer/agents/agent-1/open-credit-line': () => ({
          status: 402,
          body: { error: 'insufficient_funds', message: 'Deposit exceeds wallet balance.' },
        }),
      });
      await main(['credit', 'open', '--deposit', '10', '--yes']);
      expect(process.exitCode).toBe(5);
      expect(stderr).toContain('Deposit exceeds wallet balance.');
    });
  });
});

describe('credit dispatch', () => {
  it('rejects an unknown subcommand', async () => {
    await withConfig(async () => {
      const calls = stubFetch({});
      await main(['credit', 'frobnicate']);
      expect(process.exitCode).toBe(2);
      expect(stderr).toContain('Unknown credit subcommand');
      expect(calls).toHaveLength(0);
    });
  });
});
