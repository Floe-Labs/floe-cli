import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/lib/duration.js';
import { UsageError } from '../src/lib/output.js';

describe('parseDuration', () => {
  it('parses <number><unit> into seconds', () => {
    expect(parseDuration('30s')).toBe(30);
    expect(parseDuration('30m')).toBe(1_800);
    expect(parseDuration('24h')).toBe(86_400);
    expect(parseDuration('7d')).toBe(604_800);
    expect(parseDuration('2w')).toBe(1_209_600);
    expect(parseDuration(' 24h ')).toBe(86_400); // trimmed
  });

  it('rejects malformed inputs', () => {
    for (const bad of ['', 'abc', '10', 'h', '1x', '-5m', '1.5h', 'once']) {
      expect(() => parseDuration(bad)).toThrow(UsageError);
    }
  });

  it('rejects a huge but syntactically valid value instead of overflowing to a non-safe integer', () => {
    // Would multiply to > Number.MAX_SAFE_INTEGER → JSON would emit null and the
    // API would apply the wrong window. Must be a UsageError, not a silent value.
    expect(() => parseDuration('99999999999999999999w')).toThrow(UsageError);
    expect(() => parseDuration(`${Number.MAX_SAFE_INTEGER}w`)).toThrow(UsageError);
  });
});
