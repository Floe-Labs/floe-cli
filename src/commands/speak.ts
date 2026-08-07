import { writeFileSync } from 'node:fs';
import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { agentContext } from '../lib/context.js';
import { bold, kv, ok, printJson, UsageError } from '../lib/output.js';
import { meterOf, meterRows, resolveGatewayModel } from './chat.js';

const TTS_PREFERENCE = ['openai/tts-1'];
const DEFAULT_VOICE = 'alloy';

export interface SpeakFlags {
  apiUrl?: string;
  json?: boolean;
  model?: string;
  voice?: string;
  out?: string;
}

export async function speakCommand(text: string, flags: SpeakFlags): Promise<void> {
  // Validation precedes I/O.
  const out = flags.out;
  if (!out) {
    throw new UsageError('--out <file> is required — audio is binary and never printed to the terminal.');
  }
  if (out === '-') {
    if (process.stdout.isTTY === true) {
      throw new UsageError('Refusing to write binary audio to a terminal — pipe stdout or use --out <file>.');
    }
    if (flags.json) {
      throw new UsageError('--out - streams the audio to stdout and cannot combine with --json.');
    }
  }

  const { api } = await agentContext(flags);
  const model = await resolveGatewayModel(api, flags.model, 'tts', TTS_PREFERENCE);

  const res = await api.agent('POST', '/v1/audio/speech', {
    model,
    input: text,
    voice: flags.voice ?? DEFAULT_VOICE,
  });
  const audio = Buffer.from(await res.arrayBuffer());
  const meter = meterOf(res);

  if (out === '-') {
    process.stdout.write(audio);
    process.stderr.write(`${audio.byteLength} bytes · cost ${meter.costUsd}\n`);
    return;
  }
  writeFileSync(out, audio);

  if (flags.json) {
    return printJson({
      out,
      bytes: audio.byteLength,
      model,
      costRaw: meter.costRaw,
      costUsd: meter.costUsd,
      budgetRemainingUsd: meter.budgetRemainingUsd,
    });
  }
  process.stdout.write(`${ok(`Wrote ${bold(String(audio.byteLength))} bytes to ${bold(out)}`)}\n`);
  process.stdout.write(`${kv(meterRows(model, meter))}\n`);
}

export const speakDef: CommandDef = {
  name: 'speak',
  summary: 'Text-to-speech through the metered gateway (writes a file)',
  usage: `Usage: floe speak "<text>" --out <file> [flags]

Synthesize speech through the metered gateway with this machine's agent key,
write the audio to --out, and print the bytes written plus the per-call cost.
--out - streams the audio to stdout (refused on a terminal).

Flags:
  --out <file>     Output file for the audio (required; "-" for stdout)
  --model <id>     TTS model id (default: a TTS model from /v1/models)
  --voice <name>   Voice name (default "${DEFAULT_VOICE}")
`,
  options: {
    out: { type: 'string' },
    model: { type: 'string' },
    voice: { type: 'string' },
  },
  run: async (ctx) => {
    const [text] = ctx.args;
    if (!text) throw new UsageError('Usage: floe speak "<text>" --out <file>');
    expectArgs(ctx, 1);
    await speakCommand(text, {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      model: str(ctx, 'model'),
      voice: str(ctx, 'voice'),
      out: str(ctx, 'out'),
    });
  },
};
