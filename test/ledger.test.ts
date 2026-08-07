import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;

const DIR = `${process.cwd()}/test/.tmp-config-ledger-${process.pid}`;

const CONFIG = {
  apiUrl: 'https://credit-api.floelabs.xyz',
  activeAgentId: 'agent-1',
  agents: {
    'agent-1': { name: 'my-agent', wallet: '0xabc', keyId: 'key-1', keyPrefix: 'floe_ab12' },
  },
};

const FLEET = {
  agents: [{ id: 'agent-1', name: 'my-agent', status: 'active', agentWalletAddress: '0xabc' }],
};

const LEDGER = {
  days: 30,
  groupBy: 'source',
  totalRaw: '10000000',
  rows: [
    { key: 'x402-proxy', tagged: true, calls: 50, costRaw: '7500000', reconciledRaw: '0' },
    { key: 'vapi', tagged: true, calls: 10, costRaw: '2500000', reconciledRaw: '2500000' },
  ],
};

const LEDGER_CUSTOMER = {
  days: 7,
  groupBy: 'customer',
  totalRaw: '1000000',
  rows: [
    { key: 'acme', tagged: true, calls: 5, costRaw: '750000', reconciledRaw: '0' },
    { key: 'untagged', tagged: false, calls: 2, costRaw: '250000', reconciledRaw: '0' },
  ],
};

/** Route fetch by pathname; unknown paths 404 like the API would. */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>): Mock {
  const spy = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    const route = routes[url.pathname];
    if (!route) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function ledgerCall(spy: Mock): { url: URL; init: RequestInit } {
  const call = spy.mock.calls.find(([u]) => new URL(String(u)).pathname === '/v1/developer/ledger');
  expect(call, 'expected a request to /v1/developer/ledger').toBeDefined();
  return { url: new URL(String(call![0])), init: call![1] as RequestInit };
}

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(`${DIR}/floe`, { recursive: true });
  writeFileSync(`${DIR}/floe/config.json`, JSON.stringify(CONFIG));
  vi.stubEnv('XDG_CONFIG_HOME', DIR);
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(DIR, { recursive: true, force: true });
});

describe('floe ledger', () => {
  it('defaults to --group-by source and renders the rollup', async () => {
    const spy = stubFetch({ '/v1/developer/ledger': { body: LEDGER } });
    await main(['ledger']);
    expect(process.exitCode ?? 0).toBe(0);
    const { url, init } = ledgerCall(spy);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer floe_live_test');
    expect(url.searchParams.get('groupBy')).toBe('source');
    expect(url.searchParams.get('days')).toBeNull(); // no --days → server default
    expect(stdout).toContain('Ledger — by source · last 30 days');
    expect(stdout).toContain('x402-proxy');
    expect(stdout).toContain('$7.50');
    expect(stdout).toContain('$2.50'); // vapi bucket, fully reconciled
    expect(stdout).toContain('Total: $10.00');
  });

  it('maps --group-by and --days onto the query and marks untagged rows', async () => {
    const spy = stubFetch({ '/v1/developer/ledger': { body: LEDGER_CUSTOMER } });
    await main(['ledger', '--group-by', 'customer', '--days', '7']);
    expect(process.exitCode ?? 0).toBe(0);
    const { url } = ledgerCall(spy);
    expect(url.searchParams.get('groupBy')).toBe('customer');
    expect(url.searchParams.get('days')).toBe('7');
    expect(stdout).toContain('acme');
    expect(stdout).toContain('untagged (no tag)');
  });

  it('resolves --agent to an agentId', async () => {
    const spy = stubFetch({
      '/v1/developer/agents': { body: FLEET },
      '/v1/developer/ledger': { body: LEDGER },
    });
    await main(['ledger', '--agent', 'my-agent']);
    expect(process.exitCode ?? 0).toBe(0);
    const { url } = ledgerCall(spy);
    expect(url.searchParams.get('agentId')).toBe('agent-1');
  });

  it('--json passes the ledger response through unchanged', async () => {
    stubFetch({ '/v1/developer/ledger': { body: LEDGER } });
    await main(['ledger', '--json']);
    expect(JSON.parse(stdout)).toEqual(LEDGER);
  });

  it('rejects an invalid --group-by before any network call', async () => {
    const spy = stubFetch({});
    await main(['ledger', '--group-by', 'vendor']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--group-by');
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a bad --days before any network call', async () => {
    const spy = stubFetch({});
    await main(['ledger', '--days', '0']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--days');
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects extra positionals', async () => {
    const spy = stubFetch({});
    await main(['ledger', 'extra']);
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps a 402 to exit code 5', async () => {
    stubFetch({
      '/v1/developer/ledger': {
        status: 402,
        body: { error: 'payment_required', message: 'Insufficient credit' },
      },
    });
    await main(['ledger']);
    expect(process.exitCode).toBe(5);
    expect(stderr).toContain('Insufficient credit');
  });
});
