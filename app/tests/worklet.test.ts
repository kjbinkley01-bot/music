import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Load the AudioWorklet source into Node with minimal fakes for the worklet globals. */
function loadProcessors(sampleRate = 48000) {
  const registry: Record<string, new () => any> = {};
  class AudioWorkletProcessor {
    port = { postMessage: (_m: unknown) => undefined, onmessage: null as null | ((e: { data: unknown }) => void) };
  }
  const src = readFileSync(new URL('../src/audio/deck-worklet.js', import.meta.url), 'utf8');
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', src)(
    AudioWorkletProcessor,
    (name: string, cls: new () => any) => (registry[name] = cls),
    sampleRate,
  );
  return registry;
}

function sineInt16(freq: number, seconds: number, sr: number) {
  const n = Math.round(seconds * sr);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 12000);
  return a;
}

function render(proc: any, blocks: number) {
  const out: number[] = [];
  for (let b = 0; b < blocks; b++) {
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    proc.process([], [[l, r]]);
    out.push(...l);
  }
  return Float32Array.from(out);
}

function zeroCrossRate(x: Float32Array, sr: number) {
  let n = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++;
  return (n / 2) * (sr / x.length);
}

describe('DeckProcessor', () => {
  const sr = 48000;
  const setup = (keyLock: boolean, rate: number) => {
    const Deck = loadProcessors(sr)['deck-processor'];
    const proc = new Deck();
    const l = sineInt16(440, 4, sr);
    proc.onMessage({ type: 'load', stems: [{ l, r: l }], length: l.length, gains: [1] });
    proc.onMessage({ type: 'keylock', on: keyLock });
    proc.onMessage({ type: 'rate', rate });
    proc.onMessage({ type: 'play' });
    return proc;
  };

  it('key lock changes tempo but keeps pitch', () => {
    const proc = setup(true, 1.25);
    const out = render(proc, 375); // 1 s of output
    const tail = out.slice(4800);
    expect(zeroCrossRate(tail, sr)).toBeGreaterThan(420);
    expect(zeroCrossRate(tail, sr)).toBeLessThan(460);
    expect(proc.pos / sr).toBeGreaterThan(1.2); // consumed ~1.25 s of source
    expect(proc.pos / sr).toBeLessThan(1.32);
    // no dropouts: the envelope stays up once running
    let minPeak = Infinity;
    for (let i = 4800; i + 480 < out.length; i += 480) {
      let pk = 0;
      for (let j = i; j < i + 480; j++) pk = Math.max(pk, Math.abs(out[j]));
      minPeak = Math.min(minPeak, pk);
    }
    expect(minPeak).toBeGreaterThan(0.25);
  });

  it('varispeed changes pitch with tempo', () => {
    const proc = setup(false, 1.25);
    const out = render(proc, 375);
    expect(zeroCrossRate(out, sr)).toBeGreaterThan(530);
    expect(zeroCrossRate(out, sr)).toBeLessThan(570);
  });

  it('loops inside the loop region', () => {
    const proc = setup(true, 1);
    proc.onMessage({ type: 'loop', start: 0, end: sr * 0.5, jump: true });
    render(proc, 750); // 2 s
    expect(proc.pos).toBeLessThan(sr * 0.5 + 2048);
  });

  it('mutes stems via gains', () => {
    const proc = setup(false, 1);
    proc.onMessage({ type: 'gains', gains: [0] });
    const out = render(proc, 200);
    let pk = 0;
    for (let i = 4000; i < out.length; i++) pk = Math.max(pk, Math.abs(out[i]));
    expect(pk).toBeLessThan(0.001);
  });
});
