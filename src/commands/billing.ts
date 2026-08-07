import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiError } from '../lib/api.js';
import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { devContext } from '../lib/context.js';
import { bold, dim, kv, ok, printJson, sanitizeText, UsageError } from '../lib/output.js';
import { table } from '../lib/table.js';
import { rawToUsd } from '../lib/usdc.js';

/**
 * Developer-plane billing surface (console-gaps routes). Cross-agent by
 * design — no active agent required, everything is scoped server-side to the
 * agents this developer owns. All money is raw 6-dp USDC integer strings;
 * --json passes them through untouched, human output formats with rawToUsd.
 */

interface MtdByVendorItem {
  vendor: string;
  costRaw: string;
}

interface MtdByAgentItem {
  agentId: number;
  agentName: string;
  costRaw: string;
  calls: number;
}

interface MtdResult {
  totalRaw: string;
  byVendor: MtdByVendorItem[];
  byAgent: MtdByAgentItem[];
}

interface InvoiceResponse extends MtdResult {
  period: { start: string; end: string };
  currency: string;
  decimals: number;
}

interface ChargeItem {
  time: string | null;
  agentId: number;
  agentName: string;
  vendor: string;
  endpoint: string;
  amountRaw: string;
}

interface ChargesResponse {
  charges: ChargeItem[];
  limit: number;
}

export interface BillingFlags {
  out?: string;
  limit?: string;
  apiUrl?: string;
  json?: boolean;
}

function renderMtdTables(mtd: MtdResult): string {
  const byVendor = `${bold('By vendor')}\n${table(
    ['VENDOR', 'SPEND'],
    mtd.byVendor.map((v) => [sanitizeText(v.vendor), rawToUsd(v.costRaw)]),
  )}`;
  const byAgent = `${bold('By agent')}\n${table(
    ['AGENT', 'CALLS', 'SPEND'],
    mtd.byAgent.map((a) => [sanitizeText(a.agentName), String(a.calls), rawToUsd(a.costRaw)]),
  )}`;
  return `${byVendor}\n\n${byAgent}`;
}

export async function billingMtdCommand(flags: BillingFlags): Promise<void> {
  const { api } = await devContext(flags);
  const mtd = await api.dev<MtdResult>('GET', '/v1/developer/billing/mtd');

  if (flags.json) return printJson(mtd);

  process.stdout.write(`${bold('Month-to-date bill')} — total ${bold(rawToUsd(mtd.totalRaw))}\n`);
  if (mtd.byVendor.length === 0 && mtd.byAgent.length === 0) {
    process.stdout.write(`${dim('No billable charges yet this month.')}\n`);
    return;
  }
  process.stdout.write(`\n${renderMtdTables(mtd)}\n`);
}

export async function billingInvoiceCommand(flags: BillingFlags): Promise<void> {
  const { api } = await devContext(flags);
  const invoice = await api.dev<InvoiceResponse>('GET', '/v1/developer/billing/invoice');

  if (flags.out) {
    const path = resolve(process.cwd(), flags.out);
    writeFileSync(path, `${JSON.stringify(invoice, null, 2)}\n`);
    if (flags.json) {
      return printJson({ written: path, totalRaw: invoice.totalRaw, period: invoice.period });
    }
    process.stdout.write(`${ok(`Invoice written → ${path}`)}\n`);
    return;
  }

  if (flags.json) return printJson(invoice);

  const rows: Array<[string, string]> = [
    ['Period', `${invoice.period.start.slice(0, 10)} → ${invoice.period.end.slice(0, 10)}`],
    ['Total', `${rawToUsd(invoice.totalRaw)} ${dim(`(${sanitizeText(invoice.currency)})`)}`],
    ['Vendors', String(invoice.byVendor.length)],
    ['Agents billed', String(invoice.byAgent.length)],
  ];
  process.stdout.write(`${bold('Current-period invoice')}\n${kv(rows)}\n`);
  if (invoice.byVendor.length > 0 || invoice.byAgent.length > 0) {
    process.stdout.write(`\n${renderMtdTables(invoice)}\n`);
  }
  process.stdout.write(`${dim('Full JSON: floe billing invoice --out <file>  (or --json)')}\n`);
}

export async function billingExportCommand(flags: BillingFlags): Promise<void> {
  const { api } = await devContext(flags);

  let res: Response;
  try {
    res = await api.devRaw('GET', '/v1/developer/billing/export.csv');
  } catch (err) {
    if (err instanceof ApiError && err.code === 'export_too_large') {
      throw new ApiError(
        err.message,
        err.status,
        err.code,
        'The CSV export caps out per month — narrow the data or contact support for a full extract.',
      );
    }
    throw err;
  }
  const csv = await res.text();
  // Everything after the header line is a charge row.
  const rowCount = Math.max(0, csv.split('\n').filter((l) => l.length > 0).length - 1);

  if (flags.out === '-') {
    // Piping mode — raw CSV to stdout (terminal control characters stripped;
    // the data is network-sourced). Explicit opt-in only: CSV never hits a
    // TTY by default.
    process.stdout.write(sanitizeText(csv));
    return;
  }

  const name = flags.out ?? `floe-charges-${new Date().toISOString().slice(0, 7)}.csv`;
  const path = resolve(process.cwd(), name);
  writeFileSync(path, csv);
  if (flags.json) return printJson({ written: path, rows: rowCount, bytes: Buffer.byteLength(csv) });
  process.stdout.write(`${ok(`Exported ${rowCount} charge row${rowCount === 1 ? '' : 's'} → ${path}`)}\n`);
}

export async function billingChargesCommand(flags: BillingFlags): Promise<void> {
  let query = '';
  if (flags.limit !== undefined) {
    if (!/^\d+$/.test(flags.limit) || Number(flags.limit) < 1 || Number(flags.limit) > 100) {
      throw new UsageError(`Invalid --limit "${flags.limit}" — use an integer from 1 to 100.`);
    }
    query = `?limit=${Number(flags.limit)}`;
  }
  const { api } = await devContext(flags);
  const result = await api.dev<ChargesResponse>('GET', `/v1/developer/charges/recent${query}`);

  if (flags.json) return printJson(result);

  if (result.charges.length === 0) {
    process.stdout.write(`${dim('No charges yet.')}\n`);
    return;
  }
  process.stdout.write(`${bold(`Recent charges (${result.charges.length})`)}\n`);
  process.stdout.write(
    `${table(
      ['TIME', 'AGENT', 'VENDOR', 'ENDPOINT', 'AMOUNT'],
      result.charges.map((c) => [
        c.time ? c.time.slice(0, 16).replace('T', ' ') : '—',
        sanitizeText(c.agentName),
        sanitizeText(c.vendor),
        sanitizeText(c.endpoint),
        rawToUsd(c.amountRaw),
      ]),
    )}\n`,
  );
}

export const billingDef: CommandDef = {
  name: 'billing',
  summary: 'mtd | invoice | export | charges — billing and exports',
  usage: `Usage: floe billing [mtd]
       floe billing invoice [--out <file>]
       floe billing export [--out <file> | --out -]
       floe billing charges [--limit <n>]

Cross-agent billing for this developer account (current calendar month, UTC).
  mtd                 Month-to-date bill, broken down by vendor and by agent
  invoice [--out f]   Current-period invoice; --out writes the full JSON to a file
  export [--out f]    Per-charge CSV for the month. Default file:
                      floe-charges-<yyyy-mm>.csv in the current directory.
                      --out - streams raw CSV to stdout (for piping).
  charges [--limit n] Most recent charge line items across all agents (default 20, max 100)

Amounts in --json are raw 6-decimal USDC integer strings.
`,
  options: {
    out: { type: 'string' },
    limit: { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand] = ctx.args;
    const flags: BillingFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      out: str(ctx, 'out'),
      limit: str(ctx, 'limit'),
    };
    if (subcommand === undefined || subcommand === 'mtd') {
      expectArgs(ctx, 1);
      await billingMtdCommand(flags);
    } else if (subcommand === 'invoice') {
      expectArgs(ctx, 1);
      await billingInvoiceCommand(flags);
    } else if (subcommand === 'export') {
      expectArgs(ctx, 1);
      await billingExportCommand(flags);
    } else if (subcommand === 'charges') {
      expectArgs(ctx, 1);
      await billingChargesCommand(flags);
    } else {
      throw new UsageError(
        `Unknown billing subcommand "${subcommand}". Use: mtd, invoice, export, charges.`,
      );
    }
  },
};
