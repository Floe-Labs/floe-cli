import { describe, expect, it } from 'vitest';
import { rawToUsd, usdToRaw } from '../src/lib/usdc.js';

describe('usdToRaw', () => {
  it('converts whole dollars', () => {
    expect(usdToRaw('5')).toBe('5000000');
    expect(usdToRaw('$5')).toBe('5000000');
  });

  it('converts decimals without float error', () => {
    expect(usdToRaw('0.50')).toBe('500000');
    expect(usdToRaw('0.1')).toBe('100000');
    expect(usdToRaw('1.25')).toBe('1250000');
    expect(usdToRaw('0.000001')).toBe('1');
  });

  it('rejects junk, negatives, zero and >6 decimals', () => {
    expect(() => usdToRaw('abc')).toThrow();
    expect(() => usdToRaw('-5')).toThrow();
    expect(() => usdToRaw('0')).toThrow();
    expect(() => usdToRaw('0.0000001')).toThrow();
    expect(() => usdToRaw('')).toThrow();
  });
});

describe('rawToUsd', () => {
  it('formats atomic USDC', () => {
    expect(rawToUsd('5000000')).toBe('$5.00');
    expect(rawToUsd('1250000')).toBe('$1.25');
    expect(rawToUsd('123')).toBe('$0.000123');
    expect(rawToUsd('0')).toBe('$0.00');
  });

  it('handles missing and malformed values', () => {
    expect(rawToUsd(null)).toBe('—');
    expect(rawToUsd(undefined)).toBe('—');
    expect(rawToUsd('not-a-number')).toBe('—');
  });

  it('round-trips with usdToRaw', () => {
    expect(rawToUsd(usdToRaw('5'))).toBe('$5.00');
    expect(rawToUsd(usdToRaw('0.50'))).toBe('$0.50');
    expect(rawToUsd(usdToRaw('123.456789'))).toBe('$123.456789');
  });
});
