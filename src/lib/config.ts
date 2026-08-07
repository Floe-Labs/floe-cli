import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from './output.js';

export const DEFAULT_API_URL = 'https://credit-api.floelabs.xyz';
export const DASHBOARD_URL = 'https://dev-dashboard.floelabs.xyz';

export interface AgentEntry {
  name?: string;
  wallet?: string;
  keyId?: string;
  keyPrefix?: string;
}

/**
 * Config v2 (0.2.0): one entry per agent so `floe use` can switch without
 * re-minting keys. v0.1 stored a single flat agent (agentId/agentName/keyId/…)
 * and one keychain slot per host; readConfig() migrates that shape in memory
 * and records which agent owns the legacy keychain slot so its key stays
 * readable (see keychain.ts resolveAgentKey).
 */
export interface CliConfig {
  apiUrl?: string;
  activeAgentId?: string;
  agents?: Record<string, AgentEntry>;
  /** Set once by migration: the agent the pre-0.2 `agent-key:<host>` slot belongs to. */
  legacySlotAgentId?: string;
}

interface LegacyConfig extends CliConfig {
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

function migrate(raw: LegacyConfig): CliConfig {
  if (!raw.agentId || raw.agents) {
    const { agentId, agentName, agentWalletAddress, keyId, keyPrefix, ...rest } = raw;
    // Ids may have been persisted as JSON numbers (the API serializes them so).
    if (rest.activeAgentId !== undefined) rest.activeAgentId = String(rest.activeAgentId);
    if (rest.legacySlotAgentId !== undefined) rest.legacySlotAgentId = String(rest.legacySlotAgentId);
    return rest;
  }
  return {
    apiUrl: raw.apiUrl,
    activeAgentId: String(raw.agentId),
    legacySlotAgentId: String(raw.agentId),
    agents: {
      [String(raw.agentId)]: {
        name: raw.agentName,
        wallet: raw.agentWalletAddress,
        keyId: raw.keyId,
        keyPrefix: raw.keyPrefix,
      },
    },
  };
}

export function readConfig(): CliConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath(), 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return migrate(parsed as LegacyConfig);
  } catch {
    // A corrupt config silently read as {} would be overwritten (losing every
    // agent entry) by the next command that writes — fail loudly instead.
    throw new UsageError(
      `Config file ${configPath()} is not valid JSON — fix or delete it, then re-run \`floe init\`.`,
    );
  }
}

export function writeConfig(config: CliConfig): void {
  mkdirSync(configDir(), { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a truncated config.
  const tmp = `${configPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, configPath());
}

/** The agent this machine currently targets, if any. */
export function activeAgent(config: CliConfig): ({ id: string } & AgentEntry) | undefined {
  const id = config.activeAgentId;
  if (!id) return undefined;
  return { id, ...(config.agents?.[id] ?? {}) };
}

/** Returns a new config with `id` active and its entry patched in. Ids are stored as strings. */
export function withActiveAgent(config: CliConfig, id: string | number, patch: AgentEntry): CliConfig {
  const key = String(id);
  return {
    ...withAgentEntry(config, id, patch),
    activeAgentId: key,
  };
}

/** Patch one agent's entry WITHOUT switching the active agent (e.g. rotating a non-active agent's key). */
export function withAgentEntry(config: CliConfig, id: string | number, patch: AgentEntry): CliConfig {
  const key = String(id);
  return {
    ...config,
    agents: { ...config.agents, [key]: { ...config.agents?.[key], ...patch } },
  };
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
