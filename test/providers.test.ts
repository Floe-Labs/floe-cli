import { mkdirSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;
const dir = `${process.cwd()}/test/.tmp-providers-${process.pid}`;

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

const LIST_BODY = {
  providerKeys: [
    {
      provider: 'openai',
      keyPrefix: 'sk-ab12c...',
      label: 'prod',
      enabled: true,
      createdBy: '0xabc',
      lastUsedAt: '2026-08-01T09:30:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  supportedProviders: ['openai', 'anthropic', 'groq'],
};

const PUT_ROW = {
  provider: 'openai',
  keyPrefix: 'sk-test-...',
  label: 'prod',
  enabled: true,
  createdBy: '0xabc',
  lastUsedAt: null,
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-07T00:00:00.000Z',
};

/** Run with a piped (non-TTY) stdin so the secret is read from the pipe. */
async function withStdin<T>(input: string, fn: () => Promise<T>): Promise<T> {
  const fake = Readable.from([input]) as unknown as NodeJS.ReadStream & { isTTY?: boolean };
  fake.isTTY = false;
  const original = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'stdin', original);
  }
}

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

describe('floe providers', () => {
  it('list shows masked keys and supported providers, never key material', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, LIST_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main(['providers']);

    expect(process.exitCode ?? 0).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://credit-api.floelabs.xyz/v1/developer/provider-keys');
    expect(init?.method).toBe('GET');
    expect(init?.headers?.Authorization).toBe('Bearer floe_live_test');
    expect(stdout).toContain('openai');
    expect(stdout).toContain('sk-ab12c...');
    expect(stdout).toContain('enabled');
    expect(stdout).toContain('2026-08-01');
    expect(stdout).toContain('anthropic');
  });

  it('list --json emits the masked payload verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, LIST_BODY)));

    await main(['providers', 'list', '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toEqual(LIST_BODY);
  });

  it('set reads the key from stdin (never argv) and PUTs it', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(201, PUT_ROW));
    vi.stubGlobal('fetch', fetchMock);

    await withStdin('sk-test-key-1234\n', () =>
      main(['providers', 'set', 'OpenAI', '--label', 'prod']),
    );

    expect(process.exitCode ?? 0).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    // Provider slug normalized to lowercase, matching the API's canonical id.
    expect(url).toBe('https://credit-api.floelabs.xyz/v1/developer/provider-keys/openai');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body ?? '')).toEqual({ key: 'sk-test-key-1234', label: 'prod' });
    // The raw key must never be echoed back.
    expect(stdout).not.toContain('sk-test-key-1234');
    expect(stderr).not.toContain('sk-test-key-1234');
    expect(stdout).toContain('sk-test-...');
  });

  it('set rejects a malformed key before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await withStdin('short\n', () => main(['providers', 'set', 'openai']));

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('8–512 characters');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('set requires the provider argument before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['providers', 'set']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('floe providers set <provider>');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enable and disable PATCH the enabled field', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) =>
      jsonRes(200, { provider: 'openai', enabled: true }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await main(['providers', 'enable', 'openai']);
    expect(process.exitCode ?? 0).toBe(0);
    const [enableUrl, enableInit] = fetchMock.mock.calls[0]!;
    expect(enableUrl).toBe('https://credit-api.floelabs.xyz/v1/developer/provider-keys/openai');
    expect(enableInit?.method).toBe('PATCH');
    expect(JSON.parse(enableInit?.body ?? '')).toEqual({ enabled: true });
    expect(stdout).toContain('enabled');

    const disableMock = vi.fn(async (_url: string, _init?: FetchInit) =>
      jsonRes(200, { provider: 'openai', enabled: false }),
    );
    vi.stubGlobal('fetch', disableMock);
    await main(['providers', 'disable', 'openai']);
    expect(process.exitCode ?? 0).toBe(0);
    const [, disableInit] = disableMock.mock.calls[0]!;
    expect(disableInit?.method).toBe('PATCH');
    expect(JSON.parse(disableInit?.body ?? '')).toEqual({ enabled: false });
    expect(stdout).toContain('disabled');
  });

  it('remove refuses without --yes when non-interactive, before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['providers', 'remove', 'openai']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--yes');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remove --yes DELETEs the stored key', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) =>
      jsonRes(200, { message: 'Provider key removed' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['providers', 'remove', 'openai', '--yes']);

    expect(process.exitCode ?? 0).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://credit-api.floelabs.xyz/v1/developer/provider-keys/openai');
    expect(init?.method).toBe('DELETE');
    expect(stdout).toContain('Removed');
  });

  it('surfaces the API unknown-provider 400 as exit 1 with its message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes(400, {
          error: 'Unknown provider',
          message: 'Provider must be one of: openai, anthropic, groq',
        }),
      ),
    );

    await withStdin('sk-test-key-1234\n', () => main(['providers', 'set', 'nope']));

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('Provider must be one of');
  });

  it('rejects unknown subcommands before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['providers', 'rotate', 'openai']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unknown providers subcommand');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
