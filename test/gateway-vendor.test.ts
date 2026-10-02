import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSIONS, contractJsonSchema } from '../src/gateway/vendor/validator.mjs';

/**
 * L1.9 — the vendored validator and schema (src/gateway/vendor/) are a pinned
 * copy of floe-monorepo's. The bundle's own schema must equal the vendored
 * schema file (what GET /v1/ext-gateway/contract/:version serves), and, when
 * the monorepo is checked out next to this repo (or FLOE_MONOREPO points at
 * it), the vendored files must be byte-identical to a fresh build — otherwise
 * re-run scripts/sync-gateway-validator.sh.
 */

const VENDOR = resolve(__dirname, '../src/gateway/vendor');
const MONO = resolve(process.env.FLOE_MONOREPO ?? resolve(__dirname, '../../floe-monorepo'));
const BUILD = join(MONO, 'apps/api/scripts/gateway-validator/build.ts');

describe('vendored gateway validator', () => {
  it('pins contract v3, and its schema file is the bundle\'s own schema', () => {
    expect([...CONTRACT_VERSIONS]).toEqual([3]);
    const file = readFileSync(join(VENDOR, 'contract-v3.schema.json'), 'utf8');
    expect(file).toBe(`${JSON.stringify(contractJsonSchema('3'), null, 2)}\n`);
    expect(JSON.parse(file).$id).toBe('https://credit-api.floelabs.xyz/v1/ext-gateway/contract/3');
  });

  it.skipIf(!existsSync(BUILD))('is byte-identical to a fresh build of floe-monorepo', () => {
    const out = mkdtempSync(join(tmpdir(), 'floe-gv-'));
    execFileSync('pnpm', ['--filter', '@floe/api', 'build:gateway-validator', out], { cwd: MONO, stdio: 'pipe' });
    for (const f of ['validator.mjs', 'contract-v3.schema.json']) {
      expect(readFileSync(join(VENDOR, f), 'utf8'), `${f}: run scripts/sync-gateway-validator.sh`).toBe(readFileSync(join(out, f), 'utf8'));
    }
  }, 120_000);
});
