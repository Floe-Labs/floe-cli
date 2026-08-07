import { UsageError } from './output.js';

const DURATION = /^(\d+)([smhdw])$/;

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 };

/**
 * Parse a human window ("30m", "24h", "7d") into seconds for the API's
 * windowSeconds fields. "once" is a distinct policy window kind, not a
 * duration — callers that accept it handle the string before calling this.
 */
export function parseDuration(input: string): number {
  const match = DURATION.exec(input.trim());
  if (!match) {
    throw new UsageError(
      `Invalid duration "${input}" — use <number><unit> with unit s/m/h/d/w, e.g. 24h or 7d.`,
    );
  }
  const seconds = Number.parseInt(match[1]!, 10) * UNIT_SECONDS[match[2]!]!;
  // A huge but syntactically valid value (e.g. "99999999999999999999w") overflows
  // to a non-safe integer / Infinity, which JSON.stringify emits as null — the API
  // would then apply a different window than the operator asked for. Reject it.
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new UsageError('Duration must be a positive, safely representable number of seconds.');
  }
  return seconds;
}
