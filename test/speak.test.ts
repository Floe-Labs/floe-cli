import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;
const dir = `${process.cwd()}/test/.tmp-speak-${process.pid}`;

type FetchInit = { method?: string; headers?: Record<string, string>; body?: unknown };

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const MODELS_BODY = {
  object: 'list',
  data: [
    { id: 'openai/gpt-4o-mini', object: 'model', created: 0, owned_by: 'floe', modality: 'text', context_window: 128_000 },
    { id: 'openai/tts-1', object: 'model', created: 0, owned_by: 'floe', modality: 'tts', context_window: null },
  ],
};

const AUDIO_BYTES = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

const gatewayMock = () =>
  vi.fn(async (url: string | URL, _init?: FetchInit) => {
    if (String(url).endsWith('/v1/models')) return jsonRes(200, MODELS_BODY);
    return new Response(AUDIO_BYTES, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg', 'X-Floe-Cost-USDC': '250' },
    });
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

describe('floe speak', () => {
  it('writes the binary body to --out and prints bytes written plus cost', async () => {
    const fetchMock = gatewayMock();
    vi.stubGlobal('fetch', fetchMock);
    const out = `${dir}/reply.mp3`;

    await main(['speak', 'hello there', '--out', out, '--model', 'openai/tts-1', '--voice', 'nova']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://credit-api.floelabs.xyz/v1/audio/speech');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.Authorization).toBe('Bearer floe_test');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'openai/tts-1',
      input: 'hello there',
      voice: 'nova',
    });
    expect(new Uint8Array(readFileSync(out))).toEqual(AUDIO_BYTES);
    expect(stdout).toContain('8');
    expect(stdout).toContain(out);
    expect(stdout).toContain('$0.00025');
  });

  it('defaults the voice to alloy and picks a TTS model from /v1/models', async () => {
    const fetchMock = gatewayMock();
    vi.stubGlobal('fetch', fetchMock);

    await main(['speak', 'hi', '--out', `${dir}/out.mp3`]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://credit-api.floelabs.xyz/v1/models');
    const body = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
    expect(body.model).toBe('openai/tts-1');
    expect(body.voice).toBe('alloy');
  });

  it('--json reports the file, bytes, model, and cost', async () => {
    vi.stubGlobal('fetch', gatewayMock());
    const out = `${dir}/out.mp3`;

    await main(['speak', 'hi', '--out', out, '--model', 'openai/tts-1', '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      out,
      bytes: 8,
      model: 'openai/tts-1',
      costRaw: '250',
      costUsd: '$0.00025',
      budgetRemainingUsd: null,
    });
  });

  it('requires --out, before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['speak', 'hi']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--out');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(`${dir}/out.mp3`)).toBe(false);
  });

  it('maps a gateway 402 to exit 5 and writes no file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes(402, {
          error: { message: 'Budget exhausted (session).', type: 'insufficient_quota', code: 'budget_exhausted' },
        }),
      ),
    );
    const out = `${dir}/out.mp3`;

    await main(['speak', 'hi', '--out', out, '--model', 'openai/tts-1']);

    expect(process.exitCode).toBe(5);
    expect(stderr).toContain('Budget exhausted');
    expect(existsSync(out)).toBe(false);
  });
});
