import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;
let configDir: string;

const API = 'https://api.test';

const NUMBER = {
  id: 12,
  phoneNumber: '+14155550100',
  status: 'active',
  areaCode: '415',
  monthlyRentalRaw: '1150000',
  nextRenewalAt: '2026-09-07T00:00:00.000Z',
  graceUntil: null,
  releasedAt: null,
  releaseReason: null,
  createdAt: '2026-08-07T00:00:00.000Z',
};

const AVAILABLE = {
  phoneNumber: '+14155550100',
  friendlyName: '(415) 555-0100',
  locality: 'San Francisco',
  region: 'CA',
};

const FLEET = {
  number: '+14155550100',
  agentId: 1,
  agentName: 'my-agent',
  status: 'active',
  calls7d: 4,
  spendMtdRaw: '3400000',
};

const CALL = {
  id: 'CA123',
  direction: 'inbound',
  from: '+14155559999',
  to: '+14155550100',
  status: 'completed',
  durationSeconds: 42,
  startedAt: '2026-08-06T10:30:00.000Z',
  endedAt: '2026-08-06T10:30:42.000Z',
};

const USAGE = {
  number: { id: 12, phoneNumber: '+14155550100' },
  days: 30,
  totalRaw: '2500000',
  daily: [{ day: '2026-08-01', totalRaw: '2500000', requests: 3 }],
};

type FetchCall = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** Stub fetch with a fixed response; capture every call's method/url/headers/parsed body. */
function stubFetch(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    }),
  );
  return { calls };
}

function stubNoFetch(): ReturnType<typeof vi.fn> {
  const spy = vi.fn();
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
  configDir = `${process.cwd()}/test/.tmp-config-phone-${process.pid}`;
  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(`${configDir}/floe`, { recursive: true });
  writeFileSync(
    `${configDir}/floe/config.json`,
    JSON.stringify({
      apiUrl: API,
      activeAgentId: 'agent-1',
      agents: { 'agent-1': { name: 'my-agent', wallet: '0xabc', keyId: 'key-1', keyPrefix: 'floe_ab12' } },
    }),
  );
  vi.stubEnv('XDG_CONFIG_HOME', configDir);
});

afterEach(() => {
  try {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

describe('phone search', () => {
  it('searches for the active agent with --area-code as query param', async () => {
    const { calls } = stubFetch(200, { numbers: [AVAILABLE] });
    await main(['phone', 'search', '--area-code', '415']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/agents/agent-1/numbers/search?areaCode=415`);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers.Authorization).toBe('Bearer floe_live_test');
    expect(stdout).toContain('+14155550100');
    expect(stdout).toContain('San Francisco');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('omits the query param without --area-code', async () => {
    const { calls } = stubFetch(200, { numbers: [] });
    await main(['phone', 'search']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/agents/agent-1/numbers/search`);
    expect(stdout).toContain('No purchasable numbers');
  });

  it('--json round-trips the result', async () => {
    stubFetch(200, { numbers: [AVAILABLE] });
    await main(['phone', 'search', '--json']);
    const parsed = JSON.parse(stdout) as { agentId: string; numbers: Array<typeof AVAILABLE> };
    expect(parsed.agentId).toBe('agent-1');
    expect(parsed.numbers[0]).toEqual(AVAILABLE);
  });

  it('rejects a bad area code before any network call', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'search', '--area-code', '12']);
    expect(stderr).toContain('Invalid US area code');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('phone buy', () => {
  it('refuses without --yes when non-interactive and makes no network call', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'buy', '--number', '+14155550100']);
    expect(stderr).toContain('--yes');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('buys with --yes and prints the X-Floe-Cost-USDC cost', async () => {
    const { calls } = stubFetch(201, { number: NUMBER }, { 'X-Floe-Cost-USDC': '1150000' });
    await main(['phone', 'buy', '--number', '+14155550100', '--yes']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/agents/agent-1/numbers`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ phoneNumber: '+14155550100' });
    expect(stdout).toContain('+14155550100');
    expect(stdout).toContain('$1.15');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('sends areaCode when buying by --area-code', async () => {
    const { calls } = stubFetch(201, { number: NUMBER }, { 'X-Floe-Cost-USDC': '1150000' });
    await main(['phone', 'buy', '--area-code', '415', '--yes']);
    expect(calls[0]!.body).toEqual({ areaCode: '415' });
  });

  it('--json includes the number and costRaw from the header', async () => {
    stubFetch(201, { number: NUMBER }, { 'X-Floe-Cost-USDC': '1150000' });
    await main(['phone', 'buy', '--number', '+14155550100', '--yes', '--json']);
    const parsed = JSON.parse(stdout) as {
      number: typeof NUMBER;
      costRaw: string;
      costUsd: string;
    };
    expect(parsed.number).toEqual(NUMBER);
    expect(parsed.costRaw).toBe('1150000');
    expect(parsed.costUsd).toBe('$1.15');
  });

  it('rejects --number together with --area-code before any network call', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'buy', '--number', '+14155550100', '--area-code', '415', '--yes']);
    expect(stderr).toContain('not both');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a malformed --number before any network call', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'buy', '--number', '415-555-0100', '--yes']);
    expect(stderr).toContain('US E.164');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps insufficient_balance to exit 5 with a friendly message', async () => {
    stubFetch(402, { error: 'insufficient_balance', available: '0', required: '1150000' });
    await main(['phone', 'buy', '--number', '+14155550100', '--yes']);
    expect(stderr).toContain('rental');
    expect(process.exitCode).toBe(5);
  });

  it('remaps number_exists to a one-per-agent explanation', async () => {
    stubFetch(409, { error: 'number_exists', detail: 'Agent already has a phone number' });
    await main(['phone', 'buy', '--number', '+14155550100', '--yes']);
    expect(stderr).toContain('already has a live phone number');
    expect(process.exitCode).toBe(1);
  });
});

describe('phone list', () => {
  it('lists the active agent numbers', async () => {
    const { calls } = stubFetch(200, { numbers: [NUMBER] });
    await main(['phone', 'list']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/agents/agent-1/numbers`);
    expect(calls[0]!.method).toBe('GET');
    expect(stdout).toContain('+14155550100');
    expect(stdout).toContain('active');
    expect(stdout).toContain('$1.15');
  });

  it('--all hits the fleet view', async () => {
    const { calls } = stubFetch(200, { numbers: [FLEET] });
    await main(['phone', 'list', '--all']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/phone/numbers`);
    expect(stdout).toContain('my-agent');
    expect(stdout).toContain('$3.40');
  });

  it('--all --json round-trips the fleet rows', async () => {
    stubFetch(200, { numbers: [FLEET] });
    await main(['phone', 'list', '--all', '--json']);
    expect((JSON.parse(stdout) as { numbers: Array<typeof FLEET> }).numbers[0]).toEqual(FLEET);
  });
});

describe('phone release', () => {
  it('refuses without --yes when non-interactive and makes no network call', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'release', '12']);
    expect(stderr).toContain('--yes');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric id before any network call', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'release', 'abc', '--yes']);
    expect(stderr).toContain('numeric');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('releases with --yes: reads the number, then DELETEs it', async () => {
    const { calls } = stubFetch(200, { number: NUMBER });
    await main(['phone', 'release', '12', '--yes']);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/agents/agent-1/numbers/12`);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[1]!.url).toBe(`${API}/v1/developer/agents/agent-1/numbers/12`);
    expect(calls[1]!.method).toBe('DELETE');
    expect(stdout).toContain('Released');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--json reports the release', async () => {
    stubFetch(200, { number: NUMBER });
    await main(['phone', 'release', '12', '--yes', '--json']);
    const parsed = JSON.parse(stdout) as { released: boolean; number: typeof NUMBER };
    expect(parsed.released).toBe(true);
    expect(parsed.number).toEqual(NUMBER);
  });

  it('treats an already-released number as a no-op', async () => {
    const { calls } = stubFetch(200, { number: { ...NUMBER, status: 'released' } });
    await main(['phone', 'release', '12', '--yes']);
    expect(calls).toHaveLength(1); // detail read only — no DELETE
    expect(stdout).toContain('already released');
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('phone calls', () => {
  it('lists carrier call history', async () => {
    const { calls } = stubFetch(200, { calls: [CALL] });
    await main(['phone', 'calls', '12']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/agents/agent-1/numbers/12/calls`);
    expect(calls[0]!.method).toBe('GET');
    expect(stdout).toContain('inbound');
    expect(stdout).toContain('42s');
  });

  it('--limit truncates client-side (the route has no pagination params)', async () => {
    stubFetch(200, {
      calls: [CALL, { ...CALL, id: 'CA124' }, { ...CALL, id: 'CA125' }],
    });
    await main(['phone', 'calls', '12', '--limit', '2', '--json']);
    const parsed = JSON.parse(stdout) as { count: number; totalFetched: number; calls: unknown[] };
    expect(parsed.count).toBe(2);
    expect(parsed.totalFetched).toBe(3);
    expect(parsed.calls).toHaveLength(2);
  });

  it('rejects an out-of-range --limit before any network call', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'calls', '12', '--limit', '500']);
    expect(stderr).toContain('between 1 and 100');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('phone usage', () => {
  it('fetches usage with the server default window', async () => {
    const { calls } = stubFetch(200, USAGE);
    await main(['phone', 'usage', '12']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/agents/agent-1/numbers/12/usage`);
    expect(stdout).toContain('$2.50');
    expect(stdout).toContain('+14155550100');
  });

  it('--days passes the query param and --json round-trips', async () => {
    const { calls } = stubFetch(200, { ...USAGE, days: 7 });
    await main(['phone', 'usage', '12', '--days', '7', '--json']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/agents/agent-1/numbers/12/usage?days=7`);
    const parsed = JSON.parse(stdout) as { days: number; totalRaw: string; daily: unknown[] };
    expect(parsed.days).toBe(7);
    expect(parsed.totalRaw).toBe('2500000');
    expect(parsed.daily).toEqual(USAGE.daily);
  });

  it('rejects an out-of-range --days before any network call', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'usage', '12', '--days', '999']);
    expect(stderr).toContain('between 1 and 365');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('phone voice', () => {
  it('show GETs the voice settings', async () => {
    const { calls } = stubFetch(200, { voiceMode: 'hosted', voiceConfig: {} });
    await main(['phone', 'voice', 'show']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/agents/agent-1/voice`);
    expect(calls[0]!.method).toBe('GET');
    expect(stdout).toContain('hosted');
  });

  it('bare voice defaults to show with --json parity', async () => {
    stubFetch(200, { voiceMode: 'webhook', voiceConfig: { webhookUrl: 'https://x.example/hook' } });
    await main(['phone', 'voice', '--json']);
    const parsed = JSON.parse(stdout) as { voiceMode: string; voiceConfig: { webhookUrl: string } };
    expect(parsed.voiceMode).toBe('webhook');
    expect(parsed.voiceConfig.webhookUrl).toBe('https://x.example/hook');
  });

  it('set PATCHes the exact API field names', async () => {
    const { calls } = stubFetch(200, {
      voiceMode: 'webhook',
      voiceConfig: { systemPrompt: 'Be helpful', beginMessage: 'Hi!', webhookUrl: 'https://x.example/hook' },
    });
    await main([
      'phone', 'voice', 'set',
      '--mode', 'webhook',
      '--prompt', 'Be helpful',
      '--greeting', 'Hi!',
      '--webhook-url', 'https://x.example/hook',
    ]);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/agents/agent-1/voice`);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({
      voiceMode: 'webhook',
      systemPrompt: 'Be helpful',
      beginMessage: 'Hi!',
      webhookUrl: 'https://x.example/hook',
    });
    expect(stdout).toContain('updated');
  });

  it('set maps --voice and --model through unchanged', async () => {
    const { calls } = stubFetch(200, { voiceMode: 'hosted', voiceConfig: { voice: 'marin', model: 'openai/gpt-4o-mini' } });
    await main(['phone', 'voice', 'set', '--voice', 'marin', '--model', 'openai/gpt-4o-mini']);
    expect(calls[0]!.body).toEqual({ voice: 'marin', model: 'openai/gpt-4o-mini' });
  });

  it('set with no flags is a usage error before any network call', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'voice', 'set']);
    expect(stderr).toContain('Nothing to set');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('set rejects an unknown --mode before any network call', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'voice', 'set', '--mode', 'sip']);
    expect(stderr).toContain('hosted, webhook');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('set rejects a non-https webhook url before any network call', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'voice', 'set', '--webhook-url', 'http://x.example/hook']);
    expect(stderr).toContain('https');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('phone test-call', () => {
  it('refuses without --yes when non-interactive and makes no network call', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'test-call', '12', '--to', '+14155559999']);
    expect(stderr).toContain('--yes');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('places the call with --yes', async () => {
    const { calls } = stubFetch(201, {
      callId: 'CA999',
      from: '+14155550100',
      to: '+14155559999',
      status: 'queued',
    });
    await main(['phone', 'test-call', '12', '--to', '+14155559999', '--yes']);
    expect(calls[0]!.url).toBe(`${API}/v1/developer/agents/agent-1/numbers/12/test-call`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ toNumber: '+14155559999' });
    expect(stdout).toContain('queued');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--json carries the call id', async () => {
    stubFetch(201, { callId: 'CA999', from: '+14155550100', to: '+14155559999', status: 'queued' });
    await main(['phone', 'test-call', '12', '--to', '+14155559999', '--yes', '--json']);
    const parsed = JSON.parse(stdout) as { callId: string; status: string };
    expect(parsed.callId).toBe('CA999');
    expect(parsed.status).toBe('queued');
  });

  it('rejects a malformed --to before any network call', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'test-call', '12', '--to', '4155559999', '--yes']);
    expect(stderr).toContain('E.164');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('requires --to', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'test-call', '12', '--yes']);
    expect(stderr).toContain('--to');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('phone 503 handling', () => {
  it('explains telephony being unconfigured and probes /v1/capabilities', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        calls.push({
          url: u,
          method: init?.method ?? 'GET',
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        if (u.endsWith('/v1/capabilities')) {
          return new Response(JSON.stringify({ capabilities: { telephony: false } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ error: 'telephony_unavailable', detail: 'Floe Phone is not configured' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    await main(['phone', 'search']);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(`${API}/v1/capabilities`);
    expect(calls[1]!.headers.Authorization).toBeUndefined(); // public probe, no key
    expect(stderr).toContain('telephony disabled');
    expect(process.exitCode).toBe(1);
  });
});

describe('phone dispatch', () => {
  it('rejects an unknown subcommand', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'frobnicate']);
    expect(stderr).toContain('Unknown phone subcommand');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects extra positionals', async () => {
    const spy = stubNoFetch();
    await main(['phone', 'calls', '12', 'extra']);
    expect(stderr).toContain('Unexpected argument');
    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });
});
