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

/** Config v2 with an active agent, plus the dev key via env (keychain never consulted). */
function setup(tag: string): void {
  dir = `${process.cwd()}/test/.tmp-policy-${tag}-${process.pid}`;
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

const POLICY = {
  id: 12,
  scope: 'agent',
  kind: 'api',
  matchKey: '.openai.com',
  matchKind: 'host_suffix',
  limitRaw: '5000000',
  windowKind: 'rolling',
  windowSeconds: 86_400,
  expiresAt: null,
  action: null,
  status: 'active',
  label: 'OpenAI',
  createdAt: '2026-08-01T00:00:00.000Z',
};

describe('policy list', () => {
  it('lists the active agent policies on the developer plane', async () => {
    setup('list');
    const calls = stubApi(() => ({ body: { policies: [POLICY] } }));
    await main(['policy', 'list']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/v1/developer/agents/agent-1/policies',
      auth: 'Bearer floe_live_test',
    });
    expect(stdout).toContain('.openai.com');
    expect(stdout).toContain('$5.00');
    expect(stdout).toContain('1d rolling');
  });

  it('--include-revoked adds the query param', async () => {
    setup('list-revoked');
    const calls = stubApi(() => ({ body: { policies: [] } }));
    await main(['policy', 'list', '--include-revoked']);
    expect(calls[0]!.path).toBe('/v1/developer/agents/agent-1/policies?includeRevoked=true');
  });

  it('--json emits agentId + raw policies', async () => {
    setup('list-json');
    stubApi(() => ({ body: { policies: [POLICY] } }));
    await main(['policy', '--json']);
    expect(JSON.parse(stdout)).toEqual({ agentId: 'agent-1', policies: [POLICY] });
  });

  it('--team folds in the account cap and defaults', async () => {
    setup('list-team');
    const calls = stubApi((_method, pathname) => {
      if (pathname === '/v1/developer/policies') return { body: { policies: [{ ...POLICY, id: 30, scope: 'developer' }] } };
      if (pathname === '/v1/developer/policies/account-cap') {
        return {
          body: { configured: true, limitRaw: '100000000', spentRaw: '25000000', windowKind: 'session', windowResetsAt: null },
        };
      }
      if (pathname === '/v1/developer/policies/defaults') {
        return { body: { sessionLimitRaw: '100000000', autoPauseEnabled: true, allowlistMode: 'off' } };
      }
      return undefined;
    });
    await main(['policy', 'list', '--team']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls.map((c) => c.path).sort()).toEqual([
      '/v1/developer/policies',
      '/v1/developer/policies/account-cap',
      '/v1/developer/policies/defaults',
    ]);
    expect(stdout).toContain('Account cap');
    expect(stdout).toContain('$25.00 spent of $100.00');
    expect(stdout).toContain('auto-pause on');
  });

  it('resolves --agent by name via the fleet', async () => {
    setup('list-agent');
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
      return { body: { policies: [] } };
    });
    await main(['policy', 'list', '--agent', 'other']);
    expect(calls[1]!.path).toBe('/v1/developer/agents/agent-2/policies');
  });

  it('rejects --agent together with --team before any network call', async () => {
    setup('scope-clash');
    const calls = stubApi(() => undefined);
    await main(['policy', 'list', '--agent', 'x', '--team']);
    expect(stderr).toContain('mutually exclusive');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe('policy create', () => {
  it('creates an api policy with a derived host_suffix matchKind', async () => {
    setup('create-api');
    const calls = stubApi(() => ({ status: 201, body: { policy: POLICY } }));
    await main(['policy', 'create', '--kind', 'api', '--match', '.openai.com', '--limit', '5']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/developer/agents/agent-1/policies' });
    expect(calls[0]!.body).toEqual({
      kind: 'api',
      matchKey: '.openai.com',
      matchKind: 'host_suffix',
      limitRaw: '5000000',
      windowKind: 'rolling',
      windowSeconds: 86_400,
    });
    expect(stdout).toContain('Policy 12 created');
  });

  it('creates a once-window task policy (no windowSeconds)', async () => {
    setup('create-task');
    const calls = stubApi(() => ({
      status: 201,
      body: { policy: { ...POLICY, id: 13, kind: 'task', matchKey: 'run-42', matchKind: null, windowKind: 'once', windowSeconds: null } },
    }));
    await main(['policy', 'create', '--kind', 'task', '--match', 'Run-42', '--limit', '2', '--window', 'once']);
    expect(calls[0]!.body).toEqual({
      kind: 'task',
      matchKey: 'run-42',
      limitRaw: '2000000',
      windowKind: 'once',
    });
  });

  it('creates a team session policy on the team route with a session window', async () => {
    setup('create-team');
    const calls = stubApi(() => ({
      status: 201,
      body: { policy: { ...POLICY, id: 31, scope: 'developer', kind: 'session', matchKey: null, windowKind: 'session', windowSeconds: null } },
    }));
    await main(['policy', 'create', '--team', '--kind', 'session', '--limit', '100', '--action', 'suspend_agent']);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/developer/policies' });
    expect(calls[0]!.body).toEqual({
      kind: 'session',
      limitRaw: '100000000',
      windowKind: 'session',
      action: 'suspend_agent',
    });
  });

  it('fails without --limit before any network call', async () => {
    setup('create-nolimit');
    const calls = stubApi(() => undefined);
    await main(['policy', 'create', '--kind', 'api', '--match', '.openai.com']);
    expect(stderr).toContain('--limit');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('rejects --kind session without --team before any network call', async () => {
    setup('create-session-agent');
    const calls = stubApi(() => undefined);
    await main(['policy', 'create', '--kind', 'session', '--limit', '5']);
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('remaps duplicate_active_policy to an actionable error', async () => {
    setup('create-dup');
    stubApi(() => ({ status: 409, body: { error: 'duplicate_active_policy', message: 'already exists' } }));
    await main(['policy', 'create', '--kind', 'api', '--match', '.openai.com', '--limit', '5']);
    expect(stderr).toContain('already exists — update it instead');
    expect(process.exitCode).toBe(1);
  });
});

describe('policy update', () => {
  it('PATCHes limit and rolling window seconds', async () => {
    setup('update');
    const calls = stubApi(() => ({ body: { policy: { ...POLICY, limitRaw: '10000000' } } }));
    await main(['policy', 'update', '12', '--limit', '10', '--window', '12h']);
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/v1/developer/agents/agent-1/policies/12' });
    expect(calls[0]!.body).toEqual({ limitRaw: '10000000', windowSeconds: 43_200 });
    expect(stdout).toContain('Policy 12 updated');
  });

  it('refuses --window once (the API cannot change window kind)', async () => {
    setup('update-once');
    const calls = stubApi(() => undefined);
    await main(['policy', 'update', '12', '--window', 'once']);
    expect(stderr).toContain("window kind can't be changed");
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('maps a 402 to exit code 5', async () => {
    setup('update-402');
    stubApi(() => ({ status: 402, body: { error: 'payment_required', message: 'payment required' } }));
    await main(['policy', 'update', '12', '--limit', '10']);
    expect(process.exitCode).toBe(5);
  });
});

describe('policy revoke', () => {
  it('refuses without --yes when non-interactive, before any network call', async () => {
    setup('revoke-noyes');
    const calls = stubApi(() => undefined);
    await main(['policy', 'revoke', '12']);
    expect(stderr).toContain('--yes');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('DELETEs with --yes and reports JSON', async () => {
    setup('revoke');
    const calls = stubApi(() => ({ body: { status: 'revoked' } }));
    await main(['policy', 'revoke', '12', '--yes', '--json']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/v1/developer/agents/agent-1/policies/12' });
    expect(JSON.parse(stdout)).toEqual({ policyId: 12, status: 'revoked' });
  });

  it('targets the team route with --team', async () => {
    setup('revoke-team');
    const calls = stubApi(() => ({ body: { status: 'revoked' } }));
    await main(['policy', 'revoke', '30', '--team', '--yes']);
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/v1/developer/policies/30' });
  });
});

describe('policy reset', () => {
  it('POSTs the agent-scoped reset route', async () => {
    setup('reset');
    const calls = stubApi(() => ({ body: { policy: POLICY } }));
    await main(['policy', 'reset', '12']);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/developer/agents/agent-1/policies/12/reset' });
    expect(stdout).toContain('window restarted');
  });

  it('rejects --team (no team reset endpoint) before any network call', async () => {
    setup('reset-team');
    const calls = stubApi(() => undefined);
    await main(['policy', 'reset', '12', '--team']);
    expect(stderr).toContain('no reset endpoint');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe('policy chain', () => {
  const CHAIN = {
    agentId: 1,
    asOf: '2026-08-07T10:00:00.000Z',
    chain: [
      {
        scope: 'agent',
        kind: 'session',
        label: null,
        policyId: 5,
        matchKey: null,
        limitRaw: '5000000',
        spentRaw: '500000',
        remainingRaw: '4500000',
        windowKind: 'session',
        windowResetsAt: null,
      },
      {
        scope: 'balance',
        kind: null,
        label: 'Spendable balance',
        policyId: null,
        matchKey: null,
        limitRaw: '12000000',
        spentRaw: '0',
        remainingRaw: '12000000',
        windowKind: null,
        windowResetsAt: null,
      },
    ],
  };

  it('renders every link ending in the balance row', async () => {
    setup('chain');
    const calls = stubApi(() => ({ body: CHAIN }));
    await main(['policy', 'chain']);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/v1/developer/agents/agent-1/limit-chain' });
    expect(stdout).toContain('Spendable balance');
    expect(stdout).toContain('$4.50');
    expect(stdout).toContain('$12.00');
  });

  it('--json passes the response through', async () => {
    setup('chain-json');
    stubApi(() => ({ body: CHAIN }));
    await main(['policy', 'chain', '--json']);
    expect(JSON.parse(stdout)).toEqual(CHAIN);
  });
});

describe('policy test (dry-run resolve)', () => {
  it('POSTs the resolve body and prints ALLOW with the binding limit', async () => {
    setup('test-allow');
    const calls = stubApi(() => ({
      body: {
        decision: 'approve',
        effectiveRemainingRaw: '4500000',
        binding: {
          scope: 'agent',
          kind: 'api',
          label: null,
          policyId: 12,
          matchKey: '.openai.com',
          limitRaw: '5000000',
          spentRaw: '500000',
          remainingRaw: '4500000',
          windowKind: 'rolling',
          windowResetsAt: null,
        },
      },
    }));
    await main([
      'policy', 'test',
      '--host', 'api.openai.com',
      '--amount', '2',
      '--task', 'run-42',
      '--key', '7',
      '--recipient', '0x1111111111111111111111111111111111111111',
    ]);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/developer/agents/agent-1/resolve' });
    expect(calls[0]!.body).toEqual({
      host: 'api.openai.com',
      amountRaw: '2000000',
      recipient: '0x1111111111111111111111111111111111111111',
      taskId: 'run-42',
      keyId: 7,
    });
    expect(stdout).toContain('ALLOW');
    expect(stdout).toContain('.openai.com');
    expect(stdout).toContain('$4.50 of $5.00');
  });

  it('prints DECLINE with the deciding rule and USD-formatted amounts', async () => {
    setup('test-decline');
    stubApi(() => ({
      body: {
        decision: 'decline',
        decline: {
          error: 'policy_exceeded',
          kind: 'api',
          matchKey: '.openai.com',
          policyId: 12,
          label: null,
          reason: null,
          required: '2000000',
          spent: '4500000',
          limit: '5000000',
        },
      },
    }));
    await main(['policy', 'test', '--host', 'api.openai.com', '--amount', '2']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('DECLINE');
    expect(stdout).toContain('policy_exceeded');
    expect(stdout).toContain('$4.50');
    expect(stdout).toContain('$5.00');
  });

  it('--json passes the full response body through', async () => {
    setup('test-json');
    const body = { decision: 'decline', decline: { error: 'host_not_allowlisted', host: 'evil.example' } };
    stubApi(() => ({ body }));
    await main(['policy', 'test', '--host', 'evil.example', '--amount', '1', '--json']);
    expect(JSON.parse(stdout)).toEqual(body);
  });

  it('rejects a non-numeric --key before any network call', async () => {
    setup('test-badkey');
    const calls = stubApi(() => undefined);
    await main(['policy', 'test', '--host', 'api.openai.com', '--amount', '2', '--key', 'key-1']);
    expect(stderr).toContain('--key');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe('policy dispatch', () => {
  it('rejects unknown subcommands', async () => {
    setup('unknown');
    const calls = stubApi(() => undefined);
    await main(['policy', 'frobnicate']);
    expect(stderr).toContain('Unknown policy subcommand');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
