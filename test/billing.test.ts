import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;

interface FetchCall {
  url: string;
  method: string;
  auth?: string;
}
let calls: FetchCall[];

const tmpRoot = `${process.cwd()}/test/.tmp-billing-${process.pid}`;

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
      calls.push({ url: String(url), method: init?.method ?? 'GET', auth: headers.Authorization });
      return handler(String(url), init);
    }),
  );
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const MTD = {
  totalRaw: '12500000',
  byVendor: [
    { vendor: 'openai', costRaw: '8000000' },
    { vendor: 'deepgram', costRaw: '4500000' },
  ],
  byAgent: [{ agentId: 3, agentName: 'my-agent', costRaw: '12500000', calls: 42 }],
};

const INVOICE = {
  period: { start: '2026-08-01T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z' },
  currency: 'USDC',
  decimals: 6,
  ...MTD,
};

const CSV = 'time,agent,vendor_endpoint,amount_raw\n2026-08-05T10:00:00Z,my-agent,openai·/v1/chat/completions,1000\n';

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

describe('floe billing (mtd)', () => {
  it('GETs /billing/mtd on the developer plane and renders both tables', async () => {
    stubFetch(() => json(200, MTD));
    await main(['billing']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://credit-api.floelabs.xyz/v1/developer/billing/mtd');
    expect(calls[0]?.auth).toBe('Bearer floe_live_test');
    expect(stdout).toContain('$12.50');
    expect(stdout).toContain('openai');
    expect(stdout).toContain('deepgram');
    expect(stdout).toContain('my-agent');
    expect(stdout).toContain('42');
  });

  it('--json passes raw amounts through untouched', async () => {
    stubFetch(() => json(200, MTD));
    await main(['billing', 'mtd', '--json']);
    expect(JSON.parse(stdout)).toEqual(MTD);
  });

  it('strips terminal escapes from network-sourced vendor names', async () => {
    stubFetch(() =>
      json(200, {
        ...MTD,
        byVendor: [{ vendor: ']0;pwnedopen[31mai', costRaw: '1000000' }],
      }),
    );
    await main(['billing']);
    expect(stdout).not.toContain(']');
    expect(stdout).toContain('openai');
  });
});

describe('floe billing invoice', () => {
  it('prints a human summary of the current period', async () => {
    stubFetch(() => json(200, INVOICE));
    await main(['billing', 'invoice']);
    expect(calls[0]?.url).toBe('https://credit-api.floelabs.xyz/v1/developer/billing/invoice');
    expect(stdout).toContain('2026-08-01 → 2026-09-01');
    expect(stdout).toContain('$12.50');
    expect(stdout).toContain('USDC');
  });

  it('--out writes the full invoice JSON to the file', async () => {
    stubFetch(() => json(200, INVOICE));
    const out = `${tmpRoot}/invoice.json`;
    await main(['billing', 'invoice', '--out', out]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(INVOICE);
    expect(stdout).toContain('Invoice written');
  });

  it('--json prints the invoice body verbatim', async () => {
    stubFetch(() => json(200, INVOICE));
    await main(['billing', 'invoice', '--json']);
    expect(JSON.parse(stdout)).toEqual(INVOICE);
  });
});

describe('floe billing export', () => {
  it('writes floe-charges-<yyyy-mm>.csv in cwd by default', async () => {
    stubFetch(() => new Response(CSV, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } }));
    vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot);
    await main(['billing', 'export']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]?.url).toBe('https://credit-api.floelabs.xyz/v1/developer/billing/export.csv');
    const month = new Date().toISOString().slice(0, 7);
    expect(readFileSync(`${tmpRoot}/floe-charges-${month}.csv`, 'utf8')).toBe(CSV);
    expect(stdout).toContain('Exported 1 charge row');
    // CSV never lands on stdout by default.
    expect(stdout).not.toContain('vendor_endpoint');
  });

  it('--out - streams raw CSV to stdout for piping', async () => {
    stubFetch(() => new Response(CSV, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } }));
    await main(['billing', 'export', '--out', '-']);
    expect(stdout).toBe(CSV);
  });

  it('surfaces the 413 export_too_large body as a clear error', async () => {
    stubFetch(() =>
      json(413, {
        error: 'export_too_large',
        message: "This month's charge export exceeds the 10000-row CSV limit. Contact support for a full extract.",
        limit: 10000,
      }),
    );
    await main(['billing', 'export']);
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('10000-row CSV limit');
    expect(stderr).toContain('contact support');
  });
});

describe('floe billing charges', () => {
  const CHARGES = {
    charges: [
      {
        time: '2026-08-06T09:30:00.000Z',
        agentId: 3,
        agentName: 'my-agent',
        vendor: 'openai',
        endpoint: '/v1/chat/completions',
        amountRaw: '1234',
      },
    ],
    limit: 5,
  };

  it('passes --limit through as a query param and renders the table', async () => {
    stubFetch(() => json(200, CHARGES));
    await main(['billing', 'charges', '--limit', '5']);
    expect(calls[0]?.url).toBe('https://credit-api.floelabs.xyz/v1/developer/charges/recent?limit=5');
    expect(stdout).toContain('my-agent');
    expect(stdout).toContain('/v1/chat/completions');
    expect(stdout).toContain('$0.001234');
    expect(stdout).toContain('2026-08-06 09:30');
  });

  it('--json round-trips the response', async () => {
    stubFetch(() => json(200, CHARGES));
    await main(['billing', 'charges', '--json']);
    expect(calls[0]?.url).toBe('https://credit-api.floelabs.xyz/v1/developer/charges/recent');
    expect(JSON.parse(stdout)).toEqual(CHARGES);
  });

  it('rejects a non-numeric --limit before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['billing', 'charges', '--limit', 'abc']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Invalid --limit');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('floe billing dispatch', () => {
  it('rejects an unknown subcommand', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['billing', 'frobnicate']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unknown billing subcommand');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects extra positionals', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await main(['billing', 'mtd', 'extra']);
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
