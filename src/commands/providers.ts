import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext } from '../lib/context.js';
import { bold, dim, green, kv, ok, printJson, sanitizeText, UsageError, yellow } from '../lib/output.js';
import { askSecret, isInteractive } from '../lib/prompt.js';
import { table } from '../lib/table.js';

/**
 * `floe providers` — stored BYOK vendor keys (/v1/developer/provider-keys).
 * With a key stored, gateway calls route byok: inference is paid by YOUR
 * vendor account and Floe bills only a service fee.
 *
 * The API never returns stored key material — every read is the masked
 * projection (provider, keyPrefix "abcd...", label, enabled, timestamps) —
 * and this command never accepts a key on argv: interactive runs prompt with
 * hidden input, scripts pipe the key on stdin.
 */

/** Masked row — the only shape any provider-keys read returns. */
interface ProviderKeyRow {
  provider: string;
  keyPrefix: string;
  label: string | null;
  enabled: boolean;
  createdBy: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProviderKeysListResponse {
  providerKeys: ProviderKeyRow[];
  supportedProviders: string[];
}

export interface ProvidersFlags {
  label?: string;
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
}

/** Client-side mirror of the API's :provider slug shape — fail before I/O. */
function normalizeProvider(raw: string): string {
  const provider = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider)) {
    throw new UsageError(`"${raw}" is not a valid provider id (see \`floe providers list\` for supported providers).`);
  }
  return provider;
}

async function readStdinKey(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += String(chunk);
  return data.trim();
}

/**
 * Collect the key without ever touching argv or shell history: hidden prompt
 * when interactive, stdin pipe otherwise. Shape-validated locally (mirror of
 * the API schema: 8–512 chars, no whitespace) so bad pastes fail pre-network.
 */
async function collectKey(provider: string): Promise<string> {
  const key = isInteractive()
    ? await askSecret(`Paste the ${provider} API key (input hidden): `)
    : await readStdinKey();
  if (!key) {
    throw new UsageError(
      `No key provided. Interactively you are prompted; in scripts pipe it:\n  printf '%s' "$KEY" | floe providers set ${provider}`,
    );
  }
  if (key.length < 8 || key.length > 512 || !/^\S+$/.test(key)) {
    throw new UsageError('Provider keys must be 8–512 characters with no whitespace.');
  }
  return key;
}

export async function providersListCommand(flags: ProvidersFlags): Promise<void> {
  const { api } = await devContext(flags);
  const result = await api.dev<ProviderKeysListResponse>('GET', '/v1/developer/provider-keys');

  if (flags.json) return printJson(result);

  if (result.providerKeys.length === 0) {
    process.stdout.write(
      `No stored provider keys. Add one: ${bold('floe providers set <provider>')}\n`,
    );
  } else {
    const rows = result.providerKeys.map((k) => [
      sanitizeText(k.provider),
      sanitizeText(k.keyPrefix),
      k.label ? sanitizeText(k.label) : dim('—'),
      k.enabled ? green('enabled') : yellow('disabled'),
      k.lastUsedAt ? k.lastUsedAt.slice(0, 10) : dim('never'),
    ]);
    process.stdout.write(`${bold(`Stored provider keys (BYOK)`)}\n`);
    process.stdout.write(`${table(['PROVIDER', 'KEY', 'LABEL', 'STATUS', 'LAST USED'], rows)}\n`);
  }
  process.stdout.write(
    `${dim(`Supported providers: ${result.supportedProviders.map((p) => sanitizeText(p)).join(', ')}`)}\n`,
  );
}

export async function providersSetCommand(providerArg: string, flags: ProvidersFlags): Promise<void> {
  const provider = normalizeProvider(providerArg);
  const { api } = await devContext(flags);
  const key = await collectKey(provider);

  const row = await api.dev<ProviderKeyRow>('PUT', `/v1/developer/provider-keys/${provider}`, {
    key,
    ...(flags.label ? { label: flags.label } : {}),
  });

  if (flags.json) return printJson(row);
  process.stdout.write(
    `${ok(`Stored ${bold(sanitizeText(row.provider))} key ${sanitizeText(row.keyPrefix)}${row.label ? ` (${sanitizeText(row.label)})` : ''}`)}\n`,
  );
  process.stdout.write(
    `${dim('Gateway calls for this vendor now route through your key (byok); Floe bills only the service fee.')}\n`,
  );
}

export async function providersToggleCommand(
  providerArg: string,
  enabled: boolean,
  flags: ProvidersFlags,
): Promise<void> {
  const provider = normalizeProvider(providerArg);
  const { api } = await devContext(flags);
  const result = await api.dev<{ provider: string; enabled: boolean }>(
    'PATCH',
    `/v1/developer/provider-keys/${provider}`,
    { enabled },
  );
  if (flags.json) return printJson(result);
  process.stdout.write(
    `${ok(`${bold(sanitizeText(result.provider))} key ${result.enabled ? green('enabled') : yellow('disabled')}`)}\n`,
  );
  if (!result.enabled) {
    process.stdout.write(`${dim('Calls fall back to the keyless rails until re-enabled.')}\n`);
  }
}

export async function providersRemoveCommand(providerArg: string, flags: ProvidersFlags): Promise<void> {
  const provider = normalizeProvider(providerArg);
  const { api } = await devContext(flags);
  await confirmAction(`remove the stored ${provider} provider key`, provider, { yes: flags.yes });
  await api.dev<{ message: string }>('DELETE', `/v1/developer/provider-keys/${provider}`);
  if (flags.json) return printJson({ provider, removed: true });
  process.stdout.write(
    `${ok(`Removed the ${bold(provider)} key`)}\n${kv([
      ['Effect', 'calls for this vendor use the keyless rails again'],
    ])}\n`,
  );
}

export const providersDef: CommandDef = {
  name: 'providers',
  summary: 'list | set | enable | disable | remove — BYOK provider keys',
  usage: `Usage: floe providers [list]
       floe providers set <provider> [--label <text>]
       floe providers enable <provider>
       floe providers disable <provider>
       floe providers remove <provider>

Bring-your-own-key (BYOK) vendor keys for the inference gateway. With a key
stored, gateway calls for that vendor are paid by YOUR vendor account; Floe
bills only a service fee. Stored key material is never shown again.

  list                Stored keys (masked) + the supported provider ids
  set <provider>      Save or replace the key. Prompted with hidden input;
                      in scripts pipe it on stdin — NEVER pass keys as
                      arguments:  printf '%s' "$KEY" | floe providers set openai
  enable <provider>   Re-enable a disabled key
  disable <provider>  Stop using the key without deleting it
  remove <provider>   Delete the stored key (asks for confirmation; --yes in scripts)
`,
  options: {
    label: { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand, provider] = ctx.args;
    const flags: ProvidersFlags = {
      label: str(ctx, 'label'),
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      yes: ctx.yes,
    };
    const requireProvider = (): string => {
      if (!provider) {
        throw new UsageError(`Usage: floe providers ${subcommand} <provider> — see \`floe providers list\`.`);
      }
      return provider;
    };
    if (subcommand === 'set') {
      expectArgs(ctx, 2);
      await providersSetCommand(requireProvider(), flags);
    } else if (subcommand === 'enable' || subcommand === 'disable') {
      expectArgs(ctx, 2);
      await providersToggleCommand(requireProvider(), subcommand === 'enable', flags);
    } else if (subcommand === 'remove') {
      expectArgs(ctx, 2);
      await providersRemoveCommand(requireProvider(), flags);
    } else if (subcommand === undefined || subcommand === 'list') {
      expectArgs(ctx, 1);
      await providersListCommand(flags);
    } else {
      throw new UsageError(
        `Unknown providers subcommand "${subcommand}". Use: list, set <provider>, enable <provider>, disable <provider>, remove <provider>.`,
      );
    }
  },
};
