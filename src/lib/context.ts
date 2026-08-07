import { ApiError, FloeApi } from './api.js';
import { activeAgent, readConfig, resolveApiUrl, type AgentEntry, type CliConfig } from './config.js';
import { resolveAgentKey, resolveDevKey } from './keychain.js';
import { UsageError } from './output.js';
import type { SerializedAgent } from './types.js';

/**
 * Shared per-command setup. Every command resolves one of these instead of
 * hand-rolling config + key lookup, so credential errors and agent targeting
 * stay identical across the whole surface.
 */

export interface DevContext {
  api: FloeApi;
  config: CliConfig;
  apiUrl: string;
}

/** Management-plane context (floe_live_ key). Throws 401 when not signed in. */
export async function devContext(flags: { apiUrl?: string }): Promise<DevContext> {
  const config = readConfig();
  const apiUrl = resolveApiUrl(flags.apiUrl, config);
  const devKey = await resolveDevKey(apiUrl);
  if (!devKey) {
    throw new ApiError('Not signed in. Run `floe init` first.', 401, 'missing_credential');
  }
  return { api: new FloeApi(apiUrl, devKey), config, apiUrl };
}

export interface AgentContext {
  api: FloeApi;
  config: CliConfig;
  apiUrl: string;
  /** Unset when FLOE_AGENT_KEY authenticated without any configured agent. */
  agentId?: string;
}

/** Gateway-plane context (floe_ agent key for the active agent). Throws 401 when absent. */
export async function agentContext(flags: { apiUrl?: string }): Promise<AgentContext> {
  const config = readConfig();
  const apiUrl = resolveApiUrl(flags.apiUrl, config);
  const agentId = config.activeAgentId;
  const agentKey = await resolveAgentKey(apiUrl, agentId, config);
  if (!agentKey) {
    throw new ApiError(
      'No agent key found. Run `floe init` first (or set FLOE_AGENT_KEY).',
      401,
      'missing_credential',
    );
  }
  return { api: new FloeApi(apiUrl, undefined, agentKey), config, apiUrl, agentId };
}

/** The agent this machine targets. UsageError (not auth) when none is configured. */
export function requireActiveAgent(config: CliConfig): { id: string } & AgentEntry {
  const agent = activeAgent(config);
  if (!agent) {
    throw new UsageError('No agent configured on this machine. Run `floe init` first.');
  }
  return agent;
}

/**
 * Resolve an agent reference (--agent flag or positional): exact id first,
 * then exact name; no reference means the machine's active agent. Fetches the
 * fleet once — callers that already hold the list pass it in.
 */
export async function resolveAgentRef(
  ctx: DevContext,
  ref: string | undefined,
  fleet?: SerializedAgent[],
): Promise<SerializedAgent> {
  const agents =
    fleet ?? (await ctx.api.dev<{ agents: SerializedAgent[] }>('GET', '/v1/developer/agents')).agents;
  if (!ref) {
    const active = requireActiveAgent(ctx.config);
    const found = agents.find((a) => String(a.id) === String(active.id));
    if (!found) {
      throw new UsageError(
        'The agent configured on this machine no longer exists. Run `floe use <agent>` or `floe init`.',
      );
    }
    return found;
  }
  const byId = agents.find((a) => String(a.id) === ref);
  if (byId) return byId;
  const byName = agents.filter((a) => a.name === ref);
  const activeMatch = byName.find((a) => a.status === 'active') ?? byName[0];
  if (activeMatch) return activeMatch;
  throw new UsageError(
    `No agent named "${ref}". Known: ${agents.map((a) => a.name).join(', ') || '(none)'}`,
  );
}
