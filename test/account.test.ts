import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;

interface FetchCall {
  url: string;
  method: string;
  body?: string;
  auth?: string;
}
let calls: FetchCall[];

const tmpRoot = `${process.cwd()}/test/.tmp-account-${process.pid}`;

function setupConfig(): void {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(`${tmpRoot}/floe`, { recursive: true });
  writeFileSync(
    `${tmpRoot}/floe/config.json`,
    JSON.stringify({
      apiUrl: 'https://credit-api.floelabs.xyz',
      activeAgentId: 'agent-1',
      agents: {
        'agent-1': { name: 'my-agent', wallet: '0xabc', keyId: 'key-1', keyPrefix: 'floe_ab12' },
      },
    }),
  );
  vi.stubEnv('XDG_CONFIG_HOME', tmpRoot);
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
        auth: headers.Authorization,
      });
      return handler(String(url), init);
    }),
  );
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const PROFILE = {
  developer: {
    walletAddress: '0x1111111111111111111111111111111111111111',
    displayName: 'Acme Labs',
    email: 'ops@acme.dev',
    accountId: 'acct_9f3k2m',
    role: 'owner',
    createdAt: '2026-05-01T12:00:00.000Z',
  },
  agents: [
    { id: 'agent-1', name: 'my-agent', status: 'active' },
    { id: 'agent-2', name: 'old-agent', status: 'closed' },
  ],
};

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  setupConfig();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('floe account (show)', () => {
  it('GETs /profile on the developer plane and renders identity', async () => {
    stubFetch(() => json(200, PROFILE));
    await main(['account']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://credit-api.floelabs.xyz/v1/developer/profile');
    expect(calls[0]?.auth).toBe('Bearer floe_live_test');
    expect(stdout).toContain('Acme Labs');
    expect(stdout).toContain('acct_9f3k2m');
    expect(stdout).toContain('owner');
    expect(stdout).toContain('0x1111111111111111111111111111111111111111');
    expect(stdout).toContain('2 (1 active)');
  });

  it('--json round-trips the profile body', async () => {
    stubFetch(() => json(200, PROFILE));
    await main(['account', 'show', '--json']);
    expect(JSON.parse(stdout)).toEqual(PROFILE);
  });

  it('nudges unnamed accounts toward rename', async () => {
    stubFetch(() =>
      json(200, { ...PROFILE, developer: { ...PROFILE.developer, displayName: null } }),
    );
    await main(['account']);
    expect(stdout).toContain('floe account rename');
  });
});

describe('floe account rename', () => {
  it('PATCHes /me with only displayName', async () => {
    stubFetch(() =>
      json(200, {
        developer: {
          walletAddress: PROFILE.developer.walletAddress,
          displayName: 'New Name',
          accountId: 'acct_9f3k2m',
        },
      }),
    );
    await main(['account', 'rename', 'New Name']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe('https://credit-api.floelabs.xyz/v1/developer/me');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ displayName: 'New Name' });
    expect(stdout).toContain('renamed to');
    expect(stdout).toContain('New Name');
  });

  it('--json prints the PATCH response', async () => {
    const body = {
      developer: { walletAddress: '0x1', displayName: 'New Name', accountId: 'acct_9f3k2m' },
    };
    stubFetch(() => json(200, body));
    await main(['account', 'rename', 'New Name', '--json']);
    expect(JSON.parse(stdout)).toEqual(body);
  });

  it('rejects a >100-char name before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['account', 'rename', 'x'.repeat(101)]);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('1–100 characters');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requires a name argument', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['account', 'rename']);
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps the 403 non-admin rename to exit 4', async () => {
    stubFetch(() =>
      json(403, { error: 'Forbidden', message: 'Only an owner or admin can rename the account.' }),
    );
    await main(['account', 'rename', 'Nope']);
    expect(process.exitCode).toBe(4);
    expect(stderr).toContain('Only an owner or admin can rename the account.');
  });
});

describe('floe account dispatch', () => {
  it('rejects an unknown subcommand', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['account', 'frobnicate']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unknown account subcommand');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
