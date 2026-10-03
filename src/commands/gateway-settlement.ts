import { devContext } from '../lib/context.js';
import { bold, dim, ok, printJson, sanitizeText, UsageError, warn } from '../lib/output.js';
import { table } from '../lib/table.js';

/**
 * L1.13 — how each payer (billed_by) on a gateway connection settles.
 *
 *   floe gateway settlement-modes <slug>                           declared modes + seeded defaults
 *   floe gateway declare-mode <slug> <billed-by> <mode> [--cost-source <s>]   declare, flip, or remove (mode "none")
 *
 * A declaration is a new profile version (POST …/profile-versions
 * `settlementModes`). Rows imported for a payer with no mode are held out of
 * the ledger; declaring that payer releases them, with no re-upload.
 */

export const SETTLEMENT_MODES = ['invoiced', 'bucket', 'final_at_settlement'] as const;
export const COST_SOURCES = ['vendor_reported', 'gateway_computed'] as const;
type Mode = (typeof SETTLEMENT_MODES)[number];
type CostSource = (typeof COST_SOURCES)[number];

interface Declared { billedBy: string; costSource?: CostSource; mode: Mode }
interface SeededDefault { billedBy: string; costSource: CostSource | null; mode: Mode; status: 'default_unverified' }
interface Profile { version: number; settlementModes?: Declared[]; settlementModeDefaults?: SeededDefault[] }
interface Connection { slug: string; profile: Profile }

export interface GatewaySettlementFlags {
  apiUrl?: string;
  json?: boolean;
  costSource?: string;
}

const clean = (s: string) => sanitizeText(s);
const source = (s: string | null | undefined) => (s ? clean(s) : 'either');

function modesTable(declared: Declared[], defaults: SeededDefault[]): string {
  const rows = [
    ...declared.map((d) => [clean(d.billedBy), source(d.costSource), clean(d.mode), 'declared']),
    ...defaults.map((d) => [clean(d.billedBy), source(d.costSource), clean(d.mode), 'default, unverified']),
  ];
  return table(['BILLED BY', 'COST SOURCE', 'MODE', 'STATUS'], rows);
}

export async function gatewaySettlementModesCommand(slug: string, flags: GatewaySettlementFlags): Promise<void> {
  const { api } = await devContext(flags);
  const { connections } = await api.dev<{ connections: Connection[] }>('GET', '/v1/developer/ext-gateway/connections');
  const conn = connections.find((c) => c.slug === slug);
  if (!conn) throw new UsageError(`No gateway connection "${clean(slug)}".`);
  const declared = conn.profile.settlementModes ?? [];
  const defaults = conn.profile.settlementModeDefaults ?? [];
  if (flags.json) {
    printJson({ slug: conn.slug, profileVersion: conn.profile.version, settlementModes: declared, settlementModeDefaults: defaults });
    return;
  }
  process.stdout.write(`${bold(clean(conn.slug))} ${dim(`profile v${conn.profile.version}`)}\n${modesTable(declared, defaults)}\n`);
  process.stdout.write(dim('A declaration replaces a default for its payer. A payer with neither imports held (not on the ledger).\n'));
}

export async function gatewayDeclareModeCommand(slug: string, billedBy: string, modeArg: string, flags: GatewaySettlementFlags): Promise<void> {
  const mode = modeArg === 'none' ? null : modeArg;
  if (mode !== null && !(SETTLEMENT_MODES as readonly string[]).includes(mode)) {
    throw new UsageError(`Unknown mode "${clean(modeArg)}". Use: ${SETTLEMENT_MODES.join(', ')}, or none to remove.`);
  }
  if (flags.costSource !== undefined && !(COST_SOURCES as readonly string[]).includes(flags.costSource)) {
    throw new UsageError(`Unknown cost source "${clean(flags.costSource)}". Use: ${COST_SOURCES.join(', ')}.`);
  }
  const { api } = await devContext(flags);
  const entry = { billedBy, ...(flags.costSource ? { costSource: flags.costSource } : {}), mode };
  const res = await api.dev<{ profile: Profile }>('POST', `/v1/developer/ext-gateway/connections/${encodeURIComponent(slug)}/profile-versions`, { settlementModes: [entry] });
  if (flags.json) {
    printJson(res);
    return;
  }
  const payer = clean(billedBy.trim().toLowerCase());
  const declared = res.profile.settlementModes ?? [];
  const lines = [
    mode === null
      ? ok(`Removed the settlement mode for ${payer} (${source(flags.costSource)}) on ${clean(slug)}: profile v${res.profile.version}.`)
      : ok(`Declared ${payer} (${source(flags.costSource)}) ${mode} on ${clean(slug)}: profile v${res.profile.version}.`),
    declared.length
      ? `Declared now:\n${table(['BILLED BY', 'COST SOURCE', 'MODE'], declared.map((d) => [clean(d.billedBy), source(d.costSource), clean(d.mode)]))}`
      : `Declared now: ${dim('none')}`,
  ];
  if (mode === null) {
    lines.push(warn(`A seeded default applies to ${payer} if one covers it; otherwise its new rows import held (not on the ledger).`));
  } else {
    lines.push(`Rows held for ${payer} because it had no settlement mode are released into the ledger now, with no re-upload (a locked month's through a restatement in the next open period). The API does not return a count of released rows.`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
