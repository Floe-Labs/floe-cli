import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';
import { jsonResponse, stubRoutes } from './helpers/http.js';

/**
 * L1.13 — a gateway connection's payer settlement modes: list the seeded
 * defaults next to the declarations, declare / flip / remove one, and say on
 * import when rows were held because their payer has no mode.
 */

let stdout: string;
const dir = `${process.cwd()}/test/.tmp-gateway-settlement-${process.pid}`;

const DEFAULTS = [
  { billedBy: 'openai', costSource: null, mode: 'invoiced', status: 'default_unverified' },
  { billedBy: 'openrouter', costSource: 'vendor_reported', mode: 'final_at_settlement', status: 'default_unverified' },
];
const profile = (version: number, settlementModes: object[]) => ({ version, template: 'floe-canonical-ndjson@3', settlementModes, settlementModeDefaults: DEFAULTS });
const connection = (slug: string, settlementModes: object[] = []) => ({ slug, gateway: 'own', grain: [], createdBy: 'x', createdAt: '2026-10-01T00:00:00Z', profile: profile(3, settlementModes) });

const outcome = (quarantinedPayer: object) => ({
  import: {
    id: 'egi_1', mode: 'append', windowStart: null, windowEnd: null, profileVersion: 3, rowCount: 10, inserted: 7, duplicates: 0,
    superseded: [], skipped: 0, rejectedReasons: {}, quarantinedPayer,
  },
  slots: 2,
  normalizer: null,
});

beforeEach(() => {
  stdout = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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

describe('floe gateway settlement-modes <slug>', () => {
  it('lists the declared modes and the seeded defaults, each "default, unverified"', async () => {
    stubRoutes({
      'GET /v1/developer/ext-gateway/connections': () =>
        jsonResponse({ connections: [connection('other'), connection('posthog', [{ billedBy: 'openrouter', costSource: 'gateway_computed', mode: 'bucket' }])] }),
    });
    await main(['gateway', 'settlement-modes', 'posthog']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toMatch(/openrouter\s+gateway_computed\s+bucket\s+declared/);
    expect(stdout).toMatch(/openai\s+either\s+invoiced\s+default, unverified/);
    expect(stdout).toMatch(/openrouter\s+vendor_reported\s+final_at_settlement\s+default, unverified/);
    expect(stdout).toContain('profile v3');
  });

  it('--json returns the connection\'s declared modes and defaults', async () => {
    stubRoutes({ 'GET /v1/developer/ext-gateway/connections': () => jsonResponse({ connections: [connection('posthog')] }) });
    await main(['gateway', 'settlement-modes', 'posthog', '--json']);
    expect(JSON.parse(stdout)).toEqual({ slug: 'posthog', profileVersion: 3, settlementModes: [], settlementModeDefaults: DEFAULTS });
  });

  it('an unknown connection is a usage error, exit 2', async () => {
    stubRoutes({ 'GET /v1/developer/ext-gateway/connections': () => jsonResponse({ connections: [connection('other')] }) });
    await main(['gateway', 'settlement-modes', 'posthog']);
    expect(process.exitCode).toBe(2);
  });
});

describe('floe gateway declare-mode <slug> <billed-by> <mode>', () => {
  it('posts the declaration and says held rows for that payer are released, with no re-upload', async () => {
    let sent: unknown;
    stubRoutes({
      'POST /v1/developer/ext-gateway/connections/posthog/profile-versions': (init) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ profile: profile(4, [{ billedBy: 'openrouter', costSource: 'gateway_computed', mode: 'bucket' }]) }, 201);
      },
    });
    await main(['gateway', 'declare-mode', 'posthog', 'OpenRouter', 'bucket', '--cost-source', 'gateway_computed']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(sent).toEqual({ settlementModes: [{ billedBy: 'OpenRouter', costSource: 'gateway_computed', mode: 'bucket' }] });
    expect(stdout).toContain('profile v4');
    expect(stdout).toMatch(/openrouter\s+gateway_computed\s+bucket/);
    expect(stdout).toContain('released into the ledger');
    expect(stdout).toContain('no re-upload');
  });

  it('"none" removes the declaration (mode null) and omits costSource when not given', async () => {
    let sent: unknown;
    stubRoutes({
      'POST /v1/developer/ext-gateway/connections/posthog/profile-versions': (init) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ profile: profile(5, []) }, 201);
      },
    });
    await main(['gateway', 'declare-mode', 'posthog', 'openai', 'none']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(sent).toEqual({ settlementModes: [{ billedBy: 'openai', mode: null }] });
    expect(stdout).toContain('Removed');
    expect(stdout).not.toContain('released into the ledger');
  });

  it('--json prints the new profile version', async () => {
    stubRoutes({
      'POST /v1/developer/ext-gateway/connections/posthog/profile-versions': () => jsonResponse({ profile: profile(4, []) }, 201),
    });
    await main(['gateway', 'declare-mode', 'posthog', 'openai', 'invoiced', '--json']);
    expect(JSON.parse(stdout).profile.version).toBe(4);
  });

  it('rejects an unknown mode or cost source before any request', async () => {
    const fetchMock = stubRoutes({});
    await main(['gateway', 'declare-mode', 'posthog', 'openai', 'monthly']);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await main(['gateway', 'declare-mode', 'posthog', 'openai', 'invoiced', '--cost-source', 'guess']);
    expect(process.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('floe gateway import <slug> <file>', () => {
  const file = (name: string) => {
    const p = `${dir}/${name}`;
    writeFileSync(p, '{"id":"a"}\n');
    return p;
  };

  it('posts the file and names the held payers with the command to declare them', async () => {
    let url = '';
    let type = '';
    const fetchMock = stubRoutes({
      'POST /v1/developer/ext-gateway/connections/posthog/imports': (init) => {
        type = new Headers(init?.headers).get('content-type') ?? '';
        return jsonResponse(outcome({ rows: 3, cost: { micro: '4000000', display: '$4.00' }, billedBy: ['acme-llm', 'vllm-box'] }));
      },
    });
    await main(['gateway', 'import', 'posthog', file('x.ndjson'), '--window-start', '2026-09-01T00:00:00Z', '--window-end', '2026-10-01T00:00:00Z', '--replace']);
    url = String(fetchMock.mock.calls[0]![0]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(type).toBe('application/x-ndjson');
    const q = new URL(url).searchParams;
    expect(q.get('mode')).toBe('replace');
    expect(q.get('window_start')).toBe('2026-09-01T00:00:00Z');
    expect(q.get('window_end')).toBe('2026-10-01T00:00:00Z');
    expect(stdout).toContain('3 rows ($4.00) held: payers with no declared settlement mode (acme-llm, vllm-box). Declare them with floe gateway declare-mode posthog <billed-by> <mode>.');
  });

  it('says nothing about held rows when none were held', async () => {
    stubRoutes({
      'POST /v1/developer/ext-gateway/connections/posthog/imports': () => jsonResponse(outcome({ rows: 0, cost: { micro: '0', display: '$0.00' }, billedBy: [] })),
    });
    await main(['gateway', 'import', 'posthog', file('x.csv')]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toMatch(/Inserted\s+7/);
    expect(stdout).not.toContain('held');
  });

  it('--json prints the API outcome as is, quarantinedPayer included', async () => {
    const body = outcome({ rows: 1, cost: { micro: '10000', display: '$0.01' }, billedBy: ['x'] });
    stubRoutes({ 'POST /v1/developer/ext-gateway/connections/posthog/imports': () => jsonResponse(body) });
    await main(['gateway', 'import', 'posthog', file('x.ndjson'), '--json']);
    expect(JSON.parse(stdout)).toEqual(body);
  });
});
