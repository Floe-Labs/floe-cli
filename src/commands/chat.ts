import { ApiError, type FloeApi } from '../lib/api.js';
import { expectArgs, flag, str, type CommandDef } from '../lib/command.js';
import { agentContext } from '../lib/context.js';
import { bold, cyan, dim, kv, printJson, sanitizeText, UsageError } from '../lib/output.js';
import type { GatewayModel, ModelsResponse } from '../lib/types.js';
import { rawToUsd } from '../lib/usdc.js';

/**
 * Agent-plane metered calls (chat/embed/speak/transcribe) share three
 * mechanics, all defined here and imported by the sibling commands:
 *  - model resolution: --model wins, else GET /v1/models biased by a
 *    known-cheap preference list (the catalog stays the source of truth);
 *  - metering: every response carries X-Floe-Cost-USDC (raw atomic 6dp) and,
 *    when the billing gate knows it, X-Floe-Budget-Remaining-USDC (already
 *    decimal-formatted — printed as-is with a $);
 *  - stdin plumbing for "-" arguments (pipes).
 */

// Same bias list as `floe test` — whatever the catalog actually lists wins.
const CHAT_PREFERENCE = ['openai/gpt-4o-mini', 'google/gemini-2.5-flash', 'anthropic/claude-haiku-4-5'];

/** Per-call meter read off a gateway response's X-Floe-* headers. */
export interface MeterInfo {
  costRaw: string;
  costUsd: string;
  /** Decimal string straight from the header (e.g. "4.999877"), or null. */
  budgetRemainingUsd: string | null;
}

export function meterOf(res: Response): MeterInfo {
  const costRaw = res.headers.get('X-Floe-Cost-USDC') ?? '0';
  return {
    costRaw,
    costUsd: rawToUsd(costRaw),
    budgetRemainingUsd: res.headers.get('X-Floe-Budget-Remaining-USDC'),
  };
}

/** Human kv rows for a metered call: model, cost, budget remaining. */
export function meterRows(model: string, meter: MeterInfo): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['model', cyan(sanitizeText(model))],
    ['cost', bold(meter.costUsd)],
  ];
  if (meter.budgetRemainingUsd) rows.push(['budget left', `$${meter.budgetRemainingUsd}`]);
  return rows;
}

/** --model wins; otherwise pick from the live catalog with a preference bias. */
export async function resolveGatewayModel(
  api: FloeApi,
  explicit: string | undefined,
  modality: GatewayModel['modality'],
  preference: string[],
): Promise<string> {
  if (explicit) return explicit;
  const models = ((await (await api.agent('GET', '/v1/models')).json()) as ModelsResponse).data;
  if (!Array.isArray(models)) {
    throw new ApiError('Unexpected /v1/models response from the gateway.', 500, 'bad_response');
  }
  const available = models.filter((m) => m.modality === modality);
  if (available.length === 0) {
    throw new ApiError(`No ${modality} models are available on this gateway.`, 404, 'no_models');
  }
  return preference.find((id) => available.some((m) => m.id === id)) ?? available[0]!.id;
}

/** Read piped stdin to a string ("-" arguments). Refuses on a TTY: nothing is piped. */
export async function readStdin(what: string): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw new UsageError(`"-" reads the ${what} from stdin, but nothing is piped in.`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface ChatCompletionBody {
  choices?: Array<{ message?: { content?: string | null } }>;
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

/** Parse the gateway's SSE relay (`data:` lines, `[DONE]` terminator), writing deltas as they arrive. */
async function streamDeltas(res: Response): Promise<void> {
  const body = res.body;
  if (!body) throw new ApiError('The gateway returned an empty stream.', 500, 'bad_response');
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = '';
  let done = false;
  const handleLine = (line: string): void => {
    if (done || !line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    try {
      const chunk = JSON.parse(payload) as StreamChunk;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        process.stdout.write(sanitizeText(delta));
      }
    } catch {
      // Partial or non-JSON keep-alive line — skip it, never abort the stream.
    }
  };
  for (;;) {
    const { done: eof, value } = await reader.read();
    if (eof) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      handleLine(buf.slice(0, idx).trimEnd());
      buf = buf.slice(idx + 1);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) handleLine(buf.trim());
  process.stdout.write('\n');
}

export interface ChatFlags {
  apiUrl?: string;
  json?: boolean;
  model?: string;
  system?: string;
  maxTokens?: string;
  stream?: boolean;
}

export async function chatCommand(promptArg: string, flags: ChatFlags): Promise<void> {
  // Validation precedes I/O.
  if (flags.stream && flags.json) {
    throw new UsageError('--stream and --json cannot combine — the stream is written as it arrives.');
  }
  let maxTokens: number | undefined;
  if (flags.maxTokens !== undefined) {
    maxTokens = Number(flags.maxTokens);
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new UsageError(`Invalid --max-tokens "${flags.maxTokens}" — use a positive integer.`);
    }
  }
  const prompt = (promptArg === '-' ? await readStdin('prompt') : promptArg).trim();
  if (!prompt) throw new UsageError('The prompt is empty.');

  const { api } = await agentContext(flags);
  const model = await resolveGatewayModel(api, flags.model, 'text', CHAT_PREFERENCE);

  const body: Record<string, unknown> = {
    model,
    messages: [
      ...(flags.system !== undefined ? [{ role: 'system', content: flags.system }] : []),
      { role: 'user', content: prompt },
    ],
  };
  if (maxTokens !== undefined) body.max_tokens = maxTokens;

  if (flags.stream) {
    body.stream = true;
    const res = await api.agent('POST', '/v1/chat/completions', body);
    await streamDeltas(res);
    // SSE carries no cost header — the cost is only known at the terminal
    // usage chunk server-side and lands in the ledger.
    process.stdout.write(
      `${dim(`model: ${sanitizeText(model)} — streamed call metered server-side (see \`floe usage\`)`)}\n`,
    );
    return;
  }

  const res = await api.agent('POST', '/v1/chat/completions', body);
  const parsed = (await res.json()) as ChatCompletionBody & Record<string, unknown>;
  const meter = meterOf(res);

  if (flags.json) {
    return printJson({
      model,
      response: parsed,
      costRaw: meter.costRaw,
      costUsd: meter.costUsd,
      budgetRemainingUsd: meter.budgetRemainingUsd,
    });
  }
  const reply = parsed.choices?.[0]?.message?.content ?? '(no content)';
  process.stdout.write(`${sanitizeText(reply)}\n\n`);
  process.stdout.write(`${kv(meterRows(model, meter))}\n`);
}

export const chatDef: CommandDef = {
  name: 'chat',
  summary: 'Send a prompt through the metered gateway',
  usage: `Usage: floe chat "<prompt>" [flags]

Send one prompt through the metered gateway with this machine's agent key and
print the reply plus the per-call cost (X-Floe-Cost-USDC). Use "-" as the
prompt to read it from stdin (pipes).

Flags:
  --model <id>       Model id (default: a cheap chat model from /v1/models)
  --system <text>    System prompt
  --max-tokens <n>   Cap the completion length
  --stream           Stream tokens as they arrive (SSE; cannot combine with
                     --json — a streamed call's cost lands in the ledger)
`,
  options: {
    model: { type: 'string' },
    system: { type: 'string' },
    'max-tokens': { type: 'string' },
    stream: { type: 'boolean' },
  },
  run: async (ctx) => {
    const [prompt] = ctx.args;
    if (!prompt) throw new UsageError('Usage: floe chat "<prompt>" — or `floe chat -` to read stdin.');
    expectArgs(ctx, 1);
    await chatCommand(prompt, {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      model: str(ctx, 'model'),
      system: str(ctx, 'system'),
      maxTokens: str(ctx, 'max-tokens'),
      stream: flag(ctx, 'stream'),
    });
  },
};
