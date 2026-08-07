import { mkdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;
const dir = `${process.cwd()}/test/.tmp-embed-${process.pid}`;

type FetchInit = { method?: string; headers?: Record<string, string>; body?: unknown };

const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const MODELS_BODY = {
  object: 'list',
  data: [
    { id: 'openai/gpt-4o-mini', object: 'model', created: 0, owned_by: 'floe', modality: 'text', context_window: 128_000 },
    { id: 'baai/bge-m3', object: 'model', created: 0, owned_by: 'floe', modality: 'embedding', context_window: 8_192 },
    { id: 'openai/text-embedding-3-small', object: 'model', created: 0, owned_by: 'floe', modality: 'embedding', context_window: 8_191 },
  ],
};

const EMBED_BODY = {
  object: 'list',
  data: [{ object: 'embedding', index: 0, embedding: [0.1, -0.2, 0.3, 0.4, 0.5] }],
  model: 'openai/text-embedding-3-small',
  usage: { prompt_tokens: 2, total_tokens: 2 },
};

const gatewayMock = () =>
  vi.fn(async (url: string | URL, _init?: FetchInit) => {
    if (String(url).endsWith('/v1/models')) return jsonRes(200, MODELS_BODY);
    return jsonRes(200, EMBED_BODY, { 'X-Floe-Cost-USDC': '45' });
  });

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

describe('floe embed', () => {
  it('picks a preferred embedding model and prints dimensions, cost, and an elided vector', async () => {
    const fetchMock = gatewayMock();
    vi.stubGlobal('fetch', fetchMock);

    await main(['embed', 'hello world']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://credit-api.floelabs.xyz/v1/models');
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe('https://credit-api.floelabs.xyz/v1/embeddings');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.Authorization).toBe('Bearer floe_test');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'openai/text-embedding-3-small',
      input: 'hello world',
    });
    expect(stdout).toContain('openai/text-embedding-3-small');
    expect(stdout).toMatch(/dimensions\s+5/);
    expect(stdout).toContain('$0.000045');
    expect(stdout).toContain('…'); // vector elided in human mode
    expect(stdout).not.toContain('0.500000'); // 5th value never shown
  });

  it('--model overrides discovery (single call)', async () => {
    const fetchMock = gatewayMock();
    vi.stubGlobal('fetch', fetchMock);

    await main(['embed', 'hello', '--model', 'baai/bge-m3']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).model).toBe('baai/bge-m3');
  });

  it('--json passes the full vector through', async () => {
    vi.stubGlobal('fetch', gatewayMock());

    await main(['embed', 'hello', '--model', 'openai/text-embedding-3-small', '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({
      model: 'openai/text-embedding-3-small',
      response: EMBED_BODY,
      costRaw: '45',
      costUsd: '$0.000045',
      budgetRemainingUsd: null,
    });
    expect(parsed.response.data[0].embedding).toHaveLength(5);
  });

  it('requires the text positional, before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['embed']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Usage: floe embed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a gateway 402 to exit 5', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes(402, {
          error: { message: 'Budget exhausted (agent).', type: 'insufficient_quota', code: 'budget_exhausted' },
        }),
      ),
    );

    await main(['embed', 'hello', '--model', 'openai/text-embedding-3-small']);

    expect(process.exitCode).toBe(5);
    expect(stderr).toContain('Budget exhausted');
  });
});
