import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;
let dir: string | undefined;

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
});

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

function setup(tag: string): void {
  dir = `${process.cwd()}/test/.tmp-budget-${tag}-${process.pid}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/floe`, { recursive: true });
  writeFileSync(
    `${dir}/floe/config.json`,
    JSON.stringify({
      apiUrl: 'https://credit-api.floelabs.xyz',
      activeAgentId: 'agent-1',
      agents: { 'agent-1': { name: 'my-agent', wallet: '0xabc', keyId: 'key-1', keyPrefix: 'floe_ab12' } },
    }),
  );
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
}

interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | undefined;
}

function stubApi(
  handler: (method: string, pathname: string) => { status?: number; body: unknown } | undefined,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        method,
        path: url.pathname + url.search,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        auth: headers.Authorization,
      });
      const res = handler(method, url.pathname);
      if (!res) {
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      }
      return new Response(JSON.stringify(res.body), { status: res.status ?? 200 });
    }),
  );
  return calls;
}

const RESERVE_RESPONSE = {
  policyId: 77,
  taskId: 'run-42',
  limitRaw: '3000000',
  expiresAt: 1_786_540_800,
  expiresAtIso: '2026-08-07T12:00:00.000Z',
};

describe('budget reserve', () => {
  it('POSTs a pre-borrow hold for the active agent', async () => {
    setup('reserve');
    const calls = stubApi(() => ({ status: 201, body: RESERVE_RESPONSE }));
    await main(['budget', 'reserve', '--task', 'run-42', '--amount', '3', '--ttl', '2h']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/developer/agents/agent-1/pre-borrow',
      auth: 'Bearer floe_live_test',
    });
    expect(calls[0]!.body).toEqual({ taskId: 'run-42', amountRaw: '3000000', ttlSeconds: 7_200 });
    expect(stdout).toContain('Reserved $3.00 for task "run-42"');
    expect(stdout).toContain('X-Floe-Task-Id: run-42');
    expect(stdout).toContain('2026-08-07T12:00:00.000Z');
  });

  it('omits ttlSeconds when --ttl is not passed (server default)', async () => {
    setup('reserve-nottl');
    const calls = stubApi(() => ({ status: 201, body: RESERVE_RESPONSE }));
    await main(['budget', 'reserve', '--task', 'run-42', '--amount', '3']);
    expect(calls[0]!.body).toEqual({ taskId: 'run-42', amountRaw: '3000000' });
  });

  it('resolves --agent via the fleet', async () => {
    setup('reserve-agent');
    const calls = stubApi((_method, pathname) => {
      if (pathname === '/v1/developer/agents') {
        return {
          body: {
            agents: [
              { id: 'agent-1', name: 'my-agent', status: 'active' },
              { id: 'agent-2', name: 'other', status: 'active' },
            ],
          },
        };
      }
      return { status: 201, body: RESERVE_RESPONSE };
    });
    await main(['budget', 'reserve', '--task', 'run-42', '--amount', '3', '--agent', 'other']);
    expect(calls[1]!.path).toBe('/v1/developer/agents/agent-2/pre-borrow');
  });

  it('--json passes the pre-borrow response through', async () => {
    setup('reserve-json');
    stubApi(() => ({ status: 201, body: RESERVE_RESPONSE }));
    await main(['budget', 'reserve', '--task', 'run-42', '--amount', '3', '--json']);
    expect(JSON.parse(stdout)).toEqual(RESERVE_RESPONSE);
  });

  it('requires --task before any network call', async () => {
    setup('reserve-notask');
    const calls = stubApi(() => undefined);
    await main(['budget', 'reserve', '--amount', '3']);
    expect(stderr).toContain('--task');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('rejects an invalid --amount before any network call', async () => {
    setup('reserve-badamount');
    const calls = stubApi(() => undefined);
    await main(['budget', 'reserve', '--task', 'run-42', '--amount', 'lots']);
    expect(stderr).toContain('Invalid USD amount');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('rejects a --ttl above the API 24h cap before any network call', async () => {
    setup('reserve-bigttl');
    const calls = stubApi(() => undefined);
    await main(['budget', 'reserve', '--task', 'run-42', '--amount', '3', '--ttl', '2d']);
    expect(stderr).toContain('24h');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('remaps task_already_held to an actionable error', async () => {
    setup('reserve-held');
    stubApi(() => ({ status: 409, body: { error: 'task_already_held', message: 'held' } }));
    await main(['budget', 'reserve', '--task', 'run-42', '--amount', '3']);
    expect(stderr).toContain('already has an active hold');
    expect(process.exitCode).toBe(1);
  });

  it('maps a 402 to exit code 5', async () => {
    setup('reserve-402');
    stubApi(() => ({ status: 402, body: { error: 'payment_required', message: 'payment required' } }));
    await main(['budget', 'reserve', '--task', 'run-42', '--amount', '3']);
    expect(process.exitCode).toBe(5);
  });
});

describe('budget show/set/clear (existing surface, unchanged)', () => {
  it('shows the spend limit and key budget', async () => {
    setup('show');
    const calls = stubApi((_method, pathname) => {
      if (pathname === '/v1/developer/agents/agent-1/spend-limit') {
        return { body: { active: true, limitRaw: '5000000', sessionSpentRaw: '500000', sessionRemainingRaw: '4500000' } };
      }
      if (pathname === '/v1/developer/agents/agent-1/keys') {
        return {
          body: {
            keys: [
              {
                id: 'key-1',
                keyPrefix: 'floe_ab12',
                label: 'floe-cli',
                permissions: 'read_write',
                lastUsedAt: null,
                createdAt: '2026-08-01T00:00:00.000Z',
                budget: null,
              },
            ],
          },
        };
      }
      return undefined;
    });
    await main(['budget', 'show']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls).toHaveLength(2);
    expect(stdout).toContain('$4.50 of $5.00 remaining');
  });

  it('sets the total spend limit', async () => {
    setup('set');
    const calls = stubApi(() => ({ body: { active: true, limitRaw: '5000000' } }));
    await main(['budget', 'set', '5']);
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/v1/developer/agents/agent-1/spend-limit' });
    expect(calls[0]!.body).toEqual({ limitRaw: '5000000' });
  });

  it('sets a per-day key budget', async () => {
    setup('set-day');
    const calls = stubApi(() => ({
      body: { budget: { policyId: '9', limitRaw: '5000000', spentRaw: '0', remainingRaw: '5000000', windowKind: 'rolling', windowResetsAt: null } },
    }));
    await main(['budget', 'set', '5', '--per', 'day']);
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/v1/developer/agents/agent-1/keys/key-1/budget' });
    expect(calls[0]!.body).toEqual({ budgetRaw: '5000000', windowSeconds: 86_400 });
  });

  it('clears the total spend limit', async () => {
    setup('clear');
    const calls = stubApi(() => ({ body: { status: 'cleared' } }));
    await main(['budget', 'clear']);
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/v1/developer/agents/agent-1/spend-limit' });
    expect(stdout).toContain('cleared');
  });

  it('rejects unknown subcommands, listing reserve', async () => {
    setup('unknown');
    const calls = stubApi(() => undefined);
    await main(['budget', 'frobnicate']);
    expect(stderr).toContain('reserve');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
