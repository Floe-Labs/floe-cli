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

/** Run `fn` with a temp XDG_CONFIG_HOME containing a v2 config. */
async function withConfig(fn: () => Promise<void>, config: unknown = CONFIG): Promise<void> {
  const dir = `${process.cwd()}/test/.tmp-agents-${process.pid}-${tmpSeq++}`;
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

/** Stub global fetch with a "METHOD /path" → response router; returns the call log. */
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

describe('agents list', () => {
  it('lists agents in a table and marks the machine agent', async () => {
    await withConfig(async () => {
      const calls = stubFetch({ 'GET /v1/developer/agents': () => FLEET });
      await main(['agents', 'list']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: 'GET',
        path: '/v1/developer/agents',
        auth: 'Bearer floe_live_test',
      });
      expect(stdout).toContain('● my-agent');
      expect(stdout).toContain('other-agent');
      expect(stdout).toContain('2026-08-01');
    });
  });

  it('--rollup hits the console rollup endpoint and formats money', async () => {
    await withConfig(async () => {
      const calls = stubFetch({
        'GET /v1/developer/agents/rollup': () => ({
          body: {
            agents: [
              {
                id: 'agent-1',
                name: 'my-agent',
                status: 'active',
                balanceRaw: '2500000',
                spend30dRaw: '340000',
                phone: '+15550001111',
                keysCount: 2,
              },
            ],
          },
        }),
      });
      await main(['agents', 'list', '--rollup']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls[0]?.path).toBe('/v1/developer/agents/rollup');
      expect(stdout).toContain('$2.50');
      expect(stdout).toContain('$0.34');
      expect(stdout).toContain('+15550001111');
    });
  });

  it('--json passes the server shape through verbatim', async () => {
    await withConfig(async () => {
      stubFetch({ 'GET /v1/developer/agents': () => FLEET });
      await main(['agents', 'list', '--json']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ agents: [AGENT_1, AGENT_2] });
    });
  });
});

describe('agents get', () => {
  const DETAIL = {
    agent: AGENT_1,
    creditUsed: '150000',
    recentTransactionCount24h: 7,
    sessionSpend: { limitRaw: null, startedAtUnix: null },
  };
  const USAGE = {
    totalCalls: 3,
    totalCostRaw: '340000',
    byModel: [{ model: 'openai/gpt-4o-mini', rail: 'llm', calls: 3, costRaw: '340000' }],
  };

  it('resolves a name and shows the detail endpoint fields', async () => {
    await withConfig(async () => {
      const calls = stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'GET /v1/developer/agents/agent-1': () => ({ body: DETAIL }),
      });
      await main(['agents', 'get', 'my-agent']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls.map((c) => c.path)).toEqual([
        '/v1/developer/agents',
        '/v1/developer/agents/agent-1',
      ]);
      expect(stdout).toContain('my-agent');
      expect(stdout).toContain('0xabc');
      expect(stdout).toContain('$0.15'); // creditUsed
      expect(stdout).toContain('$1000.00'); // creditLimit
    });
  });

  it('--usage folds in gateway usage and renders a missing reputation as an em dash', async () => {
    await withConfig(async () => {
      const calls = stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'GET /v1/developer/agents/agent-1': () => ({ body: DETAIL }),
        'GET /v1/developer/agents/agent-1/gateway-usage': () => ({ body: USAGE }),
        'GET /v1/developer/agents/agent-1/reputation': () => ({
          status: 404,
          body: { error: 'no_reputation_yet' },
        }),
      });
      await main(['agents', 'get', '--usage']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls.map((c) => c.path)).toContain('/v1/developer/agents/agent-1/reputation');
      expect(stdout).toContain('openai/gpt-4o-mini');
      expect(stdout).toContain('$0.34');
      expect(stdout).toMatch(/Reputation\s+—/);
    });
  });

  it('--usage --json reports reputation: null on 404', async () => {
    await withConfig(async () => {
      stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'GET /v1/developer/agents/agent-1': () => ({ body: DETAIL }),
        'GET /v1/developer/agents/agent-1/gateway-usage': () => ({ body: USAGE }),
        'GET /v1/developer/agents/agent-1/reputation': () => ({
          status: 404,
          body: { error: 'no_reputation_yet' },
        }),
      });
      await main(['agents', 'get', '--usage', '--json']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ ...DETAIL, usage: USAGE, reputation: null });
    });
  });
});

describe('agents create', () => {
  it('sends the required delegation defaults plus borrowLimitRaw and suggests floe use', async () => {
    await withConfig(async () => {
      const calls = stubFetch({
        'POST /v1/developer/agents': () => ({
          status: 201,
          body: {
            agentId: 'agent-3',
            status: 'active',
            privyWalletAddress: '0xccc',
            delegationTxHash: '0xtx',
          },
        }),
      });
      await main(['agents', 'create', 'bot', '--credit-limit', '25']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.body).toEqual({
        name: 'bot',
        maxRateBps: 1000,
        expirySeconds: 31536000,
        borrowLimitRaw: '25000000',
      });
      expect(stdout).toContain('agent-3');
      expect(stdout).toContain('floe use bot');
    });
  });

  it('rejects an invalid --credit-limit before any network call', async () => {
    await withConfig(async () => {
      const calls = stubFetch({});
      await main(['agents', 'create', 'bot', '--credit-limit', 'lots']);
      expect(process.exitCode).toBe(2);
      expect(stderr).toContain('Invalid USD amount');
      expect(calls).toHaveLength(0);
    });
  });

  it('requires a name', async () => {
    await withConfig(async () => {
      const calls = stubFetch({});
      await main(['agents', 'create']);
      expect(process.exitCode).toBe(2);
      expect(stderr).toContain('Usage: floe agents create');
      expect(calls).toHaveLength(0);
    });
  });

  it('rejects an invalid agent name before any network call', async () => {
    await withConfig(async () => {
      const calls = stubFetch({});
      await main(['agents', 'create', 'bad/name']);
      expect(process.exitCode).toBe(2);
      expect(stderr).toContain('1–64 characters');
      expect(calls).toHaveLength(0);
    });
  });

  it('remaps limit_exceeded to a friendly agent-cap error', async () => {
    await withConfig(async () => {
      stubFetch({
        'POST /v1/developer/agents': () => ({
          status: 409,
          body: { error: 'limit_exceeded', max: 5 },
        }),
      });
      await main(['agents', 'create', 'bot']);
      expect(process.exitCode).toBe(1);
      expect(stderr).toContain('close an unused agent');
    });
  });
});

describe('agents pause / resume', () => {
  it('pause PATCHes status=suspended without confirmation', async () => {
    await withConfig(async () => {
      const calls = stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'PATCH /v1/developer/agents/agent-1/status': () => ({
          body: { id: 'agent-1', status: 'suspended', suspendedReason: 'developer_manual' },
        }),
      });
      await main(['agents', 'pause', 'my-agent']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls[1]).toMatchObject({
        method: 'PATCH',
        path: '/v1/developer/agents/agent-1/status',
        body: { status: 'suspended' },
      });
      expect(stdout).toContain('can no longer spend');
    });
  });

  it('resume PATCHes status=active', async () => {
    await withConfig(async () => {
      const suspended = { ...AGENT_1, status: 'suspended', suspendedReason: 'developer_manual' };
      const calls = stubFetch({
        'GET /v1/developer/agents': () => ({ body: { agents: [suspended, AGENT_2] } }),
        'PATCH /v1/developer/agents/agent-1/status': () => ({
          body: { id: 'agent-1', status: 'active', suspendedReason: null },
        }),
      });
      await main(['agents', 'resume', 'my-agent']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls[1]?.body).toEqual({ status: 'active' });
      expect(stdout).toContain('resumed');
    });
  });
});

describe('agents close', () => {
  it('refuses without --yes in non-interactive mode, before any network call', async () => {
    await withConfig(async () => {
      const calls = stubFetch({});
      await main(['agents', 'close', 'my-agent']);
      expect(process.exitCode).toBe(2);
      expect(stderr).toContain('--yes');
      expect(calls).toHaveLength(0);
    });
  });

  it('with --yes closes and warns that this machine needs floe use', async () => {
    await withConfig(async () => {
      const calls = stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'POST /v1/developer/agents/agent-1/close': () => ({
          body: {
            status: 'closed',
            loansRepaid: 1,
            loansRemaining: 0,
            usdcTransferred: '4500000',
            transferTxHash: '0xsweep',
          },
        }),
      });
      await main(['agents', 'close', 'my-agent', '--yes']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'GET /v1/developer/agents',
        'POST /v1/developer/agents/agent-1/close',
      ]);
      expect(stdout).toContain('closed');
      expect(stdout).toContain('$4.50');
      expect(stdout).toContain('floe use');
    });
  });

  it('surfaces a 409 close refusal as an error exit', async () => {
    await withConfig(async () => {
      stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'POST /v1/developer/agents/agent-1/close': () => ({
          status: 409,
          body: {
            error: 'unrecovered_facilitator_debt',
            message: 'Agent has unrecovered facilitator debt of 120000.',
          },
        }),
      });
      await main(['agents', 'close', 'my-agent', '--yes']);
      expect(process.exitCode).toBe(1);
      expect(stderr).toContain('unrecovered facilitator debt');
    });
  });
});

describe('agents lock', () => {
  it('with no flags shows the current lock state', async () => {
    await withConfig(async () => {
      const calls = stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'GET /v1/developer/agents/agent-1/self-service-lock': () => ({ body: { locked: false } }),
      });
      await main(['agents', 'lock']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls[1]?.method).toBe('GET');
      expect(stdout).toContain('off');
    });
  });

  it('--on PUTs locked=true', async () => {
    await withConfig(async () => {
      const calls = stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'PUT /v1/developer/agents/agent-1/self-service-lock': () => ({ body: { locked: true } }),
      });
      await main(['agents', 'lock', '--on', '--json']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls[1]).toMatchObject({ method: 'PUT', body: { locked: true } });
      expect(JSON.parse(stdout)).toEqual({ agentId: 'agent-1', locked: true });
    });
  });

  it('--off with --agent targets the named agent', async () => {
    await withConfig(async () => {
      const calls = stubFetch({
        'GET /v1/developer/agents': () => FLEET,
        'PUT /v1/developer/agents/agent-2/self-service-lock': () => ({ body: { locked: false } }),
      });
      await main(['agents', 'lock', '--off', '--agent', 'other-agent']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls[1]).toMatchObject({
        method: 'PUT',
        path: '/v1/developer/agents/agent-2/self-service-lock',
        body: { locked: false },
      });
    });
  });
});

describe('agents dispatch', () => {
  it('rejects an unknown subcommand with the valid list', async () => {
    await withConfig(async () => {
      const calls = stubFetch({});
      await main(['agents', 'frobnicate']);
      expect(process.exitCode).toBe(2);
      expect(stderr).toContain('Unknown agents subcommand');
      expect(calls).toHaveLength(0);
    });
  });

  it('rejects extra positionals', async () => {
    await withConfig(async () => {
      const calls = stubFetch({});
      await main(['agents', 'pause', 'my-agent', 'extra']);
      expect(process.exitCode).toBe(2);
      expect(stderr).toContain('Unexpected argument');
      expect(calls).toHaveLength(0);
    });
  });
});
