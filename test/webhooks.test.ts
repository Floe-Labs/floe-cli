import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;
let configDir: string;

const API = 'https://api.test';

const HOOK = {
  id: 7,
  url: 'https://example.com/hook',
  events: ['loan.repaid', 'loan.liquidated'],
  scope: 'global',
  scopeValue: null,
  active: true,
  description: null,
  createdAt: '2026-08-01T00:00:00.000Z',
};

const DELIVERY = {
  id: 1,
  deliveryId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  event: 'loan.repaid',
  statusCode: 200,
  status: 'success',
  attempt: 1,
  error: null,
  createdAt: '2026-08-05T10:30:00.000Z',
};

const LOG_ROW = {
  id: 11,
  deliveryId: 'f0e1d2c3b4a5968778695a4b3c2d1e0f',
  webhookId: 7,
  webhookUrl: 'https://example.com/hook',
  event: 'call.ended',
  status: 'failed',
  statusCode: 500,
  attempt: 2,
  error: 'HTTP 500',
  agentWallet: '0x1234567890abcdef1234567890abcdef12345678',
  correlationId: null,
  createdAt: '2026-08-10T09:15:00.000Z',
};

const LOG_ROW_SESSION = {
  ...LOG_ROW,
  id: 12,
  deliveryId: '0123456789abcdef0123456789abcdef',
  event: 'call.report.ready',
  status: 'success',
  statusCode: 200,
  attempt: 1,
  error: null,
  correlationId: 'CA9f2f0f5c',
};

type FetchCall = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** Stub fetch with a fixed response; capture every call's method/url/headers/parsed body. */
function stubFetch(status: number, payload: unknown): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return { calls };
}

function stubNoFetch(): ReturnType<typeof vi.fn> {
  const spy = vi.fn();
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
  configDir = `${process.cwd()}/test/.tmp-config-webhooks-${process.pid}`;
  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(`${configDir}/floe`, { recursive: true });
  writeFileSync(
    `${configDir}/floe/config.json`,
    JSON.stringify({
      apiUrl: API,
      activeAgentId: 'agent-1',
      agents: { 'agent-1': { name: 'my-agent', wallet: '0xabc', keyId: 'key-1', keyPrefix: 'floe_ab12' } },
    }),
  );
  vi.stubEnv('XDG_CONFIG_HOME', configDir);
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

describe('webhooks list', () => {
  it('lists webhooks over the developer plane', async () => {
    const { calls } = stubFetch(200, { webhooks: [HOOK] });
    await main(['webhooks']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/webhooks`);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers.Authorization).toBe('Bearer floe_live_test');
    expect(stdout).toContain('https://example.com/hook');
    expect(stdout).toContain('active');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--json round-trips the raw list', async () => {
    stubFetch(200, { webhooks: [HOOK] });
    await main(['webhooks', 'list', '--json']);
    const parsed = JSON.parse(stdout) as { webhooks: Array<typeof HOOK> };
    expect(parsed.webhooks[0]).toEqual(HOOK);
  });

  it('maps 402 to exit 5', async () => {
    stubFetch(402, { error: 'payment_required', message: 'Balance exhausted' });
    await main(['webhooks', 'list']);
    expect(stderr).toContain('Balance exhausted');
    expect(process.exitCode).toBe(5);
  });
});

describe('webhooks create', () => {
  it('POSTs the exact body and prints the secret exactly once', async () => {
    const { calls } = stubFetch(201, { webhook: { ...HOOK, secret: 'whsec_abc123' } });
    await main([
      'webhooks', 'create', 'https://example.com/hook',
      '--events', 'loan.repaid,loan.liquidated',
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/webhooks`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      url: 'https://example.com/hook',
      events: ['loan.repaid', 'loan.liquidated'],
      scope: 'global',
    });
    expect(stdout.split('whsec_abc123').length - 1).toBe(1);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('sends scope + scopeValue for loan scope', async () => {
    const { calls } = stubFetch(201, {
      webhook: { ...HOOK, scope: 'loan', scopeValue: '42', secret: 'whsec_x' },
    });
    await main([
      'webhooks', 'create', 'https://example.com/hook',
      '--events', 'loan.repaid', '--scope', 'loan', '--scope-value', '42',
    ]);
    expect(calls[0]!.body).toEqual({
      url: 'https://example.com/hook',
      events: ['loan.repaid'],
      scope: 'loan',
      scopeValue: '42',
    });
  });

  it('--json includes the once-only secret', async () => {
    stubFetch(201, { webhook: { ...HOOK, secret: 'whsec_abc123' } });
    await main(['webhooks', 'create', 'https://example.com/hook', '--events', 'loan.repaid', '--json']);
    const parsed = JSON.parse(stdout) as { webhook: { secret: string } };
    expect(parsed.webhook.secret).toBe('whsec_abc123');
  });

  it('rejects unknown events before any network call', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'create', 'https://example.com/hook', '--events', 'loan.exploded']);
    expect(stderr).toContain('Unknown event(s): loan.exploded');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects --scope loan without a numeric --scope-value, pre-network', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'create', 'https://example.com/hook', '--events', 'loan.repaid', '--scope', 'loan']);
    expect(stderr).toContain('--scope loan requires');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts the expanded catalog, including loan.overdue', async () => {
    const { calls } = stubFetch(201, { webhook: { ...HOOK, secret: 'whsec_x' } });
    await main([
      'webhooks', 'create', 'https://example.com/hook',
      '--events', 'loan.overdue,call.ended,marketplace.job.completed',
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      url: 'https://example.com/hook',
      events: ['loan.overdue', 'call.ended', 'marketplace.job.completed'],
      scope: 'global',
    });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('sends scope + wallet scopeValue for agent scope', async () => {
    const wallet = '0x1234567890abcdef1234567890abcdef12345678';
    const { calls } = stubFetch(201, {
      webhook: { ...HOOK, scope: 'agent', scopeValue: wallet, secret: 'whsec_x' },
    });
    await main([
      'webhooks', 'create', 'https://example.com/hook',
      '--events', 'call.ended', '--scope', 'agent', '--scope-value', wallet,
    ]);
    expect(calls[0]!.body).toEqual({
      url: 'https://example.com/hook',
      events: ['call.ended'],
      scope: 'agent',
      scopeValue: wallet,
    });
  });

  it('rejects --scope agent without a wallet --scope-value, pre-network', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'create', 'https://example.com/hook', '--events', 'call.ended', '--scope', 'agent']);
    expect(stderr).toContain('--scope agent requires');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts '*' and prefix wildcards the API contract allows", async () => {
    const { calls } = stubFetch(201, { webhook: { ...HOOK, secret: 'whsec_x' } });
    await main(['webhooks', 'create', 'https://example.com/hook', '--events', 'call.*,loan.repaid']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      url: 'https://example.com/hook',
      events: ['call.*', 'loan.repaid'],
      scope: 'global',
    });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('rejects a wildcard covering no catalog events, pre-network', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'create', 'https://example.com/hook', '--events', 'bogus.*']);
    expect(stderr).toContain('Unknown event(s): bogus.*');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('remaps the max-webhooks limit error to a friendly message', async () => {
    stubFetch(400, { error: 'Limit exceeded', message: 'Maximum 10 webhooks allowed' });
    await main(['webhooks', 'create', 'https://example.com/hook', '--events', 'loan.repaid']);
    expect(stderr).toContain('maximum of 10 webhooks');
    expect(process.exitCode).toBe(1);
  });
});

describe('webhooks get', () => {
  it('shows one webhook with delivery stats', async () => {
    const { calls } = stubFetch(200, { webhook: HOOK, deliveryStats: { success: 3, failed: 1 } });
    await main(['webhooks', 'get', '7']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/webhooks/7`);
    expect(calls[0]!.method).toBe('GET');
    expect(stdout).toContain('https://example.com/hook');
    expect(stdout).toContain('3 success');
    expect(stdout).toContain('1 failed');
  });

  it('omits total and zero-count statuses from the dense stats shape', async () => {
    stubFetch(200, {
      webhook: HOOK,
      deliveryStats: { pending: 0, success: 3, failed: 0, retrying: 0, total: 3 },
    });
    await main(['webhooks', 'get', '7']);
    expect(stdout).toContain('3 success');
    expect(stdout).not.toContain('total');
    expect(stdout).not.toContain('0 pending');
  });

  it('shows the empty state when the dense stats are all zero', async () => {
    stubFetch(200, {
      webhook: HOOK,
      deliveryStats: { pending: 0, success: 0, failed: 0, retrying: 0, total: 0 },
    });
    await main(['webhooks', 'get', '7']);
    expect(stdout).toContain('none yet');
  });

  it('rejects a non-numeric id before any network call', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'get', 'abc']);
    expect(stderr).toContain('must be numeric');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('names the webhook on 404', async () => {
    stubFetch(404, { error: 'Not found' });
    await main(['webhooks', 'get', '99']);
    expect(stderr).toContain('Webhook 99 not found');
    expect(process.exitCode).toBe(1);
  });
});

describe('webhooks pause / enable', () => {
  it('pause PATCHes active:false', async () => {
    const { calls } = stubFetch(200, { webhook: { ...HOOK, active: false } });
    await main(['webhooks', 'pause', '7']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/webhooks/7`);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({ active: false });
    expect(stdout).toContain('paused');
  });

  it('enable PATCHes active:true with --json parity', async () => {
    const { calls } = stubFetch(200, { webhook: HOOK });
    await main(['webhooks', 'enable', '7', '--json']);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({ active: true });
    expect((JSON.parse(stdout) as { webhook: { active: boolean } }).webhook.active).toBe(true);
  });
});

describe('webhooks delete', () => {
  it('refuses without --yes when non-interactive and makes no network call', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'delete', '7']);
    expect(stderr).toContain('--yes');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('deletes with --yes', async () => {
    const { calls } = stubFetch(200, { message: 'Webhook deleted' });
    await main(['webhooks', 'delete', '7', '--yes']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/webhooks/7`);
    expect(calls[0]!.method).toBe('DELETE');
    expect(stdout).toContain('deleted');
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('webhooks test', () => {
  it('POSTs the test route and prints a successful outcome', async () => {
    const { calls } = stubFetch(200, { success: true, statusCode: 200, deliveryId: 'd1' });
    await main(['webhooks', 'test', '7']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/webhooks/7/test`);
    expect(calls[0]!.method).toBe('POST');
    expect(stdout).toContain('HTTP 200');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('exits 1 when the delivery fails', async () => {
    stubFetch(200, { success: false, error: 'connect ECONNREFUSED', deliveryId: 'd2' });
    await main(['webhooks', 'test', '7']);
    expect(stdout).toContain('failed');
    expect(stdout).toContain('ECONNREFUSED');
    expect(process.exitCode).toBe(1);
  });
});

describe('webhooks rotate-secret', () => {
  it('prints the new secret exactly once', async () => {
    const { calls } = stubFetch(200, { secret: 'whsec_new456' });
    await main(['webhooks', 'rotate-secret', '7']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/webhooks/7/rotate-secret`);
    expect(calls[0]!.method).toBe('POST');
    expect(stdout.split('whsec_new456').length - 1).toBe(1);
  });

  it('--json carries the secret', async () => {
    stubFetch(200, { secret: 'whsec_new456' });
    await main(['webhooks', 'rotate-secret', '7', '--json']);
    expect(JSON.parse(stdout)).toEqual({ rotated: true, id: 7, secret: 'whsec_new456' });
  });
});

describe('webhooks deliveries', () => {
  it('lists deliveries with --limit as a query param', async () => {
    const { calls } = stubFetch(200, { deliveries: [DELIVERY] });
    await main(['webhooks', 'deliveries', '7', '--limit', '10']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/webhooks/7/deliveries?limit=10`);
    expect(calls[0]!.method).toBe('GET');
    expect(stdout).toContain(DELIVERY.deliveryId);
    expect(stdout).toContain('loan.repaid');
  });

  it('--json includes webhookId, limit, and rows', async () => {
    stubFetch(200, { deliveries: [DELIVERY] });
    await main(['webhooks', 'deliveries', '7', '--json']);
    const parsed = JSON.parse(stdout) as { webhookId: number; limit: number; deliveries: unknown[] };
    expect(parsed.webhookId).toBe(7);
    expect(parsed.limit).toBe(50);
    expect(parsed.deliveries).toEqual([DELIVERY]);
  });

  it('rejects an out-of-range --limit before any network call', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'deliveries', '7', '--limit', '500']);
    expect(stderr).toContain('between 1 and 100');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('--retry POSTs the retry route and reports the outcome', async () => {
    const { calls } = stubFetch(200, { success: true, statusCode: 204, deliveryId: 'd9' });
    await main(['webhooks', 'deliveries', '7', '--retry', 'd9']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/webhooks/7/deliveries/d9/retry`);
    expect(calls[0]!.method).toBe('POST');
    expect(stdout).toContain('HTTP 204');
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('webhooks events', () => {
  const CATALOG = [
    { name: 'loan.repaid', title: 'Loan repaid', description: 'A loan was repaid', category: 'loan', scope: 'loan' },
    { name: 'call.ended', title: 'Call ended', description: 'A voice call ended', category: 'call', scope: 'agent' },
    { name: 'call.analyzed', title: 'Call analyzed', description: 'Post-call analysis ready', category: 'call', scope: 'agent' },
  ];

  it('renders the catalog sorted by category then name', async () => {
    const { calls } = stubFetch(200, { events: CATALOG });
    await main(['webhooks', 'events']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/webhooks/events`);
    expect(calls[0]!.method).toBe('GET');
    expect(stdout).toContain('CATEGORY');
    expect(stdout).toContain('A voice call ended');
    // call.analyzed < call.ended < loan.repaid once sorted category-then-name
    expect(stdout.indexOf('call.analyzed')).toBeLessThan(stdout.indexOf('call.ended'));
    expect(stdout.indexOf('call.ended')).toBeLessThan(stdout.indexOf('loan.repaid'));
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--json round-trips the catalog unsorted', async () => {
    stubFetch(200, { events: CATALOG });
    await main(['webhooks', 'events', '--json']);
    expect(JSON.parse(stdout)).toEqual({ events: CATALOG });
  });

  it('explains a 404 from an API build without the catalog endpoint', async () => {
    stubFetch(404, { error: 'Not found' });
    await main(['webhooks', 'events']);
    expect(stderr).toContain('predates the webhook event catalog');
    expect(stderr).toContain('still valid');
    expect(process.exitCode).toBe(1);
  });
});

describe('webhooks logs', () => {
  it('GETs the account-wide log without filters and renders the table', async () => {
    const { calls } = stubFetch(200, {
      deliveries: [LOG_ROW, LOG_ROW_SESSION],
      nextCursor: null,
      hasMore: false,
    });
    await main(['webhooks', 'logs']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/webhook-deliveries`);
    expect(calls[0]!.method).toBe('GET');
    expect(stdout).toContain('2026-08-10 09:15'); // AT
    expect(stdout).toContain('#7'); // ENDPOINT
    expect(stdout).toContain('call.ended');
    expect(stdout).toContain('0x1234…5678'); // shortened wallet
    expect(stdout).toContain('CA9f2f0f5c'); // correlation id wins over wallet
    expect(stdout).toContain('500');
    expect(stdout).toContain('failed');
    expect(stdout).toContain('--retry');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('lands every filter in the query string, with from/to normalized to ISO', async () => {
    const { calls } = stubFetch(200, { deliveries: [], nextCursor: null, hasMore: false });
    await main([
      'webhooks', 'logs',
      '--endpoint', '7',
      '--event', 'call.ended',
      '--agent', '0x1234567890abcdef1234567890abcdef12345678',
      '--status', 'failed',
      '--from', '2026-08-01',
      '--to', '2026-08-05T10:00:00Z',
      '--id', 'CA9f2f0f5c',
      '--cursor', 'cur_opaque',
      '--limit', '25',
    ]);
    const params = new URL(calls[0]!.url).searchParams;
    expect(calls[0]!.url.startsWith(`${API}/v1/developer/webhook-deliveries?`)).toBe(true);
    expect(params.get('endpoint')).toBe('7');
    expect(params.get('event')).toBe('call.ended');
    expect(params.get('agent')).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(params.get('status')).toBe('failed');
    expect(params.get('from')).toBe('2026-08-01T00:00:00.000Z');
    expect(params.get('to')).toBe('2026-08-05T10:00:00.000Z');
    expect(params.get('id')).toBe('CA9f2f0f5c');
    expect(params.get('cursor')).toBe('cur_opaque');
    expect(params.get('limit')).toBe('25');
  });

  it('rejects a non-numeric --endpoint before any network call', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'logs', '--endpoint', 'my-hook']);
    expect(stderr).toContain('numeric webhook id');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a malformed --agent before any network call', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'logs', '--agent', '42']);
    expect(stderr).toContain('wallet address');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an unparseable --from before any network call', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'logs', '--from', 'yesterday-ish']);
    expect(stderr).toContain('ISO 8601');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an unknown --event before any network call', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'logs', '--event', 'loan.exploded']);
    expect(stderr).toContain('Unknown --event');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an unknown --status before any network call', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'logs', '--status', 'bogus']);
    expect(stderr).toContain('Unknown --status "bogus"');
    expect(stderr).toContain('pending, retrying, success, failed');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts every documented --status value and lands it in the query string', async () => {
    for (const status of ['pending', 'retrying', 'success', 'failed']) {
      const { calls } = stubFetch(200, { deliveries: [], nextCursor: null, hasMore: false });
      await main(['webhooks', 'logs', '--status', status]);
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0]!.url).searchParams.get('status')).toBe(status);
      expect(process.exitCode ?? 0).toBe(0);
    }
  });

  it('prints the real next cursor when hasMore', async () => {
    stubFetch(200, { deliveries: [LOG_ROW], nextCursor: 'cur_next123', hasMore: true });
    await main(['webhooks', 'logs']);
    expect(stdout).toContain('floe webhooks logs --cursor cur_next123');
  });

  it('repeats the active filters in the next-page hint', async () => {
    stubFetch(200, { deliveries: [LOG_ROW], nextCursor: 'cur_next123', hasMore: true });
    await main(['webhooks', 'logs', '--status', 'failed', '--event', 'call.ended']);
    // Filters ride along so page 2 stays the same result set, not the
    // unfiltered account-wide log. Query-insertion order: event before status.
    expect(stdout).toContain(
      'floe webhooks logs --event call.ended --status failed --cursor cur_next123',
    );
  });

  it('omits the cursor hint on the last page', async () => {
    stubFetch(200, { deliveries: [LOG_ROW], nextCursor: null, hasMore: false });
    await main(['webhooks', 'logs']);
    expect(stdout).not.toContain('--cursor');
  });

  it('suggests widening filters or a test event when nothing matches', async () => {
    stubFetch(200, { deliveries: [], nextCursor: null, hasMore: false });
    await main(['webhooks', 'logs', '--status', 'failed']);
    expect(stdout).toContain('Widen the filters');
    expect(stdout).toContain('floe webhooks test');
  });

  it('--json emits {deliveries, nextCursor, hasMore} verbatim', async () => {
    stubFetch(200, { deliveries: [LOG_ROW], nextCursor: 'cur_next123', hasMore: true });
    await main(['webhooks', 'logs', '--json']);
    expect(JSON.parse(stdout)).toEqual({
      deliveries: [LOG_ROW],
      nextCursor: 'cur_next123',
      hasMore: true,
    });
  });
});

describe('webhooks help', () => {
  it('lists catalog events in the usage text without a network call', async () => {
    const spy = stubNoFetch();
    await main(['help', 'webhooks']);
    // Spot-check first and last catalog entries — proves the derived list renders.
    expect(stdout).toContain('loan.health_warning');
    expect(stdout).toContain('loan.overdue');
    expect(stdout).toContain('marketplace.vendor.recovered');
    expect(process.exitCode ?? 0).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('webhooks dispatch', () => {
  it('rejects an unknown subcommand', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'frobnicate']);
    expect(stderr).toContain('Unknown webhooks subcommand');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects extra positionals', async () => {
    const spy = stubNoFetch();
    await main(['webhooks', 'get', '7', 'extra']);
    expect(stderr).toContain('Unexpected argument');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });
});
