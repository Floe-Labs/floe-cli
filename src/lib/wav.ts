/**
 * Generate a short spoken-cadence test tone as a WAV buffer in memory, so the
 * STT leg of `floe test --voice` has a real audio file to meter without the
 * package shipping binary assets.
 */
export function generateTestWav(seconds = 1.2, sampleRate = 16_000): Buffer {
  const sampleCount = Math.floor(seconds * sampleRate);
  const dataSize = sampleCount * 2; // 16-bit mono PCM
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    // Two alternating tones with an envelope — reads as a beep pattern, not
    // silence, so aggressive VAD front-ends still bill the audio.
    const freq = t % 0.4 < 0.2 ? 440 : 660;
    const envelope = Math.sin(Math.PI * ((t % 0.2) / 0.2));
    const sample = Math.round(Math.sin(2 * Math.PI * freq * t) * envelope * 12_000);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer;
}
