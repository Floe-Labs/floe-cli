import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const API = 'https://credit-api.floelabs.xyz';
const dir = `${process.cwd()}/test/.tmp-use-${process.pid}`;

// In-memory keychain — `use` mints and stores real agent keys, and the real
// module would reach the actual OS keychain on this machine.
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

const baseAgent = {
  mode: 'managed',
  fundingMode: 'credit_line',
  suspendedReason: null,
  privyWalletAddress: null,
  creditLimit: null,
  sessionSpendLimitRaw: null,
  selfServiceLocked: false,
  createdAt: '2026-08-01T00:00:00Z',
  closedAt: null,
};
const PROD = { ...baseAgent, id: 7, name: 'prod-agent', status: 'active', agentWalletAddress: '0x7' };
const STAGING = { ...baseAgent, id: 8, name: 'staging', status: 'active', agentWalletAddress: '0x8' };
const PAUSED = {
  ...baseAgent,
  id: 9,
  name: 'paused-bot',
  status: 'suspended',
  suspendedReason: 'manual',
  agentWalletAddress: '0x9',
};

const FLEET = { agents: [PROD, STAGING, PAUSED] };

const MINTED = {
  id: 43,
  keyPrefix: 'floe_cd34...',
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
    activeAgentId?: string;
    agents?: Record<string, { name?: string; keyId?: unknown; keyPrefix?: string }>;
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
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
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

describe('use argument handling', () => {
  it('requires an agent reference', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['use']);

    expect(stderr).toContain('Usage: floe use <agent>');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requires a signed-in developer', async () => {
    vi.stubEnv('FLOE_API_KEY', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['use', 'staging']);

    expect(stderr).toContain('Not signed in');
    expect(process.exitCode).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('use switching', () => {
  it('switches to an agent whose key is already stored without minting', async () => {
    writeConfigFile({
      activeAgentId: '8',
      agents: { '7': { name: 'prod-agent', keyId: 42, keyPrefix: 'floe_ab12...' } },
    });
    h.secrets.set('agent-key:credit-api.floelabs.xyz:7', 'floe_storedsecret');
    // No POST route: a mint attempt fails the test.
    const fetchMock = stubRoutes({
      'GET /v1/developer/agents': () => jsonResponse(FLEET),
    });

    await main(['use', 'prod-agent']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stdout).toContain('Now using agent prod-agent');
    expect(stdout).toContain('Stored key reused.');
    const config = readConfigFile();
    expect(config.activeAgentId).toBe('7');
    expect(config.agents?.['7']?.keyPrefix).toBe('floe_ab12...');
  });

  it('mints and stores a key on the first switch to an agent', async () => {
    writeConfigFile({ activeAgentId: '7', agents: { '7': { name: 'prod-agent' } } });
    const fetchMock = stubRoutes({
      'GET /v1/developer/agents': () => jsonResponse(FLEET),
      'POST /v1/developer/agents/8/keys': () => jsonResponse(MINTED, 201),
    });

    await main(['use', 'staging']);

    expect(process.exitCode ?? 0).toBe(0);
    const mintCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/keys'));
    expect(JSON.parse(String((mintCall?.[1] as RequestInit).body))).toEqual({ label: 'floe-cli' });
    expect(h.secrets.get('agent-key:credit-api.floelabs.xyz:8')).toBe('floe_mintedsecret');
    expect(stdout).toContain('new key was minted');
    const config = readConfigFile();
    expect(config.activeAgentId).toBe('8');
    expect(config.agents?.['8']?.keyPrefix).toBe('floe_cd34...');
    // The other agent's entry survives the switch.
    expect(config.agents?.['7']?.name).toBe('prod-agent');
  });

  it('resolves a numeric id reference', async () => {
    writeConfigFile({});
    h.secrets.set('agent-key:credit-api.floelabs.xyz:7', 'floe_storedsecret');
    stubRoutes({
      'GET /v1/developer/agents': () => jsonResponse(FLEET),
    });

    await main(['use', '7']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(readConfigFile().activeAgentId).toBe('7');
  });

  it('--json reports the switch machine-readably', async () => {
    writeConfigFile({});
    stubRoutes({
      'GET /v1/developer/agents': () => jsonResponse(FLEET),
      'POST /v1/developer/agents/8/keys': () => jsonResponse(MINTED, 201),
    });

    await main(['use', 'staging', '--json']);

    expect(JSON.parse(stdout)).toEqual({
      agentId: 8,
      agentName: 'staging',
      keyPrefix: 'floe_cd34...',
      mintedNewKey: true,
    });
  });
});

describe('use refusals', () => {
  it('refuses a suspended agent with resume guidance', async () => {
    writeConfigFile({});
    const fetchMock = stubRoutes({
      'GET /v1/developer/agents': () => jsonResponse(FLEET),
    });

    await main(['use', 'paused-bot']);

    expect(stderr).toContain('suspended');
    expect(stderr).toContain('floe agents resume');
    expect(process.exitCode).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown agent listing what exists', async () => {
    writeConfigFile({});
    stubRoutes({
      'GET /v1/developer/agents': () => jsonResponse(FLEET),
    });

    await main(['use', 'ghost']);

    expect(stderr).toContain('No agent named "ghost"');
    expect(stderr).toContain('prod-agent');
    expect(process.exitCode).toBe(2);
  });

  it('remaps the key-limit error to rotate/revoke guidance', async () => {
    writeConfigFile({});
    stubRoutes({
      'GET /v1/developer/agents': () => jsonResponse(FLEET),
      'POST /v1/developer/agents/8/keys': () =>
        jsonResponse({ error: 'limit_exceeded', message: 'Maximum 5 API keys allowed' }, 409),
    });

    await main(['use', 'staging']);

    expect(stderr).toContain('maximum number of API keys');
    expect(stderr).toContain('floe keys rotate');
    expect(process.exitCode).toBe(1);
  });
});
