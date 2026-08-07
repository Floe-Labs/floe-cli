import { ApiError, FloeApi } from '../lib/api.js';
import { expectArgs, flag, str, type CommandDef } from '../lib/command.js';
import { readConfig, resolveApiUrl } from '../lib/config.js';
import { devContext } from '../lib/context.js';
import { resolveAgentKey, resolveDevKey } from '../lib/keychain.js';
import { bold, dim, printJson, sanitizeText, UsageError } from '../lib/output.js';
import { table } from '../lib/table.js';
import type { GatewayModel, ModelsResponse } from '../lib/types.js';

/**
 * `floe models` — the keyless gateway catalog.
 *
 * GET /v1/models is a gateway route that accepts ANY authed credential (its
 * handler has no agent guard — the shared /v1/* auth middleware resolves both
 * key kinds), so this command prefers the developer key and falls back to the
 * agent key. `--pricing` swaps to the developer-only rate-card route
 * GET /v1/developer/gateway/models.
 */

const MODALITIES = ['text', 'embedding', 'tts', 'stt', 'realtime'] as const;

export interface GatewayCliContext {
  api: FloeApi;
  plane: 'developer' | 'agent';
}

/**
 * Credential resolution for gateway routes that take either plane: prefer the
 * developer key, else the active agent's key. Shared with `floe estimate`.
 */
export async function anyPlaneContext(flags: { apiUrl?: string }): Promise<GatewayCliContext> {
  const config = readConfig();
  const apiUrl = resolveApiUrl(flags.apiUrl, config);
  const devKey = await resolveDevKey(apiUrl);
  if (devKey) return { api: new FloeApi(apiUrl, devKey), plane: 'developer' };
  const agentKey = await resolveAgentKey(apiUrl, config.activeAgentId, config);
  if (agentKey) return { api: new FloeApi(apiUrl, undefined, agentKey), plane: 'agent' };
  throw new ApiError(
    'Not signed in. Run `floe init` first (or set FLOE_API_KEY / FLOE_AGENT_KEY).',
    401,
    'missing_credential',
  );
}

/** Route a JSON request through whichever plane anyPlaneContext resolved. */
export async function anyPlaneJson<T>(
  cx: GatewayCliContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (cx.plane === 'developer') return cx.api.dev<T>(method, path, body);
  const res = await cx.api.agent(method, path, body);
  return (await res.json()) as T;
}

/** GET /v1/developer/gateway/models response — rates are USD per 1M units. */
interface PricedSource {
  rail: string;
  provider: string;
  marginBps: number;
  rates: Record<string, number>;
}

interface PricedModel {
  id: string;
  displayName: string | null;
  modality: string;
  contextWindow: number | null;
  isOpenWeight: boolean;
  sources: PricedSource[];
}

const UNIT_LABELS: Record<string, string> = {
  text_input_token: 'in',
  text_output_token: 'out',
  cached_input_token: 'cached',
  character: 'chars',
  audio_second: 'audio-sec',
  audio_input_token: 'audio-in',
  audio_output_token: 'audio-out',
};

/** USD per 1M units → "$0.15/M". Display-only (the API sends these as numbers). */
function fmtRate(perMillion: number): string {
  const s = perMillion >= 0.01 ? perMillion.toFixed(2) : perMillion.toPrecision(2);
  const trimmed = s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  return `$${trimmed || '0'}/M`;
}

function contextCell(contextWindow: number | null): string {
  if (contextWindow === null || contextWindow === undefined) return dim('—');
  return contextWindow >= 1_000 ? `${Math.round(contextWindow / 1_000)}k` : String(contextWindow);
}

function pricesCell(sources: PricedSource[]): string {
  const first = sources[0];
  if (!first) return dim('unpriced');
  const parts = Object.entries(first.rates).map(
    ([unit, rate]) => `${sanitizeText(UNIT_LABELS[unit] ?? unit)} ${fmtRate(rate)}`,
  );
  const more = sources.length > 1 ? ` ${dim(`+${sources.length - 1} more`)}` : '';
  return `${parts.join(' · ')} ${dim(`(${sanitizeText(first.provider)})`)}${more}`;
}

export interface ModelsFlags {
  modality?: string;
  pricing?: boolean;
  apiUrl?: string;
  json?: boolean;
}

export async function modelsCommand(flags: ModelsFlags): Promise<void> {
  const modality = flags.modality;
  if (modality !== undefined && !(MODALITIES as readonly string[]).includes(modality)) {
    throw new UsageError(`Unknown modality "${modality}". Supported: ${MODALITIES.join(', ')}.`);
  }

  if (flags.pricing) {
    // Rate cards live on the developer plane only.
    const { api } = await devContext(flags);
    const { models } = await api.dev<{ models: PricedModel[] }>(
      'GET',
      '/v1/developer/gateway/models',
    );
    const filtered = modality ? models.filter((m) => m.modality === modality) : models;
    if (flags.json) return printJson({ models: filtered });

    if (filtered.length === 0) {
      process.stdout.write(`No models${modality ? ` with modality "${modality}"` : ''}.\n`);
      return;
    }
    const rows = filtered.map((m) => [
      sanitizeText(m.id),
      sanitizeText(m.modality),
      contextCell(m.contextWindow),
      pricesCell(m.sources),
    ]);
    process.stdout.write(`${bold(`Gateway models (${filtered.length}) — prices per 1M units`)}\n`);
    process.stdout.write(`${table(['MODEL', 'MODALITY', 'CONTEXT', 'PRICES'], rows)}\n`);
    process.stdout.write(
      `${dim('Quote a call: floe estimate --model <id> --input-tokens N --output-tokens N')}\n`,
    );
    return;
  }

  const cx = await anyPlaneContext(flags);
  const list = await anyPlaneJson<ModelsResponse>(cx, 'GET', '/v1/models');
  const data: GatewayModel[] = modality
    ? list.data.filter((m) => m.modality === modality)
    : list.data;
  if (flags.json) return printJson({ object: list.object, data });

  if (data.length === 0) {
    process.stdout.write(`No models${modality ? ` with modality "${modality}"` : ''}.\n`);
    return;
  }
  const rows = data.map((m) => [
    sanitizeText(m.id),
    sanitizeText(m.modality),
    contextCell(m.context_window),
  ]);
  process.stdout.write(`${bold(`Gateway models (${data.length})`)}\n`);
  process.stdout.write(`${table(['MODEL', 'MODALITY', 'CONTEXT'], rows)}\n`);
  process.stdout.write(
    `${dim('Rate cards: floe models --pricing · quote a call: floe estimate --model <id> …')}\n`,
  );
}

export const modelsDef: CommandDef = {
  name: 'models',
  summary: 'Model catalog with modalities and pricing',
  usage: `Usage: floe models [--modality text|embedding|tts|stt|realtime] [--pricing]

List the keyless gateway's model catalog.
  --modality <m>  Only models of one modality (text, embedding, tts, stt, realtime)
  --pricing       Include per-source rate cards (USD per 1M units; developer key
                  required — the plain listing works with either key)

Model ids are provider/model, e.g. openai/gpt-4o-mini. Use them with
floe estimate or any OpenAI SDK pointed at the Floe gateway.
`,
  options: {
    modality: { type: 'string' },
    pricing: { type: 'boolean' },
  },
  run: async (ctx) => {
    expectArgs(ctx, 0);
    await modelsCommand({
      modality: str(ctx, 'modality'),
      pricing: flag(ctx, 'pricing'),
      apiUrl: ctx.apiUrl,
      json: ctx.json,
    });
  },
};
