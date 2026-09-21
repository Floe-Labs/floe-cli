import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const API = 'https://credit-api.floelabs.xyz';
const dir = `${process.cwd()}/test/.tmp-outcomes-${process.pid}`;

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

const BOUND = {
  eventId: 'oev_00112233445566aa',
  outcomeKind: 'meeting_booked',
  status: 'reported',
  quantity: 1,
  occurredAt: '2026-09-15T10:30:00Z',
  confirmedAt: null,
  source: 'agent',
  assertedBy: 'key:17',
  identifier: { vendor: 'floe', kind: 'floe_task', identifier: 'call-8821' },
  binding: {
    interactionId: 'int_00112233445566bb',
    customerId: 'acme',
    campaignId: 'q3-outbound',
    matchedVia: 'floe_task',
    unresolvedReason: null,
  },
  evidence: { externalSystem: null, externalRef: null, note: null, redactedAt: null },
  billedInPeriodId: null,
};

const UNBOUND = {
  ...BOUND,
  eventId: 'oev_ffeeddccbbaa9988',
  source: 'orchestrator',
  assertedBy: 'webhook:twilio:run-5',
  identifier: { vendor: 'twilio', kind: 'callsid', identifier: 'CA5' },
  binding: {
    interactionId: null,
    customerId: null,
    campaignId: null,
    matchedVia: null,
    unresolvedReason: 'no_current_binding',
  },
};

const listBody = (outcomes: unknown[], extra: Record<string, unknown> = {}) => ({
  outcomes,
  nextCursor: null,
  hasMore: false,
  range: { since: '2026-09-01T00:00:00Z', until: '2026-09-21T00:00:00Z' },
  historyFloor: null,
  historyClamped: false,
  ...extra,
});

const detailBody = (outcome: unknown, extra: Record<string, unknown> = {}) => ({
  requested: (outcome as { eventId: string }).eventId,
  isHead: true,
  outcome,
  predecessors: [],
  ...extra,
});

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

describe('outcomes list', () => {
  it('finds claims by the CALL and renders them', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(listBody([BOUND])));
    vi.stubGlobal('fetch', fetchMock);

    await main(['outcomes', 'list', '--task', 'call-8821', '--kind', 'meeting_booked']);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/outcomes?taskId=call-8821&outcomeKind=meeting_booked`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer floe_live_test');
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('oev_00112233445566aa');
    expect(stdout).toContain('meeting_booked');
    expect(stdout).toContain('int_00112233445566bb');
    expect(stdout).toContain('acme');
  });

  /** A claim nothing can bill must stay visible, with the reason it has no call. */
  it('renders an unbound claim with its reason rather than a blank', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(listBody([UNBOUND]))));

    await main(['outcomes', 'list']);

    expect(stdout).toContain('no_current_binding');
    expect(stdout).toContain('oev_ffeeddccbbaa9988');
  });

  it('--json passes the server payload through untouched', async () => {
    const body = listBody([BOUND]);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body)));

    await main(['outcomes', 'list', '--json']);

    expect(JSON.parse(stdout)).toEqual(body);
  });

  it('warns when the plan clamped the history window', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(
      listBody([BOUND], { historyClamped: true, historyFloor: '2026-09-10T00:00:00Z' }),
    )));

    await main(['outcomes', 'list']);

    expect(stdout).toContain('History clamped to 2026-09-10');
  });

  it('rejects an unknown --status before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['outcomes', 'list', '--status', 'nonsense']);

    expect(stderr).toContain('Unknown status "nonsense"');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('outcomes get', () => {
  /** The id an operator wrote down is the REPORTED one; by the time they open
   *  it a confirmation has superseded it. That must not read as deleted. */
  it('answers a superseded id with the current head and says so', async () => {
    const head = { ...BOUND, eventId: 'oev_99887766554433aa', status: 'confirmed', confirmedAt: '2026-09-16T09:00:00Z' };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(detailBody(head, {
      requested: 'oev_00112233445566aa',
      isHead: false,
      predecessors: [{
        eventId: 'oev_00112233445566aa',
        status: 'reported',
        quantity: 1,
        source: 'agent',
        assertedBy: 'key:17',
        occurredAt: '2026-09-15T10:30:00Z',
        confirmedAt: null,
        supersededAt: '2026-09-16T09:00:00Z',
        billedInPeriodId: null,
      }],
    }))));

    await main(['outcomes', 'get', 'oev_00112233445566aa']);

    expect(stdout).toContain('was corrected');
    expect(stdout).toContain('oev_99887766554433aa');
    expect(stdout).toContain('Chain');
  });

  it('rejects a malformed claim id before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['outcomes', 'get', 'not-an-id']);

    expect(stderr).toContain('oev_');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('outcomes confirm', () => {
  it('confirms by id, then re-fetches and prints the resulting head', async () => {
    const head = { ...BOUND, eventId: 'oev_99887766554433aa', status: 'confirmed', confirmedAt: '2026-09-16T09:00:00Z' };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/confirm')) return jsonResponse({ outcome: { eventId: head.eventId } });
      return jsonResponse(detailBody(head));
    });
    vi.stubGlobal('fetch', fetchMock);

    await main(['outcomes', 'confirm', 'oev_00112233445566aa']);

    const [postUrl, postInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(postUrl)).toBe(`${API}/v1/developer/outcomes/oev_00112233445566aa/confirm`);
    expect(postInit.method).toBe('POST');
    // Deterministic, so a retried command replays instead of writing again.
    expect(JSON.parse(String(postInit.body))).toEqual({
      idempotencyKey: 'cli:confirm:oev_00112233445566aa',
    });
    // The write answers with the agent-shaped serializer, so the CLI re-fetches.
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`${API}/v1/developer/outcomes/oev_99887766554433aa`);
    expect(stdout).toContain('now billable');
    expect(stdout).toContain('confirmed');
  });

  it('resolves --task + --kind to the one current claim', async () => {
    const head = { ...BOUND, eventId: 'oev_99887766554433aa', status: 'confirmed' };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/v1/developer/outcomes?')) return jsonResponse(listBody([BOUND]));
      if (String(url).includes('/confirm')) return jsonResponse({ outcome: { eventId: head.eventId } });
      return jsonResponse(detailBody(head));
    });
    vi.stubGlobal('fetch', fetchMock);

    await main(['outcomes', 'confirm', '--task', 'call-8821', '--kind', 'meeting_booked']);

    const listUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(listUrl).toContain('taskId=call-8821');
    expect(listUrl).toContain('status=reported%2Cconfirmed%2Cdisputed');
    // Two rows is all it takes to answer "is this unique?" — asking for a
    // default-sized page would read 100 to decide the same thing.
    expect(listUrl).toContain('limit=2');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/outcomes/oev_00112233445566aa/confirm');
  });

  /**
   * The page itself says there may be more. Trusting a lone row on one page is
   * how a second matching claim ends up ignored — so `hasMore` is read as a
   * claim that exists and simply cannot be named here.
   */
  it('refuses a singleton page that reports more matching claims behind it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(
      listBody([BOUND], { hasMore: true, nextCursor: 'opaque-cursor' }),
    ));
    vi.stubGlobal('fetch', fetchMock);

    await main(['outcomes', 'confirm', '--task', 'call-8821', '--kind', 'meeting_booked']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('At least 1');
    expect(stderr).toContain('and more');
    expect(stderr).toContain('collision');
    // Listed, then stopped. Nothing was written.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * THE COLLISION CASE. Two current claims of one kind on one call is either
   * one outcome reported twice or two genuine outcomes — the system cannot
   * tell, so the CLI must not pick.
   */
  it('REFUSES when more than one current claim of that kind comes back', async () => {
    const second = { ...BOUND, eventId: 'oev_1122334455667788' };
    const fetchMock = vi.fn(async () => jsonResponse(listBody([BOUND, second])));
    vi.stubGlobal('fetch', fetchMock);

    await main(['outcomes', 'confirm', '--task', 'call-8821', '--kind', 'meeting_booked']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('collision');
    expect(stderr).toContain('oev_00112233445566aa');
    expect(stderr).toContain('oev_1122334455667788');
    // It listed, then stopped. Nothing was written.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * `Number()` rounds silently past 2^53, so this would otherwise POST …992 —
   * a billable quantity the operator never typed. The column ceiling is what
   * catches it (2^53 sits far above 2^31), which is why one bound suffices
   * rather than a separate safe-integer check.
   */
  it('refuses a --quantity that Number() would silently round', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['outcomes', 'confirm', 'oev_00112233445566aa', '--quantity', '9007199254740993']);

    expect(stderr).toContain('--quantity must be a whole number from 1 to 2147483647');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /** The column is a 32-bit int: above its ceiling the write fails inside the
   *  database, which reaches the caller as a 500 for a plainly bad request. */
  it('refuses a --quantity above the column ceiling', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['outcomes', 'confirm', 'oev_00112233445566aa', '--quantity', '3000000000']);

    expect(stderr).toContain('2147483647');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses --external-ref without --external-system before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['outcomes', 'confirm', 'oev_00112233445566aa', '--external-ref', 'DEAL-9']);

    expect(stderr).toContain('--external-ref requires --external-system');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('outcomes void', () => {
  /** Retiring a claim removes billable money; a reason reconstructed later is
   *  a reason nobody wrote. */
  it('refuses without --reason before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['outcomes', 'void', 'oev_00112233445566aa']);

    expect(stderr).toContain('--reason is required');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the reason as the note and carries --duplicate-of when proven', async () => {
    const head = { ...BOUND, eventId: 'oev_99887766554433aa', status: 'void' };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/void')) return jsonResponse({ outcome: { eventId: head.eventId } });
      return jsonResponse(detailBody(head));
    });
    vi.stubGlobal('fetch', fetchMock);

    await main([
      'outcomes', 'void', 'oev_00112233445566aa',
      '--reason', 'duplicate of the webhook claim',
      '--duplicate-of', 'oev_1122334455667788',
    ]);

    const [, voidInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(voidInit.body))).toEqual({
      idempotencyKey: 'cli:void:oev_00112233445566aa',
      note: 'duplicate of the webhook claim',
      duplicateOfEventId: 'oev_1122334455667788',
    });
    expect(stdout).toContain('Voided');
  });

  it('says so when no --duplicate-of was given — a retirement is not a proven duplicate', async () => {
    const head = { ...BOUND, eventId: 'oev_99887766554433aa', status: 'void' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      String(url).includes('/void')
        ? jsonResponse({ outcome: { eventId: head.eventId } })
        : jsonResponse(detailBody(head))
    )));

    await main(['outcomes', 'void', 'oev_00112233445566aa', '--reason', 'client cancelled']);

    expect(stdout).toContain('proven duplicate');
  });
});

describe('outcomes confirm-distinct', () => {
  it('resolves the collision as two real outcomes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      resolved: 'outcome_claim_collision:int_00112233445566bb:meeting_booked',
      claimsRating: 'both',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await main([
      'outcomes', 'confirm-distinct',
      '--interaction', 'int_00112233445566bb',
      '--kind', 'meeting_booked',
    ]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(`${API}/v1/developer/outcomes/collisions/confirm-distinct`);
    expect(JSON.parse(String(init.body))).toEqual({
      interactionId: 'int_00112233445566bb',
      outcomeKind: 'meeting_booked',
    });
    expect(stdout).toContain('both');
  });

  it('requires the call and the kind before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await main(['outcomes', 'confirm-distinct', '--interaction', 'int_00112233445566bb']);

    expect(stderr).toContain('--kind is required');
    expect(process.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
