import { ApiError, FloeApi } from '../lib/api.js';
import { readConfig, resolveApiUrl } from '../lib/config.js';
import { resolveAgentKey } from '../lib/keychain.js';
import { bold, cyan, dim, kv, ok, printJson, sanitizeText } from '../lib/output.js';
import type { GatewayModel, ModelsResponse } from '../lib/types.js';
import { rawToUsd } from '../lib/usdc.js';
import { generateTestWav } from '../lib/wav.js';

export interface TestFlags {
  voice?: boolean;
  model?: string;
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  apiUrl?: string;
  json?: boolean;
}

// Known-cheap defaults, in preference order; the catalog is the source of
// truth, so these only bias the pick — whatever is actually listed wins.
const CHAT_PREFERENCE = ['openai/gpt-4o-mini', 'google/gemini-2.5-flash', 'anthropic/claude-haiku-4-5'];
// whisper-1 first — the most broadly compatible transcription model through
// the gateway; override with --stt-model.
const STT_PREFERENCE = ['openai/whisper-1', 'openai/gpt-4o-mini-transcribe'];
const TTS_PREFERENCE = ['openai/tts-1'];

const TEST_PROMPT = 'Reply with exactly: Floe gateway OK';

interface Leg {
  leg: string;
  model: string;
  costRaw: string;
}

function pickModel(models: GatewayModel[], modality: GatewayModel['modality'], preference: string[]): string {
  const available = models.filter((m) => m.modality === modality);
  if (available.length === 0) {
    throw new ApiError(`No ${modality} models are available on this gateway.`, 404, 'no_models');
  }
  const preferred = preference.find((id) => available.some((m) => m.id === id));
  return preferred ?? available[0]!.id;
}

function costOf(res: Response): string {
  return res.headers.get('X-Floe-Cost-USDC') ?? '0';
}

export async function testCommand(flags: TestFlags): Promise<void> {
  const config = readConfig();
  const apiUrl = resolveApiUrl(flags.apiUrl, config);
  const agentKey = await resolveAgentKey(apiUrl);
  if (!agentKey) {
    throw new ApiError('No agent key found. Run `floe init` first (or set FLOE_AGENT_KEY).', 401, 'missing_credential');
  }
  const api = new FloeApi(apiUrl, undefined, agentKey);

  const models = ((await (await api.agent('GET', '/v1/models')).json()) as ModelsResponse).data;
  if (!Array.isArray(models)) {
    throw new ApiError('Unexpected /v1/models response from the gateway.', 500, 'bad_response');
  }
  const legs: Leg[] = [];
  let prompt = TEST_PROMPT;
  let sttNote = '';

  if (flags.voice) {
    const sttModel = flags.sttModel ?? pickModel(models, 'stt', STT_PREFERENCE);
    const form = new FormData();
    form.set('model', sttModel);
    // Plain json — the most widely supported transcription response format.
    form.set('response_format', 'json');
    form.set('file', new Blob([new Uint8Array(generateTestWav())], { type: 'audio/wav' }), 'floe-test.wav');
    const sttRes = await api.agent('POST', '/v1/audio/transcriptions', form);
    const transcript = ((await sttRes.json()) as { text?: string }).text?.trim() ?? '';
    legs.push({ leg: 'STT', model: sttModel, costRaw: costOf(sttRes) });
    // The generated tone rarely transcribes to words — the leg exists to prove
    // metering, not speech quality. Fall back to the fixed prompt.
    if (transcript) {
      prompt = `The user said: "${transcript}". ${TEST_PROMPT}`;
    } else {
      sttNote = 'test tone transcribed as empty — metering still verified';
    }
  }

  const chatModel = flags.model ?? pickModel(models, 'text', CHAT_PREFERENCE);
  const chatRes = await api.agent('POST', '/v1/chat/completions', {
    model: chatModel,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 32,
  });
  const chatBody = (await chatRes.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const reply = chatBody.choices?.[0]?.message?.content?.trim() ?? '(no content)';
  legs.push({ leg: flags.voice ? 'LLM' : 'Chat', model: chatModel, costRaw: costOf(chatRes) });

  if (flags.voice) {
    const ttsModel = flags.ttsModel ?? pickModel(models, 'tts', TTS_PREFERENCE);
    const ttsRes = await api.agent('POST', '/v1/audio/speech', {
      model: ttsModel,
      input: reply,
      voice: flags.ttsVoice ?? 'alloy',
    });
    await ttsRes.arrayBuffer(); // drain — we meter it, we don't play it
    legs.push({ leg: 'TTS', model: ttsModel, costRaw: costOf(ttsRes) });
  }

  const totalRaw = legs
    .reduce((sum, l) => {
      try {
        return sum + BigInt(l.costRaw || '0');
      } catch {
        return sum; // malformed header — the per-leg display already shows "—"
      }
    }, 0n)
    .toString();
  const budgetRemaining = chatRes.headers.get('X-Floe-Budget-Remaining-USDC');

  if (flags.json) {
    printJson({
      ok: true,
      voice: Boolean(flags.voice),
      reply,
      legs: legs.map((l) => ({ ...l, costUsd: rawToUsd(l.costRaw) })),
      totalCostRaw: totalRaw,
      totalCostUsd: rawToUsd(totalRaw),
      budgetRemainingUsd: budgetRemaining,
      sttNote: sttNote || undefined,
    });
    return;
  }

  process.stdout.write(`${ok(`Live metered ${flags.voice ? 'voice pipeline' : 'call'} through ${bold(apiUrl)}/v1`)}\n\n`);
  const rows: Array<[string, string]> = legs.map((l) => [
    l.leg,
    `${cyan(sanitizeText(l.model))}  ${bold(rawToUsd(l.costRaw))}`,
  ]);
  if (legs.length > 1) rows.push(['Total', bold(rawToUsd(totalRaw))]);
  process.stdout.write(`${kv(rows)}\n\n`);
  process.stdout.write(`  ${dim('reply:')} ${sanitizeText(reply)}\n`);
  if (sttNote) process.stdout.write(`  ${dim(`note: ${sttNote}`)}\n`);
  if (budgetRemaining) process.stdout.write(`  ${dim('budget remaining:')} $${budgetRemaining}\n`);
  if (flags.voice) {
    process.stdout.write(`\n${dim('Three legs, one key, one bill.')}\n`);
  }
}
