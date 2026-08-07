import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { agentContext } from '../lib/context.js';
import { kv, printJson, sanitizeText, UsageError } from '../lib/output.js';
import { meterOf, meterRows, resolveGatewayModel } from './chat.js';

// whisper-1 first — the most broadly compatible transcription model through
// the gateway (same bias as `floe test`).
const STT_PREFERENCE = ['openai/whisper-1', 'openai/gpt-4o-mini-transcribe'];

/** Content type by extension; the gateway forwards it to the upstream. */
const AUDIO_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
};

interface TranscriptionBody {
  text?: string;
}

export interface TranscribeFlags {
  apiUrl?: string;
  json?: boolean;
  model?: string;
}

export async function transcribeCommand(filePath: string, flags: TranscribeFlags): Promise<void> {
  // The file must be readable BEFORE any network call.
  let audio: Buffer;
  try {
    audio = readFileSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT' ? 'no such file' : code === 'EACCES' ? 'permission denied' : (err as Error).message;
    throw new UsageError(`Cannot read "${filePath}" — ${reason}.`);
  }
  if (audio.byteLength === 0) {
    throw new UsageError(`"${filePath}" is empty — nothing to transcribe.`);
  }

  const { api } = await agentContext(flags);
  const model = await resolveGatewayModel(api, flags.model, 'stt', STT_PREFERENCE);

  const form = new FormData();
  form.set('model', model);
  // Plain json — the most widely supported transcription response format.
  form.set('response_format', 'json');
  const type = AUDIO_TYPES[extname(filePath).toLowerCase()] ?? 'audio/wav';
  form.set('file', new Blob([new Uint8Array(audio)], { type }), basename(filePath));

  const res = await api.agent('POST', '/v1/audio/transcriptions', form);
  const parsed = (await res.json()) as TranscriptionBody & Record<string, unknown>;
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
  const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  process.stdout.write(`${text ? sanitizeText(text) : '(empty transcript)'}\n\n`);
  process.stdout.write(`${kv(meterRows(model, meter))}\n`);
}

export const transcribeDef: CommandDef = {
  name: 'transcribe',
  summary: 'Transcribe an audio file through the metered gateway',
  usage: `Usage: floe transcribe <file> [flags]

Transcribe a local audio file through the metered gateway with this machine's
agent key and print the transcript plus the per-call cost. The content type is
inferred from the file extension (wav, mp3, m4a, flac, ogg, webm, …).

Flags:
  --model <id>   Transcription model id (default: an STT model from /v1/models)
`,
  options: {
    model: { type: 'string' },
  },
  run: async (ctx) => {
    const [file] = ctx.args;
    if (!file) throw new UsageError('Usage: floe transcribe <file> [--model <id>]');
    expectArgs(ctx, 1);
    await transcribeCommand(file, {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      model: str(ctx, 'model'),
    });
  },
};
