import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeAgent,
  configDir,
  DEFAULT_API_URL,
  readConfig,
  resolveApiUrl,
  withActiveAgent,
  withAgentEntry,
  writeConfig,
} from '../src/lib/config.js';
import { UsageError } from '../src/lib/output.js';

// Not ".tmp-config-": main.test.ts already owns that name for the same pid.
const dir = `${process.cwd()}/test/.tmp-config-lib-${process.pid}`;

const configPath = () => join(configDir(), 'config.json');

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  vi.stubEnv('FLOE_API_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('readConfig', () => {
  it('treats a missing file as a fresh install', () => {
    expect(readConfig()).toEqual({});
  });

  it('fails loudly on corrupt JSON instead of silently returning {}', () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), '{ not json');
    expect(() => readConfig()).toThrow(UsageError);
    expect(() => readConfig()).toThrow(/not valid JSON/);
  });

  it('rejects a JSON array (config must be an object)', () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), '[]');
    expect(() => readConfig()).toThrow(/not valid JSON/);
  });

  it('migrates a v0.1 flat config into the per-agent shape, recording the legacy slot owner', () => {
    mkdirSync(configDir(), { recursive: true });
    // v0.1 persisted the id as a JSON number (the API serializes ids so).
    writeFileSync(
      configPath(),
      JSON.stringify({
        apiUrl: 'https://credit-api.floelabs.xyz',
        agentId: 7,
        agentName: 'prod-agent',
        agentWalletAddress: '0xabc',
        keyId: 42,
        keyPrefix: 'floe_ab12...',
      }),
    );

    const config = readConfig();

    expect(config.activeAgentId).toBe('7');
    expect(config.legacySlotAgentId).toBe('7');
    expect(config.agents?.['7']).toEqual({
      name: 'prod-agent',
      wallet: '0xabc',
      keyId: 42,
      keyPrefix: 'floe_ab12...',
    });
    expect(config.apiUrl).toBe('https://credit-api.floelabs.xyz');
  });

  it('coerces numeric ids in a v2 config to strings', () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({ activeAgentId: 7, legacySlotAgentId: 7, agents: { '7': { name: 'a' } } }),
    );

    const config = readConfig();

    expect(config.activeAgentId).toBe('7');
    expect(config.legacySlotAgentId).toBe('7');
  });
});

describe('writeConfig', () => {
  it('round-trips through readConfig', () => {
    const config = {
      apiUrl: 'https://credit-api.floelabs.xyz',
      activeAgentId: '7',
      agents: { '7': { name: 'prod-agent', keyId: '42', keyPrefix: 'floe_ab12...' } },
    };
    writeConfig(config);
    expect(readConfig()).toEqual(config);
  });

  it('writes the file 0600 and leaves no temp file behind', () => {
    writeConfig({ activeAgentId: '7' });
    if (process.platform !== 'win32') {
      expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(configDir())).toEqual(['config.json']);
  });
});

describe('active agent helpers', () => {
  it('activeAgent is undefined when nothing is configured', () => {
    expect(activeAgent({})).toBeUndefined();
  });

  it('activeAgent merges the id with its entry', () => {
    const config = { activeAgentId: '7', agents: { '7': { name: 'prod-agent' } } };
    expect(activeAgent(config)).toEqual({ id: '7', name: 'prod-agent' });
  });

  it('withActiveAgent stores ids as strings and switches the active agent', () => {
    const config = withActiveAgent({}, 7, { name: 'prod-agent' });
    expect(config.activeAgentId).toBe('7');
    expect(config.agents?.['7']).toEqual({ name: 'prod-agent' });
  });

  it('withAgentEntry patches an entry WITHOUT switching the active agent', () => {
    const base = withActiveAgent({}, 7, { name: 'prod-agent' });
    const patched = withAgentEntry(base, 8, { name: 'staging' });
    expect(patched.activeAgentId).toBe('7');
    expect(patched.agents?.['8']).toEqual({ name: 'staging' });
    // Existing entries survive the merge.
    expect(patched.agents?.['7']).toEqual({ name: 'prod-agent' });
  });
});

describe('resolveApiUrl', () => {
  it('defaults to production and strips trailing slashes', () => {
    expect(resolveApiUrl(undefined, {})).toBe(DEFAULT_API_URL);
    expect(resolveApiUrl('https://api.example.com///', {})).toBe('https://api.example.com');
  });

  it('precedence: flag > FLOE_API_URL > saved config > default', () => {
    expect(resolveApiUrl(undefined, { apiUrl: 'https://saved.example.com' })).toBe(
      'https://saved.example.com',
    );
    vi.stubEnv('FLOE_API_URL', 'https://env.example.com');
    expect(resolveApiUrl(undefined, { apiUrl: 'https://saved.example.com' })).toBe(
      'https://env.example.com',
    );
    expect(resolveApiUrl('https://flag.example.com', { apiUrl: 'https://saved.example.com' })).toBe(
      'https://flag.example.com',
    );
  });

  it('allows plain http only for localhost', () => {
    expect(resolveApiUrl('http://localhost:3001', {})).toBe('http://localhost:3001');
    expect(resolveApiUrl('http://127.0.0.1:3001', {})).toBe('http://127.0.0.1:3001');
    expect(() => resolveApiUrl('http://evil.example.com', {})).toThrow(/must use https/);
  });

  it('rejects an unparseable URL', () => {
    expect(() => resolveApiUrl('not a url', {})).toThrow(/Invalid API URL/);
  });
});
