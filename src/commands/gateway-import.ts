import { existsSync, readFileSync, statSync } from 'node:fs';
import { devContext } from '../lib/context.js';
import { kv, ok, printJson, sanitizeText, UsageError, warn } from '../lib/output.js';

/**
 * `floe gateway import <slug> <file>` — POST /v1/developer/ext-gateway/connections/:slug/imports
 * (≤ 10 MiB, all-or-nothing). Prints the API's counts and, when the import
 * held rows because their payer has no settlement mode (L1.13), names those
 * payers and the command that declares them.
 */

const MAX_BYTES = 10 * 1024 * 1024;

interface ImportOutcome {
  import: {
    id: string;
    profileVersion: number;
    rowCount: number;
    inserted: number;
    duplicates: number;
    skipped: number;
    superseded: string[];
    quarantinedPayer?: { rows: number; cost: { micro: string; display: string }; billedBy: string[] };
  };
  slots: number;
}

export interface GatewayImportFlags {
  apiUrl?: string;
  json?: boolean;
  replace?: boolean;
  windowStart?: string;
  windowEnd?: string;
}

export async function gatewayImportCommand(slug: string, file: string, flags: GatewayImportFlags): Promise<void> {
  if (!existsSync(file)) throw new UsageError(`No such file: ${file}`);
  if (statSync(file).size > MAX_BYTES) throw new UsageError('The file is over 10 MiB: the API takes larger files as uploads.');
  const { api } = await devContext(flags);
  const q = new URLSearchParams();
  if (flags.replace) q.set('mode', 'replace');
  if (flags.windowStart) q.set('window_start', flags.windowStart);
  if (flags.windowEnd) q.set('window_end', flags.windowEnd);
  const qs = q.toString();
  const type = /\.csv$/i.test(file) ? 'text/csv' : 'application/x-ndjson';
  const path = `/v1/developer/ext-gateway/connections/${encodeURIComponent(slug)}/imports${qs ? `?${qs}` : ''}`;
  const res = await api.devFile<ImportOutcome>('POST', path, new Uint8Array(readFileSync(file)), type);
  if (flags.json) {
    printJson(res);
    return;
  }
  const i = res.import;
  const out = [
    ok(`Imported ${sanitizeText(file)} into ${sanitizeText(slug)} (${sanitizeText(i.id)}, profile v${i.profileVersion}).`),
    kv([
      ['Rows', String(i.rowCount)],
      ['Inserted', String(i.inserted)],
      ['Duplicates', String(i.duplicates)],
      ['Skipped', String(i.skipped)],
      ['Superseded', i.superseded.length ? i.superseded.map(sanitizeText).join(', ') : '—'],
      ['Slots queued', String(res.slots)],
    ]),
  ];
  const held = i.quarantinedPayer;
  if (held && held.rows > 0) {
    out.push(warn(`${held.rows} rows (${sanitizeText(held.cost.display)}) held: payers with no declared settlement mode (${held.billedBy.map(sanitizeText).join(', ')}). Declare them with floe gateway declare-mode ${sanitizeText(slug)} <billed-by> <mode>, then release them with floe gateway release-held ${sanitizeText(slug)}.`));
  }
  process.stdout.write(`${out.join('\n')}\n`);
}
