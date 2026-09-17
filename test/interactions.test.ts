import { mkdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;
const dir = `${process.cwd()}/test/.tmp-interactions-${process.pid}`;

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

const OWNER_ECHO = {
  costOwner: 'developer',
  costOwnerNote:
    'The vendor-cost figures cover legs your account pays for. A Floe-carried leg carries no vendor bill of yours.',
};

const SUBTOTAL_ZERO = {
  composition: { exact: 0, periodRate: 0, invoiced: 0, pending: 0, manual: 0, groupLegs: 0 },
  exactRaw: '0',
  periodRateRaw: '0',
  invoicedRaw: '0',
  groupsRaw: '0',
  groupCount: 0,
  adjustmentsRaw: '0',
  totalRaw: null,
  totalBlockedBy: [],
  totalLabel: 'partial — lower bound',
  nonUsd: false,
};

/** Two tasks: one fully costed with a Floe charge beside its vendor cost, one
 *  still partial with no Floe-carried leg at all. */
const LIST_BODY = {
  interactions: [
    {
      ...SUBTOTAL_ZERO,
      interactionId: 'int_00112233445566aa',
      channel: 'voice',
      direction: 'outbound',
      startedAt: '2026-09-10T10:00:00.000Z',
      endedAt: '2026-09-10T10:04:00.000Z',
      durationMs: 240_000,
      agentId: '7',
      customerId: 'acme-dental',
      campaignId: 'q3-recalls',
      outcome: 'success',
      legCount: 3,
      floeCarriedLegCount: 1,
      vendors: ['deepgram', 'openai', 'twilio'],
      byKind: {
        telephony: { legs: 1, costRaw: '34000', partial: false },
        llm: { legs: 1, costRaw: '280000', partial: false },
      },
      topKind: { kind: 'llm', costRaw: '280000', partial: false },
      composition: { exact: 2, periodRate: 0, invoiced: 0, pending: 0, manual: 0, groupLegs: 0 },
      exactRaw: '314000',
      totalRaw: '314000',
      totalLabel: null,
      floeChargeRaw: '7000',
      floeChargeRequests: 1,
      paidRaw: '321000',
      marginRaw: null,
      marginPartial: false,
      marginBps: null,
    },
    {
      ...SUBTOTAL_ZERO,
      interactionId: 'int_00112233445566bb',
      channel: 'job',
      direction: null,
      startedAt: '2026-09-10T09:00:00.000Z',
      endedAt: null,
      durationMs: null,
      agentId: '7',
      customerId: null,
      campaignId: null,
      outcome: null,
      legCount: 2,
      floeCarriedLegCount: 0,
      vendors: ['twilio'],
      byKind: { telephony: { legs: 2, costRaw: null, partial: true } },
      topKind: null,
      composition: { exact: 0, periodRate: 0, invoiced: 0, pending: 2, manual: 0, groupLegs: 0 },
      totalRaw: null,
      totalBlockedBy: ['unresolved_legs'],
      totalLabel: 'partial — lower bound',
      // Floe carried nothing here — null, which must not render as $0.00.
      floeChargeRaw: null,
      floeChargeRequests: 0,
      paidRaw: null,
      marginRaw: null,
      marginPartial: false,
      marginBps: null,
    },
  ],
  nextCursor: null,
  hasMore: false,
  orderBy: 'started',
  subtotals: {
    perStatus: null,
    unsupportedFilters: [],
    unstampedLegs: 0,
    nonUsdLegs: 0,
    groupScopeLegs: 0,
    legs: 5,
    totalRaw: null,
    totalBlockedBy: ['unresolved_legs'],
    totalLabel: 'partial — lower bound',
  },
  range: { since: '2026-09-01T00:00:00.000Z', until: '2026-09-17T00:00:00.000Z' },
  ...OWNER_ECHO,
  resolution: {
    legs: { total: 6, bound: 5, unresolved: 1, unswept: 0 },
    unresolvedByReason: { no_join_identifiers: 1 },
    resolutionBps: 8333,
  },
  distribution: {
    calls: 2,
    partialCalls: 1,
    lowerBound: true,
    p50Raw: '157000',
    p95Raw: '300000',
    maxRaw: '314000',
  },
  historyFloor: null,
  historyClamped: false,
};

const DETAIL_BODY = {
  ...SUBTOTAL_ZERO,
  interactionId: 'int_00112233445566aa',
  requestedId: null,
  channel: 'voice',
  direction: 'outbound',
  startedAt: '2026-09-10T10:00:00.000Z',
  endedAt: '2026-09-10T10:04:00.000Z',
  durationMs: 240_000,
  agentId: '7',
  customerId: 'acme-dental',
  campaignId: 'q3-recalls',
  outcome: 'success',
  ...OWNER_ECHO,
  legs: [
    {
      legId: 1,
      vendor: 'twilio',
      legKind: 'telephony',
      occurredAt: '2026-09-10T10:00:00.000Z',
      captureSource: 'telephony',
      attemptOutcome: 'success',
      matchedVia: 'callsid',
      units: { minutes: '4' },
      reconciliationStatus: 'exact',
      statusReason: null,
      costOwner: 'developer',
      costRaw: '34000',
      currency: 'usd',
      costScope: 'leg',
    },
    {
      legId: 2,
      vendor: 'openai',
      legKind: 'llm',
      occurredAt: '2026-09-10T10:00:05.000Z',
      captureSource: 'gateway',
      attemptOutcome: 'success',
      matchedVia: 'vendor_request',
      units: { input_tokens: '1200' },
      reconciliationStatus: 'exact',
      statusReason: null,
      costOwner: 'developer',
      costRaw: '280000',
      currency: 'usd',
      costScope: 'leg',
    },
    {
      legId: 3,
      vendor: 'deepgram',
      legKind: 'stt',
      occurredAt: '2026-09-10T10:00:09.000Z',
      captureSource: 'gateway',
      attemptOutcome: 'success',
      matchedVia: 'floe_task',
      units: { seconds: '240' },
      // Floe carried this leg: no vendor bill of yours, so no cost cell.
      reconciliationStatus: 'pending',
      statusReason: null,
      costOwner: 'platform',
      costRaw: null,
      currency: 'usd',
      costScope: 'leg',
    },
  ],
  links: [
    {
      vendor: 'twilio',
      identifierKind: 'callsid',
      identifier: 'CA9988776655443322',
      createdAt: '2026-09-10T10:00:00.000Z',
    },
  ],
  byKind: {
    telephony: { legs: 1, costRaw: '34000', partial: false },
    llm: { legs: 1, costRaw: '280000', partial: false },
  },
  composition: { exact: 2, periodRate: 0, invoiced: 0, pending: 0, manual: 0, groupLegs: 0 },
  exactRaw: '314000',
  totalRaw: '314000',
  totalLabel: null,
  floeChargeRaw: '7000',
  floeChargeRequests: 1,
  paidRaw: '321000',
  historyFloor: null,
  historyClamped: false,
};

const ROLLUPS_BODY = {
  by: 'customer',
  rollups: [
    {
      ...SUBTOTAL_ZERO,
      key: 'acme-dental',
      legCount: 2,
      vendors: ['deepgram', 'twilio'],
      composition: { exact: 2, periodRate: 0, invoiced: 0, pending: 0, manual: 0, groupLegs: 0 },
      exactRaw: '120000',
      totalRaw: '120000',
      totalLabel: null,
      interactionCount: 1,
      openInteractions: 0,
      durationMs: 3_600_000,
      costPerMinuteRaw: '2000',
      costPerMinuteBlockedBy: [],
    },
    {
      ...SUBTOTAL_ZERO,
      key: '(unattributed)',
      legCount: 1,
      vendors: ['twilio'],
      composition: { exact: 0, periodRate: 0, invoiced: 0, pending: 1, manual: 0, groupLegs: 0 },
      totalRaw: null,
      totalBlockedBy: ['unresolved_legs'],
      totalLabel: 'partial — lower bound',
      interactionCount: 1,
      openInteractions: 1,
      durationMs: 0,
      costPerMinuteRaw: null,
      costPerMinuteBlockedBy: ['partial_cost', 'open_interactions', 'no_duration'],
    },
  ],
  nextCursor: null,
  hasMore: false,
  range: LIST_BODY.range,
  ...OWNER_ECHO,
  resolution: LIST_BODY.resolution,
  historyFloor: null,
  historyClamped: false,
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

describe('floe interactions list', () => {
  it('shows one row per task with its cost, and never turns an unknown into $0.00', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, LIST_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main(['interactions', 'list']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://credit-api.floelabs.xyz/v1/developer/interactions',
    );
    expect(stdout).toContain('int_00112233445566aa');
    expect(stdout).toContain('acme-dental');
    expect(stdout).toContain('4m00s');
    // The costed task's figures, kept apart: vendor cost, Floe charge, paid.
    expect(stdout).toContain('$0.314');
    expect(stdout).toContain('$0.007');
    expect(stdout).toContain('$0.321');
    // The partial task has no total and no Floe charge — neither may print as zero.
    expect(stdout).toContain('partial — lower bound');
    expect(stdout).not.toContain('$0.00 ');
  });

  it('names the culprit leg and flags a lower-bound distribution', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, LIST_BODY)));

    await main(['interactions', 'list']);

    expect(stdout).toContain('TOP LEG');
    expect(stdout).toContain('llm $0.28');
    expect(stdout).toContain('p95');
    // One of two tasks entered at its lower bound, so the percentiles read "at least".
    expect(stdout).toContain('≥');
    expect(stdout).toContain('1 of 2 tasks are not fully costed');
  });

  it('states which legs are bound to a task and why the rest are not', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, LIST_BODY)));

    await main(['interactions', 'list']);

    expect(stdout).toContain('5/6');
    expect(stdout).toContain('no_join_identifiers=1');
  });

  it('passes filters through as the API-documented query params', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, LIST_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main([
      'interactions', 'list',
      '--customer', 'acme-dental',
      '--campaign', 'q3-recalls',
      '--channel', 'voice',
      '--outcome', 'success',
      '--order', 'cost',
      '--limit', '25',
    ]);

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v1/developer/interactions');
    expect(url.searchParams.get('customerId')).toBe('acme-dental');
    expect(url.searchParams.get('campaignId')).toBe('q3-recalls');
    expect(url.searchParams.get('channel')).toBe('voice');
    expect(url.searchParams.get('outcome')).toBe('success');
    expect(url.searchParams.get('orderBy')).toBe('cost');
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('rejects an unknown channel, outcome or order before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['interactions', 'list', '--channel', 'telepathy']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--channel must be one of');

    process.exitCode = undefined;
    await main(['interactions', 'list', '--order', 'margin']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--order must be one of');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('--json emits the payload verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, LIST_BODY)));

    await main(['interactions', 'list', '--json']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toEqual(LIST_BODY);
  });
});

describe('floe interactions show', () => {
  it('opens one task: its legs, per-kind breakdown, and the two kinds of money', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, DETAIL_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main(['interactions', 'show', 'int_00112233445566aa']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://credit-api.floelabs.xyz/v1/developer/interactions/int_00112233445566aa',
    );
    expect(stdout).toContain('twilio');
    expect(stdout).toContain('minutes=4');
    expect(stdout).toContain('input_tokens=1200');
    // Per-kind: where the money went on this call.
    expect(stdout).toContain('LEG KIND');
    expect(stdout).toContain('$0.28');
    // The Floe-carried leg is a leg of the task but carries no cost of yours.
    expect(stdout).toContain('floe-carried');
    // Vendor cost, Floe charge and the paid total stay three separate lines.
    expect(stdout).toContain('Vendor cost');
    expect(stdout).toContain('Floe charge');
    expect(stdout).toContain('Paid total');
    expect(stdout).toContain('$0.321');
    expect(stdout).toContain('callsid=CA9988776655443322');
  });

  it('refuses a malformed task id before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['interactions', 'show', '42']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('int_0123456789abcdef');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says so when the id asked for was merged into another task', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonRes(200, { ...DETAIL_BODY, requestedId: 'int_00112233445566cc' })));

    await main(['interactions', 'show', 'int_00112233445566cc']);

    expect(stdout).toContain('was merged into this task');
  });

  it('prints a partial task without inventing a total', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonRes(200, {
        ...DETAIL_BODY,
        totalRaw: null,
        totalLabel: 'partial — lower bound',
        totalBlockedBy: ['unresolved_legs'],
        paidRaw: null,
        floeChargeRaw: null,
        floeChargeRequests: 0,
        byKind: { llm: { legs: 2, costRaw: null, partial: true } },
      })));

    await main(['interactions', 'show', 'int_00112233445566aa']);

    expect(stdout).toContain('partial — lower bound');
    expect(stdout).toContain('unresolved_legs');
    // Floe carried nothing, so the money block has no charge ROW at all —
    // never a $0.00 one. (The prose below the legs table still uses the
    // words "Floe charge", hence the stricter match on a key/value row.)
    expect(stdout).not.toMatch(/Floe charge\s+\$/);
    // And the paid total stays a label, not a figure.
    expect(stdout).toMatch(/Paid total\s+partial/);
  });
});

describe('floe interactions rollups', () => {
  it('states cost per minute, and names what blocked it when it cannot', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => jsonRes(200, ROLLUPS_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await main(['interactions', 'rollups', '--by', 'customer']);

    expect(process.exitCode ?? 0).toBe(0);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v1/developer/interactions/rollups');
    expect(url.searchParams.get('by')).toBe('customer');
    expect(stdout).toContain('COST/MIN');
    expect(stdout).toContain('$0.002/min');
    // The blocked row names its reasons instead of showing a figure.
    expect(stdout).toContain('partial_cost');
    expect(stdout).toContain('open_interactions');
    expect(stdout).toContain('1 task(s) have no end time yet');
  });

  it('rejects an unknown --by before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['interactions', 'rollups', '--by', 'vendor']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('--by must be one of');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('floe interactions usage', () => {
  it('is listed in the top-level help and explains itself', async () => {
    await main([]);
    expect(stdout).toContain('interactions');

    stdout = '';
    await main(['help', 'interactions']);
    expect(stdout).toContain('floe interactions list');
    expect(stdout).toContain('FLOE CHARGE');
  });

  it('rejects an unknown subcommand', async () => {
    await main(['interactions', 'legs']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('Unknown interactions subcommand');
  });
});
