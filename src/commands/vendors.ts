import { expectArgs, type CommandDef } from '../lib/command.js';
import { DASHBOARD_URL } from '../lib/config.js';
import { devContext } from '../lib/context.js';
import { bold, dim, green, printJson, red, sanitizeText, UsageError } from '../lib/output.js';
import { table } from '../lib/table.js';
import { rawToUsd } from '../lib/usdc.js';

/**
 * `floe vendors status` — GET /v1/playground/vendors: the cached results of
 * REAL x402 probe calls the platform makes against marketplace vendors, so
 * "live" means verified-live, not just configured. Developer-authed (the route
 * only needs a walletAddress-setting credential).
 *
 * There is NO vendor-catalog API — the dashboard's vendor directory is static
 * frontend data. For the full catalog and per-vendor docs this command points
 * at the dashboard instead of pretending to have a list endpoint.
 */

interface PlaygroundVendor {
  vendor: string;
  name: string;
  endpoint: string;
  method: string;
  priceUsdc: string;
  status: 'ok' | 'down' | string;
  responseExcerpt: string | null;
  costRaw: string | null;
  latencyMs: number | null;
  checkedAt: string;
}

interface VendorsStatusResponse {
  now: string;
  vendors: PlaygroundVendor[];
}

/** "2h ago" style freshness against the server's own clock. */
function age(now: string, checkedAt: string): string {
  const ms = Date.parse(now) - Date.parse(checkedAt);
  if (!Number.isFinite(ms) || ms < 0) return sanitizeText(checkedAt.slice(0, 10));
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** One-line, control-free, truncated excerpt of the probe's response. */
function excerptCell(excerpt: string | null): string {
  if (!excerpt) return dim('—');
  const clean = sanitizeText(excerpt).replace(/\s+/g, ' ').trim();
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
}

export interface VendorsFlags {
  apiUrl?: string;
  json?: boolean;
}

export async function vendorsStatusCommand(flags: VendorsFlags): Promise<void> {
  const { api } = await devContext(flags);
  const result = await api.dev<VendorsStatusResponse>('GET', '/v1/playground/vendors');

  if (flags.json) return printJson(result);

  if (result.vendors.length === 0) {
    process.stdout.write(`No vendor probes recorded yet.\n`);
    process.stdout.write(`${dim(`Vendor catalog & docs: ${DASHBOARD_URL}/vendors`)}\n`);
    return;
  }
  const rows = result.vendors.map((v) => [
    sanitizeText(v.name || v.vendor),
    v.status === 'ok' ? green('ok') : red(sanitizeText(v.status)),
    rawToUsd(v.costRaw),
    v.latencyMs !== null && v.latencyMs !== undefined ? `${v.latencyMs}ms` : dim('—'),
    age(result.now, v.checkedAt),
    excerptCell(v.responseExcerpt),
  ]);
  process.stdout.write(`${bold(`Verified-live vendors (${result.vendors.length}) — real x402 probe calls`)}\n`);
  process.stdout.write(`${table(['VENDOR', 'STATUS', 'COST', 'LATENCY', 'CHECKED', 'RESPONSE'], rows)}\n`);
  process.stdout.write(`${dim(`Full vendor catalog & docs: ${DASHBOARD_URL}/vendors`)}\n`);
}

export const vendorsDef: CommandDef = {
  name: 'vendors',
  summary: 'status — live-verified vendor probes',
  usage: `Usage: floe vendors [status]

Health of the metered marketplace vendors, proven by real x402 probe calls:
  status  Per-vendor health, settled probe cost, latency, and response excerpt

There is no vendor-catalog API — browse the full directory and per-vendor docs
at ${DASHBOARD_URL}/vendors.
`,
  options: {},
  run: async (ctx) => {
    const [subcommand] = ctx.args;
    if (subcommand === undefined || subcommand === 'status') {
      expectArgs(ctx, 1);
      await vendorsStatusCommand({ apiUrl: ctx.apiUrl, json: ctx.json });
    } else {
      throw new UsageError(`Unknown vendors subcommand "${subcommand}". Use: status.`);
    }
  },
};
