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

const tmpRoot = `${process.cwd()}/test/.tmp-team-${process.pid}`;

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

const OWNER_WALLET = '0x1111111111111111111111111111111111111111';
const MEMBER_WALLET = '0x2222222222222222222222222222222222222222';

const MEMBERS = {
  members: [
    {
      memberWallet: OWNER_WALLET,
      role: 'owner',
      displayName: 'Acme Labs',
      email: 'ops@acme.dev',
      invitedBy: null,
      createdAt: '2026-05-01T12:00:00.000Z',
      isSelf: true,
    },
    {
      memberWallet: MEMBER_WALLET,
      role: 'member',
      displayName: null,
      email: null,
      invitedBy: OWNER_WALLET,
      createdAt: '2026-07-15T08:00:00.000Z',
      isSelf: false,
    },
  ],
  role: 'owner',
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

describe('floe team members', () => {
  it('GETs /team/members and renders wallet, role, and join date', async () => {
    stubFetch(() => json(200, MEMBERS));
    await main(['team']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://credit-api.floelabs.xyz/v1/developer/team/members');
    expect(calls[0]?.auth).toBe('Bearer floe_live_test');
    expect(stdout).toContain(OWNER_WALLET);
    expect(stdout).toContain(MEMBER_WALLET);
    expect(stdout).toContain('owner');
    expect(stdout).toContain('2026-07-15');
    expect(stdout).toContain('● = you');
  });

  it('--json round-trips the roster', async () => {
    stubFetch(() => json(200, MEMBERS));
    await main(['team', 'members', '--json']);
    expect(JSON.parse(stdout)).toEqual(MEMBERS);
  });
});

describe('floe team invite', () => {
  const INVITE_RESPONSE = {
    invite: {
      id: 7,
      email: 'new@acme.dev',
      role: 'member',
      expiresAt: '2026-08-14T12:00:00.000Z',
      createdAt: '2026-08-07T12:00:00.000Z',
    },
  };

  it('POSTs email + role and explains the emailed accept link', async () => {
    stubFetch(() => json(200, INVITE_RESPONSE));
    await main(['team', 'invite', 'new@acme.dev', '--role', 'member']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://credit-api.floelabs.xyz/v1/developer/team/invites');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ email: 'new@acme.dev', role: 'member' });
    expect(stdout).toContain('new@acme.dev');
    expect(stdout).toContain('2026-08-14');
    // The token never comes back from the API; the CLI must say the link was
    // emailed rather than fabricate one.
    expect(stdout).toContain('dev-dashboard.floelabs.xyz/invite/accept?token=…');
    expect(stdout).toContain('emailed');
  });

  it('--json prints the created invite', async () => {
    stubFetch(() => json(200, INVITE_RESPONSE));
    await main(['team', 'invite', 'new@acme.dev', '--role', 'viewer', '--json']);
    expect(JSON.parse(stdout)).toEqual(INVITE_RESPONSE);
  });

  it('requires --role before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['team', 'invite', 'new@acme.dev']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('admin, member, viewer');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects the owner role before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['team', 'invite', 'new@acme.dev', '--role', 'owner']);
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed email before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['team', 'invite', 'not-an-email', '--role', 'member']);
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces the owner-only admin-invite 403 as exit 4', async () => {
    stubFetch(() => json(403, { error: 'Forbidden', message: 'Only an owner can invite an admin.' }));
    await main(['team', 'invite', 'new@acme.dev', '--role', 'admin']);
    expect(process.exitCode).toBe(4);
    expect(stderr).toContain('Only an owner can invite an admin.');
  });
});

describe('floe team revoke-invite', () => {
  it('refuses without --yes when non-interactive, before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['team', 'revoke-invite', '7']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--yes');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('DELETEs the invite with --yes', async () => {
    stubFetch(() => json(200, { ok: true }));
    await main(['team', 'revoke-invite', '7', '--yes']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('https://credit-api.floelabs.xyz/v1/developer/team/invites/7');
    expect(stdout).toContain('Invite 7 revoked');
  });

  it('rejects a non-numeric id before confirm or network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['team', 'revoke-invite', 'seven', '--yes']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Invalid invite id');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('floe team set-role', () => {
  it('PATCHes the member wallet with the new role (lowercased path)', async () => {
    const mixedCase = '0xAbCDef0123456789abCDef0123456789ABcdEF01';
    const lowered = mixedCase.toLowerCase();
    stubFetch(() => json(200, { ok: true, memberWallet: lowered, role: 'viewer' }));
    await main(['team', 'set-role', mixedCase, 'viewer']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe(
      `https://credit-api.floelabs.xyz/v1/developer/team/members/${lowered}`,
    );
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ role: 'viewer' });
    expect(stdout).toContain('viewer');
  });

  it('remaps the owner-only 403 clearly with exit 4', async () => {
    stubFetch(() =>
      json(403, { error: 'Forbidden', message: 'This action requires the owner role or higher.' }),
    );
    await main(['team', 'set-role', MEMBER_WALLET, 'admin']);
    expect(process.exitCode).toBe(4);
    expect(stderr).toContain('Only the account owner can change member roles.');
  });

  it('rejects a bad wallet before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['team', 'set-role', 'not-a-wallet', 'viewer']);
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('floe team remove', () => {
  it('refuses without --yes when non-interactive, before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['team', 'remove', MEMBER_WALLET]);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--yes');
    // The refusal copy must carry the key-revocation warning.
    expect(stderr).toContain('revokes every API key they minted');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('DELETEs the member with --yes and reports revoked keys', async () => {
    stubFetch(() => json(200, { ok: true, memberWallet: MEMBER_WALLET, revokedKeys: 3 }));
    await main(['team', 'remove', MEMBER_WALLET, '--yes']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe(
      `https://credit-api.floelabs.xyz/v1/developer/team/members/${MEMBER_WALLET}`,
    );
    expect(stdout).toContain('Removed');
    expect(stdout).toContain('3 API keys');
  });

  it('--json round-trips the removal result', async () => {
    const body = { ok: true, memberWallet: MEMBER_WALLET, revokedKeys: 0 };
    stubFetch(() => json(200, body));
    await main(['team', 'remove', MEMBER_WALLET, '--yes', '--json']);
    expect(JSON.parse(stdout)).toEqual(body);
  });
});

describe('floe team dispatch', () => {
  it('rejects an unknown subcommand', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['team', 'frobnicate']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unknown team subcommand');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
