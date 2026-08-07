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
