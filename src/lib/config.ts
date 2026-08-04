import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_URL = 'https://credit-api.floelabs.xyz';
export const DASHBOARD_URL = 'https://dev-dashboard.floelabs.xyz';

export interface CliConfig {
  apiUrl?: string;
  agentId?: string;
  agentName?: string;
  agentWalletAddress?: string;
  keyId?: string;
  keyPrefix?: string;
}

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'floe');
}

const configPath = () => join(configDir(), 'config.json');

export function readConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as CliConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: CliConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** Precedence: --api-url flag > FLOE_API_URL > saved config > production default. */
export function resolveApiUrl(flag: string | undefined, config: CliConfig): string {
  const url = flag || process.env.FLOE_API_URL || config.apiUrl || DEFAULT_API_URL;
  return url.replace(/\/+$/, '');
}
