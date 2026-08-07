import { mkdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;
const dir = `${process.cwd()}/test/.tmp-pay-${process.pid}`;

type FetchInit = { method?: string; headers?: Record<string, string>; body?: unknown };

const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const VENDOR_URL = 'https://api.vendor.example/v1/thing';

const CHECK_BODY = {
  x402: true,
  status: 402,
  x402Version: 2,
  payment: {
    amount: '50000',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0xAbCd000000000000000000000000000000001234',
    network: 'base',
  },
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
  vi.stubEnv('FLOE_API_KEY', '');
  vi.stubEnv('FLOE_AGENT_KEY', 'floe_test');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('floe pay --check', () => {
  it('runs the unauthenticated pre-flight and prints the price', async () => {
    vi.stubEnv('FLOE_AGENT_KEY', ''); // works signed-out
    const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchInit) => jsonRes(200, CHECK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main(['pay', VENDOR_URL, '--check']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://credit-api.floelabs.xyz/v1/proxy/check?url=${encodeURIComponent(VENDOR_URL)}`,
    );
    expect(init?.headers?.Authorization).toBeUndefined();
    expect(stdout).toContain('$0.05');
    expect(stdout).toContain('0xAbCd000000000000000000000000000000001234');
    expect(stdout).toContain('base');
  });

  it('--check --json passes the pre-flight response through verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, CHECK_BODY)));

    await main(['pay', VENDOR_URL, '--check', '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toEqual(CHECK_BODY);
  });

  it('reports a free URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes(200, { x402: false, status: 200, message: 'This URL does not require x402 payment' })),
    );

    await main(['pay', VENDOR_URL, '--check']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('No x402 payment required');
  });
});

describe('floe pay', () => {
  it('POSTs the proxy body and rides attribution as headers', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchInit) =>
      new Response('{"result":42}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'X-Floe-Cost-USDC': '50000',
          'X-Floe-Payment': 'paid',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main([
      'pay', VENDOR_URL,
      '--method', 'POST',
      '--data', '{"q":1}',
      '--header', 'X-Vendor: abc',
      '--header', 'Accept: application/json',
      '--task', 'task-1',
      '--action', 'act-9',
      '--idempotency-key', 'idem-1',
    ]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://credit-api.floelabs.xyz/v1/proxy/fetch');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.Authorization).toBe('Bearer floe_test');
    expect(init?.headers?.['Idempotency-Key']).toBe('idem-1');
    expect(init?.headers?.['X-Floe-Task-Id']).toBe('task-1');
    expect(init?.headers?.['X-Floe-Action-Id']).toBe('act-9');
    expect(JSON.parse(String(init?.body))).toEqual({
      url: VENDOR_URL,
      method: 'POST',
      headers: { 'X-Vendor': 'abc', Accept: 'application/json' },
      body: '{"q":1}',
    });
    expect(stdout).toContain('200');
    expect(stdout).toContain('$0.05');
    expect(stdout).toContain('result');
  });

  it('defaults the method to POST when --data is given', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchInit) =>
      new Response('ok', { status: 200, headers: { 'X-Floe-Cost-USDC': '0', 'X-Floe-Payment': 'passthrough' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['pay', VENDOR_URL, '--data', '{}']);

    expect(process.exitCode ?? 0).toBe(0);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).method).toBe('POST');
  });

  it('--json emits status, payment marker, cost, and the parsed body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('{"result":42}', {
          status: 200,
          headers: { 'X-Floe-Cost-USDC': '50000', 'X-Floe-Payment': 'paid' },
        }),
      ),
    );

    await main(['pay', VENDOR_URL, '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      status: 200,
      payment: 'paid',
      replayed: false,
      costRaw: '50000',
      costUsd: '$0.05',
      body: { result: 42 },
    });
  });

  it('relays an upstream error passthrough (marker present) without failing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('upstream broke', {
          status: 500,
          headers: { 'X-Floe-Cost-USDC': '0', 'X-Floe-Payment': 'passthrough' },
        }),
      ),
    );

    await main(['pay', VENDOR_URL]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('500');
    expect(stdout).toContain('upstream broke');
    expect(stdout).toContain('passthrough');
  });

  it('maps a proxy 402 refusal (no payment marker) to exit 5', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(402, { error: 'insufficient_funds' })));

    await main(['pay', VENDOR_URL]);

    expect(process.exitCode).toBe(5);
    expect(stderr).toContain('insufficient_funds');
  });

  it('rejects an unsupported method before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['pay', VENDOR_URL, '--method', 'TRACE']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unsupported method');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed --header before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['pay', VENDOR_URL, '--header', 'not-a-header']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Invalid --header');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid URL before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['pay', 'not a url']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Invalid URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exits 4 without an agent credential, before any network call', async () => {
    vi.stubEnv('FLOE_AGENT_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['pay', VENDOR_URL]);

    expect(process.exitCode).toBe(4);
    expect(stderr).toContain('No agent key found');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
