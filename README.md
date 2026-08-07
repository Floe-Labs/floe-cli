# Floe CLI

The full Floe platform from your terminal — setup, metered calls, agents, keys, budgets,
policies, billing, funds, and phone. Built for humans and for AI coding agents.

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

## Quickstart

```bash
npm install -g @floelabs/cli
floe init                   # authenticate, set up an agent + key
floe status                 # am I set up? balance, budgets, active agent
floe chat "hello"           # one metered call, cost printed
floe test --voice           # STT → LLM → TTS: three legs, one key, one bill
```

## Commands

`floe help <command>` prints each command's full usage and flags.

### Get started

| Command | What it does |
|---|---|
| `floe init` | Authenticate, set up an agent + key, print the base-URL swap |
| `floe status` | Am I set up? Balance, budgets, active agent and key |
| `floe use` | Switch this machine to another agent (keys kept per agent) |
| `floe test` | Make one real metered call and print its cost |

### Metered calls

| Command | What it does |
|---|---|
| `floe chat` | Send a prompt through the metered gateway |
| `floe embed` | Create embeddings through the metered gateway |
| `floe speak` | Text-to-speech through the metered gateway (writes a file) |
| `floe transcribe` | Transcribe an audio file through the metered gateway |
| `floe pay` | Call any x402 vendor through the metered proxy |

### Agents & limits

| Command | What it does |
|---|---|
| `floe agents` | list \| get \| create \| pause \| resume \| close \| lock — agent fleet |
| `floe keys` | list \| create \| revoke \| rotate — agent runtime keys |
| `floe devkeys` | list \| create \| revoke \| rotate — developer (`floe_live_`) keys |
| `floe budget` | show \| set \| clear \| reserve — cap agent spend |
| `floe policy` | list \| create \| update \| revoke \| reset \| chain \| test — spend policies |
| `floe allowlist` | show \| set \| add \| remove — merchant allowlist |
| `floe credit` | bounds \| open — credit-line inspection and opt-in open |

### Observability & billing

| Command | What it does |
|---|---|
| `floe activity` | Unified spend/activity feed with filters |
| `floe usage` | Spend series \| summary \| coverage — usage analytics |
| `floe ledger` | Cross-source spend ledger, grouped |
| `floe billing` | mtd \| invoice \| export \| charges — billing and exports |
| `floe account` | show \| rename — account identity |
| `floe team` | members \| invite \| revoke-invite \| set-role \| remove — team roster |

### Money

| Command | What it does |
|---|---|
| `floe funds` | withdraw \| move \| list \| address \| topup \| sessions — move money |
| `floe cashout` | start \| list \| status \| cancel — cash out USDC to fiat |

### Platform

| Command | What it does |
|---|---|
| `floe webhooks` | list \| create \| get \| pause \| enable \| delete \| test \| rotate-secret \| deliveries |
| `floe models` | Model catalog with modalities and pricing |
| `floe estimate` | Estimate a call cost without spending |
| `floe providers` | list \| set \| enable \| disable \| remove — BYOK provider keys |
| `floe phone` | search \| buy \| list \| release \| calls \| usage \| voice \| test-call — Floe Phone |
| `floe actions` | list \| report — cost-per-action rollups and outcomes |
| `floe orchestrators` | connect \| list \| rotate \| enable \| disable \| remove — Vapi/Retell/Bland |
| `floe vendors` | status — live-verified vendor probes |

## Two keys, handled for you

Floe has a **developer key** (`floe_live_…`, from the [dashboard](https://dev-dashboard.floelabs.xyz))
for managing agents, and per-agent **runtime keys** (`floe_…`) that the gateway meters. The CLI
stores both in your OS keychain and always sends the right one — you never pick. On systems
without a usable keychain (headless Linux, some containers) it falls back to
`~/.config/floe/credentials.json` with `0600` permissions and tells you so.

Runtime keys are stored **per agent**, so `floe use <agent>` switches this machine between
agents without re-minting keys — the first switch to an agent mints its key once (agents cap
at 5 keys), and every switch after that reuses it.

## Conventions

- `--json` on every command — machine-readable output for CI and coding agents.
- `--yes` skips confirmation on destructive or money-moving commands (`agents close`,
  `keys revoke`, `funds withdraw`, …). Non-interactive runs **require** it — a script never
  destroys something by default.
- Exit codes: `0` ok · `1` error · `2` usage · `4` auth · `5` payment/budget.
- `--api-url <url>` overrides the API base on any command.

## Environment

Headless / CI: set `FLOE_API_KEY` (developer key) and/or `FLOE_AGENT_KEY` (runtime key);
env vars always win over the keychain. `FLOE_API_URL` overrides the API base.

## For AI agents

The CLI is a first-class surface for coding agents:

- Every command takes `--json` and prints exactly what the API returned — parse, don't scrape.
- Nothing hangs on a prompt: non-interactive destructive calls fail fast with exit 2 unless
  `--yes` is passed.
- Bootstrap without a keychain: export `FLOE_API_KEY` (and `FLOE_AGENT_KEY` for metered calls)
  and every command works immediately — no `init`, no stored state.
- Exit codes are stable and meaningful — branch on `4` (re-auth) and `5` (out of budget).

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
