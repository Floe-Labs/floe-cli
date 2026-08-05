import { bold, cyan, dim } from './output.js';

/**
 * The `floe init` payoff: the base-URL swap, agent key already filled in.
 * Pointing an existing OpenAI/Pipecat client at Floe is the adoption moment —
 * everything above this block is just plumbing.
 */
export function renderSnippets(apiUrl: string, agentKey: string): string {
  const base = `${apiUrl}/v1`;
  return `
${bold('Point your existing OpenAI client at Floe — one metered bill in USDC:')}

${cyan('# Python')}
  from openai import OpenAI
  client = OpenAI(base_url="${base}", api_key="${agentKey}")

${cyan('# TypeScript')}
  import OpenAI from "openai";
  const client = new OpenAI({ baseURL: "${base}", apiKey: "${agentKey}" });

${cyan('# curl')}
  curl ${base}/chat/completions \\
    -H "Authorization: Bearer ${agentKey}" \\
    -H "Content-Type: application/json" \\
    -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

${cyan('# Pipecat (voice — STT, LLM and TTS through the same key)')}
  from pipecat.services.openai.llm import OpenAILLMService
  llm = OpenAILLMService(base_url="${base}", api_key="${agentKey}",
                         model="openai/gpt-4o-mini")

${dim('Every response carries X-Floe-Cost-USDC. Try it:')} ${bold('floe test')}${dim(', then cap it:')} ${bold('floe budget set 5')}
`;
}
