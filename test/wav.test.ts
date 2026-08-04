import { describe, expect, it } from 'vitest';
import { generateTestWav } from '../src/lib/wav.js';

describe('generateTestWav', () => {
  it('produces a valid RIFF/WAVE header with correct sizes', () => {
    const wav = generateTestWav(1.2, 16_000);
    const samples = Math.floor(1.2 * 16_000);
    expect(wav.length).toBe(44 + samples * 2);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(4)).toBe(36 + samples * 2);
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000); // sample rate
    expect(wav.readUInt32LE(40)).toBe(samples * 2); // data chunk size
  });

  it('is not silence', () => {
    const wav = generateTestWav(0.5, 8_000);
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) {
      peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    }
    expect(peak).toBeGreaterThan(5_000);
  });
});
