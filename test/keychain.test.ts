import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentKeyAccount,
  devKeyAccount,
  getSecret,
  legacyAgentKeyAccount,
  resolveAgentKey,
  resolveDevKey,
  setSecret,
} from '../src/lib/keychain.js';

// A throwaway host for storage tests: if the '@napi-rs/keyring' mock ever
// silently stopped applying, writes would land in the REAL OS keychain — a
// .invalid host guarantees they could never collide with actual credentials.
const API = 'https://keychain-test.invalid';
const dir = `${process.cwd()}/test/.tmp-keychain-${process.pid}`;
const credentialsPath = () => join(dir, 'floe', 'credentials.json');

// Fake native keyring so tests NEVER touch the real OS keychain. `mode`
// switches behavior at call time: 'ok' stores in-memory, 'refuse' simulates a
// locked/headless backend (the module then degrades to the credentials file).
const h = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'refuse',
  kc: new Map<string, string>(),
}));

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {}
    getPassword(): string {
      if (h.mode === 'refuse') throw new Error('keychain locked');
      const value = h.kc.get(`${this.service}:${this.account}`);
      if (value === undefined) throw new Error('no entry');
      return value;
    }
    setPassword(value: string): void {
      if (h.mode === 'refuse') throw new Error('keychain locked');
      h.kc.set(`${this.service}:${this.account}`, value);
    }
    deletePassword(): boolean {
      return h.kc.delete(`${this.service}:${this.account}`);
    }
  },
}));

let stderr: string;

beforeEach(() => {
  stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  h.mode = 'ok';
  h.kc.clear();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  vi.stubEnv('FLOE_API_KEY', '');
  vi.stubEnv('FLOE_AGENT_KEY', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('account names', () => {
  it('scopes every slot by API host so staging cannot shadow production', () => {
    // Pure string helpers — safe to exercise with the production URL.
    const prod = 'https://credit-api.floelabs.xyz';
    expect(devKeyAccount(prod)).toBe('dev-key:credit-api.floelabs.xyz');
    expect(agentKeyAccount(prod, 7)).toBe('agent-key:credit-api.floelabs.xyz:7');
    expect(legacyAgentKeyAccount(prod)).toBe('agent-key:credit-api.floelabs.xyz');
    expect(devKeyAccount('https://staging.example.com')).toBe('dev-key:staging.example.com');
  });
});

describe('keyring-backed storage', () => {
  it('round-trips a secret through the keyring without creating the credentials file', async () => {
    await setSecret(agentKeyAccount(API, 7), 'floe_secret');
    expect(await getSecret(agentKeyAccount(API, 7))).toBe('floe_secret');
    expect(existsSync(credentialsPath())).toBe(false);
    expect(stderr).toBe('');
  });

  it('returns undefined for an account stored nowhere', async () => {
    expect(await getSecret(agentKeyAccount(API, 999))).toBeUndefined();
  });
});

describe('credentials-file fallback', () => {
  // ORDER-DEPENDENT: keychain.ts's warn-once flag is module state with no
  // reset, so the warning assertion below must be the FIRST fallback in this
  // file. Don't add fallback-path tests above this one.
  it('degrades to a 0600 credentials.json when the keyring backend refuses, warning once', async () => {
    h.mode = 'refuse';

    await setSecret(devKeyAccount(API), 'floe_live_fallback');

    expect(await getSecret(devKeyAccount(API))).toBe('floe_live_fallback');
    const stored = JSON.parse(readFileSync(credentialsPath(), 'utf8')) as Record<string, string>;
    expect(stored[devKeyAccount(API)]).toBe('floe_live_fallback');
    if (process.platform !== 'win32') {
      expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    }
    expect(stderr).toContain('OS keychain unavailable');

    // The note prints once per process, not once per write.
    stderr = '';
    await setSecret(devKeyAccount(API), 'floe_live_fallback2');
    expect(stderr).toBe('');
  });

  it('getSecret falls back to the file when the keyring has no entry', async () => {
    h.mode = 'refuse';
    await setSecret(agentKeyAccount(API, 7), 'floe_filed');
    h.mode = 'ok'; // keyring back, but the entry lives in the file

    expect(await getSecret(agentKeyAccount(API, 7))).toBe('floe_filed');
  });
});

describe('resolveDevKey', () => {
  it('prefers FLOE_API_KEY over the stored slot', async () => {
    await setSecret(devKeyAccount(API), 'floe_live_stored');
    vi.stubEnv('FLOE_API_KEY', 'floe_live_env');
    expect(await resolveDevKey(API)).toBe('floe_live_env');
  });

  it('falls back to the stored slot when the env var is unset', async () => {
    await setSecret(devKeyAccount(API), 'floe_live_stored');
    expect(await resolveDevKey(API)).toBe('floe_live_stored');
  });
});

describe('resolveAgentKey', () => {
  it('FLOE_AGENT_KEY wins for every agent, even with no agent configured', async () => {
    vi.stubEnv('FLOE_AGENT_KEY', 'floe_env');
    expect(await resolveAgentKey(API, undefined)).toBe('floe_env');
    expect(await resolveAgentKey(API, 7)).toBe('floe_env');
  });

  it('is undefined when no agent id is known', async () => {
    expect(await resolveAgentKey(API, undefined)).toBeUndefined();
  });

  it('reads the per-agent slot', async () => {
    await setSecret(agentKeyAccount(API, 7), 'floe_seven');
    expect(await resolveAgentKey(API, 7)).toBe('floe_seven');
  });

  it('reads the legacy 0.1 slot ONLY for the agent config migration recorded as its owner', async () => {
    await setSecret(legacyAgentKeyAccount(API), 'floe_legacy');

    // Owner (recorded id compares as string against a numeric id).
    expect(await resolveAgentKey(API, 7, { legacySlotAgentId: '7' })).toBe('floe_legacy');
    // Any other agent must never see the legacy key.
    expect(await resolveAgentKey(API, 8, { legacySlotAgentId: '7' })).toBeUndefined();
    // No recorded owner → no legacy access.
    expect(await resolveAgentKey(API, 7)).toBeUndefined();
  });

  it('prefers the per-agent slot over the legacy slot', async () => {
    await setSecret(legacyAgentKeyAccount(API), 'floe_legacy');
    await setSecret(agentKeyAccount(API, 7), 'floe_seven');
    expect(await resolveAgentKey(API, 7, { legacySlotAgentId: '7' })).toBe('floe_seven');
  });
});
