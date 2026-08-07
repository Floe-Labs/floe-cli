import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const API = 'https://credit-api.floelabs.xyz';
const dir = `${process.cwd()}/test/.tmp-orchestrators-${process.pid}`;

let stdout: string;
let stderr: string;

// retell/bland secrets are collected from stdin in non-interactive runs —
// swap process.stdin for an in-memory stream, never the real terminal.
const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
function stubStdin(data: string): void {
  Object.defineProperty(process, 'stdin', {
    value: Readable.from([data]),
    configurable: true,
  });
}

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

const VAPI_CONN = {
  id: 3,
  provider: 'vapi',
  agentWallet: '0xabcd000000000000000000000000000000001234',
  label: 'prod',
  active: true,
  lastEventAt: '2026-08-06T10:00:00Z',
  webhookUrl: `${API}/v1/webhooks/vapi/call-end/tok123`,
  preCallUrl: `${API}/v1/webhooks/vapi/pre-call/tok123`,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
};

const RETELL_CONN = {
  ...VAPI_CONN,
  id: 4,
  provider: 'retell',
  label: null,
  webhookUrl: `${API}/v1/webhooks/retell/call-end/tok456`,
  preCallUrl: `${API}/v1/webhooks/retell/pre-call/tok456`,
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
  if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('orchestrators list', () => {
  it('GETs the connections and renders the table', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ connections: [VAPI_CONN, RETELL_CONN] }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['orchestrators', 'list']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/orchestrators`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer floe_live_test');
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('vapi');
    expect(stdout).toContain('retell');
    expect(stdout).toContain('active');
  });

  it('--json returns the connections unchanged', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ connections: [VAPI_CONN] }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['orchestrators', '--json']); // bare noun defaults to list

    expect(JSON.parse(stdout)).toEqual({ connections: [VAPI_CONN] });
  });
});

describe('orchestrators connect', () => {
  it('vapi: POSTs without a secret and prints the minted secret exactly once', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ...VAPI_CONN, secret: 'whsec_mintedonce123' }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['orchestrators', 'connect', '--provider', 'vapi', '--label', 'prod']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/orchestrators`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      agentId: 'agent-1',
      provider: 'vapi',
      label: 'prod',
    });
    expect(process.exitCode ?? 0).toBe(0);
    // The minted secret is shown exactly once, alongside the paste-in URLs.
    expect(stdout.split('whsec_mintedonce123').length - 1).toBe(1);
    expect(stdout).toContain(VAPI_CONN.webhookUrl);
    expect(stdout).toContain(VAPI_CONN.preCallUrl);
  });

  it('vapi --json includes the minted secret in machine-readable output', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ...VAPI_CONN, secret: 'whsec_mintedonce123' }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['orchestrators', 'connect', '--provider', 'vapi', '--json']);

    expect(JSON.parse(stdout)).toEqual({
      connected: true,
      agentId: 'agent-1',
      ...VAPI_CONN,
      secret: 'whsec_mintedonce123',
    });
  });

  it('retell: reads the supplied secret from stdin, sends it, and never echoes it', async () => {
    stubStdin('retell_key_abc123\n');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(RETELL_CONN, 201));
    vi.stubGlobal('fetch', fetchMock);

    await main(['orchestrators', 'connect', '--provider', 'retell']);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      agentId: 'agent-1',
      provider: 'retell',
      secret: 'retell_key_abc123',
    });
    expect(process.exitCode ?? 0).toBe(0);
    // Supplied secrets are the caller's own — never printed back.
    expect(stdout).not.toContain('retell_key_abc123');
    expect(stderr).not.toContain('retell_key_abc123');
  });

  it('bland: refuses an empty stdin secret before any network call', async () => {
    stubStdin('');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['orchestrators', 'connect', '--provider', 'bland']);

    expect(stderr).toContain('No bland secret provided');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown --provider before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['orchestrators', 'connect', '--provider', 'twilio']);

    expect(stderr).toContain('Unknown provider');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('remaps already_connected to a rotate hint', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: 'already_connected', detail: 'This agent already has a vapi connection.', id: 3 }, 409),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['orchestrators', 'connect', '--provider', 'vapi']);

    expect(stderr).toContain('already has a vapi connection');
    expect(stderr).toContain('floe orchestrators rotate');
    expect(process.exitCode).toBe(1);
  });
});

describe('orchestrators rotate', () => {
  it('vapi: POSTs an empty body and prints the new secret + URLs exactly once', async () => {
    const rotated = {
      ...VAPI_CONN,
      webhookUrl: `${API}/v1/webhooks/vapi/call-end/tok999`,
      preCallUrl: `${API}/v1/webhooks/vapi/pre-call/tok999`,
      secret: 'whsec_rotatedonce456',
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET'
        ? jsonResponse({ connections: [VAPI_CONN, RETELL_CONN] })
        : jsonResponse(rotated),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['orchestrators', 'rotate', '3']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${API}/v1/developer/orchestrators`);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/orchestrators/3/rotate`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({});
    expect(stdout.split('whsec_rotatedonce456').length - 1).toBe(1);
    expect(stdout).toContain('tok999'); // the NEW urls, not the old ones
  });

  it('retell: collects the new provider credential from stdin and sends it', async () => {
    stubStdin('retell_key_new_9876');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET'
        ? jsonResponse({ connections: [RETELL_CONN] })
        : jsonResponse(RETELL_CONN),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['orchestrators', 'rotate', '4', '--json']);

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/orchestrators/4/rotate`);
    expect(JSON.parse(String(init.body))).toEqual({ secret: 'retell_key_new_9876' });
    expect(JSON.parse(stdout)).toEqual({ rotated: true, ...RETELL_CONN });
    expect(stdout).not.toContain('retell_key_new_9876');
  });

  it('fails with the known ids when the connection does not exist', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ connections: [VAPI_CONN] }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['orchestrators', 'rotate', '99']);

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the list lookup
    expect(stderr).toContain('No orchestrator connection with id 99');
    expect(process.exitCode).toBe(2);
  });
});

describe('orchestrators enable / disable', () => {
  it('enable PATCHes active:true', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true, active: true }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['orchestrators', 'enable', '3']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/orchestrators/3`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ active: true });
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('enabled');
  });

  it('disable PATCHes active:false and --json reports it', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true, active: false }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['orchestrators', 'disable', '3', '--json']);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ active: false });
    expect(JSON.parse(stdout)).toEqual({ id: 3, active: false });
  });

  it('maps a payment-required failure to exit 5', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: 'payment_required', message: 'Settle your balance first' }, 402),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['orchestrators', 'enable', '3']);

    expect(process.exitCode).toBe(5);
    expect(stderr).toContain('Settle your balance first');
  });
});

describe('orchestrators remove', () => {
  it('refuses without --yes when non-interactive and makes no network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['orchestrators', 'remove', '3']);

    expect(stderr).toContain('--yes');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('DELETEs the connection with --yes', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['orchestrators', 'remove', '3', '--yes', '--json']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/orchestrators/3`);
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(stdout)).toEqual({ removed: true, id: 3 });
  });
});

describe('orchestrators dispatch', () => {
  it('rejects a non-numeric connection id before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['orchestrators', 'remove', 'abc', '--yes']);

    expect(stderr).toContain('Invalid connection id');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown subcommand', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['orchestrators', 'frobnicate']);

    expect(stderr).toContain('Unknown orchestrators subcommand');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects extra positionals', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['orchestrators', 'enable', '3', 'extra']);

    expect(stderr).toContain('Unexpected argument');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
