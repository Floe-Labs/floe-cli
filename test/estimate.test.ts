import { mkdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

// In-memory keychain — env vars win, and no test can reach the real OS keychain.
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
const dir = `${process.cwd()}/test/.tmp-estimate-${process.pid}`;

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

const ESTIMATE_BODY = {
  model: 'openai/gpt-4o-mini',
  rail: 'keyless',
  provider: 'openai',
  margin_bps: 2000,
  usage: { text_input_token: 1000, text_output_token: 500 },
  upstream_cost_usdc: '0.000450',
  cost_usdc: '0.000540',
  cost_raw: '540',
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

describe('floe estimate', () => {
  it('POSTs the usage vector and prints the cost from cost_raw', async () => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, ESTIMATE_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main([
      'estimate',
      '--model',
      'openai/gpt-4o-mini',
      '--input-tokens',
      '1000',
      '--output-tokens',
      '500',
    ]);

    expect(process.exitCode ?? 0).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://credit-api.floelabs.xyz/v1/estimate');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.Authorization).toBe('Bearer floe_live_test');
    expect(JSON.parse(init?.body ?? '')).toEqual({
      model: 'openai/gpt-4o-mini',
      input_tokens: 1000,
      output_tokens: 500,
    });
    // cost_raw "540" (atomic 6dp) → $0.00054 — never the decimal echo.
    expect(stdout).toContain('$0.00054');
    expect(stdout).toContain('openai');
    expect(stdout).toContain('nothing was charged');
  });

  it('--json passes the response through verbatim', async () => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, ESTIMATE_BODY)));

    await main(['estimate', '--model', 'openai/gpt-4o-mini', '--input-tokens', '1000', '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toEqual(ESTIMATE_BODY);
  });

  it('falls back to the agent key and maps --audio-seconds to audio_seconds', async () => {
    vi.stubEnv('FLOE_AGENT_KEY', 'floe_test');
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) =>
      jsonRes(200, { ...ESTIMATE_BODY, model: 'deepgram/nova-3', usage: { audio_second: 60 } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['estimate', '--model', 'deepgram/nova-3', '--audio-seconds', '60']);

    expect(process.exitCode ?? 0).toBe(0);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers?.Authorization).toBe('Bearer floe_test');
    expect(JSON.parse(init?.body ?? '')).toEqual({ model: 'deepgram/nova-3', audio_seconds: 60 });
  });

  it('requires --model before any network call', async () => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['estimate', '--input-tokens', '1000']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--model');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires at least one usage flag before any network call', async () => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['estimate', '--model', 'openai/gpt-4o-mini']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Nothing to price');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-integer quantities before any network call', async () => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['estimate', '--model', 'openai/gpt-4o-mini', '--input-tokens', 'lots']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--input-tokens must be a positive integer');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces an unknown-model 404 as exit 1 with the API message', async () => {
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes(404, {
          error: {
            message: 'The model "nope/nope" does not exist or is disabled.',
            type: 'invalid_request_error',
            code: 'unknown_model',
          },
        }),
      ),
    );

    await main(['estimate', '--model', 'nope/nope', '--input-tokens', '10']);

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('does not exist or is disabled');
  });
});
