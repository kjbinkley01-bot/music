// Music theory and formatting helpers shared by every view.

export const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]; // indexed by pitch class
const MINOR_CAMELOT = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

export type Mode = 'major' | 'minor';
export interface Key {
  pc: number;
  mode: Mode;
}

export function keyName(k: Key | null): string {
  if (!k) return '';
  return NOTE_NAMES[((k.pc % 12) + 12) % 12] + (k.mode === 'minor' ? 'm' : '');
}

export function camelotOf(k: Key | null): { num: number; letter: 'A' | 'B' } | null {
  if (!k) return null;
  const pc = ((k.pc % 12) + 12) % 12;
  return k.mode === 'minor' ? { num: MINOR_CAMELOT[pc], letter: 'A' } : { num: MAJOR_CAMELOT[pc], letter: 'B' };
}

export function camelotName(k: Key | null): string {
  const c = camelotOf(k);
  return c ? `${c.num}${c.letter}` : '';
}

export function trackKey(t: { key_pc: number | null; key_mode: Mode | null }): Key | null {
  return t.key_pc == null || !t.key_mode ? null : { pc: t.key_pc, mode: t.key_mode };
}

/** 'perfect' = same key, 'good' = adjacent on the Camelot wheel or relative major/minor. */
export function keyCompatibility(a: Key | null, b: Key | null): 'perfect' | 'good' | 'clash' | 'unknown' {
  const ca = camelotOf(a);
  const cb = camelotOf(b);
  if (!ca || !cb) return 'unknown';
  if (ca.num === cb.num && ca.letter === cb.letter) return 'perfect';
  const dist = Math.min((ca.num - cb.num + 12) % 12, (cb.num - ca.num + 12) % 12);
  if (ca.letter === cb.letter && dist === 1) return 'good';
  if (ca.num === cb.num) return 'good';
  return 'clash';
}

/** Key after pitch shifting by a number of semitones. */
export function shiftKey(k: Key | null, semitones: number): Key | null {
  if (!k) return null;
  return { pc: (((k.pc + Math.round(semitones)) % 12) + 12) % 12, mode: k.mode };
}

/** Smallest shift (-6..+5 semitones) that puts `src` on the same Camelot number as `dst`. */
export function semitonesToMatch(src: Key | null, dst: Key | null): number {
  if (!src || !dst) return 0;
  const rel = (k: Key) => (k.mode === 'minor' ? k.pc + 3 : k.pc);
  const diff = (((rel(dst) - rel(src)) % 12) + 12) % 12;
  return diff > 5 ? diff - 12 : diff;
}

/** Whether two tempos can be beat-matched, allowing half/double time. Returns ratio or null. */
export function bpmMatch(a: number | null, b: number | null, tolerance = 0.08): number | null {
  if (!a || !b) return null;
  for (const mult of [1, 2, 0.5]) {
    const r = (b * mult) / a;
    if (Math.abs(r - 1) <= tolerance) return r;
  }
  return null;
}

export function fmtTime(sec: number, showMs = false): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const base = `${m}:${s.toString().padStart(2, '0')}`;
  return showMs ? `${base}.${Math.floor((sec % 1) * 10)}` : base;
}

export function fmtBpm(bpm: number | null | undefined): string {
  if (!bpm) return '—';
  return Number.isInteger(bpm) ? bpm.toFixed(0) : bpm.toFixed(1);
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const dbToGain = (db: number) => Math.pow(10, db / 20);
