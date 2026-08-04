import { ApiError, FloeApi } from '../lib/api.js';
import { readConfig, resolveApiUrl, writeConfig } from '../lib/config.js';
import { agentKeyAccount, resolveDevKey, setSecret } from '../lib/keychain.js';
import { bold, dim, green, kv, ok, printJson, UsageError, warn } from '../lib/output.js';
import type { AgentKeySummary, MintKeyResponse } from '../lib/types.js';
import { rawToUsd } from '../lib/usdc.js';

export interface KeysFlags {
  apiUrl?: string;
  json?: boolean;
}

async function requireContext(flags: KeysFlags) {
  const config = readConfig();
  const apiUrl = resolveApiUrl(flags.apiUrl, config);
  const devKey = await resolveDevKey(apiUrl);
  if (!devKey) throw new ApiError('Not signed in. Run `floe init` first.', 401, 'missing_credential');
  if (!config.agentId) throw new UsageError('No agent configured on this machine. Run `floe init` first.');
  return { api: new FloeApi(apiUrl, devKey), config, apiUrl };
}

export async function keysListCommand(flags: KeysFlags): Promise<void> {
  const { api, config } = await requireContext(flags);
  const { keys } = await api.dev<{ keys: AgentKeySummary[] }>(
    'GET',
    `/v1/developer/agents/${config.agentId}/keys`,
  );

  if (flags.json) return printJson({ agentId: config.agentId, keys });

  if (keys.length === 0) {
    process.stdout.write(`No keys for agent "${config.agentName}". Run ${bold('floe init --new-key')}.\n`);
    return;
  }
  process.stdout.write(`${bold(`Agent keys — ${config.agentName ?? config.agentId}`)}\n`);
  const rows: Array<[string, string]> = keys.map((k) => {
    const marker = k.id === config.keyId ? green('● ') : '  ';
    const budget = k.budget
      ? `${rawToUsd(k.budget.remainingRaw)} / ${rawToUsd(k.budget.limitRaw)} left`
      : dim('no budget');
    const used = k.lastUsedAt ? `last used ${k.lastUsedAt.slice(0, 10)}` : 'never used';
    return [`${marker}${k.keyPrefix}`, `${k.label ?? dim('(no label)')} · ${k.permissions} · ${budget} · ${dim(used)}`];
  });
  process.stdout.write(`${kv(rows)}\n`);
  if (config.keyId) process.stdout.write(`${dim('● = the key this machine uses')}\n`);
}

export async function keysRotateCommand(keyId: string | undefined, flags: KeysFlags): Promise<void> {
  const { api, config, apiUrl } = await requireContext(flags);
  const target = keyId ?? config.keyId;
  if (!target) {
    throw new UsageError('No key to rotate. Pass a key id (see `floe keys --json`) or run `floe init` first.');
  }

  const rotated = await api.dev<MintKeyResponse>(
    'POST',
    `/v1/developer/agents/${config.agentId}/keys/${target}/rotate`,
    {},
  );

  const isThisMachinesKey = target === config.keyId || !keyId;
  if (isThisMachinesKey) {
    await setSecret(agentKeyAccount(apiUrl), rotated.key);
    writeConfig({ ...config, keyId: rotated.id, keyPrefix: rotated.keyPrefix });
  }

  if (flags.json) {
    // The raw key is shown exactly once — here, for the caller that rotated it.
    return printJson({ rotated: true, id: rotated.id, keyPrefix: rotated.keyPrefix, key: rotated.key, storedLocally: isThisMachinesKey });
  }
  process.stdout.write(`${ok(`Key rotated → ${bold(rotated.keyPrefix)}`)}\n`);
  if (isThisMachinesKey) {
    process.stdout.write(`${dim('New key stored in your keychain; the old key is revoked.')}\n`);
    if (process.env.FLOE_AGENT_KEY) {
      process.stdout.write(
        `${warn(`FLOE_AGENT_KEY is set and overrides the keychain — update it to the new key:`)}\n${bold(rotated.key)}\n`,
      );
    }
  } else {
    process.stdout.write(`New key (shown once): ${bold(rotated.key)}\n${dim('The old key is revoked — update whatever was using it.')}\n`);
  }
}
