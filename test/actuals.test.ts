import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;
const dir = `${process.cwd()}/test/.tmp-actuals-${process.pid}`;

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

/** Run with a piped (non-TTY) stdin so credentials are read from the pipe. */
async function withStdin<T>(input: string, fn: () => Promise<T>): Promise<T> {
  const fake = Readable.from([input]) as unknown as NodeJS.ReadStream & { isTTY?: boolean };
  fake.isTTY = false;
  const original = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'stdin', original);
  }
}

const OWNER_ECHO = {
  costOwner: 'developer',
  costOwnerNote:
    "Only legs your account pays for are included. Floe-carried legs (cost_owner=platform) are Floe's own COGS.",
};

/** A window with one exact leg, one period-rate leg and one pending leg — so
 *  the range cannot be totalled and the two priced statuses must stay apart. */
const LEGS_BODY = {
  legs: [
    {
      id: 1,
      occurredAt: '2026-08-20T10:00:00.000Z',
      vendor: 'openai',
      legKind: 'llm',
      captureSource: 'gateway',
      vendorRequestId: 'req_abc',
      units: { input_tokens: '1200' },
      unitsProvenance: 'vendor_reported',
      status: 'exact',
      grain: 'request',
      costScope: 'leg',
      costRaw: '6400',
      currency: 'usd',
      nonUsd: false,
      attribution: { state: 'exact', agentId: '7', customerId: 'acme', taskId: 't1', campaignId: null },
      provenance: { reason: null, vendorCostNative: '0.0064', vendorCostUnit: 'usd', realizedRate: null },
    },
    {
      id: 2,
      occurredAt: '2026-08-20T10:00:05.000Z',
      vendor: 'deepgram',
      legKind: 'stt',
      captureSource: 'gateway',
      vendorRequestId: 'dg_1',
      units: { seconds: '60' },
      unitsProvenance: 'vendor_reported',
      status: 'period-rate',
      grain: 'bucket',
      costScope: 'leg',
      costRaw: '4300',
      currency: 'usd',
      nonUsd: false,
      attribution: { state: 'exact', agentId: '7', customerId: 'acme', taskId: 't1', campaignId: null },
      provenance: { reason: null, vendorCostNative: null, vendorCostUnit: null, realizedRate: { perSecond: '0.0000717' } },
    },
    {
      id: 3,
      occurredAt: '2026-08-20T10:00:09.000Z',
      vendor: 'twilio',
      legKind: 'telephony',
      captureSource: 'telephony',
      vendorRequestId: 'CA123',
      units: { minutes: '2' },
      unitsProvenance: 'floe_measured',
      status: 'pending',
      grain: 'none',
      costScope: 'leg',
      costRaw: null,
      currency: 'usd',
      nonUsd: false,
      attribution: { state: 'exact', agentId: '7', customerId: 'acme', taskId: 't1', campaignId: null },
      provenance: { reason: null, vendorCostNative: null, vendorCostUnit: null, realizedRate: null },
    },
  ],
  nextCursor: null,
  hasMore: false,
  range: { since: '2026-08-01T00:00:00.000Z', until: '2026-08-26T00:00:00.000Z' },
  ...OWNER_ECHO,
  subtotals: {
    perStatus: {
      exact: { count: 1, costRaw: '6400' },
      'period-rate': { count: 1, costRaw: '4300' },
      invoiced: { count: 0, costRaw: '0' },
      pending: { count: 1, costRaw: '0' },
      manual: { count: 0, costRaw: '0' },
    },
    unsupportedFilters: [],
    unstampedLegs: 0,
    nonUsdLegs: 0,
    groupScopeLegs: 0,
    legs: 3,
    totalRaw: null,
    totalBlockedBy: ['unresolved_legs'],
    totalLabel: 'partial — lower bound',
  },
  historyFloor: null,
  historyClamped: false,
};

const CONNECTIONS_BODY = {
  connections: [],
  credentialFields: {
    api_key: ['apiKey'],
    basic_auth: ['accountSid', 'authToken'],
    aws_sigv4: ['accessKeyId', 'secretAccessKey', 'region'],
    gcp_service_account: ['projectId', 'clientEmail', 'privateKey'],
    azure_client_secret: ['tenantId', 'clientId', 'clientSecret', 'subscriptionId'],
    oauth_client: ['clientId', 'clientSecret'],
  },
  connectors: [
    {
      vendor: 'twilio',
      bestStatus: 'exact',
      capabilities: ['per_request'],
      billingTimeZone: 'config',
      billingTimeZoneDefault: null,
    },
    {
      vendor: 'openai',
      bestStatus: 'period-rate',
      capabilities: ['cost_bucket', 'usage_bucket'],
      billingTimeZone: 'utc',
      billingTimeZoneDefault: 'UTC',
    },
  ],
};

const CONNECTION_ROW = {
  id: 4,
  vendor: 'twilio',
  name: 'main',
  kind: 'basic_auth',
  credentialPublic: { accountSid: 'ACxxxx1234', authToken: 'abcd…wxyz' },
  credentialUnreadable: false,
  status: 'unverified',
  enabled: true,
  capabilities: {},
  bestStatus: 'exact',
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  freshnessSlaMinutes: 120,
  actualsSlaHours: 48,
  scopesVerifiedAt: null,
  billingTimeZone: 'America/Los_Angeles',
  captureSince: null,
  createdAt: '2026-08-26T00:00:00.000Z',
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
  vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('floe actuals legs', () => {
  it('shows every status and never prints a dollar figure for a pending leg', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, LEGS_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main(['actuals', 'legs']);

    expect(process.exitCode ?? 0).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://credit-api.floelabs.xyz/v1/developer/actuals/legs');
    expect(init?.method).toBe('GET');
    expect(stdout).toContain('exact');
    expect(stdout).toContain('period-rate');
    expect(stdout).toContain('pending');
    // The exact leg's own cost renders; the pending leg's does not become $0.00.
    expect(stdout).toContain('$0.0064');
    expect(stdout).not.toContain('$0.00 ');
  });

  it('keeps exact and period-rate as separate subtotals and refuses a single total', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, LEGS_BODY)));

    await main(['actuals', 'legs']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('Exact');
    expect(stdout).toContain('Period-rate');
    // 6400 + 4300 = 10700 → "$0.0107". Summing the two claims is the bug.
    expect(stdout).not.toContain('$0.0107');
    expect(stdout).toContain('partial — lower bound');
    expect(stdout).toContain('unresolved_legs');
  });

  it('states that pending is the steady state for a recent Twilio call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, LEGS_BODY)));

    await main(['actuals', 'legs']);

    expect(stdout).toContain('STEADY STATE');
    expect(stdout).toContain('Floe-measured');
  });

  it('--json emits the payload verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, LEGS_BODY)));

    await main(['actuals', 'legs', '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toEqual(LEGS_BODY);
  });

  it('rejects an unknown status before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['actuals', 'legs', '--status', 'reconciled']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unknown status');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes filters through as the API-documented query params', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, LEGS_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main([
      'actuals', 'legs',
      '--customer', 'acme',
      '--vendor', 'twilio',
      '--status', 'exact,period-rate',
      '--limit', '50',
    ]);

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v1/developer/actuals/legs');
    expect(url.searchParams.get('customerId')).toBe('acme');
    expect(url.searchParams.get('vendor')).toBe('twilio');
    expect(url.searchParams.get('status')).toBe('exact,period-rate');
    expect(url.searchParams.get('limit')).toBe('50');
  });
});

describe('floe actuals rollups', () => {
  it('rejects an unknown --by before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['actuals', 'rollups', '--by', 'nope']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--by must be one of');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders exact and period-rate in separate columns', async () => {
    const body = {
      by: 'customer',
      rollups: [
        {
          key: 'acme',
          legCount: 2,
          firstOccurredAt: '2026-08-20T10:00:00.000Z',
          lastOccurredAt: '2026-08-20T10:00:05.000Z',
          vendors: ['deepgram', 'openai'],
          composition: { exact: 1, periodRate: 1, invoiced: 0, pending: 0, manual: 0, groupLegs: 0 },
          exactRaw: '6400',
          periodRateRaw: '4300',
          invoicedRaw: '0',
          groupsRaw: '0',
          groupCount: 0,
          adjustmentsRaw: '0',
          totalRaw: '10700',
          totalBlockedBy: [],
          totalLabel: null,
          nonUsd: false,
        },
      ],
      nextCursor: null,
      hasMore: false,
      range: LEGS_BODY.range,
      ...OWNER_ECHO,
      subtotals: LEGS_BODY.subtotals,
      historyFloor: null,
      historyClamped: false,
    };
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, body));
    vi.stubGlobal('fetch', fetchMock);

    await main(['actuals', 'rollups', '--by', 'customer']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('by')).toBe('customer');
    expect(stdout).toContain('EXACT');
    expect(stdout).toContain('PERIOD-RATE');
    expect(stdout).toContain('never added into one figure');
  });
});

describe('floe actuals connect', () => {
  it('reads a multi-field credential from stdin JSON, never argv, and echoes only the mask', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: FetchInit) =>
      String(url).endsWith('/vendor-connections') && (_init?.method ?? 'GET') === 'GET'
        ? jsonRes(200, CONNECTIONS_BODY)
        : jsonRes(201, { connection: CONNECTION_ROW }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await withStdin('{"accountSid":"ACreal1234567890","authToken":"tok_supersecret_value"}', () =>
      main([
        'actuals', 'connect',
        '--vendor', 'twilio',
        '--name', 'main',
        '--kind', 'basic_auth',
        '--billing-tz', 'America/Los_Angeles',
      ]),
    );

    expect(process.exitCode ?? 0).toBe(0);
    const [, postInit] = fetchMock.mock.calls[1]!;
    expect(postInit?.method).toBe('POST');
    expect(JSON.parse(postInit?.body ?? '')).toEqual({
      vendor: 'twilio',
      name: 'main',
      kind: 'basic_auth',
      credential: { accountSid: 'ACreal1234567890', authToken: 'tok_supersecret_value' },
      billingTimeZone: 'America/Los_Angeles',
    });
    // The secret must never be echoed back to either stream.
    expect(stdout).not.toContain('tok_supersecret_value');
    expect(stderr).not.toContain('tok_supersecret_value');
    expect(stdout).toContain('ACxxxx1234');
    // The ceiling is stated at connect time, not discovered later.
    expect(stdout).toContain('Best status');
  });

  it('refuses a bare token for a multi-field kind', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, CONNECTIONS_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await withStdin('just-a-token', () =>
      main(['actuals', 'connect', '--vendor', 'twilio', '--name', 'main', '--kind', 'basic_auth', '--billing-tz', 'UTC']),
    );

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('JSON object');
    // The catalog read happened; the write did not.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires --billing-tz for a vendor that cuts buckets in its own zone', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, CONNECTIONS_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await withStdin('{"accountSid":"AC1","authToken":"t"}', () =>
      main(['actuals', 'connect', '--vendor', 'twilio', '--name', 'main', '--kind', 'basic_auth']),
    );

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--billing-tz');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown credential kind against the served catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, CONNECTIONS_BODY)));

    await main(['actuals', 'connect', '--vendor', 'openai', '--name', 'main', '--kind', 'password']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--kind is required');
  });

  it('requires --name before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['actuals', 'connect', '--vendor', 'twilio']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--name is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('floe actuals connections', () => {
  it('lists the connector catalog with each vendor ceiling status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes(200, { ...CONNECTIONS_BODY, connections: [CONNECTION_ROW] }),
      ),
    );

    await main(['actuals', 'connections']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('twilio');
    expect(stdout).toContain('ACxxxx1234');
    expect(stdout).toContain('BEST STATUS');
    expect(stdout).toContain('period-rate');
  });
});

describe('floe actuals invoices', () => {
  it('foot refuses without --yes when non-interactive, before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['actuals', 'invoices', 'foot', '9']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--yes');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('foot --dry-run needs no confirmation and posts dryRun', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) =>
      jsonRes(200, {
        document: null,
        foot: {
          mode: 'usd',
          parsedTotalRaw: '125000',
          ledgerTotalRaw: '124000',
          varianceRaw: '1000',
          unexplainedRaw: '0',
          stampsWritten: 12,
          linesPromoted: 3,
        },
        dryRun: true,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['actuals', 'invoices', 'foot', '9', '--dry-run']);

    expect(process.exitCode ?? 0).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://credit-api.floelabs.xyz/v1/developer/actuals/documents/9/foot');
    expect(JSON.parse(init?.body ?? '')).toEqual({ dryRun: true });
    expect(stdout).toContain('Dry run');
    expect(stdout).toContain('$0.125');
  });

  it('upload sends a small CSV down the inline lane', async () => {
    const file = `${dir}/invoice.csv`;
    writeFileSync(file, 'description,cost\nminutes,1.25\n');
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) =>
      jsonRes(201, {
        document: {
          id: 11,
          vendor: 'twilio',
          filename: 'invoice.csv',
          state: 'needs_review',
          parseStatus: 'needs_review',
          footStatus: 'unfooted',
          parsedTotalNative: '1.25',
          currency: 'usd',
          parseError: null,
          footedAt: null,
        },
        duplicate: false,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['actuals', 'invoices', 'upload', '--vendor', 'twilio', '--file', file]);

    expect(process.exitCode ?? 0).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://credit-api.floelabs.xyz/v1/developer/actuals/documents');
    const body = JSON.parse(init?.body ?? '');
    expect(body.vendor).toBe('twilio');
    expect(body.contentType).toBe('text/csv');
    expect(body.body).toContain('minutes,1.25');
    expect(stdout).toContain('invoice #11');
  });

  it('rejects an unknown --foot-status before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['actuals', 'invoices', 'list', '--foot-status', 'paid']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--foot-status must be one of');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('floe actuals findings', () => {
  it('resolve requires a --resolution from the human-allowed set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['actuals', 'findings', 'resolve', '3', '--resolution', 'auto_cleared']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--resolution is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolve posts the resolution', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) =>
      jsonRes(200, { finding: { id: 3, kind: 'unmatched_leg' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await main(['actuals', 'findings', 'resolve', '3', '--resolution', 'acknowledged']);

    expect(process.exitCode ?? 0).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://credit-api.floelabs.xyz/v1/developer/actuals/findings/3/resolve');
    expect(JSON.parse(init?.body ?? '')).toEqual({ resolution: 'acknowledged' });
  });
});

describe('floe actuals dispatch', () => {
  it('rejects unknown subcommands before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['actuals', 'vendors']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unknown actuals subcommand');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves `floe vendors` — the marketplace probes — untouched', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, { now: '2026-08-26T00:00:00.000Z', vendors: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await main(['vendors']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://credit-api.floelabs.xyz/v1/playground/vendors',
    );
  });
});
