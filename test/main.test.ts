import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

let stdout: string;
let stderr: string;

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

describe('main dispatch', () => {
  it('prints help with exit 0 on no args', async () => {
    await main([]);
    expect(stdout).toContain('USAGE');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('prints version', async () => {
    await main(['--version']);
    expect(stdout).toMatch(/^floe-cli\/\d+\.\d+\.\d+\n$/);
  });

  it('exits 2 on unknown command', async () => {
    await main(['frobnicate']);
    expect(stderr).toContain('unknown command');
    expect(process.exitCode).toBe(2);
  });

  it('exits 2 on unknown flag', async () => {
    await main(['status', '--bogus']);
    expect(process.exitCode).toBe(2);
  });

  it('exits 2 when budget set is missing the amount', async () => {
    await main(['budget', 'set']);
    expect(stderr).toContain('Usage: floe budget set');
    expect(process.exitCode).toBe(2);
  });

  it('exits 2 on an invalid budget amount, before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    const dir = `${process.cwd()}/test/.tmp-config-amount-${process.pid}`;
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(`${dir}/floe`, { recursive: true });
    writeFileSync(`${dir}/floe/config.json`, JSON.stringify({ agentId: 'agent-1' }));
    vi.stubEnv('XDG_CONFIG_HOME', dir);
    try {
      await main(['budget', 'set', 'not-a-number']);
      expect(stderr).toContain('Invalid USD amount');
      expect(process.exitCode).toBe(2);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails budget set as a usage error, before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // Signed in (env key) but no agent configured in an empty config dir →
    // deterministic usage error regardless of the machine's keychain state.
    vi.stubEnv('FLOE_API_KEY', 'floe_live_test');
    const dir = `${process.cwd()}/test/.tmp-config-${process.pid}`;
    const { mkdirSync, rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    vi.stubEnv('XDG_CONFIG_HOME', dir);
    try {
      await main(['budget', 'set', '5']);
      expect(stderr).toContain('No agent configured');
      expect(process.exitCode).toBe(2);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
