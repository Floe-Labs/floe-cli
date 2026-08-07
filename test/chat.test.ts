import { mkdirSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;
const dir = `${process.cwd()}/test/.tmp-chat-${process.pid}`;

type FetchInit = { method?: string; headers?: Record<string, string>; body?: unknown };

const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const MODELS_BODY = {
  object: 'list',
  data: [
    { id: 'zeta/other-chat', object: 'model', created: 0, owned_by: 'floe', modality: 'text', context_window: 8_000 },
    { id: 'openai/gpt-4o-mini', object: 'model', created: 0, owned_by: 'floe', modality: 'text', context_window: 128_000 },
    { id: 'deepgram/nova-3', object: 'model', created: 0, owned_by: 'floe', modality: 'stt', context_window: null },
  ],
};

const CHAT_BODY = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'openai/gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

const METER_HEADERS = { 'X-Floe-Cost-USDC': '123', 'X-Floe-Budget-Remaining-USDC': '4.999877' };

/** models list on /v1/models, a metered completion on /v1/chat/completions. */
const gatewayMock = () =>
  vi.fn(async (url: string | URL, _init?: FetchInit) => {
    if (String(url).endsWith('/v1/models')) return jsonRes(200, MODELS_BODY);
    return jsonRes(200, CHAT_BODY, METER_HEADERS);
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

describe('floe chat', () => {
  it('picks a preferred model from /v1/models and prints reply, cost, and budget', async () => {
    const fetchMock = gatewayMock();
    vi.stubGlobal('fetch', fetchMock);

    await main(['chat', 'hi']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [modelsUrl] = fetchMock.mock.calls[0]!;
    expect(String(modelsUrl)).toBe('https://credit-api.floelabs.xyz/v1/models');
    const [chatUrl, init] = fetchMock.mock.calls[1]!;
    expect(String(chatUrl)).toBe('https://credit-api.floelabs.xyz/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.Authorization).toBe('Bearer floe_test');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(stdout).toContain('hello there');
    expect(stdout).toContain('$0.000123');
    expect(stdout).toContain('$4.999877');
  });

  it('--model skips discovery; --system and --max-tokens shape the request', async () => {
    const fetchMock = gatewayMock();
    vi.stubGlobal('fetch', fetchMock);

    await main(['chat', 'hi', '--model', 'zeta/other-chat', '--system', 'be terse', '--max-tokens', '64']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'zeta/other-chat',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 64,
    });
  });

  it('--json emits the full response body plus costs', async () => {
    vi.stubGlobal('fetch', gatewayMock());

    await main(['chat', 'hi', '--model', 'openai/gpt-4o-mini', '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      model: 'openai/gpt-4o-mini',
      response: CHAT_BODY,
      costRaw: '123',
      costUsd: '$0.000123',
      budgetRemainingUsd: '4.999877',
    });
  });

  it('--stream sends stream:true and writes SSE deltas as they arrive', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchInit) =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['chat', 'hi', '--model', 'openai/gpt-4o-mini', '--stream']);

    expect(process.exitCode ?? 0).toBe(0);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).stream).toBe(true);
    expect(stdout).toContain('Hello world');
  });

  it('reads the prompt from stdin when the positional is "-"', async () => {
    const fetchMock = gatewayMock();
    vi.stubGlobal('fetch', fetchMock);
    const original = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    Object.defineProperty(process, 'stdin', {
      value: Readable.from(['piped prompt\n']),
      configurable: true,
    });
    try {
      await main(['chat', '-', '--model', 'openai/gpt-4o-mini']);
    } finally {
      Object.defineProperty(process, 'stdin', original);
    }

    expect(process.exitCode ?? 0).toBe(0);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).messages).toEqual([{ role: 'user', content: 'piped prompt' }]);
  });

  it('rejects --stream with --json before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['chat', 'hi', '--stream', '--json']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--stream and --json');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a bad --max-tokens before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['chat', 'hi', '--max-tokens', 'lots']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Invalid --max-tokens');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a prompt', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['chat']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Usage: floe chat');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a gateway 402 (budget exhausted) to exit 5', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes(402, {
          error: { message: 'Budget exhausted (session).', type: 'insufficient_quota', code: 'budget_exhausted' },
        }),
      ),
    );

    await main(['chat', 'hi', '--model', 'openai/gpt-4o-mini']);

    expect(process.exitCode).toBe(5);
    expect(stderr).toContain('Budget exhausted');
  });
});
