import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, FloeApi } from '../src/lib/api.js';

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe('FloeApi credential routing', () => {
  it('sends the developer key on dev() and the agent key on agent()', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: (init?.headers as Record<string, string>).Authorization });
      return jsonResponse(200, { ok: true });
    });

    const api = new FloeApi('https://api.example', 'floe_live_dev', 'floe_agent');
    await api.dev('GET', '/v1/developer/profile');
    await api.agent('GET', '/v1/models');

    expect(seen[0]?.auth).toBe('Bearer floe_live_dev');
    expect(seen[1]?.auth).toBe('Bearer floe_agent');
  });

  it('fails fast with a friendly message when the plane has no key', async () => {
    const api = new FloeApi('https://api.example', undefined, undefined);
    await expect(api.dev('GET', '/v1/developer/profile')).rejects.toMatchObject({
      status: 401,
      code: 'missing_credential',
    });
  });

  it('sets a floe-cli User-Agent', async () => {
    let ua: string | undefined;
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      ua = (init?.headers as Record<string, string>)['User-Agent'];
      return jsonResponse(200, {});
    });
    await new FloeApi('https://api.example', 'floe_live_x').dev('GET', '/v1/developer/profile');
    expect(ua).toMatch(/^floe-cli\//);
  });
});

describe('ApiError mapping', () => {
  it('parses developer-surface error bodies with hints', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse(403, {
        error: 'developer_credential_required',
        message: 'Agent API keys cannot call developer routes.',
        next: { hint: 'Use a developer key.', method: 'POST', path: '/v1/developer/keys' },
      }),
    );
    const err = (await new FloeApi('https://api.example', 'floe_live_x')
      .dev('GET', '/v1/developer/profile')
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('developer_credential_required');
    expect(err.hint).toBe('Use a developer key.');
    expect(err.exitCode).toBe(4);
  });

  it('parses gateway OpenAI-shaped errors and maps 402 to exit 5', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse(402, {
        error: { message: 'Budget exhausted (key).', type: 'insufficient_quota', code: 'budget_exhausted' },
      }),
    );
    const err = (await new FloeApi('https://api.example', undefined, 'floe_x')
      .agent('POST', '/v1/chat/completions', {})
      .catch((e: unknown) => e)) as ApiError;
    expect(err.message).toBe('Budget exhausted (key).');
    expect(err.code).toBe('budget_exhausted');
    expect(err.exitCode).toBe(5);
  });

  it('uses the body `detail` sentence as the message when there is no `message`', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse(400, {
        error: 'area_code_required',
        detail: 'Enter a 3-digit US area code (e.g. 415) to pick a number',
      }),
    );
    const err = (await new FloeApi('https://api.example', 'floe_live_x')
      .devRaw('POST', '/v1/developer/agents/1/numbers', {})
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('area_code_required');
    expect(err.message).toBe('Enter a 3-digit US area code (e.g. 415) to pick a number');
  });

  it('prefers `message` over `detail` when a body carries both', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse(400, { error: 'x_code', message: 'M wins', detail: 'D loses' }),
    );
    const err = (await new FloeApi('https://api.example', 'floe_live_x')
      .devRaw('POST', '/v1/developer/agents/1/numbers', {})
      .catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('x_code');
    expect(err.message).toBe('M wins');
  });

  it('maps 401/403 to exit 4 and other statuses to 1', () => {
    expect(new ApiError('x', 401).exitCode).toBe(4);
    expect(new ApiError('x', 403).exitCode).toBe(4);
    expect(new ApiError('x', 402).exitCode).toBe(5);
    expect(new ApiError('x', 500).exitCode).toBe(1);
    expect(new ApiError('x', 0).exitCode).toBe(1);
  });
});
