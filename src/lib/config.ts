import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from './output.js';

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

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Precedence: --api-url flag > FLOE_API_URL > saved config > production default.
 * API keys travel in the Authorization header, so the URL must be https —
 * plain http is allowed only for localhost (local API development).
 */
export function resolveApiUrl(flag: string | undefined, config: CliConfig): string {
  const url = (flag || process.env.FLOE_API_URL || config.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`Invalid API URL "${url}".`);
  }
  const isLocalHttp = parsed.protocol === 'http:' && LOCAL_HOSTNAMES.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLocalHttp) {
    throw new UsageError(`API URL must use https (got "${url}"); plain http is allowed only for localhost.`);
  }
  return url;
}
