import { devContext } from '../lib/context.js';
import { bold, dim, printJson, sanitizeText, warn } from '../lib/output.js';
import { table } from '../lib/table.js';
import { rawToUsd } from '../lib/usdc.js';

/**
 * `floe gateway release-held <slug> [--billed-by a,b]` — PREVIEW ONLY of a
 * connection's held rows (GET /v1/developer/ext-gateway/connections/:slug/held).
 *
 * Held rows were imported while their payer had no settlement mode: stored,
 * never on the ledger. Releasing them moves money onto the ledger, and finance
 * writes are dashboard-only by design (a signed-in owner or admin; the API
 * refuses a key with 403 person_required). So this command never POSTs.
 */

interface Period { period: string; locked: boolean }
interface Totals { rows: number; cost: { micro: string; display: string }; periods: Period[] }
interface HeldGroup extends Totals { billedBy: string; costSource: string; mode: string | null; releasable: boolean }
interface HeldPreview { held: HeldGroup[]; releasable: Totals }

export interface GatewayHeldFlags {
  apiUrl?: string;
  json?: boolean;
  billedBy?: string;
}

export const DASHBOARD_RELEASE =
  "Release these in the dashboard: Settings → Gateway connections (an owner or admin signed in). The CLI can't release held spend.";

const periodList = (ps: Period[]) => ps.map((p) => `${sanitizeText(p.period)}${p.locked ? ' (locked)' : ''}`).join(', ');

/** The releasable total of some payers' groups, in the API's shape (bigint micro-USD, never a float). */
function totalOf(groups: HeldGroup[]): Totals {
  const ok = groups.filter((g) => g.releasable);
  const micro = ok.reduce((sum, g) => sum + BigInt(g.cost.micro), 0n);
  const periods = new Map<string, boolean>();
  for (const g of ok) for (const p of g.periods) periods.set(p.period, p.locked);
  return {
    rows: ok.reduce((n, g) => n + g.rows, 0),
    cost: { micro: micro.toString(), display: rawToUsd(micro) },
    periods: [...periods].sort(([a], [b]) => (a < b ? -1 : 1)).map(([period, locked]) => ({ period, locked })),
  };
}

export async function gatewayReleaseHeldCommand(slug: string, flags: GatewayHeldFlags): Promise<void> {
  const { api } = await devContext(flags);
  let preview = await api.dev<HeldPreview>('GET', `/v1/developer/ext-gateway/connections/${encodeURIComponent(slug)}/held`);
  if (flags.billedBy) {
    const only = new Set(flags.billedBy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    const held = preview.held.filter((g) => only.has(g.billedBy.toLowerCase()));
    preview = { held, releasable: totalOf(held) };
  }
  if (flags.json) {
    printJson(preview);
    return;
  }
  if (preview.held.length === 0) {
    process.stdout.write(`No held rows on ${sanitizeText(slug)}.\n`);
    return;
  }
  const rows = preview.held.map((g) => [
    sanitizeText(g.billedBy), sanitizeText(g.costSource), g.mode ? sanitizeText(g.mode) : 'undeclared',
    String(g.rows), sanitizeText(g.cost.display), periodList(g.periods),
  ]);
  const r = preview.releasable;
  const out = [
    `${bold(`Held rows on ${sanitizeText(slug)}`)} ${dim('(not on the ledger)')}`,
    table(['BILLED BY', 'COST SOURCE', 'MODE', 'ROWS', 'COST', 'PERIODS'], rows),
    r.rows > 0
      ? `Releasable now: ${r.rows} rows, ${sanitizeText(r.cost.display)}, into ${periodList(r.periods)}. A locked period's rows restate into the next open period.`
      : 'Releasable now: none. Declare a mode first: floe gateway declare-mode <slug> <billed-by> <mode>.',
  ];
  if (preview.held.some((g) => g.mode === null)) out.push(warn('Undeclared payers stay held until a settlement mode is declared for them.'));
  if (r.rows > 0) out.push(DASHBOARD_RELEASE);
  process.stdout.write(`${out.join('\n')}\n`);
}
