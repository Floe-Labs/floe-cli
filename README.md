# Floe CLI

`npm i` to a metered Floe call wired into your code — with zero dashboard round-trips after the first key.

```bash
npx @floelabs/cli init
```

`floe init` authenticates with your developer key, creates (or selects) an agent, mints its
runtime key into your OS keychain, and ends with the only thing that matters — the base-URL
swap for your existing OpenAI-compatible client, key already filled in:

```python
from openai import OpenAI
client = OpenAI(base_url="https://credit-api.floelabs.xyz/v1", api_key="floe_…")
```

Every response carries `X-Floe-Cost-USDC`. One key meters chat, embeddings, speech and
transcription across 15+ vendors — one bill, in USDC.

## Commands

| Command | What it does |
|---|---|
| `floe init` | Full setup in one command; ends with the copy-paste snippet. Flags: `--key <floe_live_…>`, `--agent <name>`, `--name <name>`, `--new-key`, `--open` |
| `floe status` | Am I set up? Balance, budgets, active agent + key. |
| `floe test` | Make one real metered call and print its cost. `--voice` runs STT → LLM → TTS: three legs, one key, one bill. Override models with `--model`, `--stt-model`, `--tts-model`, `--tts-voice`. |
| `floe budget set <usd>` | Cap total spend before you let an agent loose. `--per day` caps this key per rolling 24 h; `--per task --task <id>` caps one task. `floe budget` shows, `floe budget clear` removes. |
| `floe keys` | List this agent's keys; `floe keys rotate` replaces yours atomically. |

Every command takes `--json` (for CI and coding agents) and `--api-url <url>`.

## Two keys, handled for you

Floe has a **developer key** (`floe_live_…`, from the [dashboard](https://dev-dashboard.floelabs.xyz))
for managing agents, and per-agent **runtime keys** (`floe_…`) that the gateway meters. The CLI
stores both in your OS keychain and always sends the right one — you never pick. On systems
without a usable keychain (headless Linux, some containers) it falls back to
`~/.config/floe/credentials.json` with `0600` permissions and tells you so.

Headless / CI: set `FLOE_API_KEY` (developer key) and/or `FLOE_AGENT_KEY` (runtime key);
env vars always win over the keychain. `FLOE_API_URL` overrides the API base.

## Exit codes

`0` ok · `1` error · `2` usage · `4` auth · `5` payment/budget

## Development

```bash
pnpm install
pnpm build        # tsup → dist/
pnpm typecheck
pnpm test
node dist/bin.js --help
```

Merging to `main` publishes to npm automatically when `package.json` has a new version.

## License

MIT © Floe Labs
