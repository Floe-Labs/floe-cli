import { ApiError } from '../lib/api.js';
import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { devContext, resolveAgentRef } from '../lib/context.js';
import { bold, dim, kv, printJson, sanitizeText, UsageError } from '../lib/output.js';
import { table } from '../lib/table.js';
import { rawToUsd } from '../lib/usdc.js';

/**
 * Usage analytics, three views:
 *   floe usage                  daily spend series (GET /v1/developer/spend-series)
 *   floe usage summary          headline KPIs (GET /v1/developer/usage/summary,
 *                               enriched from GET /v1/developer/analytics/summary)
 *   floe usage coverage         per-agent governance coverage score
 *                               (GET /v1/developer/agents/:id/coverage)
 * All read-only.
 */

// ── Response shapes as served by the developer API ──

interface SpendSeriesResponse {
  days: number;
  /** Dense, zero-filled, oldest first. totalRaw is raw 6-dp USDC. */
  series: Array<{ date: string; totalRaw: string }>;
  /** Descending, top 8 + 'other'. */
  byVendor: Array<{ host: string; totalRaw: string }>;
  totals: { requests: number; declined: number; totalRaw: string };
}

interface UsageSummaryResponse {
  window: string;
  calls: number;
  errorRatePct: number;
  p50LatencyMs: number | null;
  policiesTripped: number;
}

interface AnalyticsX402Totals {
  count: number;
  volumeRaw: string;
  successCount: number;
  failedCount: number;
  pendingCount: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
}

interface AnalyticsTopEndpoint {
  host: string;
  count: number;
  volumeRaw: string;
  successRate: number;
}

interface AnalyticsSummaryResponse {
  totals: { x402: AnalyticsX402Totals };
  topEndpoints: AnalyticsTopEndpoint[];
}

interface CoverageResponse {
  days: number;
  totals: {
    knownRaw: string;
    enforceableRaw: string;
    reconciledRaw: string;
    /** bps of known spend that was pre-call enforceable; null = no spend. */
    coverageBps: number | null;
  };
  bySource: Array<{ source: string; class: string; calls: number; costRaw: string }>;
  series: Array<{ date: string; enforceableRaw: string; reconciledRaw: string }>;
  dark: string;
}

export interface UsageFlags {
  agent?: string;
  days?: string;
  window?: string;
  apiUrl?: string;
  json?: boolean;
}

/** 1..90, matching the API's MAX_DAYS on all three day-windowed routes. */
function parseDays(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 90) {
    throw new UsageError('--days must be an integer between 1 and 90.');
  }
  return raw;
}

export async function usageSeriesCommand(flags: UsageFlags): Promise<void> {
  const days = parseDays(flags.days); // validation precedes I/O
  const ctx = await devContext(flags);
  const query = new URLSearchParams();
  if (days !== undefined) query.set('days', days);
  let agentLabel: string | undefined;
  if (flags.agent !== undefined) {
    const agent = await resolveAgentRef(ctx, flags.agent);
    query.set('agentId', String(agent.id));
    agentLabel = agent.name ?? String(agent.id);
  }
  const qs = query.toString();
  const spend = await ctx.api.dev<SpendSeriesResponse>(
    'GET',
    `/v1/developer/spend-series${qs ? `?${qs}` : ''}`,
  );

  if (flags.json) return printJson(spend);

  const scope = agentLabel ? `agent ${sanitizeText(agentLabel)}` : 'all agents';
  process.stdout.write(`${bold(`Spend — last ${spend.days} days · ${scope}`)}\n`);
  process.stdout.write(
    `${table(['DATE', 'SPEND'], spend.series.map((p) => [sanitizeText(p.date), rawToUsd(p.totalRaw)]))}\n`,
  );
  process.stdout.write(
    `${kv([
      ['Total', rawToUsd(spend.totals.totalRaw)],
      ['Requests', `${spend.totals.requests} (${spend.totals.declined} declined)`],
    ])}\n`,
  );
  if (spend.byVendor.length > 0) {
    process.stdout.write(
      `${bold('By vendor')}\n${table(
        ['VENDOR', 'SPEND'],
        spend.byVendor.map((v) => [sanitizeText(v.host), rawToUsd(v.totalRaw)]),
      )}\n`,
    );
  }
  process.stdout.write(
    `${dim('Series mirrors PolicyService.getSpend — the exact numbers budget enforcement uses.')}\n`,
  );
}

const WINDOWS = new Set(['7d', '30d']);

export async function usageSummaryCommand(flags: UsageFlags): Promise<void> {
  const window = flags.window ?? '7d';
  if (!WINDOWS.has(window)) {
    throw new UsageError(`Unknown --window "${window}". Supported: 7d, 30d.`);
  }
  const ctx = await devContext(flags);
  const [summary, analytics] = await Promise.all([
    ctx.api.dev<UsageSummaryResponse>('GET', `/v1/developer/usage/summary?window=${window}`),
    ctx.api
      .dev<AnalyticsSummaryResponse>('GET', `/v1/developer/analytics/summary?window=${window}`)
      .catch((err: unknown) => {
        // /analytics/summary 404s for an account with zero agents while
        // /usage/summary still answers with zeros — degrade, don't fail.
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
  ]);
  const x402 = analytics?.totals.x402 ?? null;
  const topEndpoints = analytics?.topEndpoints ?? null;

  if (flags.json) return printJson({ ...summary, x402, topEndpoints });

  const rows: Array<[string, string]> = [
    ['Calls', String(summary.calls)],
    ['Error rate', `${summary.errorRatePct}%`],
    ['p50 latency', summary.p50LatencyMs === null ? dim('no timed calls') : `${summary.p50LatencyMs} ms`],
    ['Policies tripped', String(summary.policiesTripped)],
  ];
  if (x402) {
    rows.push(['Metered spend', rawToUsd(x402.volumeRaw)]);
    rows.push([
      'x402 calls',
      `${x402.count} (${x402.successCount} ok · ${x402.failedCount} failed · ${x402.pendingCount} pending)`,
    ]);
    if (x402.p95LatencyMs !== null || x402.p99LatencyMs !== null) {
      rows.push(['p95 / p99', `${x402.p95LatencyMs ?? '—'} / ${x402.p99LatencyMs ?? '—'} ms`]);
    }
  }
  process.stdout.write(`${bold(`Usage — last ${window}`)}\n${kv(rows)}\n`);
  if (topEndpoints && topEndpoints.length > 0) {
    process.stdout.write(
      `${bold('Top vendors')}\n${table(
        ['VENDOR', 'CALLS', 'SPEND', 'SUCCESS'],
        topEndpoints.map((t) => [
          sanitizeText(t.host),
          String(t.count),
          rawToUsd(t.volumeRaw),
          `${Math.round(t.successRate * 100)}%`,
        ]),
      )}\n`,
    );
  }
}

export async function usageCoverageCommand(flags: UsageFlags): Promise<void> {
  const days = parseDays(flags.days); // validation precedes I/O
  const ctx = await devContext(flags);
  const agent = await resolveAgentRef(ctx, flags.agent);
  const qs = days !== undefined ? `?days=${days}` : '';
  const coverage = await ctx.api.dev<CoverageResponse>(
    'GET',
    `/v1/developer/agents/${agent.id}/coverage${qs}`,
  );

  if (flags.json) return printJson({ agentId: agent.id, agentName: agent.name, ...coverage });

  const totals = coverage.totals;
  const rows: Array<[string, string]> = [
    ['Known spend', rawToUsd(totals.knownRaw)],
    ['Enforceable (pre-call)', rawToUsd(totals.enforceableRaw)],
    ['Reconciled (post-call)', rawToUsd(totals.reconciledRaw)],
    [
      'Coverage score',
      totals.coverageBps === null
        ? dim('no spend in window')
        : `${(totals.coverageBps / 100).toFixed(2)}% pre-call enforceable`,
    ],
  ];
  process.stdout.write(
    `${bold(`Governance coverage — ${sanitizeText(agent.name ?? String(agent.id))} · last ${coverage.days} days`)}\n${kv(rows)}\n`,
  );
  if (coverage.bySource.length > 0) {
    process.stdout.write(
      `${bold('By source')}\n${table(
        ['SOURCE', 'CLASS', 'CALLS', 'SPEND'],
        coverage.bySource.map((s) => [
          sanitizeText(s.source),
          sanitizeText(s.class),
          String(s.calls),
          rawToUsd(s.costRaw),
        ]),
      )}\n`,
    );
  }
  process.stdout.write(
    `${dim('Dark spend on platforms never wired to Floe is unknown — it is not in these numbers.')}\n`,
  );
}

export const usageDef: CommandDef = {
  name: 'usage',
  summary: 'Spend series | summary | coverage — usage analytics',
  usage: `Usage: floe usage [--agent <ref>] [--days <n>]
       floe usage summary [--window 7d|30d]
       floe usage coverage [--agent <ref>] [--days <n>]

Usage analytics for the account:
  (default)   Daily spend series with per-vendor rollup and totals. Mirrors
              PolicyService.getSpend — governance-accurate: the chart and
              budget enforcement can never disagree.
  summary     Headline KPIs over the window: calls, error rate, latency
              percentiles, policies tripped, metered spend, top vendors.
  coverage    Governance coverage score for one agent: pre-call enforceable
              vs orchestrator-reconciled share of known spend.

  --agent <ref>       Agent by name or id. Series: default all agents.
                      Coverage: default this machine's active agent.
  --days <n>          Window in days, 1-90 (default 30)
  --window 7d|30d     Summary window (default 7d)
`,
  options: {
    agent: { type: 'string' },
    days: { type: 'string' },
    window: { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand] = ctx.args;
    const flags: UsageFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      agent: str(ctx, 'agent'),
      days: str(ctx, 'days'),
      window: str(ctx, 'window'),
    };
    if (subcommand === 'summary') {
      expectArgs(ctx, 1);
      if (flags.days !== undefined) {
        throw new UsageError('--days does not apply to `floe usage summary`. Use --window 7d|30d.');
      }
      await usageSummaryCommand(flags);
    } else if (subcommand === 'coverage') {
      expectArgs(ctx, 1);
      if (flags.window !== undefined) {
        throw new UsageError('--window does not apply to `floe usage coverage`. Use --days <n>.');
      }
      await usageCoverageCommand(flags);
    } else if (subcommand === undefined) {
      expectArgs(ctx, 0);
      if (flags.window !== undefined) {
        throw new UsageError('--window applies to `floe usage summary` only. Use --days <n>.');
      }
      await usageSeriesCommand(flags);
    } else {
      throw new UsageError(
        `Unknown usage subcommand "${subcommand}". Use: summary, coverage, or no subcommand for the daily spend series.`,
      );
    }
  },
};
