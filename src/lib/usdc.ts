/**
 * USDC amounts cross the API as raw atomic strings (6 decimals). All
 * conversion is done in string/bigint math — never floats — so "0.1" can't
 * turn into 99999.
 */

import { UsageError } from './output.js';

const USD_INPUT = /^\$?(\d+)(?:\.(\d{1,6}))?$/;

/** "5", "0.50", "$1.25" → "5000000", "500000", "1250000". UsageError on anything else. */
export function usdToRaw(input: string): string {
  const match = USD_INPUT.exec(input.trim());
  if (!match) {
    throw new UsageError(
      `Invalid USD amount "${input}" — use a plain number with up to 6 decimals, e.g. 5 or 0.50`,
    );
  }
  const whole = match[1] ?? '0';
  const frac = (match[2] ?? '').padEnd(6, '0');
  const raw = BigInt(whole) * 1_000_000n + BigInt(frac);
  if (raw <= 0n) throw new UsageError('Amount must be greater than zero');
  return raw.toString();
}

/** "1250000" → "$1.25"; "123" → "$0.000123". Trims trailing zeros but keeps cents. */
export function rawToUsd(raw: string | bigint | null | undefined): string {
  if (raw === null || raw === undefined) return '—';
  let value: bigint;
  try {
    value = typeof raw === 'bigint' ? raw : BigInt(raw);
  } catch {
    return '—';
  }
  const negative = value < 0n;
  if (negative) value = -value;
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n).toString().padStart(6, '0');
  const trimmed = frac.replace(/0+$/, '');
  const fracOut = trimmed.length <= 2 ? frac.slice(0, 2) : trimmed;
  return `${negative ? '-' : ''}$${whole}.${fracOut}`;
}
