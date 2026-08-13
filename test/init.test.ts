import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const API = 'https://credit-api.floelabs.xyz';
const dir = `${process.cwd()}/test/.tmp-init-${process.pid}`;

// In-memory keychain: init writes real secrets (dev key + minted agent key),
// and the real module would reach the actual OS keychain on this machine.
const h = vi.hoisted(() => ({ secrets: new Map<string, string>() }));

vi.mock('../src/lib/keychain.js', () => {
  const host = (apiUrl: string) => new URL(apiUrl).host;
  const devKeyAccount = (apiUrl: string) => `dev-key:${host(apiUrl)}`;
  const agentKeyAccount = (apiUrl: string, agentId: string | number) =>
    `agent-key:${host(apiUrl)}:${agentId}`;
  const legacyAgentKeyAccount = (apiUrl: string) => `agent-key:${host(apiUrl)}`;
  return {
    devKeyAccount,
    agentKeyAccount,
    legacyAgentKeyAccount,
    getSecret: async (account: string) => h.secrets.get(account),
    setSecret: async (account: string, value: string) => {
      h.secrets.set(account, value);
    },
    resolveDevKey: async (apiUrl: string) =>
      process.env.FLOE_API_KEY || h.secrets.get(devKeyAccount(apiUrl)),
    resolveAgentKey: async (
      apiUrl: string,
      agentId: string | number | undefined,
      slot: { legacySlotAgentId?: string } = {},
    ) => {
      if (process.env.FLOE_AGENT_KEY) return process.env.FLOE_AGENT_KEY;
      if (agentId === undefined) return undefined;
      const stored = h.secrets.get(agentKeyAccount(apiUrl, agentId));
      if (stored) return stored;
      if (slot.legacySlotAgentId !== undefined && String(slot.legacySlotAgentId) === String(agentId)) {
        return h.secrets.get(legacyAgentKeyAccount(apiUrl));
      }
      return undefined;
    },
  };
});

let stdout: string;
let stderr: string;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Route fetches by "METHOD /path". An unrouted request throws inside fetch,
 * which FloeApi wraps into an exit-1 ApiError — caught by each test's
 * exit-code assertion, so always assert the exit code.
 */
function stubRoutes(routes: Record<string, (init?: RequestInit) => Response>) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected request: ${key}`);
    return handler(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// Ids arrive as JSON numbers — the API serializes them so (see regressions.test.ts).
const AGENT = {
  id: 7,
  mode: 'managed',
  fundingMode: 'credit_line',
  name: 'prod-agent',
  status: 'active',
  suspendedReason: null,
  agentWalletAddress: '0xagent7',
  privyWalletAddress: null,
  creditLimit: null,
  sessionSpendLimitRaw: null,
  selfServiceLocked: false,
  createdAt: '2026-08-01T00:00:00Z',
  closedAt: null,
};

const DEVELOPER = {
  walletAddress: '0xdev',
  displayName: 'Dev Ops',
  email: null,
  accountId: null,
  role: null,
  createdAt: '2026-07-01T00:00:00Z',
};

const MINTED = {
  id: 42,
  keyPrefix: 'floe_ab12...',
  label: 'floe-cli',
  permissions: 'read_write',
  lastUsedAt: null,
  createdAt: '2026-08-07T00:00:00Z',
  budget: null,
  key: 'floe_mintedsecret',
};

const configPath = () => join(dir, 'floe', 'config.json');

function writeConfigFile(config: unknown): void {
  mkdirSync(join(dir, 'floe'), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config));
}

const readConfigFile = () =>
  JSON.parse(readFileSync(configPath(), 'utf8')) as {
    apiUrl?: string;
    activeAgentId?: string;
    agents?: Record<string, { name?: string; wallet?: string; keyId?: unknown; keyPrefix?: string }>;
  };

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  h.secrets.clear();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  // Shield the suite from real credentials; '' is falsy for every resolver.
  vi.stubEnv('FLOE_API_KEY', '');
  vi.stubEnv('FLOE_AGENT_KEY', '');
  vi.stubEnv('FLOE_API_URL', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('init credential handling', () => {
  it('fails with exit 4 and no network call when non-interactive with no key anywhere', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['init']);

    expect(stderr).toContain('No developer key');
    expect(process.exitCode).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an agent key passed as --key before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['init', '--key', 'floe_notadevkey']);

    expect(stderr).toContain('DEVELOPER key');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('init first run', () => {
  it('signs in, mints an agent key, stores both secrets, and writes the config', async () => {
    const fetchMock = stubRoutes({
      'GET /v1/developer/profile': () => jsonResponse({ developer: DEVELOPER, agents: [AGENT] }),
      'POST /v1/developer/agents/7/keys': () => jsonResponse(MINTED, 201),
    });

    await main(['init', '--key', 'floe_live_devkey']);

    expect(process.exitCode ?? 0).toBe(0);
    const [, profileInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((profileInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer floe_live_devkey',
    );
    const mintCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/keys'));
    expect(JSON.parse(String((mintCall?.[1] as RequestInit).body))).toEqual({ label: 'floe-cli' });

    // Both planes stored, host-scoped.
    expect(h.secrets.get('dev-key:credit-api.floelabs.xyz')).toBe('floe_live_devkey');
    expect(h.secrets.get('agent-key:credit-api.floelabs.xyz:7')).toBe('floe_mintedsecret');

    const config = readConfigFile();
    expect(config.apiUrl).toBe(API);
    expect(config.activeAgentId).toBe('7');
    expect(config.agents?.['7']?.keyPrefix).toBe('floe_ab12...');
    expect(String(config.agents?.['7']?.keyId)).toBe('42');

    expect(stdout).toContain('Signed in as');
    expect(stdout).toContain('prod-agent');
    expect(stdout).toContain('(new — stored in your keychain)');
    // The payoff: base-URL swap snippet with the minted key filled in.
    expect(stdout).toContain(`${API}/v1`);
    expect(stdout).toContain('floe_mintedsecret');
  });

  it('creates an agent when none exists and surfaces the welcome credit', async () => {
    const created = { ...AGENT, id: 9, name: 'my-agent', agentWalletAddress: '0xagent9' };
    let agents: unknown[] = [];
    const fetchMock = stubRoutes({
      'GET /v1/developer/profile': () => jsonResponse({ developer: DEVELOPER, agents: [] }),
      'POST /v1/developer/agents': () => {
        agents = [created];
        return jsonResponse(
          {
            agentId: '9',
            status: 'active',
            privyWalletAddress: null,
            delegationTxHash: null,
            welcomeCreditTxHash: '0xwelcome',
          },
          201,
        );
      },
      'GET /v1/developer/agents': () => jsonResponse({ agents }),
      'POST /v1/developer/agents/9/keys': () => jsonResponse(MINTED, 201),
    });

    await main(['init', '--key', 'floe_live_devkey']);

    expect(process.exitCode ?? 0).toBe(0);
    const createCall = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith('/v1/developer/agents') && (i as RequestInit).method === 'POST',
    );
    // Non-interactive default name + dashboard-equivalent delegation terms.
    expect(JSON.parse(String((createCall?.[1] as RequestInit).body))).toEqual({
      name: 'my-agent',
      maxRateBps: 1000,
      expirySeconds: 31_536_000,
    });
    expect(stdout).toContain('Welcome credit');
    expect(readConfigFile().activeAgentId).toBe('9');
  });
});

describe('init re-run', () => {
  it('reuses the stored agent key without burning a key slot', async () => {
    writeConfigFile({
      apiUrl: API,
      activeAgentId: '7',
      agents: { '7': { name: 'prod-agent', keyId: 42, keyPrefix: 'floe_ab12...' } },
    });
    h.secrets.set('agent-key:credit-api.floelabs.xyz:7', 'floe_storedsecret');
    // No POST route: any mint attempt fails the test.
    const fetchMock = stubRoutes({
      'GET /v1/developer/profile': () => jsonResponse({ developer: DEVELOPER, agents: [AGENT] }),
    });

    await main(['init', '--key', 'floe_live_devkey']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stdout).toContain('(reused)');
    expect(stdout).toContain('floe_storedsecret');
  });

  it('remaps the key-limit error to rotate/revoke guidance', async () => {
    stubRoutes({
      'GET /v1/developer/profile': () => jsonResponse({ developer: DEVELOPER, agents: [AGENT] }),
      'POST /v1/developer/agents/7/keys': () =>
        jsonResponse({ error: 'limit_exceeded', message: 'Maximum 5 API keys allowed' }, 409),
    });

    await main(['init', '--key', 'floe_live_devkey']);

    expect(stderr).toContain('maximum number of API keys');
    expect(stderr).toContain('floe keys rotate');
    expect(process.exitCode).toBe(1);
  });
});

describe('init agent selection', () => {
  const SECOND = { ...AGENT, id: 8, name: 'staging', agentWalletAddress: '0xagent8' };

  it('requires --agent in non-interactive mode when several agents are active', async () => {
    stubRoutes({
      'GET /v1/developer/profile': () => jsonResponse({ developer: DEVELOPER, agents: [AGENT, SECOND] }),
    });

    await main(['init', '--key', 'floe_live_devkey']);

    expect(stderr).toContain('--agent');
    expect(process.exitCode).toBe(2);
  });

  it('selects the agent named by --agent', async () => {
    stubRoutes({
      'GET /v1/developer/profile': () => jsonResponse({ developer: DEVELOPER, agents: [AGENT, SECOND] }),
      'POST /v1/developer/agents/8/keys': () => jsonResponse(MINTED, 201),
    });

    await main(['init', '--key', 'floe_live_devkey', '--agent', 'staging']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(readConfigFile().activeAgentId).toBe('8');
  });

  it('rejects an unknown --agent listing what exists', async () => {
    stubRoutes({
      'GET /v1/developer/profile': () => jsonResponse({ developer: DEVELOPER, agents: [AGENT] }),
    });

    await main(['init', '--key', 'floe_live_devkey', '--agent', 'ghost']);

    expect(stderr).toContain('No active agent named "ghost"');
    expect(stderr).toContain('prod-agent');
    expect(process.exitCode).toBe(2);
  });

  it('a re-run keeps the configured agent even when others exist', async () => {
    writeConfigFile({ apiUrl: API, activeAgentId: '8', agents: { '8': { name: 'staging' } } });
    h.secrets.set('agent-key:credit-api.floelabs.xyz:8', 'floe_storedsecret');
    stubRoutes({
      'GET /v1/developer/profile': () => jsonResponse({ developer: DEVELOPER, agents: [AGENT, SECOND] }),
    });

    await main(['init', '--key', 'floe_live_devkey']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(readConfigFile().activeAgentId).toBe('8');
  });
});

describe('init --json', () => {
  it('emits the minted key machine-readably (shown once by design)', async () => {
    stubRoutes({
      'GET /v1/developer/profile': () => jsonResponse({ developer: DEVELOPER, agents: [AGENT] }),
      'POST /v1/developer/agents/7/keys': () => jsonResponse(MINTED, 201),
    });

    await main(['init', '--key', 'floe_live_devkey', '--json']);

    expect(JSON.parse(stdout)).toMatchObject({
      apiUrl: API,
      developer: '0xdev',
      agentId: 7,
      agentName: 'prod-agent',
      mintedNewKey: true,
      agentKey: 'floe_mintedsecret',
      baseUrl: `${API}/v1`,
    });
  });

  it('omits the agent key when the stored one is reused', async () => {
    writeConfigFile({
      apiUrl: API,
      activeAgentId: '7',
      agents: { '7': { name: 'prod-agent', keyId: 42, keyPrefix: 'floe_ab12...' } },
    });
    h.secrets.set('agent-key:credit-api.floelabs.xyz:7', 'floe_storedsecret');
    stubRoutes({
      'GET /v1/developer/profile': () => jsonResponse({ developer: DEVELOPER, agents: [AGENT] }),
    });

    await main(['init', '--key', 'floe_live_devkey', '--json']);

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.mintedNewKey).toBe(false);
    expect(parsed).not.toHaveProperty('agentKey');
    expect(stdout).not.toContain('floe_storedsecret');
  });
});
