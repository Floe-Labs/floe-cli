import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { agentContext } from '../lib/context.js';
import { kv, printJson, UsageError } from '../lib/output.js';
import { meterOf, meterRows, resolveGatewayModel } from './chat.js';

const EMBED_PREFERENCE = ['openai/text-embedding-3-small'];

/** How many leading vector values the human view shows before eliding. */
const PREVIEW_VALUES = 4;

interface EmbeddingsBody {
  data?: Array<{ embedding?: number[] }>;
}

export interface EmbedFlags {
  apiUrl?: string;
  json?: boolean;
  model?: string;
}

export async function embedCommand(text: string, flags: EmbedFlags): Promise<void> {
  const { api } = await agentContext(flags);
  const model = await resolveGatewayModel(api, flags.model, 'embedding', EMBED_PREFERENCE);

  const res = await api.agent('POST', '/v1/embeddings', { model, input: text });
  const parsed = (await res.json()) as EmbeddingsBody & Record<string, unknown>;
  const meter = meterOf(res);

  if (flags.json) {
    // The vector passes through untouched — agents consume it directly.
    return printJson({
      model,
      response: parsed,
      costRaw: meter.costRaw,
      costUsd: meter.costUsd,
      budgetRemainingUsd: meter.budgetRemainingUsd,
    });
  }

  const vector = parsed.data?.[0]?.embedding ?? [];
  const preview = vector
    .slice(0, PREVIEW_VALUES)
    .map((v) => (typeof v === 'number' ? v.toFixed(6) : String(v)))
    .join(', ');
  const elision = vector.length > PREVIEW_VALUES ? ', …' : '';
  const rows: Array<[string, string]> = [
    ...meterRows(model, meter),
    ['dimensions', String(vector.length)],
    ['vector', `[${preview}${elision}]`],
  ];
  process.stdout.write(`${kv(rows)}\n`);
}

export const embedDef: CommandDef = {
  name: 'embed',
  summary: 'Create embeddings through the metered gateway',
  usage: `Usage: floe embed "<text>" [flags]

Embed one text through the metered gateway with this machine's agent key and
print the model, dimensions, and per-call cost. Human output elides the
vector; --json passes it through in full.

Flags:
  --model <id>   Embedding model id (default: a cheap embedding model
                 from /v1/models)
`,
  options: {
    model: { type: 'string' },
  },
  run: async (ctx) => {
    const [text] = ctx.args;
    if (!text) throw new UsageError('Usage: floe embed "<text>" [--model <id>]');
    expectArgs(ctx, 1);
    await embedCommand(text, {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      model: str(ctx, 'model'),
    });
  },
};
