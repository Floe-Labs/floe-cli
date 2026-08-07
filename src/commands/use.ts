import { ApiError } from '../lib/api.js';
import { expectArgs, type CommandDef } from '../lib/command.js';
import { withActiveAgent, writeConfig } from '../lib/config.js';
import { devContext, resolveAgentRef } from '../lib/context.js';
import { agentKeyAccount, getSecret, legacyAgentKeyAccount, setSecret } from '../lib/keychain.js';
import { bold, dim, ok, printJson, UsageError, warn } from '../lib/output.js';
import type { MintKeyResponse } from '../lib/types.js';

/**
 * Switch this machine's active agent. Keys are stored per agent, so switching
 * back and forth reuses each agent's stored key — a key is minted only the
 * first time an agent is used on this machine (agents cap at 5 keys).
 */
export async function useCommand(ref: string, flags: { apiUrl?: string; json?: boolean }): Promise<void> {
  const ctx = await devContext(flags);
  const agent = await resolveAgentRef(ctx, ref);
  if (agent.status !== 'active') {
    throw new UsageError(
      `Agent "${agent.name}" is ${agent.status} — resume it first: floe agents resume ${agent.name}`,
    );
  }

  // Decide on the *stored* slot, not resolveAgentKey — FLOE_AGENT_KEY would
  // mask a missing slot and strand the next env-less run without a key.
  const stored =
    (await getSecret(agentKeyAccount(ctx.apiUrl, agent.id))) ??
    (ctx.config.legacySlotAgentId !== undefined &&
    String(ctx.config.legacySlotAgentId) === String(agent.id)
      ? await getSecret(legacyAgentKeyAccount(ctx.apiUrl))
      : undefined);

  const entry = ctx.config.agents?.[agent.id];
  let keyId = entry?.keyId;
  let keyPrefix = entry?.keyPrefix;
  let mintedNewKey = false;
  if (!stored) {
    let minted: MintKeyResponse;
    try {
      minted = await ctx.api.dev<MintKeyResponse>('POST', `/v1/developer/agents/${agent.id}/keys`, {
        label: 'floe-cli',
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'limit_exceeded') {
        throw new ApiError(
          `Agent "${agent.name}" already has the maximum number of API keys. Run \`floe keys rotate\` after switching, or revoke unused keys with \`floe keys revoke\`.`,
          409,
          'limit_exceeded',
        );
      }
      throw err;
    }
    // The key is minted server-side (a slot is consumed) and returned only once.
    // If local storage fails, print it before bailing or it's unrecoverable.
    try {
      await setSecret(agentKeyAccount(ctx.apiUrl, agent.id), minted.key);
    } catch (err) {
      process.stderr.write(
        `${warn('Could not save the new key locally — copy it now (shown once):')}\n${bold(minted.key)}\n`,
      );
      throw err;
    }
    keyId = minted.id;
    keyPrefix = minted.keyPrefix;
    mintedNewKey = true;
  }

  writeConfig(
    withActiveAgent(ctx.config, agent.id, {
      name: agent.name,
      wallet: agent.agentWalletAddress,
      keyId,
      keyPrefix,
    }),
  );

  if (flags.json) {
    return printJson({ agentId: agent.id, agentName: agent.name, keyPrefix, mintedNewKey });
  }
  process.stdout.write(
    `${ok(`Now using agent ${bold(agent.name)} ${dim(String(agent.id))}`)}\n` +
      `${dim(mintedNewKey ? 'First use on this machine — a new key was minted and stored.' : 'Stored key reused.')}\n`,
  );
  if (process.env.FLOE_AGENT_KEY) {
    process.stdout.write(
      `${warn('FLOE_AGENT_KEY is set and overrides the stored key for CLI commands.')}\n`,
    );
  }
}

export const useDef: CommandDef = {
  name: 'use',
  summary: 'Switch this machine to another agent (keys kept per agent)',
  usage: `Usage: floe use <agent>

Switch the active agent by name or id. Each agent's key is stored separately,
so switching never re-mints an existing key; the first switch to an agent
mints one (agents cap at 5 keys).
`,
  options: {},
  run: async (ctx) => {
    const [ref] = ctx.args;
    if (!ref) throw new UsageError('Usage: floe use <agent> — see `floe agents list` for names.');
    expectArgs(ctx, 1);
    await useCommand(ref, { apiUrl: ctx.apiUrl, json: ctx.json });
  },
};
