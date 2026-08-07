import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

// keys rotate writes the replacement key via setSecret — keep secrets in
// memory so tests never touch the OS keychain or the credentials file.
vi.mock('../src/lib/keychain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/keychain.js')>();
  const store = new Map<string, string>();
  return {
    ...actual,
    getSecret: async (account: string) => store.get(account),
    setSecret: async (account: string, value: string) => {
      store.set(account, value);
    },
  };
});

const API = 'https://credit-api.floelabs.xyz';
const dir = `${process.cwd()}/test/.tmp-keys-${process.pid}`;

let stdout: string;
let stderr: string;

function writeConfigFixture(): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/floe`, { recursive: true });
  writeFileSync(
    `${dir}/floe/config.json`,
    JSON.stringify({
      apiUrl: API,
      activeAgentId: 'agent-1',
      agents: {
        'agent-1': { name: 'my-agent', wallet: '0xabc', keyId: '17', keyPrefix: 'floe_ab12' },
      },
    }),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const MINTED = {
  key: 'floe_rawmintedkey99',
  id: 'key-42',
  keyPrefix: 'floe_cd34...',
  label: 'ci',
  permissions: 'read_write',
  createdAt: '2026-08-07T00:00:00Z',
  budget: {
    policyId: 'pol-1',
    limitRaw: '5000000',
    spentRaw: '0',
    remainingRaw: '5000000',
    windowKind: 'rolling',
    windowResetsAt: null,
  },
};

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
  writeConfigFixture();
  vi.stubEnv('XDG_CONFIG_HOME', dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('keys create', () => {
  it('POSTs label, budgetRaw and windowSeconds and prints the raw key once', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(MINTED, 201));
    vi.stubGlobal('fetch', fetchMock);

    await main(['keys', 'create', '--label', 'ci', '--budget', '5', '--window', '24h']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/agents/agent-1/keys`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer floe_live_test');
    expect(JSON.parse(String(init.body))).toEqual({
      label: 'ci',
      budgetRaw: '5000000',
      windowSeconds: 86_400,
    });
    expect(process.exitCode ?? 0).toBe(0);
    // Raw key shown exactly once; machine's own key is untouched.
    expect(stdout.split('floe_rawmintedkey99').length - 1).toBe(1);
    expect(stdout).toContain('This machine keeps using its current key');
  });

  it('--json emits the minted key as machine-readable JSON', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(MINTED, 201));
    vi.stubGlobal('fetch', fetchMock);

    await main(['keys', 'create', '--json']);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({});
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      created: true,
      agentId: 'agent-1',
      id: 'key-42',
      keyPrefix: 'floe_cd34...',
      key: 'floe_rawmintedkey99',
      budget: { limitRaw: '5000000' },
    });
  });

  it('rejects an invalid --budget before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['keys', 'create', '--budget', 'abc']);

    expect(stderr).toContain('Invalid USD amount');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses --window without --budget before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['keys', 'create', '--window', '24h']);

    expect(stderr).toContain('--window only applies with --budget');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('remaps limit_exceeded to a friendly revoke-or-rotate error', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ error: 'limit_exceeded', max: 5 }, 409));
    vi.stubGlobal('fetch', fetchMock);

    await main(['keys', 'create']);

    expect(stderr).toContain('maximum number of API keys');
    expect(stderr).toContain('floe keys revoke');
    expect(process.exitCode).toBe(1);
  });
});

describe('keys revoke', () => {
  it('refuses without --yes when non-interactive and makes no network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['keys', 'revoke', '17']);

    expect(stderr).toContain('--yes');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('DELETEs the key with --yes and warns when it is this machine\'s key', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ message: 'API key revoked' }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['keys', 'revoke', '17', '--yes']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/agents/agent-1/keys/17`);
    expect(init.method).toBe('DELETE');
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('revoked');
    // keyId 17 is the machine's recorded key → recovery warning.
    expect(stderr).toContain('floe init --new-key');
    expect(stdout).toContain('floe init --new-key');
  });

  it('--json reports wasMachineKey with clean JSON on stdout', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ message: 'API key revoked' }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['keys', 'revoke', '17', '--yes', '--json']);

    expect(JSON.parse(stdout)).toEqual({
      revoked: true,
      agentId: 'agent-1',
      keyId: '17',
      wasMachineKey: true,
    });
  });

  it('resolves --agent against the fleet before revoking', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          agents: [{ id: 'agent-2', name: 'other', status: 'active' }],
        });
      }
      return jsonResponse({ message: 'API key revoked' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await main(['keys', 'revoke', '9', '--agent', 'other', '--yes', '--json']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${API}/v1/developer/agents`);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`${API}/v1/developer/agents/agent-2/keys/9`);
    expect(JSON.parse(stdout)).toMatchObject({ revoked: true, agentId: 'agent-2', wasMachineKey: false });
  });

  it('rejects a non-numeric key id before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['keys', 'revoke', 'abc', '--yes']);

    expect(stderr).toContain('Invalid key id');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps an auth failure to exit 4', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: 'forbidden', message: 'This key is read-only' }, 403),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['keys', 'revoke', '17', '--yes']);

    expect(process.exitCode).toBe(4);
  });
});

describe('keys list / rotate (existing behavior)', () => {
  it('list --json returns the agent id and keys unchanged', async () => {
    const keys = [
      {
        id: '17',
        keyPrefix: 'floe_ab12...',
        label: null,
        permissions: 'read_write',
        lastUsedAt: null,
        createdAt: '2026-08-01T00:00:00Z',
        budget: null,
      },
    ];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ keys }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['keys', 'list', '--json']);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${API}/v1/developer/agents/agent-1/keys`);
    expect(JSON.parse(stdout)).toEqual({ agentId: 'agent-1', keys });
  });

  it('rotate defaults to the machine key and stores the replacement', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ...MINTED, id: 'key-99', keyPrefix: 'floe_ef56...' }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['keys', 'rotate', '--json']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/agents/agent-1/keys/17/rotate`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(stdout)).toEqual({
      rotated: true,
      id: 'key-99',
      keyPrefix: 'floe_ef56...',
      key: 'floe_rawmintedkey99',
      storedLocally: true,
    });
    const config = JSON.parse(readFileSync(`${dir}/floe/config.json`, 'utf8'));
    expect(config.agents['agent-1']).toMatchObject({ keyId: 'key-99', keyPrefix: 'floe_ef56...' });
  });
});

describe('keys dispatch', () => {
  it('rejects an unknown subcommand', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['keys', 'frobnicate']);

    expect(stderr).toContain('Unknown keys subcommand');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects extra positionals', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['keys', 'revoke', '17', 'extra', '--yes']);

    expect(stderr).toContain('Unexpected argument');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
