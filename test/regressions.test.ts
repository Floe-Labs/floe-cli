import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

/**
 * Regression suite for the 0.2.0 review findings. The common thread: the API
 * serializes agent and key ids as JSON NUMBERS, so config.json holds numbers
 * in production — fixtures here use numeric ids on purpose (string-id fixtures
 * masked every one of these bugs).
 */

const secretStore = new Map<string, string>();
vi.mock('../src/lib/keychain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/keychain.js')>();
  return {
    ...actual,
    getSecret: async (account: string) => secretStore.get(account),
    setSecret: async (account: string, value: string) => {
      secretStore.set(account, value);
    },
  };
});

const API = 'https://credit-api.floelabs.xyz';
const HOST = 'credit-api.floelabs.xyz';
const dir = `${process.cwd()}/test/.tmp-regressions-${process.pid}`;

let stdout: string;
let stderr: string;

function writeConfigRaw(config: unknown): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/floe`, { recursive: true });
  writeFileSync(`${dir}/floe/config.json`, JSON.stringify(config));
}

const readConfigFile = () =>
  JSON.parse(readFileSync(`${dir}/floe/config.json`, 'utf8')) as Record<string, unknown>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const AGENT_7 = {
  id: 7,
  mode: 'managed',
  fundingMode: 'wallet',
  name: 'my-agent',
  status: 'active',
  suspendedReason: null,
  agentWalletAddress: '0xabc',
  privyWalletAddress: null,
  creditLimit: null,
  sessionSpendLimitRaw: null,
  selfServiceLocked: false,
  createdAt: '2026-08-01T00:00:00Z',
  closedAt: null,
};
const AGENT_8 = { ...AGENT_7, id: 8, name: 'other-agent', agentWalletAddress: '0xdef' };

beforeEach(() => {
  stdout = '';
  stderr = '';
  secretStore.clear();
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('keys rotate — numeric config keyId vs argv string (review finding 1)', () => {
  it('rotating this machine key by explicit id stores the replacement locally', async () => {
    writeConfigRaw({
      apiUrl: API,
      activeAgentId: '7',
      agents: { '7': { name: 'my-agent', wallet: '0xabc', keyId: 17, keyPrefix: 'floe_ab12' } },
    });
    const fetchSpy = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain('/v1/developer/agents/7/keys/17/rotate');
      return jsonResponse({
        id: 18,
        keyPrefix: 'floe_cd34',
        key: 'floe_replacement_raw',
        label: 'floe-cli',
        permissions: 'read_write',
        lastUsedAt: null,
        createdAt: '2026-08-07T00:00:00Z',
        budget: null,
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await main(['keys', 'rotate', '17']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(secretStore.get(`agent-key:${HOST}:7`)).toBe('floe_replacement_raw');
    const config = readConfigFile();
    expect((config.agents as Record<string, { keyId: unknown }>)['7']?.keyId).toBe(18);
    expect(stdout).toContain('stored in your keychain');
  });

  it('rotating a non-active agent key via --agent updates that entry without switching agents', async () => {
    writeConfigRaw({
      apiUrl: API,
      activeAgentId: '7',
      agents: {
        '7': { name: 'my-agent', keyId: 17, keyPrefix: 'floe_ab12' },
        '8': { name: 'other-agent', keyId: 21, keyPrefix: 'floe_ef56' },
      },
    });
    const fetchSpy = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/developer/agents')) return jsonResponse({ agents: [AGENT_7, AGENT_8] });
      expect(u).toContain('/v1/developer/agents/8/keys/21/rotate');
      return jsonResponse({
        id: 22,
        keyPrefix: 'floe_gh78',
        key: 'floe_other_replacement',
        label: 'floe-cli',
        permissions: 'read_write',
        lastUsedAt: null,
        createdAt: '2026-08-07T00:00:00Z',
        budget: null,
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await main(['keys', 'rotate', '--agent', 'other-agent']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(secretStore.get(`agent-key:${HOST}:8`)).toBe('floe_other_replacement');
    const config = readConfigFile();
    expect(config.activeAgentId).toBe('7');
    expect((config.agents as Record<string, { keyId: unknown }>)['8']?.keyId).toBe(22);
    expect((config.agents as Record<string, { keyId: unknown }>)['7']?.keyId).toBe(17);
  });
});

describe('use — migrated 0.1 legacy keychain slot (review finding 2)', () => {
  it('reuses the legacy slot key instead of minting a new one', async () => {
    // v0.1 flat config shape, numeric agentId, key in the un-suffixed slot.
    writeConfigRaw({
      apiUrl: API,
      agentId: 7,
      agentName: 'my-agent',
      agentWalletAddress: '0xabc',
      keyId: 17,
      keyPrefix: 'floe_ab12',
    });
    secretStore.set(`agent-key:${HOST}`, 'floe_legacy_key');
    const fetchSpy = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      expect(String(url)).toContain('/v1/developer/agents');
      return jsonResponse({ agents: [AGENT_7] });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await main(['use', 'my-agent']);

    expect(process.exitCode ?? 0).toBe(0);
    // Exactly one request (the fleet read) — no POST .../keys mint.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(stdout).toContain('Stored key reused');
  });
});

describe('budget --agent targets the named agent (review finding 3)', () => {
  it('budget set --agent routes the spend-limit PUT to the resolved agent', async () => {
    writeConfigRaw({
      apiUrl: API,
      activeAgentId: '7',
      agents: { '7': { name: 'my-agent', keyId: 17 } },
    });
    const calls: string[] = [];
    const fetchSpy = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/v1/developer/agents')) return jsonResponse({ agents: [AGENT_7, AGENT_8] });
      return jsonResponse({ active: true, limitRaw: '5000000' });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await main(['budget', 'set', '5', '--agent', 'other-agent']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(calls.some((c) => c.includes('PUT') && c.includes('/v1/developer/agents/8/spend-limit'))).toBe(true);
    expect(calls.some((c) => c.includes('/v1/developer/agents/7/spend-limit'))).toBe(false);
  });
});

describe('init under FLOE_AGENT_KEY (review finding 4)', () => {
  it('mints and stores a real key instead of treating the env var as the stored one', async () => {
    writeConfigRaw({ apiUrl: API });
    vi.stubEnv('FLOE_AGENT_KEY', 'floe_env_key_from_elsewhere');
    const calls: string[] = [];
    const fetchSpy = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/v1/developer/profile')) {
        return jsonResponse({
          developer: {
            walletAddress: '0xdev',
            displayName: 'Dev',
            email: null,
            accountId: 'acct-1',
            role: 'owner',
            createdAt: '2026-08-01T00:00:00Z',
          },
          agents: [AGENT_7],
        });
      }
      if (u.endsWith('/v1/developer/agents/7/keys') && init?.method === 'POST') {
        return jsonResponse({
          id: 30,
          keyPrefix: 'floe_zz99',
          key: 'floe_freshly_minted',
          label: 'floe-cli',
          permissions: 'read_write',
          lastUsedAt: null,
          createdAt: '2026-08-07T00:00:00Z',
          budget: null,
        });
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${u}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    await main(['init', '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(calls.some((c) => c.startsWith('POST') && c.includes('/agents/7/keys'))).toBe(true);
    expect(secretStore.get(`agent-key:${HOST}:7`)).toBe('floe_freshly_minted');
    const config = readConfigFile();
    expect(config.activeAgentId).toBe('7');
    const parsed = JSON.parse(stdout) as { mintedNewKey: boolean; agentKey: string };
    expect(parsed.mintedNewKey).toBe(true);
    expect(parsed.agentKey).toBe('floe_freshly_minted');
  });
});

describe('config hardening', () => {
  it('corrupt config.json fails loudly instead of being silently replaced', async () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(`${dir}/floe`, { recursive: true });
    writeFileSync(`${dir}/floe/config.json`, '{ definitely not json');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['status']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('not valid JSON');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
