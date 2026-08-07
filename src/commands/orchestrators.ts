import { ApiError } from '../lib/api.js';
import { expectArgs, str, type CommandDef } from '../lib/command.js';
import type { AgentEntry } from '../lib/config.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext, requireActiveAgent, resolveAgentRef, type DevContext } from '../lib/context.js';
import { bold, dim, green, kv, ok, printJson, sanitizeText, UsageError, warn, yellow } from '../lib/output.js';
import { askSecret, isInteractive } from '../lib/prompt.js';
import { table } from '../lib/table.js';

/**
 * `floe orchestrators` — Vapi/Retell/Bland governance.
 *
 * Connect a voice orchestrator so its call costs land on the Floe ledger and
 * budgets/policies govern them. Secret handling per provider:
 *   vapi   — Floe MINTS the shared secret and returns it exactly once; paste
 *            it into your Vapi server/webhook credential.
 *   retell — YOU supply your Retell API key (Retell signs webhooks with it).
 *   bland  — YOU supply your Bland webhook signing secret.
 * Supplied secrets never travel on argv (shell history): hidden prompt when
 * interactive, stdin pipe in scripts. No read API ever returns a secret again.
 */

const PROVIDERS = ['vapi', 'retell', 'bland'] as const;
type Provider = (typeof PROVIDERS)[number];

/** Serialized connection — webhook/pre-call URLs carry the capability token. */
interface OrchestratorConnectionView {
  id: number;
  provider: string;
  agentWallet: string;
  label: string | null;
  active: boolean;
  lastEventAt: string | null;
  webhookUrl: string;
  /** null for bland — it exposes no pre-call hook. */
  preCallUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** connect/rotate response: the connection + the minted secret (vapi only, shown once). */
interface ConnectionMutationResponse extends OrchestratorConnectionView {
  secret?: string;
}

export interface OrchestratorsFlags {
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
  agent?: string;
  provider?: string;
  label?: string;
}

function requireProvider(raw: string | undefined): Provider {
  if (!raw) {
    throw new UsageError(`--provider is required: ${PROVIDERS.join(' | ')}`);
  }
  const provider = raw.trim().toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new UsageError(`Unknown provider "${raw}". Supported: ${PROVIDERS.join(', ')}.`);
  }
  return provider as Provider;
}

function requireConnectionId(raw: string | undefined, verb: string): string {
  if (!raw) {
    throw new UsageError(
      `Usage: floe orchestrators ${verb} <id> — list connection ids with \`floe orchestrators list\`.`,
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(
      `Invalid connection id "${raw}" — ids are numeric (see \`floe orchestrators list\`).`,
    );
  }
  return raw;
}

/** What the builder must paste for providers whose secret Floe cannot mint. */
const SECRET_PROMPTS: Record<Exclude<Provider, 'vapi'>, string> = {
  retell: 'Paste your Retell API key (input hidden): ',
  bland: 'Paste your Bland webhook signing secret (input hidden): ',
};

async function readStdinSecret(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += String(chunk);
  return data.trim();
}

/**
 * Collect a retell/bland provider credential without ever touching argv or
 * shell history: hidden prompt when interactive, stdin pipe otherwise.
 * Length-validated locally (mirror of the API schema: 8–512 chars) so bad
 * pastes fail pre-network.
 */
async function collectProviderSecret(provider: Exclude<Provider, 'vapi'>): Promise<string> {
  const secret = isInteractive()
    ? await askSecret(SECRET_PROMPTS[provider])
    : await readStdinSecret();
  if (!secret) {
    throw new UsageError(
      `No ${provider} secret provided. Interactively you are prompted; in scripts pipe it:\n` +
        `  printf '%s' "$SECRET" | floe orchestrators connect --provider ${provider}`,
    );
  }
  if (secret.length < 8 || secret.length > 512) {
    throw new UsageError('Provider secrets must be 8–512 characters.');
  }
  return secret;
}

/**
 * The agent connect targets: --agent resolves against the fleet by
 * id-then-name; omitted → this machine's active agent straight from config
 * (no network round-trip). Same contract as keys.ts.
 */
async function targetAgent(
  ctx: DevContext,
  ref: string | undefined,
): Promise<{ id: string } & AgentEntry> {
  if (!ref) return requireActiveAgent(ctx.config);
  const agent = await resolveAgentRef(ctx, ref);
  return { ...ctx.config.agents?.[agent.id], id: String(agent.id), name: agent.name };
}

const shortWallet = (w: string): string => (w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w);

/** URL rows for connect/rotate output — what gets pasted into the provider. */
function urlRows(row: OrchestratorConnectionView): Array<[string, string]> {
  const rows: Array<[string, string]> = [['Call-end webhook', sanitizeText(row.webhookUrl)]];
  rows.push([
    'Pre-call URL',
    row.preCallUrl !== null ? sanitizeText(row.preCallUrl) : dim('(bland has no pre-call hook)'),
  ]);
  return rows;
}

/** Floe-minted secrets appear in output exactly once — here. Never swallowed. */
function printMintedSecretOnce(secret: string): void {
  process.stdout.write(
    `${warn('Shared secret (shown once — store it now):')}\n${bold(sanitizeText(secret))}\n` +
      `${dim('Paste it into your Vapi server/webhook credential so deliveries carry it back. No API ever returns it again.')}\n`,
  );
}

export async function orchestratorsListCommand(flags: OrchestratorsFlags): Promise<void> {
  const { api } = await devContext(flags);
  const { connections } = await api.dev<{ connections: OrchestratorConnectionView[] }>(
    'GET',
    '/v1/developer/orchestrators',
  );

  if (flags.json) return printJson({ connections });

  if (connections.length === 0) {
    process.stdout.write(
      `No orchestrator connections. Connect one: ${bold('floe orchestrators connect --provider vapi')}\n`,
    );
    return;
  }

  process.stdout.write(`${bold('Orchestrator connections')}\n`);
  const rows = connections.map((c) => [
    String(c.id),
    sanitizeText(c.provider),
    shortWallet(sanitizeText(c.agentWallet)),
    c.label ? sanitizeText(c.label) : dim('—'),
    c.active ? green('active') : yellow('disabled'),
    c.lastEventAt ? sanitizeText(c.lastEventAt).slice(0, 10) : dim('never'),
  ]);
  process.stdout.write(`${table(['ID', 'PROVIDER', 'AGENT', 'LABEL', 'STATUS', 'LAST EVENT'], rows)}\n`);
  process.stdout.write(
    `${dim('Webhook / pre-call URLs: floe orchestrators list --json (secrets are never shown again).')}\n`,
  );
}

export async function orchestratorsConnectCommand(flags: OrchestratorsFlags): Promise<void> {
  const provider = requireProvider(flags.provider);
  const ctx = await devContext(flags);
  const agent = await targetAgent(ctx, flags.agent);

  // vapi: the API mints the secret; retell/bland: the provider credential is
  // required and is collected off-argv (hidden prompt / stdin).
  const secret = provider === 'vapi' ? undefined : await collectProviderSecret(provider);

  const body: Record<string, unknown> = { agentId: agent.id, provider };
  if (secret !== undefined) body.secret = secret;
  if (flags.label !== undefined) body.label = flags.label;

  let row: ConnectionMutationResponse;
  try {
    row = await ctx.api.dev<ConnectionMutationResponse>('POST', '/v1/developer/orchestrators', body);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'already_connected') {
      throw new ApiError(
        `Agent "${agent.name ?? agent.id}" already has a ${provider} connection. Rotate it instead: \`floe orchestrators rotate <id>\` (ids: \`floe orchestrators list\`).`,
        err.status,
        'already_connected',
      );
    }
    throw err;
  }

  if (flags.json) {
    // The minted secret (vapi) is shown exactly once — here, for the caller that connected.
    return printJson({ connected: true, agentId: agent.id, ...row });
  }

  process.stdout.write(
    `${ok(`Connected agent "${sanitizeText(agent.name ?? agent.id)}" to ${bold(sanitizeText(row.provider))} — connection #${row.id}`)}\n`,
  );
  process.stdout.write(`${kv(urlRows(row))}\n`);
  if (row.secret !== undefined) {
    printMintedSecretOnce(row.secret);
  } else {
    process.stdout.write(
      `${dim('Deliveries are verified with the credential you supplied — it is stored sealed and never shown again.')}\n`,
    );
  }
}

export async function orchestratorsRotateCommand(id: string, flags: OrchestratorsFlags): Promise<void> {
  const ctx = await devContext(flags);
  const { connections } = await ctx.api.dev<{ connections: OrchestratorConnectionView[] }>(
    'GET',
    '/v1/developer/orchestrators',
  );
  const existing = connections.find((c) => String(c.id) === id);
  if (!existing) {
    throw new UsageError(
      `No orchestrator connection with id ${id}. Known ids: ${connections.map((c) => c.id).join(', ') || '(none)'}`,
    );
  }

  // Rotating retell/bland re-keys verification, so the NEW provider credential
  // is required — collected off-argv, like connect. vapi mints its own.
  const provider = existing.provider === 'retell' || existing.provider === 'bland'
    ? existing.provider
    : 'vapi';
  const secret = provider === 'vapi' ? undefined : await collectProviderSecret(provider);

  const row = await ctx.api.dev<ConnectionMutationResponse>(
    'POST',
    `/v1/developer/orchestrators/${id}/rotate`,
    secret !== undefined ? { secret } : {},
  );

  if (flags.json) {
    // The minted secret (vapi) is shown exactly once — here, for the caller that rotated.
    return printJson({ rotated: true, ...row });
  }

  process.stdout.write(`${ok(`Rotated ${sanitizeText(row.provider)} connection #${row.id}`)}\n`);
  process.stdout.write(
    `${warn('The old webhook URLs (and old secret) stopped working — update the provider config now:')}\n`,
  );
  process.stdout.write(`${kv(urlRows(row))}\n`);
  if (row.secret !== undefined) printMintedSecretOnce(row.secret);
}

export async function orchestratorsToggleCommand(
  id: string,
  active: boolean,
  flags: OrchestratorsFlags,
): Promise<void> {
  const { api } = await devContext(flags);
  const result = await api.dev<{ ok: boolean; active: boolean }>(
    'PATCH',
    `/v1/developer/orchestrators/${id}`,
    { active },
  );
  if (flags.json) return printJson({ id: Number(id), active: result.active });
  process.stdout.write(
    `${ok(`Connection #${id} ${result.active ? green('enabled') : yellow('disabled')}`)}\n`,
  );
  if (!result.active) {
    process.stdout.write(
      `${dim('Its webhooks are refused until re-enabled — history and the ledger survive.')}\n`,
    );
  }
}

export async function orchestratorsRemoveCommand(id: string, flags: OrchestratorsFlags): Promise<void> {
  const { api } = await devContext(flags);
  await confirmAction(`remove orchestrator connection ${id}`, id, { yes: flags.yes });
  await api.dev<{ ok: boolean }>('DELETE', `/v1/developer/orchestrators/${id}`);
  if (flags.json) return printJson({ removed: true, id: Number(id) });
  process.stdout.write(
    `${ok(`Orchestrator connection ${id} removed.`)}\n` +
      `${dim('Reconciled ledger history survives; the webhook URLs stop working immediately.')}\n`,
  );
}

export const orchestratorsDef: CommandDef = {
  name: 'orchestrators',
  summary: 'connect | list | rotate | enable | disable | remove — Vapi/Retell/Bland',
  usage: `Usage: floe orchestrators [list]
       floe orchestrators connect --provider <vapi|retell|bland>
                                  [--agent <name|id>] [--label <text>]
       floe orchestrators rotate <id>
       floe orchestrators enable <id>
       floe orchestrators disable <id>
       floe orchestrators remove <id> [--yes]

Connect voice orchestrators (Vapi / Retell / Bland) so their call costs land
on the Floe ledger and budgets/policies govern them. Default agent: the one
this machine uses.

  list          The account's connections; full webhook URLs via --json
  connect       Create a connection for an agent. Secrets, per provider:
                  vapi    Floe mints the shared secret — shown ONCE; paste it
                          into your Vapi server/webhook credential
                  retell  you supply your Retell API key (hidden prompt; in
                          scripts pipe it on stdin — NEVER as an argument)
                  bland   you supply your Bland webhook signing secret (same)
  rotate <id>   Mint a new webhook token (+ secret). The old URLs and secret
                stop working immediately; retell/bland prompt for the new
                provider credential
  enable <id>   Resume ingesting the connection's webhooks
  disable <id>  Pause it without deleting (ledger history survives)
  remove <id>   Delete the connection — asks for confirmation (--yes in scripts)
`,
  options: {
    agent: { type: 'string' },
    provider: { type: 'string' },
    label: { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand, arg] = ctx.args;
    const flags: OrchestratorsFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      yes: ctx.yes,
      agent: str(ctx, 'agent'),
      provider: str(ctx, 'provider'),
      label: str(ctx, 'label'),
    };
    if (subcommand === 'connect') {
      expectArgs(ctx, 1);
      await orchestratorsConnectCommand(flags);
    } else if (subcommand === 'rotate') {
      expectArgs(ctx, 2);
      await orchestratorsRotateCommand(requireConnectionId(arg, 'rotate'), flags);
    } else if (subcommand === 'enable' || subcommand === 'disable') {
      expectArgs(ctx, 2);
      await orchestratorsToggleCommand(requireConnectionId(arg, subcommand), subcommand === 'enable', flags);
    } else if (subcommand === 'remove') {
      expectArgs(ctx, 2);
      await orchestratorsRemoveCommand(requireConnectionId(arg, 'remove'), flags);
    } else if (subcommand === undefined || subcommand === 'list') {
      expectArgs(ctx, 1);
      await orchestratorsListCommand(flags);
    } else {
      throw new UsageError(
        `Unknown orchestrators subcommand "${subcommand}". Use: list, connect, rotate <id>, enable <id>, disable <id>, remove <id>.`,
      );
    }
  },
};
