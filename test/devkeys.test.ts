import { mkdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const API = 'https://credit-api.floelabs.xyz';
const dir = `${process.cwd()}/test/.tmp-devkeys-${process.pid}`;

let stdout: string;
let stderr: string;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const MINTED = {
  key: 'floe_live_secretraw9',
  id: 7,
  keyPrefix: 'floe_live_cd34...',
  label: 'deploy',
  permissions: 'read',
  createdAt: '2026-08-07T00:00:00Z',
};

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
  // Empty config dir → default API URL, no agent needed (dev-plane only).
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  vi.stubEnv('XDG_CONFIG_HOME', dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('devkeys list', () => {
  const KEYS = [
    {
      id: 1,
      keyPrefix: 'floe_live_ab12...',
      label: 'ci[2Jx',
      permissions: 'read_write',
      lastUsedAt: '2026-08-01T10:00:00Z',
      createdAt: '2026-07-01T00:00:00Z',
    },
    {
      id: 2,
      keyPrefix: 'floe_live_ef56...',
      label: null,
      permissions: 'read',
      lastUsedAt: null,
      createdAt: '2026-07-15T00:00:00Z',
    },
  ];

  it('GETs /v1/developer/keys and prints a sanitized table', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ keys: KEYS }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['devkeys', 'list']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/keys`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer floe_live_test');
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('floe_live_ab12...');
    expect(stdout).toContain('2026-08-01');
    expect(stdout).toContain('never');
    // Network-sourced label had a CSI clear-screen sequence — stripped.
    expect(stdout).not.toContain('[2J');
    expect(stdout).toContain('cix');
  });

  it('--json passes the response through', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ keys: KEYS }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['devkeys', '--json']);

    expect(JSON.parse(stdout)).toEqual({ keys: KEYS });
  });

  it('maps an auth failure to exit 4', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: 'Unauthorized', message: 'Invalid API key' }, 401),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['devkeys', 'list']);

    expect(stderr).toContain('Invalid API key');
    expect(process.exitCode).toBe(4);
  });
});

describe('devkeys create', () => {
  it('POSTs label and read-only permissions and prints the raw key once', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(MINTED, 201));
    vi.stubGlobal('fetch', fetchMock);

    await main(['devkeys', 'create', '--label', 'deploy', '--read-only']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/keys`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ label: 'deploy', permissions: 'read' });
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout.split('floe_live_secretraw9').length - 1).toBe(1);
    expect(stdout).toContain('floe init --key');
  });

  it('--json emits the minted key as machine-readable JSON with an empty default body', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(MINTED, 201));
    vi.stubGlobal('fetch', fetchMock);

    await main(['devkeys', 'create', '--json']);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({});
    expect(JSON.parse(stdout)).toEqual({
      created: true,
      id: 7,
      keyPrefix: 'floe_live_cd34...',
      key: 'floe_live_secretraw9',
      label: 'deploy',
      permissions: 'read',
    });
  });

  it('remaps the key-limit error to a friendly revoke-or-rotate message', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: 'Limit exceeded', message: 'Maximum 5 API keys allowed' }, 400),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['devkeys', 'create']);

    expect(stderr).toContain('maximum number of developer keys');
    expect(stderr).toContain('floe devkeys revoke');
    expect(process.exitCode).toBe(1);
  });
});

describe('devkeys revoke', () => {
  it('refuses without --yes when non-interactive and makes no network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['devkeys', 'revoke', '3']);

    expect(stderr).toContain('--yes');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('DELETEs the key with --yes and warns the machine may be stranded', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ message: 'API key revoked' }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['devkeys', 'revoke', '3', '--yes']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/keys/3`);
    expect(init.method).toBe('DELETE');
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('Developer key 3 revoked');
    // Generic strand warning — the CLI cannot know which id it signs in with.
    expect(stderr).toContain('floe init');
  });

  it('--json keeps stdout machine-readable (warning goes to stderr)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ message: 'API key revoked' }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['devkeys', 'revoke', '3', '--yes', '--json']);

    expect(JSON.parse(stdout)).toEqual({ revoked: true, keyId: '3' });
    expect(stderr).toContain('floe init');
  });

  it('rejects a non-numeric key id before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['devkeys', 'revoke', 'abc', '--yes']);

    expect(stderr).toContain('Invalid key id');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('devkeys rotate', () => {
  it('POSTs the rotate route and prints the new key once with recovery notes', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(MINTED, 201));
    vi.stubGlobal('fetch', fetchMock);

    await main(['devkeys', 'rotate', '3']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/keys/3/rotate`);
    expect(init.method).toBe('POST');
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout.split('floe_live_secretraw9').length - 1).toBe(1);
    expect(stdout).toContain('floe init --key');
    // FLOE_API_KEY is stubbed in these tests → env-override note must print.
    expect(stdout).toContain('FLOE_API_KEY is set');
  });

  it('--json emits the rotated key as machine-readable JSON', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(MINTED, 201));
    vi.stubGlobal('fetch', fetchMock);

    await main(['devkeys', 'rotate', '3', '--json']);

    expect(JSON.parse(stdout)).toEqual({
      rotated: true,
      id: 7,
      keyPrefix: 'floe_live_cd34...',
      key: 'floe_live_secretraw9',
      label: 'deploy',
      permissions: 'read',
    });
  });

  it('requires a keyId', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['devkeys', 'rotate']);

    expect(stderr).toContain('Usage: floe devkeys rotate <keyId>');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a not-found rotate as an error exit', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: 'Not found', message: 'API key not found or already revoked' }, 404),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['devkeys', 'rotate', '3']);

    expect(stderr).toContain('not found or already revoked');
    expect(process.exitCode).toBe(1);
  });
});

describe('devkeys dispatch', () => {
  it('rejects an unknown subcommand', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['devkeys', 'frobnicate']);

    expect(stderr).toContain('Unknown devkeys subcommand');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects extra positionals', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['devkeys', 'list', 'extra']);

    expect(stderr).toContain('Unexpected argument');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
