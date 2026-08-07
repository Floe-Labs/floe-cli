import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;
const dir = `${process.cwd()}/test/.tmp-transcribe-${process.pid}`;

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
    { id: 'deepgram/nova-3', object: 'model', created: 0, owned_by: 'floe', modality: 'stt', context_window: null },
    { id: 'openai/whisper-1', object: 'model', created: 0, owned_by: 'floe', modality: 'stt', context_window: null },
  ],
};

const gatewayMock = () =>
  vi.fn(async (url: string | URL, _init?: FetchInit) => {
    if (String(url).endsWith('/v1/models')) return jsonRes(200, MODELS_BODY);
    return jsonRes(200, { text: 'hello from the recording' }, { 'X-Floe-Cost-USDC': '77' });
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

describe('floe transcribe', () => {
  it('sends the file as multipart form-data and prints transcript plus cost', async () => {
    const fetchMock = gatewayMock();
    vi.stubGlobal('fetch', fetchMock);
    const file = `${dir}/note.wav`;
    writeFileSync(file, Buffer.from([1, 2, 3, 4]));

    await main(['transcribe', file, '--model', 'openai/whisper-1']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://credit-api.floelabs.xyz/v1/audio/transcriptions');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.Authorization).toBe('Bearer floe_test');
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('openai/whisper-1');
    expect(form.get('response_format')).toBe('json');
    const blob = form.get('file') as File;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('audio/wav');
    expect(blob.name).toBe('note.wav');
    expect(blob.size).toBe(4);
    expect(stdout).toContain('hello from the recording');
    expect(stdout).toContain('$0.000077');
  });

  it('infers the content type from the extension and picks an STT model', async () => {
    const fetchMock = gatewayMock();
    vi.stubGlobal('fetch', fetchMock);
    const file = `${dir}/note.mp3`;
    writeFileSync(file, Buffer.from([255, 251, 0, 0]));

    await main(['transcribe', file]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://credit-api.floelabs.xyz/v1/models');
    const form = fetchMock.mock.calls[1]![1]?.body as FormData;
    expect(form.get('model')).toBe('openai/whisper-1'); // preference beats catalog order
    expect((form.get('file') as File).type).toBe('audio/mpeg');
  });

  it('--json emits the response body plus costs', async () => {
    vi.stubGlobal('fetch', gatewayMock());
    const file = `${dir}/note.wav`;
    writeFileSync(file, Buffer.from([1, 2, 3]));

    await main(['transcribe', file, '--model', 'openai/whisper-1', '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      model: 'openai/whisper-1',
      response: { text: 'hello from the recording' },
      costRaw: '77',
      costUsd: '$0.000077',
      budgetRemainingUsd: null,
    });
  });

  it('fails clearly on a missing file BEFORE any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['transcribe', `${dir}/nope.wav`]);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Cannot read');
    expect(stderr).toContain('no such file');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires the file positional', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['transcribe']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Usage: floe transcribe');
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
    const file = `${dir}/note.wav`;
    writeFileSync(file, Buffer.from([1]));

    await main(['transcribe', file, '--model', 'openai/whisper-1']);

    expect(process.exitCode).toBe(5);
    expect(stderr).toContain('Budget exhausted');
  });
});
