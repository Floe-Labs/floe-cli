import { cliVersion } from './version.js';

/**
 * One client, two credential planes:
 *  - dev*    → /v1/developer/* management routes, Bearer floe_live_… key
 *  - agent*  → gateway / agent routes, Bearer floe_… agent key
 *
 * The caller never chooses a key per request — each method knows its plane.
 * That routing is the whole point: agent keys 403 on /v1/developer/* and
 * developer keys are rejected by the gateway, and users should never have to
 * learn that the hard way.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly hint?: string;

  constructor(message: string, status: number, code?: string, hint?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }

  /** CLI exit-code convention: 4 auth, 5 payment, 1 everything else. */
  get exitCode(): number {
    if (this.status === 401 || this.status === 403) return 4;
    if (this.status === 402) return 5;
    return 1;
  }
}

interface RequestOptions {
  body?: unknown;
  timeoutMs?: number;
}

/** Developer-surface errors: {error, message?|detail?, details?, next?:{hint}}. Gateway: {error:{message,type,code}}.
 *  `message` (auth/accounts) and `detail` (phone, voice, calls) are both the
 *  human sentence for the `error` code — prefer either over the bare code. */
async function toApiError(res: Response): Promise<ApiError> {
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  let hint: string | undefined;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const err = body.error;
    if (typeof err === 'string') {
      code = err;
      message =
        typeof body.message === 'string'
          ? body.message
          : typeof body.detail === 'string'
            ? body.detail
            : err;
    } else if (err && typeof err === 'object') {
      const oai = err as Record<string, unknown>;
      if (typeof oai.message === 'string') message = oai.message;
      if (typeof oai.code === 'string') code = oai.code;
    }
    const next = body.next as Record<string, unknown> | undefined;
    if (next && typeof next.hint === 'string') hint = next.hint;
  } catch {
    // Non-JSON error body — keep the status-line message.
  }
  if (res.status === 403 && !hint && /read[-_ ]?only|permission/i.test(`${code ?? ''} ${message}`)) {
    hint = 'This developer key may be read-only — mint a read_write key with `floe devkeys create`.';
  }
  if (res.status === 429 && !hint) {
    const retryAfter = res.headers.get('Retry-After');
    hint = retryAfter ? `Rate limited — retry in ${retryAfter}s.` : 'Rate limited — retry shortly.';
  }
  return new ApiError(message, res.status, code, hint);
}

const RETRY_DELAYS_MS = [1_000, 2_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FloeApi {
  constructor(
    private readonly baseUrl: string,
    private readonly devKey?: string,
    private readonly agentKey?: string,
  ) {}

  private async request(
    key: string | undefined,
    plane: 'developer' | 'agent' | 'public',
    method: string,
    path: string,
    { body, timeoutMs = 30_000 }: RequestOptions = {},
  ): Promise<Response> {
    if (!key && plane !== 'public') {
      throw new ApiError(
        plane === 'developer'
          ? 'No developer key found. Run `floe init` (or set FLOE_API_KEY).'
          : 'No agent key found. Run `floe init` (or set FLOE_AGENT_KEY).',
        401,
        'missing_credential',
      );
    }
    const headers: Record<string, string> = {
      'User-Agent': `floe-cli/${cliVersion()}`,
    };
    if (key) headers.Authorization = `Bearer ${key}`;
    let payload: string | FormData | undefined;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    // Reads retry through transient rate limits; writes never auto-repeat —
    // a 429 on a state-changing call surfaces immediately with its hint.
    const retries = method === 'GET' ? RETRY_DELAYS_MS : [];
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'failed';
        throw new ApiError(`Request to ${this.baseUrl}${path} ${reason}: ${(err as Error).message}`, 0);
      }
      if (res.status === 429 && attempt < retries.length) {
        const retryAfter = Number.parseFloat(res.headers.get('Retry-After') ?? '');
        const delayMs = Number.isFinite(retryAfter)
          ? Math.min(Math.max(retryAfter * 1_000, retries[attempt]!), 10_000)
          : retries[attempt]!;
        await res.body?.cancel().catch(() => {});
        await sleep(delayMs);
        continue;
      }
      if (!res.ok) throw await toApiError(res);
      return res;
    }
  }

  /** Management plane — floe_live_ developer key. Returns parsed JSON. */
  async dev<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(this.devKey, 'developer', method, path, { body });
    return (await res.json()) as T;
  }

  /**
   * Management plane, raw Response — for non-JSON bodies (CSV export) and
   * routes whose X-Floe-* headers matter (phone buy cost).
   */
  async devRaw(method: string, path: string, body?: unknown): Promise<Response> {
    return this.request(this.devKey, 'developer', method, path, { body });
  }

  /** Gateway / agent plane — floe_ agent key. Returns the raw Response so callers can read X-Floe-* headers. */
  async agent(method: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<Response> {
    return this.request(this.agentKey, 'agent', method, path, { body, timeoutMs });
  }

  /** Unauthenticated routes (/v1/capabilities, /v1/health). Returns parsed JSON. */
  async public<T>(method: string, path: string): Promise<T> {
    const res = await this.request(undefined, 'public', method, path, {});
    return (await res.json()) as T;
  }
}
