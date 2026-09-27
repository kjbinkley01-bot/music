import { api } from '../api';
import { audioContext, masterBus } from './context';
import { decodeBytes } from './loader';

/** Built-in drum kit, synthesised on first use so the app ships without sample files. */
export const BUILTIN_SOUNDS = ['Kick', 'Snare', 'Clap', 'Closed Hat', 'Open Hat', 'Rim', 'Tom', 'Crash'] as const;
export type BuiltinSound = (typeof BUILTIN_SOUNDS)[number];

const cache = new Map<string, Promise<AudioBuffer>>();

function noise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

async function synth(name: BuiltinSound): Promise<AudioBuffer> {
  const sr = audioContext().sampleRate;
  const len = name === 'Crash' ? 2.2 : name === 'Open Hat' ? 0.6 : name === 'Kick' || name === 'Tom' ? 0.7 : 0.35;
  const ctx = new OfflineAudioContext(1, Math.ceil(sr * len), sr);
  const t = 0;
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const env = (g: GainNode, peak: number, decay: number) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  };
  const noiseSrc = (hp: number, lp = 18000) => {
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx, len);
    const h = ctx.createBiquadFilter();
    h.type = 'highpass';
    h.frequency.value = hp;
    const l = ctx.createBiquadFilter();
    l.type = 'lowpass';
    l.frequency.value = lp;
    src.connect(h).connect(l);
    src.start(t);
    return l;
  };
  const tone = (from: number, to: number, sweep: number, type: OscillatorType = 'sine') => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + sweep);
    o.start(t);
    return o;
  };
  switch (name) {
    case 'Kick': {
      const g = ctx.createGain();
      env(g, 1, 0.55);
      tone(160, 45, 0.12).connect(g).connect(out);
      const click = ctx.createGain();
      env(click, 0.3, 0.02);
      noiseSrc(1500).connect(click).connect(out);
      break;
    }
    case 'Snare': {
      const g = ctx.createGain();
      env(g, 0.6, 0.18);
      tone(240, 160, 0.08, 'triangle').connect(g).connect(out);
      const n = ctx.createGain();
      env(n, 0.7, 0.25);
      noiseSrc(1200, 9000).connect(n).connect(out);
      break;
    }
    case 'Clap': {
      const src = noiseSrc(900, 5000);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      for (const [dt, peak] of [[0, 0.8], [0.012, 0.7], [0.024, 0.9]] as const) {
        g.gain.setValueAtTime(peak, t + dt);
        g.gain.exponentialRampToValueAtTime(0.05, t + dt + 0.01);
      }
      g.gain.setValueAtTime(0.7, t + 0.036);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      src.connect(g).connect(out);
      break;
    }
    case 'Closed Hat': {
      const g = ctx.createGain();
      env(g, 0.5, 0.06);
      noiseSrc(7000).connect(g).connect(out);
      break;
    }
    case 'Open Hat': {
      const g = ctx.createGain();
      env(g, 0.45, 0.5);
      noiseSrc(6500).connect(g).connect(out);
      break;
    }
    case 'Rim': {
      const g = ctx.createGain();
      env(g, 0.6, 0.05);
      tone(1700, 1600, 0.02, 'square').connect(g).connect(out);
      break;
    }
    case 'Tom': {
      const g = ctx.createGain();
      env(g, 0.9, 0.45);
      tone(220, 90, 0.3).connect(g).connect(out);
      break;
    }
    case 'Crash': {
      const g = ctx.createGain();
      env(g, 0.5, 2.1);
      noiseSrc(4000, 16000).connect(g).connect(out);
      break;
    }
  }
  return ctx.startRendering();
}

/** Resolve a drum sound reference: 'builtin:Kick' or 'sample:12'. */
export function drumBuffer(ref: string): Promise<AudioBuffer> {
  let p = cache.get(ref);
  if (!p) {
    const [kind, value] = ref.split(':');
    p =
      kind === 'sample'
        ? api.sampleAudio(Number(value)).then(decodeBytes)
        : synth((BUILTIN_SOUNDS as readonly string[]).includes(value) ? (value as BuiltinSound) : 'Kick');
    p.catch(() => cache.delete(ref));
    cache.set(ref, p);
  }
  return p;
}

export function previewDrum(ref: string, gain = 1) {
  void drumBuffer(ref).then((buf) => {
    const ctx = audioContext();
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    g.gain.value = gain;
    src.buffer = buf;
    src.connect(g).connect(masterBus());
    src.start();
  });
}
