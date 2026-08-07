import { mkdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

// In-memory keychain so credential fallback tests never touch the real OS
// keychain (env vars still win, mirroring the real module's contract).
vi.mock('../src/lib/keychain.js', () => {
  const store = new Map<string, string>();
  const host = (apiUrl: string) => new URL(apiUrl).host;
  return {
    devKeyAccount: (apiUrl: string) => `dev-key:${host(apiUrl)}`,
    agentKeyAccount: (apiUrl: string, agentId: string) => `agent-key:${host(apiUrl)}:${agentId}`,
    legacyAgentKeyAccount: (apiUrl: string) => `agent-key:${host(apiUrl)}`,
    getSecret: async (account: string) => store.get(account),
    setSecret: async (account: string, value: string) => {
      store.set(account, value);
    },
    resolveDevKey: async (apiUrl: string) =>
      process.env.FLOE_API_KEY || store.get(`dev-key:${host(apiUrl)}`),
    resolveAgentKey: async (apiUrl: string, agentId?: string) =>
      process.env.FLOE_AGENT_KEY ||
      (agentId ? store.get(`agent-key:${host(apiUrl)}:${agentId}`) : undefined),
  };
});

let stdout: string;
let stderr: string;
const dir = `${process.cwd()}/test/.tmp-models-${process.pid}`;

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

const LIST_BODY = {
  object: 'list',
  data: [
    {
      id: 'openai/gpt-4o-mini',
      object: 'model',
      created: 1_700_000_000,
      owned_by: 'floe',
      modality: 'text',
      context_window: 128_000,
    },
    {
      id: 'deepgram/nova-3',
      object: 'model',
      created: 1_700_000_000,
      owned_by: 'floe',
      modality: 'stt',
      context_window: null,
    },
  ],
};

const PRICED_BODY = {
  models: [
    {
      id: 'openai/gpt-4o-mini',
      displayName: 'GPT-4o mini',
      modality: 'text',
      contextWindow: 128_000,
      isOpenWeight: false,
      sources: [
        {
          rail: 'keyless',
          provider: 'openai',
          marginBps: 2000,
          rates: { text_input_token: 0.15, text_output_token: 0.6 },
        },
      ],
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
  vi.stubEnv('FLOE_API_KEY', '');
  vi.stubEnv('FLOE_AGENT_KEY', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('floe models', () => {
  it('lists the catalog over the developer plane when a dev key is present', async () => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, LIST_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main(['models']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://credit-api.floelabs.xyz/v1/models');
    expect(init?.method).toBe('GET');
    expect(init?.headers?.Authorization).toBe('Bearer floe_live_test');
    expect(stdout).toContain('openai/gpt-4o-mini');
    expect(stdout).toContain('128k');
    expect(stdout).toContain('stt');
  });

  it('falls back to the agent key when no dev key is available', async () => {
    vi.stubEnv('FLOE_AGENT_KEY', 'floe_test');
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, LIST_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main(['models']);

    expect(process.exitCode ?? 0).toBe(0);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers?.Authorization).toBe('Bearer floe_test');
    expect(stdout).toContain('openai/gpt-4o-mini');
  });

  it('--json emits the machine-readable list', async () => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, LIST_BODY)));

    await main(['models', '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toEqual(LIST_BODY);
  });

  it('--modality filters client-side', async () => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, LIST_BODY)));

    await main(['models', '--modality', 'stt']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('deepgram/nova-3');
    expect(stdout).not.toContain('openai/gpt-4o-mini');
  });

  it('rejects an unknown --modality before any network call', async () => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['models', '--modality', 'video']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unknown modality');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('--pricing hits the developer rate-card route and renders per-1M prices', async () => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, PRICED_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main(['models', '--pricing']);

    expect(process.exitCode ?? 0).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://credit-api.floelabs.xyz/v1/developer/gateway/models');
    expect(init?.headers?.Authorization).toBe('Bearer floe_live_test');
    expect(stdout).toContain('openai/gpt-4o-mini');
    expect(stdout).toContain('$0.15/M');
    expect(stdout).toContain('$0.6/M');
  });

  it('--pricing --json emits the rate-card payload verbatim', async () => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, PRICED_BODY)));

    await main(['models', '--pricing', '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toEqual(PRICED_BODY);
  });

  it('exits 4 with no credential at all, before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['models']);

    expect(process.exitCode).toBe(4);
    expect(stderr).toContain('Not signed in');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an API 401 to exit 4', async () => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes(401, { error: 'Unauthorized', message: 'Invalid API key' })),
    );

    await main(['models']);

    expect(process.exitCode).toBe(4);
    expect(stderr).toContain('Invalid API key');
  });
});
