import { spawn } from 'node:child_process';
import { ApiError, FloeApi } from '../lib/api.js';
import { expectArgs, flag, str, type CommandDef } from '../lib/command.js';
import { DASHBOARD_URL, readConfig, resolveApiUrl, withActiveAgent, writeConfig } from '../lib/config.js';
import {
  agentKeyAccount,
  devKeyAccount,
  getSecret,
  legacyAgentKeyAccount,
  resolveDevKey,
  setSecret,
} from '../lib/keychain.js';
import { bold, dim, kv, ok, printJson, UsageError, warn } from '../lib/output.js';
import { ask, askSecret, isInteractive } from '../lib/prompt.js';
import { renderSnippets } from '../lib/snippets.js';
import type {
  CreateAgentResponse,
  MintKeyResponse,
  ProfileResponse,
  SerializedAgent,
} from '../lib/types.js';

export interface InitFlags {
  key?: string;
  agent?: string;
  name?: string;
  newKey?: boolean;
  open?: boolean;
  apiUrl?: string;
  json?: boolean;
}

// Agent creation requires delegation terms even in wallet funding mode; these
// are the dashboard-equivalent defaults (10% max rate, 1-year expiry).
const DEFAULT_MAX_RATE_BPS = 1000;
const DEFAULT_EXPIRY_SECONDS = 31_536_000;
const DEFAULT_AGENT_NAME = 'my-agent';

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
  child.on('error', () => {
    // Best-effort — headless boxes without a browser opener just get the URL in text.
  });
  child.unref();
}

async function obtainDevKey(apiUrl: string, flags: InitFlags): Promise<{ key: string; fresh: boolean }> {
  if (flags.key) return { key: flags.key, fresh: true };
  const existing = await resolveDevKey(apiUrl);
  if (existing) return { key: existing, fresh: false };
  if (!isInteractive()) {
    throw new ApiError(
      'No developer key. Pass --key <floe_live_…>, set FLOE_API_KEY, or run interactively.',
      401,
      'missing_credential',
    );
  }
  process.stdout.write(`Mint a developer key (floe_live_…) in the dashboard: ${DASHBOARD_URL}\n`);
  const key = await askSecret('Paste your developer key: ');
  if (!key) throw new UsageError('No key entered.');
  return { key, fresh: true };
}

function validateDevKeyShape(key: string): void {
  if (key.startsWith('floe_') && !key.startsWith('floe_live_')) {
    throw new UsageError(
      'That looks like an AGENT key (floe_…). init needs your DEVELOPER key (floe_live_…) from the dashboard — the agent key gets minted for you in a moment.',
    );
  }
}

async function pickAgent(
  api: FloeApi,
  agents: SerializedAgent[],
  flags: InitFlags,
  configuredAgentId: string | undefined,
): Promise<{ agent: SerializedAgent; welcomeCreditTxHash?: string }> {
  const active = agents.filter((a) => a.status === 'active');

  if (flags.agent) {
    const match = active.find((a) => a.name === flags.agent);
    if (!match) {
      throw new UsageError(
        `No active agent named "${flags.agent}". Existing: ${active.map((a) => a.name).join(', ') || '(none)'}`,
      );
    }
    return { agent: match };
  }

  // A re-run without --agent must never switch this machine to a different
  // agent — the configured one wins as long as it's still active.
  const configured = active.find((a) => String(a.id) === String(configuredAgentId));
  if (configured) return { agent: configured };

  if (active.length === 1 && active[0]) return { agent: active[0] };

  if (active.length > 1) {
    if (!isInteractive()) {
      throw new UsageError(
        'Multiple active agents are available. Pass --agent <name> in non-interactive mode.',
      );
    }
    process.stdout.write('Which agent should this machine use?\n');
    active.forEach((a, i) => process.stdout.write(`  ${i + 1}. ${a.name} ${dim(String(a.id))}\n`));
    const answer = await ask(`Agent [1-${active.length}] (default 1): `);
    const index = answer === '' ? 0 : Number.parseInt(answer, 10) - 1;
    const chosen = active[index];
    if (!chosen) throw new UsageError(`Invalid selection "${answer}".`);
    return { agent: chosen };
  }

  // No active agent — create one (this is where the welcome credit lands).
  let name = flags.name;
  if (!name) {
    name = isInteractive()
      ? (await ask(`Agent name (default "${DEFAULT_AGENT_NAME}"): `)) || DEFAULT_AGENT_NAME
      : DEFAULT_AGENT_NAME;
  }
  const created = await api.dev<CreateAgentResponse>('POST', '/v1/developer/agents', {
    name,
    maxRateBps: DEFAULT_MAX_RATE_BPS,
    expirySeconds: DEFAULT_EXPIRY_SECONDS,
  });
  const refreshed = await api.dev<{ agents: SerializedAgent[] }>('GET', '/v1/developer/agents');
  const agent = refreshed.agents.find((a) => String(a.id) === String(created.agentId));
  if (!agent) throw new ApiError('Agent was created but could not be read back.', 500);
  return { agent, welcomeCreditTxHash: created.welcomeCreditTxHash };
}

export async function initCommand(flags: InitFlags): Promise<void> {
  const config = readConfig();
  const apiUrl = resolveApiUrl(flags.apiUrl, config);

  if (flags.open) openInBrowser(DASHBOARD_URL);
  const { key: devKey, fresh } = await obtainDevKey(apiUrl, flags);
  validateDevKeyShape(devKey);

  let api = new FloeApi(apiUrl, devKey);
  const profile = await api.dev<ProfileResponse>('GET', '/v1/developer/profile');
  if (fresh && !process.env.FLOE_API_KEY) await setSecret(devKeyAccount(apiUrl), devKey);

  const { agent, welcomeCreditTxHash } = await pickAgent(api, profile.agents, flags, config.activeAgentId);

  // Reuse the stored agent key when this agent already has one — each agent
  // has a 5-key cap, so init must be re-runnable without burning a slot.
  const entry = config.agents?.[agent.id];
  let agentKey: string | undefined;
  let keyId = entry?.keyId;
  let keyPrefix = entry?.keyPrefix;
  let mintedNewKey = false;
  if (!flags.newKey) {
    // Check the STORED slots directly, not resolveAgentKey — FLOE_AGENT_KEY
    // would mask an empty slot, leave the config keyless, and pair this agent
    // with whatever key the env var happens to hold.
    agentKey =
      (await getSecret(agentKeyAccount(apiUrl, agent.id))) ??
      (config.legacySlotAgentId !== undefined &&
      String(config.legacySlotAgentId) === String(agent.id)
        ? await getSecret(legacyAgentKeyAccount(apiUrl))
        : undefined);
  }
  if (!agentKey) {
    let minted: MintKeyResponse;
    try {
      minted = await api.dev<MintKeyResponse>('POST', `/v1/developer/agents/${agent.id}/keys`, {
        label: 'floe-cli',
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'limit_exceeded') {
        throw new ApiError(
          `Agent "${agent.name}" already has the maximum number of API keys. Run \`floe keys rotate\` to replace one, or revoke unused keys in the dashboard.`,
          409,
          'limit_exceeded',
        );
      }
      throw err;
    }
    agentKey = minted.key;
    keyId = minted.id;
    keyPrefix = minted.keyPrefix;
    mintedNewKey = true;
    // Always persist the freshest key — env vars win at read time anyway.
    await setSecret(agentKeyAccount(apiUrl, agent.id), agentKey);
  }

  writeConfig(
    withActiveAgent({ ...config, apiUrl }, agent.id, {
      name: agent.name,
      wallet: agent.agentWalletAddress,
      keyId,
      keyPrefix,
    }),
  );

  if (flags.json) {
    printJson({
      apiUrl,
      developer: profile.developer.walletAddress,
      agentId: agent.id,
      agentName: agent.name,
      keyId,
      keyPrefix,
      mintedNewKey,
      // Shown once at mint time by design; --json callers get it here or never.
      agentKey: mintedNewKey ? agentKey : undefined,
      welcomeCreditTxHash,
      baseUrl: `${apiUrl}/v1`,
    });
    return;
  }

  const who = profile.developer.displayName || profile.developer.email || profile.developer.walletAddress;
  process.stdout.write(`${ok(`Signed in as ${bold(who)}`)}\n`);
  process.stdout.write(
    kv([
      ['Agent', `${agent.name} ${dim(String(agent.id))}`],
      ['Agent key', mintedNewKey ? `${keyPrefix ?? ''} ${dim('(new — stored in your keychain)')}` : `${keyPrefix ?? ''} ${dim('(reused)')}`],
      ['Gateway', `${apiUrl}/v1`],
    ]) + '\n',
  );
  if (welcomeCreditTxHash) {
    process.stdout.write(`${ok('Welcome credit deposited — your first calls are on Floe.')}\n`);
  }
  if (process.env.FLOE_AGENT_KEY) {
    process.stdout.write(`${warn('FLOE_AGENT_KEY is set and overrides the resolved agent key for CLI commands.')}\n`);
  }
  if (!mintedNewKey && !agentKey?.startsWith('floe_')) {
    process.stdout.write(`${warn('Stored agent key looks unusual — rerun with --new-key if calls fail.')}\n`);
  }
  process.stdout.write(renderSnippets(apiUrl, agentKey));
}

export const initDef: CommandDef = {
  name: 'init',
  summary: 'Authenticate, set up an agent + key, print the base-URL swap',
  usage: `Usage: floe init [flags]

Authenticate with your developer key (floe_live_…), create or select an agent,
mint its runtime key into the OS keychain, and print the base-URL swap snippet.
Re-runs are safe: the configured agent and stored key are reused.

Flags:
  --key <floe_live_…>   Developer key (skips the prompt)
  --agent <name>        Select an existing active agent by name
  --name <name>         Name for a newly created agent (default "my-agent")
  --new-key             Mint a fresh agent key instead of reusing the stored one
  --open                Open the dashboard in your browser
`,
  options: {
    key: { type: 'string' },
    agent: { type: 'string' },
    name: { type: 'string' },
    'new-key': { type: 'boolean' },
    open: { type: 'boolean' },
  },
  run: async (ctx) => {
    expectArgs(ctx, 0);
    await initCommand({
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      key: str(ctx, 'key'),
      agent: str(ctx, 'agent'),
      name: str(ctx, 'name'),
      newKey: flag(ctx, 'new-key'),
      open: flag(ctx, 'open'),
    });
  },
};
