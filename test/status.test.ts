import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const API = 'https://credit-api.floelabs.xyz';
const dir = `${process.cwd()}/test/.tmp-status-${process.pid}`;

// In-memory keychain — the real module would reach the actual OS keychain.
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

// Route fetches by "METHOD /path". An unrouted request throws inside fetch,
// which FloeApi wraps into an exit-1 ApiError — caught by each test's
// exit-code assertion, so always assert the exit code.
function stubRoutes(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected request: ${key}`);
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

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

const BALANCES = {
  developerWalletBalanceRaw: '0',
  agentWalletsBalanceRaw: '2500000',
  apiCreditsAvailableRaw: '10000000',
  currency: 'USDC',
  decimals: 6,
};

const KEY = {
  id: 42,
  keyPrefix: 'floe_ab12...',
  label: 'floe-cli',
  permissions: 'read_write',
  lastUsedAt: null,
  createdAt: '2026-08-07T00:00:00Z',
  budget: {
    policyId: 'p1',
    limitRaw: '5000000',
    spentRaw: '1000000',
    remainingRaw: '4000000',
    windowKind: 'day',
    windowResetsAt: null,
  },
};

const SPEND_LIMIT = {
  active: true,
  limitRaw: '20000000',
  sessionSpentRaw: '5000000',
  sessionRemainingRaw: '15000000',
  sessionStartedAt: null,
};

function writeConfigFile(config: unknown): void {
  mkdirSync(join(dir, 'floe'), { recursive: true });
  writeFileSync(join(dir, 'floe', 'config.json'), JSON.stringify(config));
}

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

describe('status signed out', () => {
  it('exits 4 with an init pointer and makes no network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['status']);

    expect(stdout).toContain('Not signed in');
    expect(stdout).toContain('floe init');
    expect(process.exitCode).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('--json reports authenticated: false, still exit 4', async () => {
    vi.stubGlobal('fetch', vi.fn());

    await main(['status', '--json']);

    expect(JSON.parse(stdout)).toEqual({ authenticated: false, apiUrl: API });
    expect(process.exitCode).toBe(4);
  });
});

describe('status signed in', () => {
  beforeEach(() => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    writeConfigFile({
      activeAgentId: '7',
      agents: { '7': { name: 'prod-agent', keyId: '42', keyPrefix: 'floe_ab12...' } },
    });
    h.secrets.set('agent-key:credit-api.floelabs.xyz:7', 'floe_storedsecret');
  });

  const ROUTES = {
    'GET /v1/developer/profile': () => jsonResponse({ developer: DEVELOPER, agents: [AGENT] }),
    'GET /v1/developer/balances': () => jsonResponse(BALANCES),
    'GET /v1/developer/agents/7/keys': () => jsonResponse({ keys: [KEY] }),
    'GET /v1/developer/agents/7/spend-limit': () => jsonResponse(SPEND_LIMIT),
  };

  it('shows agent, key, balances, key budget and spend limit', async () => {
    const fetchMock = stubRoutes(ROUTES);

    await main(['status']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(stdout).toContain('signed in');
    expect(stdout).toContain('prod-agent');
    expect(stdout).toContain('floe_ab12...');
    expect(stdout).toContain('(in keychain)');
    expect(stdout).toContain('$10.00 credits · $2.50 in agent wallets');
    // Asserted separately: dim() sits between the amount and "(day)" when colors are on.
    expect(stdout).toContain('$4.00 of $5.00 remaining');
    expect(stdout).toContain('(day)');
    expect(stdout).toContain('$15.00 of $20.00 remaining');
  });

  it('strips terminal control sequences from network-sourced fields', async () => {
    stubRoutes({
      ...ROUTES,
      'GET /v1/developer/profile': () =>
        jsonResponse({
          developer: { ...DEVELOPER, displayName: 'Dev[2JOps' },
          agents: [{ ...AGENT, name: 'prod[2J-agent' }],
        }),
    });

    await main(['status']);

    expect(process.exitCode ?? 0).toBe(0);
    // CSI clear-screen from the network must never reach the terminal.
    expect(stdout).not.toContain('[2J');
    expect(stdout).toContain('DevOps');
    expect(stdout).toContain('prod-agent');
  });

  it('flags a locally-missing agent key instead of failing', async () => {
    h.secrets.clear();
    stubRoutes(ROUTES);

    await main(['status']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('missing locally — run floe init');
  });

  it('warns when the configured agent no longer exists and another was substituted', async () => {
    writeConfigFile({ activeAgentId: '99', agents: { '99': { name: 'gone-agent' } } });
    stubRoutes(ROUTES);

    await main(['status']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('prod-agent');
    expect(stdout).toContain('floe use <agent>');
  });

  it('handles an account with no agents', async () => {
    writeConfigFile({});
    stubRoutes({
      'GET /v1/developer/profile': () => jsonResponse({ developer: DEVELOPER, agents: [] }),
      'GET /v1/developer/balances': () => jsonResponse(BALANCES),
    });

    await main(['status']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('none — run floe init');
  });

  it('--json reports configStale: true when the configured agent was substituted', async () => {
    writeConfigFile({ activeAgentId: '99', agents: { '99': { name: 'gone-agent' } } });
    stubRoutes(ROUTES);

    await main(['status', '--json']);

    const parsed = JSON.parse(stdout) as { configStale: boolean; agent: { id: number } };
    expect(parsed.configStale).toBe(true);
    expect(parsed.agent.id).toBe(7);
  });

  it('--json emits the full machine-readable snapshot', async () => {
    stubRoutes(ROUTES);

    await main(['status', '--json']);

    expect(JSON.parse(stdout)).toMatchObject({
      authenticated: true,
      apiUrl: API,
      configStale: false,
      agentKeyConfigured: true,
      agent: { id: 7, name: 'prod-agent' },
      activeKey: { id: 42, keyPrefix: 'floe_ab12...' },
      spendLimit: { active: true, sessionRemainingRaw: '15000000' },
      balances: { apiCreditsAvailableRaw: '10000000' },
    });
  });
});
