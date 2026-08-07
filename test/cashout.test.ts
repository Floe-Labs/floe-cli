import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const DIR = `${process.cwd()}/test/.tmp-config-cashout-${process.pid}`;
const PAY_URL = 'https://pay.coinbase.com/v3/sell/input?sessionToken=tok';

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

function order(status: string, extra: Record<string, unknown> = {}) {
  return {
    ref: 'ref-1',
    sourceKind: 'agent_wallet',
    agentId: 7,
    status,
    devEoaAddress: '0xdev0000000000000000000000000000000000009',
    agentWalletAddress: '0xaaa1',
    requestedAmountRaw: '10000000',
    finalAmountRaw: null,
    fiatEstimate: null,
    cdpDepositAddress: null,
    cdpTransactionId: null,
    leg1TransferId: null,
    leg1TxHash: null,
    leg2TxHash: null,
    failureReason: null,
    asset: 'USDC',
    chain: 'base',
    createdAt: '2026-08-06T12:00:00.000Z',
    updatedAt: '2026-08-06T12:00:00.000Z',
    ...extra,
  };
}

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
      if (key === 'POST /v1/offramp/start') {
        return respond({ json: { order: order('leg1_pending'), sessionToken: null, payUrl: null } });
      }
      if (key === 'GET /v1/offramp/orders') {
        return respond({
          json: {
            orders: [order('completed', { ref: 'ref-0', finalAmountRaw: '9990000' }), order('awaiting_form')],
            nextCursor: 42,
          },
        });
      }
      if (key === 'GET /v1/offramp/orders/ref-1') {
        return respond({ json: { order: order('awaiting_form'), sessionToken: 'tok', payUrl: PAY_URL } });
      }
      if (key === 'POST /v1/offramp/orders/ref-1/cancel') {
        return respond({ json: { order: order('cancelled') } });
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

describe('cashout start', () => {
  it('posts an agent_wallet offramp order for the active agent', async () => {
    const calls = stubApi();
    await main(['cashout', 'start', '--amount', '10', '--yes']);
    expect(process.exitCode ?? 0).toBe(0);
    const start = calls.find((c) => c.path === '/v1/offramp/start');
    expect(start?.method).toBe('POST');
    expect(start?.auth).toBe('Bearer floe_live_test');
    expect(start?.body).toEqual({ sourceKind: 'agent_wallet', agentId: 7, amountRaw: '10000000' });
    expect(stdout).toContain('Cashout started');
    expect(stdout).toContain('ref-1');
    expect(stdout).toContain('$10.00');
    expect(stdout).toContain('leg1_pending');
  });

  it('refuses without --yes when non-interactive, before any network call', async () => {
    const calls = stubApi();
    await main(['cashout', 'start', '--amount', '10']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Refusing');
    expect(calls).toHaveLength(0);
  });

  it('requires --amount before any network call', async () => {
    const calls = stubApi();
    await main(['cashout', 'start', '--yes']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Usage: floe cashout start');
    expect(calls).toHaveLength(0);
  });

  it('passes the order through with --json', async () => {
    stubApi();
    await main(['cashout', 'start', '--amount', '10', '--yes', '--json']);
    const out = JSON.parse(stdout) as { order: { ref: string; status: string }; payUrl: string | null };
    expect(out.order.ref).toBe('ref-1');
    expect(out.order.status).toBe('leg1_pending');
    expect(out.payUrl).toBeNull();
  });

  it('prints the pay link when the API returns one', async () => {
    stubApi({
      'POST /v1/offramp/start': () => ({
        json: { order: order('awaiting_form'), sessionToken: 'tok', payUrl: PAY_URL },
      }),
    });
    await main(['cashout', 'start', '--amount', '10', '--yes']);
    expect(stdout).toContain(PAY_URL);
    expect(stdout).toContain('bank details');
  });
});

describe('cashout list', () => {
  it('renders order history with a pagination note', async () => {
    const calls = stubApi();
    await main(['cashout', 'list']);
    expect(calls[0]?.path).toBe('/v1/offramp/orders');
    expect(stdout).toContain('ref-0');
    expect(stdout).toContain('ref-1');
    expect(stdout).toContain('$9.99');
    expect(stdout).toContain('completed');
    expect(stdout).toContain('--cursor 42');
  });

  it('surfaces nextCursor with --json', async () => {
    stubApi();
    await main(['cashout', 'list', '--json']);
    const out = JSON.parse(stdout) as { orders: Array<{ ref: string }>; nextCursor: number };
    expect(out.orders).toHaveLength(2);
    expect(out.nextCursor).toBe(42);
  });

  it('forwards --limit and --cursor as query params', async () => {
    const calls = stubApi();
    await main(['cashout', 'list', '--limit', '2', '--cursor', '42', '--json']);
    expect(calls[0]?.path).toBe('/v1/offramp/orders?limit=2&cursor=42');
  });
});

describe('cashout status', () => {
  it('prints the order detail and the fresh pay link', async () => {
    const calls = stubApi();
    await main(['cashout', 'status', 'ref-1']);
    expect(calls[0]?.path).toBe('/v1/offramp/orders/ref-1');
    expect(stdout).toContain('awaiting_form');
    expect(stdout).toContain('$10.00');
    expect(stdout).toContain(PAY_URL);
    expect(stdout).toContain('5 minutes');
  });

  it('passes the detail through with --json', async () => {
    stubApi();
    await main(['cashout', 'status', 'ref-1', '--json']);
    const out = JSON.parse(stdout) as { order: { status: string }; payUrl: string };
    expect(out.order.status).toBe('awaiting_form');
    expect(out.payUrl).toBe(PAY_URL);
  });
});

describe('cashout cancel', () => {
  it('cancels with --yes and explains what stays where', async () => {
    const calls = stubApi();
    await main(['cashout', 'cancel', 'ref-1', '--yes']);
    const cancel = calls.find((c) => c.path === '/v1/offramp/orders/ref-1/cancel');
    expect(cancel?.method).toBe('POST');
    expect(stdout).toContain('cancelled');
    expect(stdout).toContain('Main Wallet');
  });

  it('refuses without --yes when non-interactive, before any network call', async () => {
    const calls = stubApi();
    await main(['cashout', 'cancel', 'ref-1']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Refusing');
    expect(calls).toHaveLength(0);
  });

  it('maps wrong_status to a hint about finality', async () => {
    stubApi({
      'POST /v1/offramp/orders/ref-1/cancel': () => ({
        status: 409,
        json: { error: 'wrong_status', message: "Cannot cancel in status 'sent'" },
      }),
    });
    await main(['cashout', 'cancel', 'ref-1', '--yes']);
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain("Cannot cancel in status 'sent'");
    expect(stderr).toContain('cannot be stopped');
  });
});

describe('cashout dispatch', () => {
  it('exits 2 on an unknown subcommand', async () => {
    const calls = stubApi();
    await main(['cashout', 'frobnicate']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unknown cashout subcommand');
    expect(calls).toHaveLength(0);
  });
});
