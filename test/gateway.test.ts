import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';
import { validateGatewayFile } from '../src/gateway/vendor/validator.mjs';

/**
 * L1.9 — `floe gateway validate <file>`: offline by default with the vendored
 * validator (the API's own code), `--online` posts the file. Neither mode ever
 * prints a row's content. The sample is synthetic and PostHog-shaped.
 */

let stdout: string;
let stderr: string;
const dir = `${process.cwd()}/test/.tmp-gateway-${process.pid}`;

const EMAILS = ['alice@posthog.com', 'bob@posthog.com'];
const SAMPLE = [
  { id: 'req-001', occurred_at: '2026-09-02T09:15:00Z', person: EMAILS[0], model: 'gpt-4o-mini', provider: 'openai', cost: '0.0012', input_tokens: 1200, output_tokens: 150 },
  { id: 'req-002', occurred_at: '2026-09-02T10:01:30+02:00', user: EMAILS[1], model: 'anthropic/claude-sonnet-4', estimated_cost: '0.0315', prompt_tokens: 5000, completion_tokens: 1100 },
];
const ndjson = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function file(name: string, text: string): string {
  const p = `${dir}/${name}`;
  writeFileSync(p, text);
  return p;
}

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

describe('floe gateway validate (offline)', () => {
  it('a clean contract file validates offline, with no network call, and prints the two caveats', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await main(['gateway', 'validate', file('ok.ndjson', ndjson(SAMPLE))]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('floe-canonical-ndjson@3');
    expect(stdout).toContain('export 2 · Floe 2');
    expect(stdout).toContain('valid: Floe would import every row');
    expect(stdout).toContain('ids already imported on your account are not checked');
    expect(stdout).toContain('people are not resolved against your account');
  });

  it('lists the exact unmapped headers and refused rows by number, never a row value; exit 1', async () => {
    const rows = [SAMPLE[0]!, { ...SAMPLE[0]!, id: 'req-003', model: 'gpt-4o', provider: undefined, prompt_text: 'SECRET PROMPT' }];
    await main(['gateway', 'validate', file('bad.ndjson', ndjson(rows)), '--json']);
    expect(process.exitCode).toBe(1);
    const out = JSON.parse(stdout);
    expect(out.mode).toBe('offline');
    expect(out.headers.unmapped).toEqual(['prompt_text']);
    expect(out.refusedRows.rows).toEqual([{ row: 2, reason: 'missing_provider', field: 'provider' }]);
    expect(out.caveats).toHaveLength(2);
    for (const leak of [...EMAILS, 'req-001', 'req-003', 'SECRET PROMPT', '0.0012']) expect(stdout).not.toContain(leak);
  });

  it('a CSV without ids: "ids derived; window required"', async () => {
    const csv = 'occurred_at,user,model,estimated_cost\n2026-09-02T09:15:00Z,alice@posthog.com,openai/gpt-4o,0.5\n';
    await main(['gateway', 'validate', file('noid.csv', csv), '--template', 'floe-canonical-csv@1']);
    expect(stdout).toContain('ids derived; window required');
    expect(stdout).not.toContain('alice@posthog.com');
  });

  it('an unknown template is a usage error', async () => {
    await main(['gateway', 'validate', file('ok.ndjson', ndjson(SAMPLE)), '--template', 'nope@1']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('floe-canonical-ndjson@3');
  });

  it('--connection needs --online', async () => {
    await main(['gateway', 'validate', file('ok.ndjson', ndjson(SAMPLE)), '--connection', 'own']);
    expect(process.exitCode).toBe(2);
  });
});

describe('CFO B1: a headerless CSV never prints row content', () => {
  const HEADERLESS = 'alice@acme.com,2026-09-02T09:15:00Z,gpt-4o,0.5\nbob@acme.com,2026-09-02T10:00:00Z,gpt-4o,0.25\n';

  it('offline text and --json: no_header_row, no email', async () => {
    const path = file('headerless.csv', HEADERLESS);
    await main(['gateway', 'validate', path]);
    expect(stdout).toContain('no_header_row');
    await main(['gateway', 'validate', path, '--json']);
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toContain('alice@acme.com');
    expect(stdout).not.toContain('bob@acme.com');
  });

  it('a value-like header prints as its column number', async () => {
    await main(['gateway', 'validate', file('h.csv', 'id,occurred_at,model,provider,cost,alice@acme.com\nr1,2026-09-02T09:15:00Z,gpt-4o,openai,0.5,x\n'), '--template', 'floe-canonical-csv@1']);
    expect(stdout).toContain('Unmapped headers: column 6');
    expect(stdout).not.toContain('alice@acme.com');
  });

  it('--online: an old-style report naming a value header is still masked', async () => {
    const { report } = await validateGatewayFile({ text: async function* () { yield ndjson(SAMPLE); } });
    const body = {
      ...report, headers: { ...report.headers, unmapped: ['alice@acme.com'] },
      duplicateIds: { ...report.duplicateIds, alreadyImported: { count: 0, rows: [], truncated: false, byConnection: {} } },
      people: { distinct: 0, known: 0 }, meteredByFloe: { count: 0, rows: [], truncated: false }, idModeMismatch: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, body)));
    await main(['gateway', 'validate', file('ok.ndjson', ndjson(SAMPLE)), '--online']);
    expect(stdout).toContain('Unmapped headers: key 1');
    expect(stdout).not.toContain('alice@acme.com');
  });
});

describe('floe gateway validate --online', () => {
  it('posts the raw file with the developer key and prints the account checks', async () => {
    const path = file('ok.ndjson', ndjson(SAMPLE));
    // The online answer is the offline report plus the two account checks (the API runs the same code).
    const { report } = await validateGatewayFile({ text: async function* () { yield ndjson(SAMPLE); } });
    const body = {
      ...report,
      duplicateIds: { ...report.duplicateIds, alreadyImported: { count: 1, rows: [1], truncated: false, byConnection: { own: 1 } } },
      people: { distinct: 2, known: 1 },
    };
    const fetchMock = vi.fn(async (_url: string, _init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array }) => jsonRes(200, body));
    vi.stubGlobal('fetch', fetchMock);
    await main(['gateway', 'validate', path, '--online', '--template', 'floe-canonical-ndjson@3']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://credit-api.floelabs.xyz/v1/developer/ext-gateway/validate?template=floe-canonical-ndjson%403');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.Authorization).toBe('Bearer floe_live_test');
    expect(init?.headers?.['Content-Type']).toBe('application/x-ndjson');
    expect(Buffer.from(init!.body!).toString('utf8')).toBe(ndjson(SAMPLE));
    expect(stdout).toContain('Ids already imported: 1 (rows 1; own 1)');
    expect(stdout).toContain('People: 2 distinct, 1 already known');
    expect(stdout).not.toContain('ids already imported on your account are not checked');
    for (const leak of EMAILS) expect(stdout).not.toContain(leak);
  });
});
