import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;

const DIR = `${process.cwd()}/test/.tmp-config-usage-${process.pid}`;

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

const SPEND_SERIES = {
  days: 2,
  series: [
    { date: '2026-08-06', totalRaw: '0' },
    { date: '2026-08-07', totalRaw: '1250000' },
  ],
  byVendor: [{ host: 'api.openai.com', totalRaw: '1250000' }],
  totals: { requests: 3, declined: 1, totalRaw: '1250000' },
};

const USAGE_SUMMARY = {
  window: '30d',
  calls: 120,
  errorRatePct: 2.5,
  p50LatencyMs: 240,
  policiesTripped: 3,
};

const ANALYTICS = {
  totals: {
    x402: {
      count: 100,
      volumeRaw: '2500000',
      successCount: 95,
      failedCount: 4,
      pendingCount: 1,
      p50LatencyMs: 240,
      p95LatencyMs: 900,
      p99LatencyMs: 1500,
    },
  },
  topEndpoints: [{ host: 'api.vendor.com', count: 80, volumeRaw: '2000000', successRate: 0.95 }],
};

const COVERAGE = {
  days: 30,
  totals: {
    knownRaw: '10000000',
    enforceableRaw: '7500000',
    reconciledRaw: '2500000',
    coverageBps: 7500,
  },
  bySource: [
    { source: 'x402-proxy', class: 'enforceable', calls: 50, costRaw: '7500000' },
    { source: 'vapi', class: 'reconciled', calls: 10, costRaw: '2500000' },
  ],
  series: [{ date: '2026-08-07', enforceableRaw: '7500000', reconciledRaw: '2500000' }],
  dark: 'unknown',
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

function callTo(spy: Mock, path: string): URL {
  const call = spy.mock.calls.find(([u]) => new URL(String(u)).pathname === path);
  expect(call, `expected a request to ${path}`).toBeDefined();
  return new URL(String(call![0]));
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
  vi.stubEnv('FLOE_API_URL', '');
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(DIR, { recursive: true, force: true });
});

describe('floe usage (spend series)', () => {
  it('renders the daily spend table with totals and vendors', async () => {
    const spy = stubFetch({ '/v1/developer/spend-series': { body: SPEND_SERIES } });
    await main(['usage']);
    expect(process.exitCode ?? 0).toBe(0);
    const url = callTo(spy, '/v1/developer/spend-series');
    expect(url.search).toBe(''); // no flags → server defaults
    expect(stdout).toContain('2026-08-07');
    expect(stdout).toContain('$1.25');
    expect(stdout).toContain('3 (1 declined)');
    expect(stdout).toContain('api.openai.com');
    expect(stdout).toContain('PolicyService.getSpend');
  });

  it('--json passes the series response through unchanged', async () => {
    stubFetch({ '/v1/developer/spend-series': { body: SPEND_SERIES } });
    await main(['usage', '--json']);
    expect(JSON.parse(stdout)).toEqual(SPEND_SERIES);
  });

  it('maps --days and --agent onto the query', async () => {
    const spy = stubFetch({
      '/v1/developer/agents': { body: FLEET },
      '/v1/developer/spend-series': { body: SPEND_SERIES },
    });
    await main(['usage', '--days', '7', '--agent', 'my-agent']);
    expect(process.exitCode ?? 0).toBe(0);
    const url = callTo(spy, '/v1/developer/spend-series');
    expect(url.searchParams.get('days')).toBe('7');
    expect(url.searchParams.get('agentId')).toBe('agent-1');
  });

  it('rejects a bad --days before any network call', async () => {
    const spy = stubFetch({});
    await main(['usage', '--days', '365']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--days');
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps a 402 to exit code 5', async () => {
    stubFetch({
      '/v1/developer/spend-series': {
        status: 402,
        body: { error: 'payment_required', message: 'Insufficient credit' },
      },
    });
    await main(['usage']);
    expect(process.exitCode).toBe(5);
    expect(stderr).toContain('Insufficient credit');
  });
});

describe('floe usage summary', () => {
  it('folds the KPI summary and analytics into one view', async () => {
    const spy = stubFetch({
      '/v1/developer/usage/summary': { body: USAGE_SUMMARY },
      '/v1/developer/analytics/summary': { body: ANALYTICS },
    });
    await main(['usage', 'summary', '--window', '30d']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(callTo(spy, '/v1/developer/usage/summary').searchParams.get('window')).toBe('30d');
    expect(callTo(spy, '/v1/developer/analytics/summary').searchParams.get('window')).toBe('30d');
    expect(stdout).toContain('120'); // calls
    expect(stdout).toContain('2.5%'); // error rate
    expect(stdout).toContain('240 ms'); // p50
    expect(stdout).toContain('$2.50'); // metered spend
    expect(stdout).toContain('api.vendor.com'); // top vendor
    expect(stdout).toContain('95%'); // vendor success rate
  });

  it('--json merges summary with x402 totals and top endpoints', async () => {
    stubFetch({
      '/v1/developer/usage/summary': { body: USAGE_SUMMARY },
      '/v1/developer/analytics/summary': { body: ANALYTICS },
    });
    await main(['usage', 'summary', '--window', '30d', '--json']);
    expect(JSON.parse(stdout)).toEqual({
      ...USAGE_SUMMARY,
      x402: ANALYTICS.totals.x402,
      topEndpoints: ANALYTICS.topEndpoints,
    });
  });

  it('degrades to summary-only when analytics 404s (no agents yet)', async () => {
    stubFetch({
      '/v1/developer/usage/summary': { body: { ...USAGE_SUMMARY, window: '7d', calls: 0 } },
      // no analytics route → 404 from the stub, like an agentless account
    });
    await main(['usage', 'summary', '--json']);
    expect(process.exitCode ?? 0).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.x402).toBeNull();
    expect(parsed.topEndpoints).toBeNull();
    expect(parsed.calls).toBe(0);
  });

  it('rejects an unknown --window before any network call', async () => {
    const spy = stubFetch({});
    await main(['usage', 'summary', '--window', '90d']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--window');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('floe usage coverage', () => {
  it('defaults to the active agent and renders the score', async () => {
    const spy = stubFetch({
      '/v1/developer/agents': { body: FLEET },
      '/v1/developer/agents/agent-1/coverage': { body: COVERAGE },
    });
    await main(['usage', 'coverage']);
    expect(process.exitCode ?? 0).toBe(0);
    const url = callTo(spy, '/v1/developer/agents/agent-1/coverage');
    expect(url.searchParams.get('days')).toBeNull(); // no --days → server default
    expect(stdout).toContain('my-agent');
    expect(stdout).toContain('$10.00'); // known spend
    expect(stdout).toContain('75.00% pre-call enforceable');
    expect(stdout).toContain('vapi');
  });

  it('--json includes the agent id plus the API response', async () => {
    stubFetch({
      '/v1/developer/agents': { body: FLEET },
      '/v1/developer/agents/agent-1/coverage': { body: COVERAGE },
    });
    await main(['usage', 'coverage', '--days', '30', '--json']);
    expect(JSON.parse(stdout)).toEqual({ agentId: 'agent-1', agentName: 'my-agent', ...COVERAGE });
  });

  it('rejects an unknown subcommand', async () => {
    const spy = stubFetch({});
    await main(['usage', 'bogus']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unknown usage subcommand');
    expect(spy).not.toHaveBeenCalled();
  });
});
