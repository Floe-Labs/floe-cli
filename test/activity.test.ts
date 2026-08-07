import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;

const DIR = `${process.cwd()}/test/.tmp-config-activity-${process.pid}`;

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

const EVENT = {
  id: 'x402_call:101',
  type: 'x402_call',
  agent: { id: 42, name: 'my-agent', walletAddress: '0xabc' },
  timestamp: '2026-08-06T10:31:22.000Z',
  status: 'success',
  summary: '$0.50 USDC → api.vendor.com',
  amountRaw: '500000',
  txHash: null,
};

const FEED = { events: [EVENT], nextCursor: null, hasMore: false };

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

function activityCall(spy: Mock): { url: URL; init: RequestInit } {
  const call = spy.mock.calls.find(([u]) => String(u).includes('/v1/developer/activity'));
  expect(call).toBeDefined();
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

describe('floe activity', () => {
  it('fetches the feed on the developer plane and renders the table', async () => {
    const spy = stubFetch({ '/v1/developer/activity': { body: FEED } });
    await main(['activity']);
    expect(process.exitCode ?? 0).toBe(0);
    const { url, init } = activityCall(spy);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer floe_live_test');
    expect(url.search).toBe(''); // no filters → no params, API defaults apply
    expect(stdout).toContain('my-agent');
    expect(stdout).toContain('x402_call');
    expect(stdout).toContain('success');
    expect(stdout).toContain('$0.50');
    expect(stdout).toContain('2026-08-06 10:31');
  });

  it('--json passes events + nextCursor through unchanged', async () => {
    stubFetch({ '/v1/developer/activity': { body: FEED } });
    await main(['activity', '--json']);
    expect(JSON.parse(stdout)).toEqual(FEED);
  });

  it('maps every filter flag onto the query string', async () => {
    const spy = stubFetch({ '/v1/developer/activity': { body: FEED } });
    await main([
      'activity',
      '--type', 'x402_call, transfer_deposit',
      '--since', '2026-08-01T00:00:00Z',
      '--until', '2026-08-07T00:00:00Z',
      '--key', '7',
      '--limit', '10',
      '--cursor', 'abc123',
      '--expand',
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    const { url } = activityCall(spy);
    expect(url.searchParams.get('type')).toBe('x402_call,transfer_deposit');
    expect(url.searchParams.get('since')).toBe('2026-08-01T00:00:00Z');
    expect(url.searchParams.get('until')).toBe('2026-08-07T00:00:00Z');
    expect(url.searchParams.get('apiKeyId')).toBe('7');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('cursor')).toBe('abc123');
    expect(url.searchParams.get('expand')).toBe('details');
  });

  it('resolves --agent by name to an agentId', async () => {
    const spy = stubFetch({
      '/v1/developer/agents': { body: FLEET },
      '/v1/developer/activity': { body: FEED },
    });
    await main(['activity', '--agent', 'my-agent']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(spy.mock.calls.some(([u]) => String(u).endsWith('/v1/developer/agents'))).toBe(true);
    const { url } = activityCall(spy);
    expect(url.searchParams.get('agentId')).toBe('agent-1');
  });

  it('rejects an unknown --type before any network call', async () => {
    const spy = stubFetch({});
    await main(['activity', '--type', 'bogus_event']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unknown event type');
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a bad --limit before any network call', async () => {
    const spy = stubFetch({});
    await main(['activity', '--limit', '0']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--limit');
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects extra positionals', async () => {
    const spy = stubFetch({});
    await main(['activity', 'extra']);
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps a 402 to exit code 5', async () => {
    stubFetch({
      '/v1/developer/activity': {
        status: 402,
        body: { error: 'payment_required', message: 'Insufficient credit' },
      },
    });
    await main(['activity']);
    expect(process.exitCode).toBe(5);
    expect(stderr).toContain('Insufficient credit');
  });

  it('prints a next-page hint when more events exist', async () => {
    stubFetch({
      '/v1/developer/activity': { body: { events: [EVENT], nextCursor: 'cursor-xyz', hasMore: true } },
    });
    await main(['activity']);
    expect(stdout).toContain('--cursor cursor-xyz');
  });
});
