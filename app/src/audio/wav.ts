/** Encode an AudioBuffer as a 16-bit PCM WAV blob (normalising only if it would clip). */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let peak = 0;
  for (const ch of data) for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(ch[i]));
  const scale = peak > 0.999 ? 0.999 / peak : 1;

  const bytes = 44 + frames * channels * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, frames * channels * 2, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i] * scale));
      view.setInt16(o, v < 0 ? v * 32768 : v * 32767, true);
      o += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}
