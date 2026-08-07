import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const TX = `0x${'a'.repeat(64)}`;
const DIR = `${process.cwd()}/test/.tmp-config-funds-${process.pid}`;

let stdout: string;
let stderr: string;

function agentRow(id: string, name: string, wallet: string) {
  return {
    id,
    mode: 'managed',
    fundingMode: 'wallet',
    name,
    status: 'active',
    suspendedReason: null,
    agentWalletAddress: wallet,
    privyWalletAddress: wallet,
    creditLimit: null,
    sessionSpendLimitRaw: null,
    selfServiceLocked: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    closedAt: null,
  };
}
const FLEET = { agents: [agentRow('7', 'my-agent', '0xaaa1'), agentRow('8', 'other-agent', '0xaaa2')] };

interface RouteResult {
  status?: number;
  json: unknown;
}
type Routes = Record<string, (url: URL, body: Record<string, unknown> | undefined) => RouteResult>;
interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  auth?: string;
}

/** Stub fetch with default happy-path routes; per-test overrides win. */
function stubApi(overrides: Routes = {}): Call[] {
  const calls: Call[] = [];
  let balancesCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ method, path: url.pathname + url.search, body, auth: init?.headers?.Authorization });
      const key = `${method} ${url.pathname}`;
      const respond = (r: RouteResult) =>
        new Response(JSON.stringify(r.json), {
          status: r.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      const override = overrides[key];
      if (override) return respond(override(url, body));
      if (key === 'GET /v1/developer/agents') return respond({ json: FLEET });
      if (key === 'POST /v1/transfers/prepare') {
        return respond({
          json: {
            transferId: 'tr-1',
            direction: body?.direction,
            signerKind: 'privy_server',
            fromAddress: '0xf000000000000000000000000000000000000001',
            toAddress: '0xd000000000000000000000000000000000000002',
            amountRaw: body?.amountRaw,
            availableRaw: '9000000',
            nextAction: 'execute',
          },
        });
      }
      if (key === 'POST /v1/transfers/tr-1/execute') {
        return respond({ json: { transferId: 'tr-1', status: 'pending', txHash: TX } });
      }
      if (key === 'GET /v1/transfers') {
        return respond({
          json: {
            transfers: [
              {
                id: 'tr-9',
                agentId: '7',
                counterpartyAgentId: null,
                direction: 'from_agent',
                fromAddress: '0xa',
                toAddress: '0xb',
                amountRaw: '5000000',
                status: 'confirmed',
                txHash: TX,
                failureReason: null,
                createdAt: '2026-08-06T12:00:00.000Z',
              },
            ],
          },
        });
      }
      if (key === 'GET /v1/developer/agents/7/funding') {
        return respond({
          json: {
            agentId: 7,
            depositAddress: '0xdep0000000000000000000000000000000000001',
            network: 'base',
            chainId: 8453,
            token: 'USDC',
            tokenContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            forwardingEnabled: true,
            spendableBalance: '1230000',
            warnings: ['Only USDC on Base - other tokens or networks will result in lost funds'],
            dashboardUrl: 'https://dev-dashboard.floelabs.xyz',
          },
        });
      }
      if (key === 'GET /v1/onramp/geo') return respond({ json: { country: 'DE', mode: 'hosted' } });
      if (key === 'GET /v1/developer/profile') {
        return respond({
          json: {
            developer: {
              walletAddress: '0xdev0000000000000000000000000000000000009',
              displayName: null,
              email: null,
              accountId: null,
              role: null,
              createdAt: '2026-01-01T00:00:00.000Z',
            },
            agents: [],
          },
        });
      }
      if (key === 'GET /v1/developer/balances') {
        balancesCalls += 1;
        return respond({
          json: {
            developerWalletBalanceRaw: balancesCalls === 1 ? '100' : '5000100',
            agentWalletsBalanceRaw: '0',
            apiCreditsAvailableRaw: '0',
            currency: 'USDC',
            decimals: 6,
          },
        });
      }
      if (key === 'POST /v1/onramp/session-token') {
        return respond({
          json: {
            sessionToken: 'sess-tok',
            channelId: '',
            correlationId: 'corr-1',
            onrampId: 42,
            mode: 'hosted',
            nonCustodialAddress: '0xdev0000000000000000000000000000000000009',
            agentWalletAddress: '0xaaa1',
          },
        });
      }
      if (key === 'GET /v1/onramp/sessions') {
        return respond({
          json: {
            sessions: [
              {
                id: 12,
                status: 'success',
                sweepStatus: 'not_started',
                mode: 'hosted',
                fiatAmount: '25',
                cryptoAmount: '24.5',
                createdAt: '2026-08-05T10:00:00.000Z',
              },
            ],
          },
        });
      }
      return respond({ status: 404, json: { error: 'not_found', message: `no stub for ${key}` } });
    }),
  );
  return calls;
}

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(`${DIR}/floe`, { recursive: true });
  writeFileSync(
    `${DIR}/floe/config.json`,
    JSON.stringify({
      apiUrl: 'https://credit-api.floelabs.xyz',
      activeAgentId: '7',
      agents: { '7': { name: 'my-agent', wallet: '0xaaa1', keyId: 'key-1', keyPrefix: 'floe_ab12' } },
    }),
  );
  vi.stubEnv('XDG_CONFIG_HOME', DIR);
});

afterEach(() => {
  try {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
  } finally {
    rmSync(DIR, { recursive: true, force: true });
  }
});

describe('funds withdraw', () => {
  it('prepares then executes a from_agent transfer for the active agent', async () => {
    const calls = stubApi();
    await main(['funds', 'withdraw', '--amount', '5', '--yes']);
    expect(process.exitCode ?? 0).toBe(0);
    const prepare = calls.find((c) => c.path === '/v1/transfers/prepare');
    expect(prepare?.method).toBe('POST');
    expect(prepare?.auth).toBe('Bearer floe_live_test');
    expect(prepare?.body).toEqual({ direction: 'from_agent', agentId: 7, amountRaw: '5000000' });
    const execute = calls.find((c) => c.path === '/v1/transfers/tr-1/execute');
    expect(execute?.method).toBe('POST');
    expect(stdout).toContain('Withdrawal broadcast');
    expect(stdout).toContain('$5.00');
    expect(stdout).toContain('Main Wallet');
    expect(stdout).toContain(TX);
  });

  it('refuses without --yes when non-interactive, before any network call', async () => {
    const calls = stubApi();
    await main(['funds', 'withdraw', '--amount', '5']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Refusing');
    expect(calls).toHaveLength(0);
  });

  it('emits machine-readable JSON with --json', async () => {
    stubApi();
    await main(['funds', 'withdraw', '--amount', '5', '--yes', '--json']);
    const out = JSON.parse(stdout) as Record<string, unknown>;
    expect(out).toEqual({
      transferId: 'tr-1',
      direction: 'from_agent',
      amountRaw: '5000000',
      fromAddress: '0xf000000000000000000000000000000000000001',
      toAddress: '0xd000000000000000000000000000000000000002',
      status: 'pending',
      txHash: TX,
    });
  });

  it('rejects a bad amount before any network call', async () => {
    const calls = stubApi();
    await main(['funds', 'withdraw', '--amount', 'nope', '--yes']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Invalid USD amount');
    expect(calls).toHaveLength(0);
  });

  it('maps the welcome-credit guard to a friendly hint', async () => {
    stubApi({
      'POST /v1/transfers/prepare': () => ({
        status: 400,
        json: {
          error: 'withdrawal_exceeds_user_balance',
          message: 'Amount exceeds your withdrawable balance. The $3 welcome credit is not withdrawable.',
          withdrawableRaw: '0',
        },
      }),
    });
    await main(['funds', 'withdraw', '--amount', '5', '--yes']);
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('welcome credit');
    expect(stderr).toContain('spend-only');
  });
});

describe('funds move', () => {
  it('prepares an agent_to_agent transfer between named agents', async () => {
    const calls = stubApi();
    await main(['funds', 'move', '--from', 'my-agent', '--to', 'other-agent', '--amount', '2.50', '--yes']);
    expect(process.exitCode ?? 0).toBe(0);
    const prepare = calls.find((c) => c.path === '/v1/transfers/prepare');
    expect(prepare?.body).toEqual({
      direction: 'agent_to_agent',
      agentId: 7,
      toAgentId: 8,
      amountRaw: '2500000',
    });
    expect(stdout).toContain('my-agent');
    expect(stdout).toContain('other-agent');
    expect(stdout).toContain('$2.50');
  });

  it('is a usage error without --to, before any network call', async () => {
    const calls = stubApi();
    await main(['funds', 'move', '--from', 'my-agent', '--amount', '2', '--yes']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Usage: floe funds move');
    expect(calls).toHaveLength(0);
  });
});

describe('funds list', () => {
  it('renders the transfer history table', async () => {
    const calls = stubApi();
    await main(['funds', 'list']);
    expect(calls[0]?.path).toBe('/v1/transfers');
    expect(stdout).toContain('agent → Main Wallet');
    expect(stdout).toContain('$5.00');
    expect(stdout).toContain('confirmed');
  });

  it('passes rows through with --json', async () => {
    stubApi();
    await main(['funds', 'list', '--json']);
    const out = JSON.parse(stdout) as { transfers: Array<{ id: string; amountRaw: string }> };
    expect(out.transfers).toHaveLength(1);
    expect(out.transfers[0]?.id).toBe('tr-9');
    expect(out.transfers[0]?.amountRaw).toBe('5000000');
  });
});

describe('funds address', () => {
  it('prints the deposit address with auto-forwarding copy', async () => {
    const calls = stubApi();
    await main(['funds', 'address']);
    expect(calls.some((c) => c.path === '/v1/developer/agents/7/funding')).toBe(true);
    expect(stdout).toContain('0xdep0000000000000000000000000000000000001');
    expect(stdout).toContain('$1.23');
    expect(stdout).toContain('auto-forwarded');
    expect(stdout).toContain('Only USDC on Base');
  });

  it('passes the funding card through with --json', async () => {
    stubApi();
    await main(['funds', 'address', '--json']);
    const out = JSON.parse(stdout) as { depositAddress: string; spendableBalance: string };
    expect(out.depositAddress).toBe('0xdep0000000000000000000000000000000000001');
    expect(out.spendableBalance).toBe('1230000');
  });
});

describe('funds topup', () => {
  it('mints a session and prints the checkout link with --json (no watching)', async () => {
    const calls = stubApi();
    await main(['funds', 'topup', '--amount', '25', '--json']);
    const session = calls.find((c) => c.path === '/v1/onramp/session-token');
    expect(session?.method).toBe('POST');
    expect(session?.body).toEqual({
      destinationKind: 'external',
      destinationAddress: '0xdev0000000000000000000000000000000000009',
      agentId: 7,
      presetFiatAmount: 25,
    });
    const out = JSON.parse(stdout) as { checkoutUrl: string; correlationId: string; onrampId: number };
    expect(out.checkoutUrl).toContain('pay.coinbase.com/buy/select-asset');
    expect(out.checkoutUrl).toContain('sessionToken=sess-tok');
    expect(out.checkoutUrl).toContain('partnerUserRef=corr-1');
    expect(out.correlationId).toBe('corr-1');
    expect(out.onrampId).toBe(42);
    // --json returns immediately: one baseline read, no polling.
    expect(calls.filter((c) => c.path === '/v1/developer/balances').length).toBe(1);
  });

  it('watches the Main Wallet balance until the purchase lands', async () => {
    const calls = stubApi();
    await main(['funds', 'topup', '--amount', '5']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('pay.coinbase.com/buy/select-asset');
    expect(stdout).toContain('Received $5.00');
    // Geo gate runs before the session is minted.
    const geoIndex = calls.findIndex((c) => c.path === '/v1/onramp/geo');
    const sessionIndex = calls.findIndex((c) => c.path === '/v1/onramp/session-token');
    expect(geoIndex).toBeGreaterThanOrEqual(0);
    expect(geoIndex).toBeLessThan(sessionIndex);
    // Baseline read + one poll that saw the balance rise.
    expect(calls.filter((c) => c.path === '/v1/developer/balances').length).toBe(2);
  });

  it('refuses headless regions with a dashboard hint', async () => {
    const calls = stubApi({
      'GET /v1/onramp/geo': () => ({ json: { country: 'US', mode: 'headless' } }),
    });
    await main(['funds', 'topup', '--amount', '5']);
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('dashboard');
    expect(calls.some((c) => c.path === '/v1/onramp/session-token')).toBe(false);
  });
});

describe('funds sessions', () => {
  it('queries recoveryOnly with --recovery and renders the table', async () => {
    const calls = stubApi();
    await main(['funds', 'sessions', '--recovery']);
    expect(calls[0]?.path).toBe('/v1/onramp/sessions?recoveryOnly=true');
    expect(stdout).toContain('$25');
    expect(stdout).toContain('not_started');
    expect(stdout).toContain('Main Wallet');
  });

  it('passes sessions through with --json', async () => {
    stubApi();
    await main(['funds', 'sessions', '--json']);
    const out = JSON.parse(stdout) as { sessions: Array<{ id: number }>; recoveryOnly: boolean };
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]?.id).toBe(12);
    expect(out.recoveryOnly).toBe(false);
  });
});

describe('funds dispatch', () => {
  it('exits 2 on an unknown subcommand', async () => {
    const calls = stubApi();
    await main(['funds', 'frobnicate']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unknown funds subcommand');
    expect(calls).toHaveLength(0);
  });
});
