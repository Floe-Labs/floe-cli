import { mkdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;
const dir = `${process.cwd()}/test/.tmp-vendors-${process.pid}`;

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

const VENDORS_BODY = {
  now: '2026-08-07T12:00:00.000Z',
  vendors: [
    {
      vendor: 'firecrawl',
      name: 'Firecrawl',
      endpoint: '/api/firecrawl/scrape',
      method: 'POST',
      priceUsdc: '0.01',
      status: 'ok',
      responseExcerpt: '{"success":true,"markdown":"# Example"}',
      costRaw: '10000',
      latencyMs: 812,
      checkedAt: '2026-08-07T10:00:00.000Z',
    },
    {
      vendor: 'badvendor',
      name: 'BadVendor',
      endpoint: '/api/badvendor/run',
      method: 'POST',
      priceUsdc: '0.02',
      status: 'down',
      // Hostile excerpt: OSC title-set sequence must never reach the terminal.
      responseExcerpt: '\u001b]0;pwned\u0007insufficient_balance',
      costRaw: null,
      latencyMs: null,
      checkedAt: '2026-08-06T12:00:00.000Z',
    },
  ],
};

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/floe`, { recursive: true });
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  vi.stubEnv('FLOE_API_URL', '');
  // Dev key via env — the keychain is never consulted.
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('floe vendors', () => {
  it('status renders health, settled cost, latency, and freshness', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, VENDORS_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main(['vendors', 'status']);

    expect(process.exitCode ?? 0).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://credit-api.floelabs.xyz/v1/playground/vendors');
    expect(init?.method).toBe('GET');
    expect(init?.headers?.Authorization).toBe('Bearer floe_live_test');
    expect(stdout).toContain('Firecrawl');
    expect(stdout).toContain('ok');
    expect(stdout).toContain('$0.01'); // settled costRaw 10000 → $0.01
    expect(stdout).toContain('812ms');
    expect(stdout).toContain('2h ago');
    expect(stdout).toContain('down');
    // No catalog API exists — point at the dashboard for full docs.
    expect(stdout).toContain('https://dev-dashboard.floelabs.xyz/vendors');
  });

  it('sanitizes network-sourced response excerpts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, VENDORS_BODY)));

    await main(['vendors', 'status']);

    expect(stdout).toContain('insufficient_balance');
    expect(stdout).not.toContain('\u001b]0;pwned');
    expect(stdout).not.toContain('\u0007');
  });

  it('defaults to status when no subcommand is given', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, VENDORS_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main(['vendors']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('--json emits the probe payload verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, VENDORS_BODY)));

    await main(['vendors', 'status', '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toEqual(VENDORS_BODY);
  });

  it('rejects unknown subcommands before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['vendors', 'list']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unknown vendors subcommand');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an API 401 to exit 4', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(401, { error: 'unauthorized' })));

    await main(['vendors', 'status']);

    expect(process.exitCode).toBe(4);
    expect(stderr).toContain('unauthorized');
  });
});
