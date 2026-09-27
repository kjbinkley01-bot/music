import { api } from '../api';
import type { StemName, Track } from '../types';
import { audioContext } from './context';

export const PEAKS_PER_SEC = 200;

export interface LoadedSource {
  name: StemName | 'original';
  buffer: AudioBuffer;
  peaks: Float32Array;
}

/** Max-abs peaks at PEAKS_PER_SEC resolution, from both channels. */
export function computePeaks(buffer: AudioBuffer): Float32Array {
  const step = Math.max(1, Math.round(buffer.sampleRate / PEAKS_PER_SEC));
  const bins = Math.ceil(buffer.length / step);
  const out = new Float32Array(bins);
  const chans = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c));
  for (const data of chans) {
    for (let b = 0; b < bins; b++) {
      let m = out[b];
      const end = Math.min(data.length, (b + 1) * step);
      for (let i = b * step; i < end; i += 2) {
        const v = data[i] < 0 ? -data[i] : data[i];
        if (v > m) m = v;
      }
      out[b] = m;
    }
  }
  return out;
}

async function decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
  return audioContext().decodeAudioData(bytes);
}

/**
 * Load a track's stems (or the original file when it hasn't been separated).
 * `onProgress` receives 0..1 as each source finishes decoding.
 */
export async function loadTrackSources(
  track: Track,
  onProgress?: (p: number) => void,
  preferStems = true,
): Promise<LoadedSource[]> {
  const names: (StemName | 'original')[] = preferStems && track.stems.length ? track.stems : ['original'];
  let done = 0;
  return Promise.all(
    names.map(async (name) => {
      const bytes = name === 'original' ? await api.audio(track.id) : await api.stem(track.id, name);
      const buffer = await decode(bytes);
      const peaks = computePeaks(buffer);
      onProgress?.(++done / names.length);
      return { name, buffer, peaks };
    }),
  );
}

export async function decodeBytes(bytes: ArrayBuffer): Promise<AudioBuffer> {
  return decode(bytes);
}

/** Float32 -> Int16 copy (halves memory inside the deck worklet). */
export function toInt16(data: Float32Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    out[i] = v <= -1 ? -32768 : v >= 1 ? 32767 : v * 32767;
  }
  return out;
}

/** Sum of several peak arrays (used for a combined waveform overview). */
export function sumPeaks(list: Float32Array[]): Float32Array {
  const len = Math.max(0, ...list.map((p) => p.length));
  const out = new Float32Array(len);
  for (const p of list) for (let i = 0; i < p.length; i++) out[i] += p[i];
  let max = 0;
  for (let i = 0; i < len; i++) if (out[i] > max) max = out[i];
  if (max > 1) for (let i = 0; i < len; i++) out[i] /= max;
  return out;
}
