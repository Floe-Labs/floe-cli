import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { expectArgs, flag, str, type CommandDef } from '../lib/command.js';
import { devContext } from '../lib/context.js';
import { bold, dim, green, kv, ok, printJson, red, sanitizeText, UsageError, warn } from '../lib/output.js';
import { decodeChunks, headerLabel, validateGatewayFile, type ValidationReport } from '../gateway/vendor/validator.mjs';

/**
 * `floe gateway validate <file>` — check a gateway export against Floe's
 * canonical contract (floe-canonical-ndjson@3 / floe-canonical-csv@1) or a
 * built-in template BEFORE importing it. Stores nothing.
 *
 * OFFLINE by default: the file never leaves the machine. The validator is the
 * API's own code, vendored (src/gateway/vendor/, scripts/sync-gateway-validator.sh),
 * so it gives the same answer as `--online` except the two checks that need
 * your account (printed as caveats). `--online` posts the file to
 * POST /v1/developer/ext-gateway/validate (≤ 10 MiB).
 *
 * Neither mode prints a row's content: only header names, counts, reason
 * codes and row numbers.
 */

const ONLINE_MAX_BYTES = 10 * 1024 * 1024;
export const OFFLINE_CAVEATS = [
  'offline: ids already imported on your account are not checked (run with --online)',
  'offline: people are not resolved against your account (run with --online)',
];

interface OnlineExtras {
  duplicateIds: ValidationReport['duplicateIds'] & {
    alreadyImported: { count: number; rows: number[]; truncated: boolean; byConnection: Record<string, number> };
  };
  people: { distinct: number; known: number };
  meteredByFloe: { count: number; rows: number[]; truncated: boolean };
  idModeMismatch: { connection: 'present' | 'derived'; file: 'present' | 'derived' } | null;
}
type OnlineReport = Omit<ValidationReport, 'duplicateIds'> & OnlineExtras;

export interface GatewayValidateFlags {
  apiUrl?: string;
  json?: boolean;
  online?: boolean;
  template?: string;
  connection?: string;
}

async function offline(file: string, template: string | undefined): Promise<ValidationReport> {
  const { report } = await validateGatewayFile({
    text: () => decodeChunks(createReadStream(file, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Uint8Array>),
    ...(template ? { template } : {}),
  });
  return report;
}

async function online(file: string, flags: GatewayValidateFlags): Promise<OnlineReport> {
  if (statSync(file).size > ONLINE_MAX_BYTES) {
    throw new UsageError('The file is over 10 MiB: validate it offline (drop --online).');
  }
  const { api } = await devContext(flags);
  const q = new URLSearchParams();
  if (flags.template) q.set('template', flags.template);
  if (flags.connection) q.set('connection', flags.connection);
  const qs = q.toString();
  const type = /\.csv$/i.test(file) ? 'text/csv' : 'application/x-ndjson';
  return api.devFile<OnlineReport>('POST', `/v1/developer/ext-gateway/validate${qs ? `?${qs}` : ''}`, new Uint8Array(readFileSync(file)), type);
}

const names = (xs: string[]) => xs.map((x) => sanitizeText(x)).join(', ');
const rowList = (rows: number[], truncated: boolean) => `rows ${rows.join(', ')}${truncated ? ', …' : ''}`;

function render(r: ValidationReport | OnlineReport, mode: 'offline' | 'online'): string {
  const out: string[] = [];
  const read = r.profile
    ? `${sanitizeText(r.profile.template)} (${r.profile.source.replace('_', ' ')}${r.bestTemplate && r.profile.source === 'best_match' ? `, score ${r.bestTemplate.score}` : ''})`
    : dim('—');
  const counts = `export ${r.exportRowCount} · Floe ${r.floeRowCount}  ${r.rowCountMatches ? green('counts match') : red('counts differ')}`;
  out.push(kv([
    ['Mode', mode],
    ['Format', r.format],
    ['Read with', read],
    ['Rows', counts],
    ['Ids', r.ids ?? dim('—')],
    ['Headers', `${r.headers.mapped.length} mapped · ${r.headers.ignored.length} ignored · ${r.headers.unmapped.length} unmapped`],
    ['Refused rows', r.refusedRows === null ? dim('not checked') : String(r.refusedRows.count)],
  ]));
  if (r.fileError) out.push(red(`File error: ${sanitizeText(r.fileError.error)} — ${sanitizeText(r.fileError.detail)}`));
  if (r.headers.unmapped.length) out.push(`${bold('Unmapped headers:')} ${names(r.headers.unmapped)}`);
  if (r.headers.missingRequired.length) out.push(`${bold('Missing required:')} ${names(r.headers.missingRequired)}`);
  if (r.refusedRows && r.refusedRows.count > 0) {
    out.push(bold('Refused rows by reason:'));
    for (const [reason, n] of Object.entries(r.refusedRows.reasons)) out.push(`  ${sanitizeText(reason)}  ${n}`);
    for (const x of r.refusedRows.rows) out.push(dim(`  row ${x.row}: ${sanitizeText(x.reason)}${x.field ? ` (${sanitizeText(x.field)})` : ''}`));
    if (r.refusedRows.truncated) out.push(dim('  …'));
  }
  if (r.skippedRows.count > 0) out.push(`${bold('Skipped rows:')} ${Object.entries(r.skippedRows.reasons).map(([k, n]) => `${sanitizeText(k)} ${n}`).join(', ')}`);
  const dup = r.duplicateIds.inFile;
  if (dup.count > 0) out.push(`${bold('Repeated ids in the file:')} ${dup.count} (${rowList(dup.rows, dup.truncated)})`);
  if ('people' in r) {
    const a = r.duplicateIds.alreadyImported;
    if (a.count > 0) {
      const by = Object.entries(a.byConnection).map(([slug, n]) => `${sanitizeText(slug)} ${n}`).join(', ');
      out.push(`${bold('Ids already imported:')} ${a.count} (${rowList(a.rows, a.truncated)}; ${by})`);
    }
    out.push(`${bold('People:')} ${r.people.distinct} distinct, ${r.people.known} already known`);
    const m = r.meteredByFloe;
    if (m && m.count > 0) out.push(red(`Floe-metered rows (refused on import): ${m.count} (${rowList(m.rows, m.truncated)})`));
    if (r.idModeMismatch) out.push(red(`Id mode: this connection's imports are ${r.idModeMismatch.connection}, this file's ids are ${r.idModeMismatch.file} (refused on import)`));
  }
  for (const n of r.notes) out.push(warn(sanitizeText(n)));
  if (mode === 'offline') for (const c of OFFLINE_CAVEATS) out.push(warn(c));
  out.push(r.valid ? ok('valid: Floe would import every row of this export') : red('✗ not valid'));
  return `${out.join('\n')}\n`;
}

export async function gatewayValidateCommand(file: string, flags: GatewayValidateFlags): Promise<void> {
  if (!existsSync(file)) throw new UsageError(`No such file: ${file}`);
  if (flags.connection && !flags.online) throw new UsageError('--connection reads your connection\'s profile: add --online.');
  if (flags.connection && flags.template) throw new UsageError('--connection and --template are exclusive.');
  let report: ValidationReport | OnlineReport;
  try {
    report = flags.online ? await online(file, flags) : await offline(file, flags.template);
  } catch (err) {
    const e = err as { code?: string; detail?: string };
    if (e.code === 'unknown_template') throw new UsageError(e.detail ?? 'Unknown template.');
    throw err;
  }
  // CFO B1: mask value-like header names in text AND --json, whichever side produced the report.
  const mask = (xs: string[]) => xs.map((x, i) => headerLabel(x, i, report.format));
  report = { ...report, headers: { ...report.headers, unmapped: mask(report.headers.unmapped), ignored: mask(report.headers.ignored) } };
  const mode = flags.online ? 'online' : 'offline';
  if (flags.json) printJson({ mode, ...report, ...(mode === 'offline' ? { caveats: OFFLINE_CAVEATS } : {}) });
  else process.stdout.write(render(report, mode));
  if (!report.valid) process.exitCode = 1;
}

export const gatewayDef: CommandDef = {
  name: 'gateway',
  summary: 'validate <file> — check a gateway export before importing it',
  usage: `Usage: floe gateway validate <file> [--online] [--template <id>] [--connection <slug>]

Check a gateway export (NDJSON or CSV) against Floe's canonical contract
(floe-canonical-ndjson@3, floe-canonical-csv@1) or a built-in template, before
importing it. Stores nothing, and never prints a row's content: only header
names, counts, reason codes and row numbers.

  (default)            Offline: the file never leaves this machine. Same checks
                       as --online except ids already imported and people.
  --online             Validate with your account (POST /v1/developer/ext-gateway/validate,
                       ≤ 10 MiB): also ids already imported and known people.
  --template <id>      Read with this template (default: the best match).
  --connection <slug>  Read with a connection's profile (needs --online).

Valid = every header mapped, no refused or repeated row, and Floe's row count
equals the export's. Exit code 1 when the file is not valid.
JSON Schema of the contract: https://credit-api.floelabs.xyz/v1/ext-gateway/contract/3
`,
  options: {
    online: { type: 'boolean' },
    template: { type: 'string' },
    connection: { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand, file] = ctx.args;
    if (subcommand !== 'validate') throw new UsageError(`Unknown gateway subcommand "${subcommand ?? ''}". Use: validate <file>.`);
    expectArgs(ctx, 2);
    if (!file) throw new UsageError('Name the export file: floe gateway validate <file>.');
    await gatewayValidateCommand(file, {
      apiUrl: ctx.apiUrl, json: ctx.json, online: flag(ctx, 'online'), template: str(ctx, 'template'), connection: str(ctx, 'connection'),
    });
  },
};
