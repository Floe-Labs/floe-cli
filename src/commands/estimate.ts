import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { bold, dim, kv, printJson, sanitizeText, UsageError } from '../lib/output.js';
import { rawToUsd } from '../lib/usdc.js';
import { anyPlaneContext, anyPlaneJson } from './models.js';

/**
 * `floe estimate` — POST /v1/estimate: price a usage vector against the
 * gateway catalog without any balance or upstream call. The route sits on the
 * bare-/v1 gateway app with no agent guard, so either credential plane works
 * (developer key preferred, agent key fallback — same policy as `floe models`).
 *
 * The response carries BOTH `cost_raw` (atomic 6-dp USDC string — what we
 * format with rawToUsd) and `cost_usdc` (pre-formatted decimal). --json passes
 * the response through verbatim.
 */

interface EstimateResponse {
  model: string;
  rail: string;
  provider: string;
  margin_bps: number;
  /** Unit-class → quantity, echoed back (text_input_token, audio_second, …). */
  usage: Record<string, number>;
  upstream_cost_usdc: string;
  cost_usdc: string;
  cost_raw: string;
}

export interface EstimateFlags {
  model?: string;
  inputTokens?: string;
  outputTokens?: string;
  audioSeconds?: string;
  characters?: string;
  apiUrl?: string;
  json?: boolean;
}

/** Positive-integer flag parse — validation precedes any I/O. */
function parseCount(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--${name} must be a positive integer (got "${raw}").`);
  }
  return n;
}

export async function estimateCommand(flags: EstimateFlags): Promise<void> {
  const model = flags.model?.trim();
  if (!model) {
    throw new UsageError(
      'Usage: floe estimate --model <id> [--input-tokens N --output-tokens N | --audio-seconds N | --characters N]',
    );
  }
  const inputTokens = parseCount('input-tokens', flags.inputTokens);
  const outputTokens = parseCount('output-tokens', flags.outputTokens);
  const audioSeconds = parseCount('audio-seconds', flags.audioSeconds);
  const characters = parseCount('characters', flags.characters);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    audioSeconds === undefined &&
    characters === undefined
  ) {
    throw new UsageError(
      'Nothing to price — pass at least one of --input-tokens/--output-tokens (text), --audio-seconds (stt), --characters (tts).',
    );
  }

  const cx = await anyPlaneContext(flags);
  const est = await anyPlaneJson<EstimateResponse>(cx, 'POST', '/v1/estimate', {
    model,
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(audioSeconds !== undefined ? { audio_seconds: audioSeconds } : {}),
    ...(characters !== undefined ? { characters } : {}),
  });

  if (flags.json) return printJson(est);

  const usage = Object.entries(est.usage ?? {})
    .map(([unit, qty]) => `${sanitizeText(unit)}×${qty}`)
    .join(' · ');
  process.stdout.write(`${bold(`Estimate — ${sanitizeText(est.model)}`)}\n`);
  process.stdout.write(
    `${kv([
      ['Cost', bold(rawToUsd(est.cost_raw))],
      ['Upstream', `$${sanitizeText(est.upstream_cost_usdc)} ${dim(`+ ${est.margin_bps} bps margin`)}`],
      ['Source', `${sanitizeText(est.provider)} ${dim(`(${sanitizeText(est.rail)})`)}`],
      ['Usage', usage || dim('—')],
    ])}\n`,
  );
  process.stdout.write(`${dim('Price quote only — nothing was charged.')}\n`);
}

export const estimateDef: CommandDef = {
  name: 'estimate',
  summary: 'Estimate a call cost without spending',
  usage: `Usage: floe estimate --model <id> [--input-tokens N --output-tokens N]
       floe estimate --model <id> --audio-seconds N
       floe estimate --model <id> --characters N

Price a usage vector against the gateway catalog — no balance touched, no
upstream call made. Works with either the developer key or an agent key.

  --model <id>       Catalog model id (see: floe models)
  --input-tokens N   Text prompt tokens
  --output-tokens N  Text completion tokens
  --audio-seconds N  Audio duration (stt models)
  --characters N     Characters to synthesize (tts models)

Combine text flags freely; pick the flags that match the model's modality.
`,
  options: {
    model: { type: 'string' },
    'input-tokens': { type: 'string' },
    'output-tokens': { type: 'string' },
    'audio-seconds': { type: 'string' },
    characters: { type: 'string' },
  },
  run: async (ctx) => {
    expectArgs(ctx, 0);
    await estimateCommand({
      model: str(ctx, 'model'),
      inputTokens: str(ctx, 'input-tokens'),
      outputTokens: str(ctx, 'output-tokens'),
      audioSeconds: str(ctx, 'audio-seconds'),
      characters: str(ctx, 'characters'),
      apiUrl: ctx.apiUrl,
      json: ctx.json,
    });
  },
};
