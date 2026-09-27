import type { Key } from '../music';
import type { StemName } from '../types';
import { BUILTIN_SOUNDS } from '../audio/drums';

export type TrackKind = 'audio' | 'drums' | 'fx';
export type SourceStem = StemName | 'original';

export interface AutoPoint {
  beat: number;
  value: number; // -1 (low pass) .. +1 (high pass)
}

interface ClipBase {
  id: string;
  start: number; // beats
  length: number; // beats
  gain: number;
}

export interface AudioClip extends ClipBase {
  type: 'audio';
  trackId: number; // library track
  stem: SourceStem;
  offset: number; // beats into the source, measured from the source's first beat
  semitones: number;
  loopLen: number | null; // beats; repeats [offset, offset+loopLen) to fill the clip
}

export interface PatternClip extends ClipBase {
  type: 'pattern';
  patternId: string;
}

export interface RiserClip extends ClipBase {
  type: 'riser';
  variant: 'riser' | 'downlifter' | 'impact';
}

export type Clip = AudioClip | PatternClip | RiserClip;

export interface RemixTrack {
  id: string;
  name: string;
  kind: TrackKind;
  color: string;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  reverb: number;
  delay: number;
  filter: number;
  auto: AutoPoint[];
  autoOn: boolean;
  showAuto: boolean;
  clips: Clip[];
}

export interface DrumVoice {
  name: string;
  ref: string; // 'builtin:Kick' | 'sample:<id>'
  gain: number;
}

export interface DrumPattern {
  id: string;
  name: string;
  steps: number[][]; // [voice][16 steps] velocity 0..1
}

export interface RemixProject {
  version: 1;
  name: string;
  bpm: number;
  key: Key | null;
  swing: number;
  loop: { start: number; end: number } | null;
  loopOn: boolean;
  masterVolume: number;
  reverbSize: number;
  delayDivision: number; // in beats (0.5 = 1/8 note)
  delayFeedback: number;
  tracks: RemixTrack[];
  voices: DrumVoice[];
  patterns: DrumPattern[];
}

export const STEPS = 16;
export const TRACK_COLORS = ['#35d9c8', '#ff5c9a', '#ffb547', '#8b7bff', '#5fb4ff', '#9be15d', '#ff7d4d', '#e36bff'];

export const uid = () => Math.random().toString(36).slice(2, 10);

export function newPattern(name: string, voices: number): DrumPattern {
  return { id: uid(), name, steps: Array.from({ length: voices }, () => new Array(STEPS).fill(0)) };
}

export function newTrack(kind: TrackKind, name: string, index: number): RemixTrack {
  return {
    id: uid(),
    name,
    kind,
    color: kind === 'drums' ? '#ffb547' : kind === 'fx' ? '#9be15d' : TRACK_COLORS[index % TRACK_COLORS.length],
    volume: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    reverb: 0,
    delay: 0,
    filter: 0,
    auto: [],
    autoOn: true,
    showAuto: false,
    clips: [],
  };
}

export function newProject(bpm = 124): RemixProject {
  const voices: DrumVoice[] = BUILTIN_SOUNDS.map((name) => ({ name, ref: `builtin:${name}`, gain: 0.8 }));
  const basic = newPattern('Four on the floor', voices.length);
  [0, 4, 8, 12].forEach((s) => (basic.steps[0][s] = 1));
  [4, 12].forEach((s) => (basic.steps[2][s] = 0.9));
  [2, 6, 10, 14].forEach((s) => (basic.steps[4][s] = 0.7));
  return {
    version: 1,
    name: 'Untitled remix',
    bpm,
    key: null,
    swing: 0,
    loop: { start: 0, end: 16 },
    loopOn: false,
    masterVolume: 0.9,
    reverbSize: 2.2,
    delayDivision: 0.75,
    delayFeedback: 0.35,
    tracks: [newTrack('audio', 'Stems 1', 0), newTrack('audio', 'Stems 2', 1), newTrack('drums', 'Drums', 2), newTrack('fx', 'FX', 3)],
    voices,
    patterns: [basic, newPattern('Pattern B', voices.length)],
  };
}

export function clipEnd(c: Clip) {
  return c.start + c.length;
}

export function projectLength(p: RemixProject): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

/** Interpolated automation value at a beat (holds first/last values outside the points). */
export function autoValueAt(points: AutoPoint[], beat: number, fallback: number): number {
  if (!points.length) return fallback;
  if (beat <= points[0].beat) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (beat <= b.beat) {
      const a = points[i - 1];
      const t = b.beat === a.beat ? 1 : (beat - a.beat) / (b.beat - a.beat);
      return a.value + (b.value - a.value) * t;
    }
  }
  return points[points.length - 1].value;
}

/** Filter knob value -> [lowpass Hz, highpass Hz, Q]. Shared by DJ decks and remix tracks. */
export function filterFreqs(v: number): [number, number, number] {
  const dead = 0.04;
  const lp = v < -dead ? 20000 * Math.pow(150 / 20000, (-v - dead) / (1 - dead)) : 22000;
  const hp = v > dead ? 10 * Math.pow(6000 / 10, (v - dead) / (1 - dead)) : 10;
  return [lp, hp, Math.abs(v) > dead ? 1.2 : 0.707];
}

export function barsBeats(beat: number): string {
  const b = Math.max(0, beat);
  const bar = Math.floor(b / 4) + 1;
  const bt = Math.floor(b % 4) + 1;
  const six = Math.floor((b % 1) * 4) + 1;
  return `${bar}.${bt}.${six}`;
}
