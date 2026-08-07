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
  dir = `${process.cwd()}/test/.tmp-allowlist-${tag}-${process.pid}`;
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

const HOST_ENTRY = {
  id: 12,
  kind: 'api',
  matchKey: '.openai.com',
  matchKind: 'host_suffix',
  limitRaw: '5000000',
  windowKind: 'rolling',
  windowSeconds: 86_400,
  status: 'active',
  label: 'OpenAI',
};

const PAYEE_ENTRY = {
  id: 13,
  kind: 'vendor',
  matchKey: '0x2222222222222222222222222222222222222222',
  matchKind: 'recipient',
  limitRaw: '3000000',
  windowKind: 'rolling',
  windowSeconds: 86_400,
  status: 'active',
  label: null,
};

const TASK_ENTRY = {
  id: 14,
  kind: 'task',
  matchKey: 'run-42',
  matchKind: null,
  limitRaw: '1000000',
  windowKind: 'once',
  windowSeconds: null,
  status: 'active',
  label: null,
};

describe('allowlist show', () => {
  it('shows the mode and only api/vendor entries', async () => {
    setup('show');
    const calls = stubApi((_method, pathname) => {
      if (pathname === '/v1/developer/agents/agent-1/allowlist-mode') return { body: { mode: 'host' } };
      if (pathname === '/v1/developer/agents/agent-1/policies') {
        return { body: { policies: [HOST_ENTRY, PAYEE_ENTRY, TASK_ENTRY] } };
      }
      return undefined;
    });
    await main(['allowlist', 'show']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls.map((c) => c.path).sort()).toEqual([
      '/v1/developer/agents/agent-1/allowlist-mode',
      '/v1/developer/agents/agent-1/policies',
    ]);
    expect(calls[0]!.auth).toBe('Bearer floe_live_test');
    expect(stdout).toContain('.openai.com');
    expect(stdout).toContain('0x2222222222222222222222222222222222222222');
    expect(stdout).not.toContain('run-42');
    // Host dimension is enforced and has an active entry — no lockout warning.
    expect(stdout).not.toContain('Lockout');
  });

  it('warns about a locked-out dimension with zero entries', async () => {
    setup('show-lockout');
    stubApi((_method, pathname) => {
      if (pathname === '/v1/developer/agents/agent-1/allowlist-mode') return { body: { mode: 'both' } };
      return { body: { policies: [HOST_ENTRY] } };
    });
    await main(['allowlist', 'show']);
    expect(stdout).toContain('Lockout: vendor');
    expect(stdout).not.toContain('Lockout: host');
  });

  it('--json emits mode + filtered entries', async () => {
    setup('show-json');
    stubApi((_method, pathname) => {
      if (pathname === '/v1/developer/agents/agent-1/allowlist-mode') return { body: { mode: 'off' } };
      return { body: { policies: [HOST_ENTRY, TASK_ENTRY] } };
    });
    await main(['allowlist', '--json']);
    expect(JSON.parse(stdout)).toEqual({ agentId: 'agent-1', mode: 'off', entries: [HOST_ENTRY] });
  });
});

describe('allowlist set', () => {
  it('PUTs the mode', async () => {
    setup('set');
    const calls = stubApi(() => ({ body: { mode: 'host' } }));
    await main(['allowlist', 'set', 'host']);
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/v1/developer/agents/agent-1/allowlist-mode' });
    expect(calls[0]!.body).toEqual({ mode: 'host' });
    expect(stdout).toContain('Allowlist mode set to host');
    expect(stdout).not.toContain('Lockout');
  });

  it('surfaces the lockout advisory prominently', async () => {
    setup('set-warning');
    stubApi(() => ({
      body: { mode: 'both', warning: { code: 'no_active_entries', dimensions: ['host', 'vendor'] } },
    }));
    await main(['allowlist', 'set', 'both']);
    expect(stdout).toContain('Lockout: host');
    expect(stdout).toContain('Lockout: vendor');
    expect(stdout).toContain('DECLINED');
  });

  it('keeps the advisory in --json output', async () => {
    setup('set-warning-json');
    const body = { mode: 'host', warning: { code: 'no_active_entries', dimensions: ['host'] } };
    stubApi(() => ({ body }));
    await main(['allowlist', 'set', 'host', '--json']);
    expect(JSON.parse(stdout)).toEqual({ agentId: 'agent-1', ...body });
  });

  it('rejects an invalid mode before any network call', async () => {
    setup('set-bad');
    const calls = stubApi(() => undefined);
    await main(['allowlist', 'set', 'strict']);
    expect(stderr).toContain('off|host|vendor|both');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe('allowlist add', () => {
  it('adds a suffix host entry (kind api, host_suffix)', async () => {
    setup('add-suffix');
    const calls = stubApi(() => ({ status: 201, body: { policy: HOST_ENTRY } }));
    await main(['allowlist', 'add', '--host', '.openai.com', '--limit', '5']);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/developer/agents/agent-1/policies' });
    expect(calls[0]!.body).toEqual({
      kind: 'api',
      matchKey: '.openai.com',
      matchKind: 'host_suffix',
      limitRaw: '5000000',
      windowKind: 'rolling',
      windowSeconds: 86_400,
    });
    expect(stdout).toContain('Allowlisted host');
  });

  it('adds an exact host entry (host_exact, custom window)', async () => {
    setup('add-exact');
    const calls = stubApi(() => ({
      status: 201,
      body: { policy: { ...HOST_ENTRY, matchKey: 'api.openai.com', matchKind: 'host_exact', windowSeconds: 3_600 } },
    }));
    await main(['allowlist', 'add', '--host', 'API.openai.com', '--limit', '5', '--window', '1h']);
    expect(calls[0]!.body).toEqual({
      kind: 'api',
      matchKey: 'api.openai.com',
      matchKind: 'host_exact',
      limitRaw: '5000000',
      windowKind: 'rolling',
      windowSeconds: 3_600,
    });
  });

  it('adds a payee entry (kind vendor) and lowercases the address', async () => {
    setup('add-payee');
    const calls = stubApi(() => ({ status: 201, body: { policy: PAYEE_ENTRY } }));
    await main(['allowlist', 'add', '--payee', '0x2222222222222222222222222222222222222222', '--limit', '3', '--json']);
    expect(calls[0]!.body).toEqual({
      kind: 'vendor',
      matchKey: '0x2222222222222222222222222222222222222222',
      limitRaw: '3000000',
      windowKind: 'rolling',
      windowSeconds: 86_400,
    });
    expect(JSON.parse(stdout)).toEqual({ agentId: 'agent-1', policy: PAYEE_ENTRY });
  });

  it('rejects a URL passed as --host before any network call', async () => {
    setup('add-url');
    const calls = stubApi(() => undefined);
    await main(['allowlist', 'add', '--host', 'https://api.openai.com', '--limit', '5']);
    expect(stderr).toContain('bare hostname');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('rejects a whole-TLD suffix before any network call', async () => {
    setup('add-tld');
    const calls = stubApi(() => undefined);
    await main(['allowlist', 'add', '--host', '.com', '--limit', '5']);
    expect(stderr).toContain('TLD');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed --payee before any network call', async () => {
    setup('add-badpayee');
    const calls = stubApi(() => undefined);
    await main(['allowlist', 'add', '--payee', '0x123', '--limit', '5']);
    expect(stderr).toContain('--payee');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('requires exactly one of --host / --payee', async () => {
    setup('add-both');
    const calls = stubApi(() => undefined);
    await main(['allowlist', 'add', '--host', '.openai.com', '--payee', '0x2222222222222222222222222222222222222222', '--limit', '5']);
    expect(stderr).toContain('exactly one');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('requires --limit', async () => {
    setup('add-nolimit');
    const calls = stubApi(() => undefined);
    await main(['allowlist', 'add', '--host', '.openai.com']);
    expect(stderr).toContain('--limit');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('maps a 402 to exit code 5', async () => {
    setup('add-402');
    stubApi(() => ({ status: 402, body: { error: 'payment_required', message: 'payment required' } }));
    await main(['allowlist', 'add', '--host', '.openai.com', '--limit', '5']);
    expect(process.exitCode).toBe(5);
  });
});

describe('allowlist remove', () => {
  it('refuses without --yes when non-interactive, before any network call', async () => {
    setup('remove-noyes');
    const calls = stubApi(() => undefined);
    await main(['allowlist', 'remove', '12']);
    expect(stderr).toContain('--yes');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('DELETEs the policy with --yes', async () => {
    setup('remove');
    const calls = stubApi(() => ({ body: { status: 'revoked' } }));
    await main(['allowlist', 'remove', '12', '--yes']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/v1/developer/agents/agent-1/policies/12' });
    expect(stdout).toContain('removed');
  });

  it('rejects a non-numeric id before any network call', async () => {
    setup('remove-bad');
    const calls = stubApi(() => undefined);
    await main(['allowlist', 'remove', 'twelve', '--yes']);
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe('allowlist dispatch', () => {
  it('rejects unknown subcommands', async () => {
    setup('unknown');
    const calls = stubApi(() => undefined);
    await main(['allowlist', 'frobnicate']);
    expect(stderr).toContain('Unknown allowlist subcommand');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
