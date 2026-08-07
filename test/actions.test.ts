import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const API = 'https://credit-api.floelabs.xyz';
const dir = `${process.cwd()}/test/.tmp-actions-${process.pid}`;

let stdout: string;
let stderr: string;

function writeConfigFixture(): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/floe`, { recursive: true });
  writeFileSync(
    `${dir}/floe/config.json`,
    JSON.stringify({
      apiUrl: API,
      activeAgentId: 'agent-1',
      agents: {
        'agent-1': { name: 'my-agent', wallet: '0xabc', keyId: '17', keyPrefix: 'floe_ab12' },
      },
    }),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const OUTCOME = {
  status: 'success',
  scoreBps: 9500,
  note: null,
  reportCount: 1,
  reportedAt: '2026-08-06T13:00:00Z',
};

const ENTRIES = [
  {
    actionId: 'checkout-run-1',
    calls: 12,
    spentRaw: '1250000',
    firstSeen: '2026-08-01 10:00:00+00',
    lastSeen: '2026-08-06 12:00:00+00',
    outcome: OUTCOME,
  },
  {
    actionId: 'refund-run-7',
    calls: 0,
    spentRaw: '0',
    firstSeen: null,
    lastSeen: null,
    outcome: { status: 'failure', scoreBps: null, note: 'timeout', reportCount: 2, reportedAt: '2026-08-05T00:00:00Z' },
  },
];

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
  writeConfigFixture();
  vi.stubEnv('XDG_CONFIG_HOME', dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('actions list', () => {
  it('GETs the rollup for the active agent and renders the table', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ actions: ENTRIES }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['actions', 'list']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/agents/agent-1/actions`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer floe_live_test');
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('checkout-run-1');
    expect(stdout).toContain('$1.25'); // spentRaw formatted via rawToUsd
    expect(stdout).toContain('success 95%'); // outcome + scoreBps as percent
    expect(stdout).toContain('refund-run-7'); // outcome-only entry still listed
  });

  it('--limit is passed through and --json returns raw spentRaw untouched', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ actions: ENTRIES }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['actions', 'list', '--limit', '5', '--json']);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${API}/v1/developer/agents/agent-1/actions?limit=5`,
    );
    expect(JSON.parse(stdout)).toEqual({ agentId: 'agent-1', actions: ENTRIES });
  });

  it('rejects an out-of-range --limit before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['actions', 'list', '--limit', '0']);

    expect(stderr).toContain('--limit must be between 1 and 500');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves --agent against the fleet before fetching', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/developer/agents')) {
        return jsonResponse({ agents: [{ id: 'agent-2', name: 'other', status: 'active' }] });
      }
      return jsonResponse({ actions: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    await main(['actions', 'list', '--agent', 'other', '--json']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${API}/v1/developer/agents`);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`${API}/v1/developer/agents/agent-2/actions`);
    expect(JSON.parse(stdout)).toEqual({ agentId: 'agent-2', actions: [] });
  });
});

describe('actions report', () => {
  it('POSTs status/scoreBps/note with the action id normalized like the API header', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ actionId: 'task-42', outcome: { ...OUTCOME, note: 'looks good' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Mixed case on argv — the server lowercases X-Floe-Action-Id, so the CLI must too.
    await main(['actions', 'report', 'Task-42', '--status', 'success', '--score', '9500', '--note', 'looks good']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/agents/agent-1/actions/task-42/outcome`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      status: 'success',
      scoreBps: 9500,
      note: 'looks good',
    });
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('Outcome recorded');
    expect(stdout).toContain('task-42');
    expect(stdout).toContain('95%');
  });

  it('URL-encodes action ids that contain path characters', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ actionId: 'agent:step/2', outcome: { ...OUTCOME, scoreBps: null } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['actions', 'report', 'agent:step/2', '--status', 'partial']);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${API}/v1/developer/agents/agent-1/actions/agent%3Astep%2F2/outcome`,
    );
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      status: 'partial',
    });
  });

  it('--json echoes the upserted outcome as machine-readable JSON', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ actionId: 'task-42', outcome: OUTCOME }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['actions', 'report', 'task-42', '--status', 'success', '--json']);

    expect(JSON.parse(stdout)).toEqual({ agentId: 'agent-1', actionId: 'task-42', outcome: OUTCOME });
  });

  it('requires --status before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['actions', 'report', 'task-42']);

    expect(stderr).toContain('--status is required');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a status the API does not accept, before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['actions', 'report', 'task-42', '--status', 'great']);

    expect(stderr).toContain('Invalid --status');
    expect(stderr).toContain('success, failure, partial, unknown');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a score above 10000 bps before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['actions', 'report', 'task-42', '--status', 'success', '--score', '10001']);

    expect(stderr).toContain('--score');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a payment-required failure to exit 5', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: 'payment_required', message: 'Insufficient credit' }, 402),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['actions', 'report', 'task-42', '--status', 'success']);

    expect(process.exitCode).toBe(5);
    expect(stderr).toContain('Insufficient credit');
  });
});

describe('actions dispatch', () => {
  it('rejects an unknown subcommand', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['actions', 'frobnicate']);

    expect(stderr).toContain('Unknown actions subcommand');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects extra positionals', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['actions', 'report', 'task-42', 'extra', '--status', 'success']);

    expect(stderr).toContain('Unexpected argument');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
