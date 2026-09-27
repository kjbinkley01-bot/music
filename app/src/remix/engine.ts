import { create } from 'zustand';
import { api } from '../api';
import { audioContext, ensureAudio, masterBus } from '../audio/context';
import { drumBuffer } from '../audio/drums';
import { computePeaks, decodeBytes } from '../audio/loader';
import type { Track } from '../types';
import {
  type AudioClip,
  type Clip,
  type PatternClip,
  type RemixProject,
  type RemixTrack,
  type RiserClip,
  type SourceStem,
  autoValueAt,
  clipEnd,
  filterFreqs,
  projectLength,
} from './model';

// ---- stretched source buffers ------------------------------------------------------

export interface ClipSource {
  buffer: AudioBuffer;
  peaks: Float32Array;
  firstBeatSec: number; // position of the source's first beat inside the (stretched) buffer
  ratio: number;
}

const sources = new Map<string, ClipSource>();
const pending = new Map<string, Promise<ClipSource | null>>();

/** Bumps whenever a source finishes loading so clip waveforms re-render. */
export const useSources = create<{ version: number; loading: number; errors: Record<string, string> }>(() => ({
  version: 0,
  loading: 0,
  errors: {},
}));

/**
 * The tempo a source is treated as in a project: its BPM, or double/half of it when that is
 * closer to the project tempo (a 64 BPM hip-hop loop in a 128 project plays in double time
 * instead of being stretched 2x).
 */
export function sourceBpm(track: Pick<Track, 'bpm'> | undefined, projectBpm: number): number {
  if (!track?.bpm) return projectBpm;
  let best = track.bpm;
  for (const m of [0.5, 2]) {
    if (Math.abs(Math.log(projectBpm / (track.bpm * m))) < Math.abs(Math.log(projectBpm / best)) - 0.05) best = track.bpm * m;
  }
  return best;
}

export function stretchRatio(track: Pick<Track, 'bpm'> | undefined, projectBpm: number): number {
  if (!track?.bpm) return 1;
  const r = projectBpm / sourceBpm(track, projectBpm);
  return Math.abs(r - 1) < 0.0015 ? 1 : Math.round(r * 100000) / 100000;
}

export function sourceKey(trackId: number, stem: SourceStem, ratio: number, semitones: number) {
  return `${trackId}:${stem}:${ratio}:${semitones}`;
}

export function clipSourceKey(clip: AudioClip, track: Track | undefined, bpm: number) {
  return sourceKey(clip.trackId, clip.stem, stretchRatio(track, bpm), clip.semitones);
}

export function getLoadedSource(key: string): ClipSource | undefined {
  return sources.get(key);
}

export function requestSource(track: Track, stem: SourceStem, projectBpm: number, semitones: number): Promise<ClipSource | null> {
  const ratio = stretchRatio(track, projectBpm);
  const key = sourceKey(track.id, stem, ratio, semitones);
  const have = sources.get(key);
  if (have) return Promise.resolve(have);
  let p = pending.get(key);
  if (p) return p;
  useSources.setState((s) => ({ loading: s.loading + 1 }));
  p = (async () => {
    try {
      const bytes =
        ratio === 1 && semitones === 0
          ? stem === 'original'
            ? await api.audio(track.id)
            : await api.stem(track.id, stem)
          : await api.stretched(track.id, stem, ratio, semitones);
      const buffer = await decodeBytes(bytes);
      const src: ClipSource = { buffer, peaks: computePeaks(buffer), firstBeatSec: (track.first_beat || 0) / ratio, ratio };
      sources.set(key, src);
      return src;
    } catch (e) {
      useSources.setState((s) => ({ errors: { ...s.errors, [key]: (e as Error).message } }));
      return null;
    } finally {
      pending.delete(key);
      useSources.setState((s) => ({ version: s.version + 1, loading: s.loading - 1 }));
    }
  })();
  pending.set(key, p);
  return p;
}

/** Drop cached buffers no longer referenced by the project (keeps memory in check). */
export function pruneSources(project: RemixProject, tracks: Track[]) {
  const keep = new Set<string>();
  for (const t of project.tracks)
    for (const c of t.clips)
      if (c.type === 'audio') keep.add(clipSourceKey(c, tracks.find((x) => x.id === c.trackId), project.bpm));
  for (const k of sources.keys()) if (!keep.has(k)) sources.delete(k);
}

// ---- audio graph (shared by live playback and offline export) -------------------------

interface TrackNodes {
  input: GainNode;
  lp: BiquadFilterNode;
  hp: BiquadFilterNode;
  autoVol: GainNode;
  pan: StereoPannerNode;
  vol: GainNode;
  out: GainNode;
  reverb: GainNode;
  delay: GainNode;
}

interface Graph {
  ctx: BaseAudioContext;
  master: GainNode;
  reverbIn: GainNode;
  convolver: ConvolverNode;
  delayIn: GainNode;
  delayNode: DelayNode;
  feedback: GainNode;
  tracks: Map<string, TrackNodes>;
  reverbSize: number;
  noise: AudioBuffer;
}

function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  return buf;
}

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function buildGraph(ctx: BaseAudioContext, destination: AudioNode): Graph {
  const master = ctx.createGain();
  master.connect(destination);
  const reverbIn = ctx.createGain();
  const convolver = ctx.createConvolver();
  const reverbOut = ctx.createGain();
  reverbOut.gain.value = 0.9;
  reverbIn.connect(convolver).connect(reverbOut).connect(master);
  const delayIn = ctx.createGain();
  const delayNode = ctx.createDelay(4);
  const feedback = ctx.createGain();
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 4500;
  delayIn.connect(delayNode);
  delayNode.connect(damp).connect(feedback).connect(delayNode);
  delayNode.connect(master);
  return { ctx, master, reverbIn, convolver, delayIn, delayNode, feedback, tracks: new Map(), reverbSize: 0, noise: noiseBuffer(ctx) };
}

function audibleTracks(p: RemixProject): Set<string> {
  const solo = p.tracks.some((t) => t.solo);
  return new Set(p.tracks.filter((t) => (solo ? t.solo : !t.mute)).map((t) => t.id));
}

/** Create/remove per-track nodes and push mixer settings. Safe to call on every edit. */
function syncGraph(g: Graph, p: RemixProject, now: number) {
  const ctx = g.ctx;
  const spb = 60 / p.bpm;
  g.master.gain.setTargetAtTime(p.masterVolume, now, 0.01);
  if (Math.abs(g.reverbSize - p.reverbSize) > 0.01) {
    g.convolver.buffer = impulse(ctx, p.reverbSize);
    g.reverbSize = p.reverbSize;
  }
  g.delayNode.delayTime.setTargetAtTime(Math.min(4, p.delayDivision * spb), now, 0.02);
  g.feedback.gain.setTargetAtTime(Math.min(0.9, p.delayFeedback), now, 0.02);

  const audible = audibleTracks(p);
  const ids = new Set(p.tracks.map((t) => t.id));
  for (const [id, n] of g.tracks) {
    if (!ids.has(id)) {
      n.out.disconnect();
      n.reverb.disconnect();
      n.delay.disconnect();
      g.tracks.delete(id);
    }
  }
  for (const t of p.tracks) {
    let n = g.tracks.get(t.id);
    if (!n) {
      n = {
        input: ctx.createGain(),
        lp: ctx.createBiquadFilter(),
        hp: ctx.createBiquadFilter(),
        autoVol: ctx.createGain(),
        pan: ctx.createStereoPanner(),
        vol: ctx.createGain(),
        out: ctx.createGain(),
        reverb: ctx.createGain(),
        delay: ctx.createGain(),
      };
      n.lp.type = 'lowpass';
      n.hp.type = 'highpass';
      n.input.connect(n.lp).connect(n.hp).connect(n.autoVol).connect(n.pan).connect(n.vol).connect(n.out).connect(g.master);
      n.vol.connect(n.reverb).connect(g.reverbIn);
      n.vol.connect(n.delay).connect(g.delayIn);
      g.tracks.set(t.id, n);
      applyFilter(n, t, now, true);
    }
    const on = audible.has(t.id) ? 1 : 0;
    n.vol.gain.setTargetAtTime(t.volume * t.volume, now, 0.01);
    n.out.gain.setTargetAtTime(on, now, 0.005);
    n.reverb.gain.setTargetAtTime(t.reverb * on, now, 0.01);
    n.delay.gain.setTargetAtTime(t.delay * on, now, 0.01);
    n.pan.pan.setTargetAtTime(t.pan, now, 0.01);
    if (!(t.autoOn && t.auto.length)) applyFilter(n, t, now, false);
    if (!(t.autoOn && t.volAuto?.length)) {
      n.autoVol.gain.cancelScheduledValues(now);
      n.autoVol.gain.setTargetAtTime(1, now, 0.01);
    }
  }
}

function applyFilter(n: TrackNodes, t: RemixTrack, now: number, immediate: boolean) {
  const [lp, hp, q] = filterFreqs(t.filter);
  for (const [param, v] of [[n.lp.frequency, lp], [n.hp.frequency, hp], [n.lp.Q, q], [n.hp.Q, q]] as const) {
    param.cancelScheduledValues(now);
    if (immediate) param.setValueAtTime(v, now);
    else param.setTargetAtTime(v, now, 0.02);
  }
}

/** Schedule filter and volume automation for [fromBeat, toBeat) starting at ctx time `at`. */
function scheduleAutomation(g: Graph, p: RemixProject, fromBeat: number, toBeat: number, at: number) {
  const spb = 60 / p.bpm;
  const step = Math.max(0.125, (toBeat - fromBeat) / 4000);
  const ramp = (params: AudioParam[], values: (beat: number) => number[]) => {
    params.forEach((pr) => pr.cancelScheduledValues(at));
    for (let b = fromBeat, first = true; b <= toBeat + 1e-9; b += step, first = false) {
      const vals = values(b);
      const time = at + (b - fromBeat) * spb;
      params.forEach((pr, i) => (first ? pr.setValueAtTime(vals[i], time) : pr.linearRampToValueAtTime(vals[i], time)));
    }
  };
  for (const t of p.tracks) {
    const n = g.tracks.get(t.id);
    if (!n || !t.autoOn) continue;
    if (t.auto.length) {
      ramp([n.lp.frequency, n.hp.frequency, n.lp.Q, n.hp.Q], (b) => {
        const [lp, hp, q] = filterFreqs(autoValueAt(t.auto, b, t.filter));
        return [lp, hp, q, q];
      });
    }
    if (t.volAuto?.length) {
      const pts = t.volAuto;
      ramp([n.autoVol.gain], (b) => [Math.pow(autoValueAt(pts, b, 1), 2)]);
    }
  }
}

/** Metronome clicks for every beat in [w0, w1): accented on the bar. Live playback only. */
function scheduleClicks(g: Graph, p: RemixProject, cycle: Cycle, w0: number, w1: number, started: AudioScheduledSourceNode[]) {
  const ctx = g.ctx;
  const spb = 60 / p.bpm;
  for (let b = Math.ceil(w0 - 1e-6); b < w1; b++) {
    const when = cycle.ctxStart + (b - cycle.beatStart) * spb;
    const o = ctx.createOscillator();
    const env = ctx.createGain();
    o.frequency.value = b % 4 === 0 ? 1760 : 1175;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(0.35, when + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
    o.connect(env).connect(g.master);
    o.start(when);
    o.stop(when + 0.07);
    started.push(o);
  }
}

interface Cycle {
  ctxStart: number;
  beatStart: number;
  beatEnd: number;
}

type SourceLookup = (clip: AudioClip) => ClipSource | undefined;
type DrumLookup = (ref: string) => AudioBuffer | undefined;

/** Schedule every event whose trigger falls in [w0, w1) beats within the given cycle. */
function scheduleWindow(
  g: Graph,
  p: RemixProject,
  cycle: Cycle,
  w0: number,
  w1: number,
  getSource: SourceLookup,
  getDrum: DrumLookup,
  started: AudioScheduledSourceNode[],
) {
  const ctx = g.ctx;
  const spb = 60 / p.bpm;
  const at = (beat: number) => cycle.ctxStart + (beat - cycle.beatStart) * spb;
  for (const t of p.tracks) {
    const n = g.tracks.get(t.id);
    if (!n) continue;
    for (const clip of t.clips) {
      const end = Math.min(clipEnd(clip), cycle.beatEnd);
      if (end <= cycle.beatStart || clip.start >= cycle.beatEnd) continue;
      if (clip.type === 'pattern') {
        schedulePattern(ctx, p, clip, n.input, w0, Math.min(w1, end), at, getDrum, started);
        continue;
      }
      const trigger = Math.max(clip.start, cycle.beatStart);
      if (trigger < w0 || trigger >= w1 || end - trigger < 1e-6) continue;
      if (clip.type === 'audio') scheduleAudio(ctx, clip, getSource(clip), n.input, trigger, end, spb, at, started);
      else scheduleRiser(g, clip, n.input, trigger, end, spb, at, started);
    }
  }
}

/**
 * Per-clip gain with fade in/out. The envelope is defined over the whole clip
 * [clipStart, clipStop] so clips that start playing midway pick up at the right level.
 */
function clipGain(
  ctx: BaseAudioContext,
  dest: AudioNode,
  clip: Clip,
  when: number,
  stop: number,
  clipStart: number,
  clipStop: number,
  spb: number,
): GainNode {
  const g = ctx.createGain();
  const edge = 0.004;
  const fin = Math.max(edge, (clip.fadeIn ?? 0) * spb);
  const fout = Math.max(edge, (clip.fadeOut ?? 0) * spb);
  const inEnd = clipStart + fin;
  const outStart = Math.max(inEnd, clipStop - fout);
  const level = (t: number) => clip.gain * Math.max(0, Math.min(1, (t - clipStart) / fin, (clipStop - t) / fout));
  g.gain.setValueAtTime(when > clipStart + 1e-4 ? Math.min(level(when), clip.gain) : 0, when);
  if (inEnd > when) g.gain.linearRampToValueAtTime(clip.gain, inEnd);
  if (outStart > when) g.gain.setValueAtTime(level(outStart), outStart);
  g.gain.linearRampToValueAtTime(0, Math.max(when + edge, clipStop));
  // a loop boundary or stop earlier than the clip end still needs a click-free edge
  if (stop < clipStop - edge) {
    g.gain.cancelAndHoldAtTime(stop - edge);
    g.gain.linearRampToValueAtTime(0, stop);
  }
  g.connect(dest);
  return g;
}

function scheduleAudio(
  ctx: BaseAudioContext,
  clip: AudioClip,
  src: ClipSource | undefined,
  dest: AudioNode,
  trigger: number,
  end: number,
  spb: number,
  at: (b: number) => number,
  started: AudioScheduledSourceNode[],
) {
  if (!src) return;
  let when = at(trigger);
  const stop = at(end);
  const into = trigger - clip.start;
  const node = ctx.createBufferSource();
  node.buffer = src.buffer;
  let offset: number;
  if (clip.loopLen && clip.loopLen > 0) {
    node.loop = true;
    node.loopStart = Math.max(0, src.firstBeatSec + clip.offset * spb);
    node.loopEnd = Math.min(src.buffer.duration, node.loopStart + clip.loopLen * spb);
    offset = node.loopStart + (into % clip.loopLen) * spb;
  } else {
    offset = src.firstBeatSec + (clip.offset + into) * spb;
  }
  if (offset < 0) {
    when -= offset;
    offset = 0;
  }
  if (when >= stop || offset >= src.buffer.duration) return;
  node.connect(clipGain(ctx, dest, clip, when, stop, at(clip.start), at(clipEnd(clip)), spb));
  node.start(when, offset);
  node.stop(stop);
  started.push(node);
}

function scheduleRiser(
  g: Graph,
  clip: RiserClip,
  dest: AudioNode,
  trigger: number,
  end: number,
  spb: number,
  at: (b: number) => number,
  started: AudioScheduledSourceNode[],
) {
  const ctx = g.ctx;
  const when = at(trigger);
  const stop = at(end);
  const total = clip.length * spb;
  const done = (trigger - clip.start) / clip.length; // fraction already elapsed if starting mid-clip
  const out = clipGain(ctx, dest, clip, when, stop, at(clip.start), at(clipEnd(clip)), spb);
  if (clip.variant === 'impact') {
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.frequency.setValueAtTime(90, when);
    o.frequency.exponentialRampToValueAtTime(32, when + 1.2);
    og.gain.setValueAtTime(0.9, when);
    og.gain.exponentialRampToValueAtTime(0.001, Math.min(stop, when + 2.5));
    o.connect(og).connect(out);
    o.start(when);
    o.stop(stop);
    started.push(o);
  }
  const n = ctx.createBufferSource();
  n.buffer = g.noise;
  n.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.4;
  const env = ctx.createGain();
  const lerp = (a: number, b: number, t: number) => a * Math.pow(b / a, t);
  const remaining = stop - when;
  if (clip.variant === 'riser') {
    bp.frequency.setValueAtTime(lerp(250, 9000, done), when);
    bp.frequency.exponentialRampToValueAtTime(9000, when + remaining);
    env.gain.setValueAtTime(Math.max(0.001, done * 0.6), when);
    env.gain.linearRampToValueAtTime(0.6, when + remaining);
  } else {
    const len = clip.variant === 'impact' ? Math.min(total, 2.5) : total;
    bp.frequency.setValueAtTime(lerp(9000, 180, done), when);
    bp.frequency.exponentialRampToValueAtTime(180, when + Math.max(0.05, len * (1 - done)));
    env.gain.setValueAtTime(0.6 * (1 - done), when);
    env.gain.linearRampToValueAtTime(0.0001, when + Math.max(0.05, len * (1 - done)));
  }
  n.connect(bp).connect(env).connect(out);
  n.start(when);
  n.stop(stop);
  started.push(n);
}

function schedulePattern(
  ctx: BaseAudioContext,
  p: RemixProject,
  clip: PatternClip,
  dest: AudioNode,
  w0: number,
  w1: number,
  at: (b: number) => number,
  getDrum: DrumLookup,
  started: AudioScheduledSourceNode[],
) {
  const pattern = p.patterns.find((x) => x.id === clip.patternId);
  if (!pattern) return;
  const kStart = Math.max(0, Math.ceil((w0 - clip.start) * 4 - 1e-6));
  const kEnd = Math.ceil((w1 - clip.start) * 4 - 1e-6);
  const swing = p.swing * 0.25 * 0.66;
  for (let k = kStart; k < kEnd && k < clip.length * 4; k++) {
    const col = k % 16;
    const beat = clip.start + k / 4 + (k % 2 === 1 ? swing : 0);
    for (let v = 0; v < pattern.steps.length; v++) {
      const vel = pattern.steps[v]?.[col] || 0;
      const voice = p.voices[v];
      if (!vel || !voice) continue;
      const buf = getDrum(voice.ref);
      if (!buf) continue;
      const src = ctx.createBufferSource();
      const g = ctx.createGain();
      g.gain.value = vel * voice.gain * clip.gain;
      src.buffer = buf;
      src.connect(g).connect(dest);
      src.start(at(beat));
      started.push(src);
    }
  }
}

// ---- live engine ----------------------------------------------------------------------

const LOOKAHEAD = 0.25; // seconds scheduled ahead of the audio clock
const TICK_MS = 30;

class RemixEngine {
  private g: Graph | null = null;
  private project: RemixProject | null = null;
  private tracks: Track[] = [];
  private drums = new Map<string, AudioBuffer>();
  private started: AudioScheduledSourceNode[] = [];
  private cycles: Cycle[] = [];
  private scheduledTo = 0;
  private timer: number | null = null;
  playing = false;
  metronome = false;
  private stoppedAt = 0;

  private graph(): Graph {
    if (!this.g) this.g = buildGraph(audioContext(), masterBus());
    return this.g;
  }

  /** Called on every project edit. Mixer changes apply instantly; structure changes reschedule. */
  update(p: RemixProject, tracks: Track[], structural: boolean) {
    this.project = p;
    this.tracks = tracks;
    syncGraph(this.graph(), p, audioContext().currentTime);
    this.preloadDrums(p);
    if (this.playing && structural) this.play(this.position());
  }

  private preloadDrums(p: RemixProject) {
    for (const v of p.voices) {
      if (!this.drums.has(v.ref)) {
        void drumBuffer(v.ref).then((b) => this.drums.set(v.ref, b)).catch(() => undefined);
      }
    }
  }

  private lookupSource: SourceLookup = (clip) => {
    const track = this.tracks.find((t) => t.id === clip.trackId);
    return track ? sources.get(clipSourceKey(clip, track, this.project!.bpm)) : undefined;
  };

  private lookupDrum: DrumLookup = (ref) => this.drums.get(ref);

  position(): number {
    const p = this.project;
    if (!p || !this.playing) return this.stoppedAt;
    const now = audioContext().currentTime;
    const spb = 60 / p.bpm;
    let cyc = this.cycles[0];
    for (const c of this.cycles) if (c.ctxStart <= now) cyc = c;
    if (!cyc) return this.stoppedAt;
    return Math.min(cyc.beatEnd, cyc.beatStart + Math.max(0, now - cyc.ctxStart) / spb);
  }

  setPosition(beat: number) {
    if (this.playing) this.play(beat);
    else this.stoppedAt = Math.max(0, beat);
  }

  private cycleEnd(p: RemixProject, from: number): number {
    if (p.loopOn && p.loop && from < p.loop.end && p.loop.end > p.loop.start) return p.loop.end;
    return Math.max(projectLength(p), from) + 0.001;
  }

  async play(fromBeat = this.stoppedAt) {
    const p = this.project;
    if (!p) return;
    await ensureAudio();
    this.silence();
    const ctx = audioContext();
    const start = ctx.currentTime + 0.05;
    if (p.loopOn && p.loop && (fromBeat >= p.loop.end || fromBeat < p.loop.start)) fromBeat = p.loop.start;
    const cycle = { ctxStart: start, beatStart: fromBeat, beatEnd: this.cycleEnd(p, fromBeat) };
    this.cycles = [cycle];
    this.scheduledTo = fromBeat;
    this.playing = true;
    scheduleAutomation(this.graph(), p, cycle.beatStart, cycle.beatEnd, start);
    this.tick();
    if (this.timer == null) this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  private tick() {
    const p = this.project;
    if (!p || !this.playing) return;
    const ctx = audioContext();
    const spb = 60 / p.bpm;
    const horizon = ctx.currentTime + LOOKAHEAD;
    for (let guard = 0; guard < 4; guard++) {
      const cyc = this.cycles[this.cycles.length - 1];
      const horizonBeat = cyc.beatStart + (horizon - cyc.ctxStart) / spb;
      const w1 = Math.min(horizonBeat, cyc.beatEnd);
      if (w1 > this.scheduledTo) {
        scheduleWindow(this.graph(), p, cyc, this.scheduledTo, w1, this.lookupSource, this.lookupDrum, this.started);
        if (this.metronome) scheduleClicks(this.graph(), p, cyc, this.scheduledTo, w1, this.started);
        this.scheduledTo = w1;
      }
      if (horizonBeat < cyc.beatEnd) break;
      const endTime = cyc.ctxStart + (cyc.beatEnd - cyc.beatStart) * spb;
      if (p.loopOn && p.loop && p.loop.end > p.loop.start) {
        const next = { ctxStart: endTime, beatStart: p.loop.start, beatEnd: p.loop.end };
        this.cycles = [cyc, next];
        this.scheduledTo = next.beatStart;
        scheduleAutomation(this.graph(), p, next.beatStart, next.beatEnd, next.ctxStart);
      } else {
        if (ctx.currentTime >= endTime) {
          this.stop();
          this.stoppedAt = 0;
        }
        break;
      }
    }
    if (this.started.length > 2000) this.started = this.started.slice(-1000);
  }

  private silence() {
    const now = audioContext().currentTime;
    for (const s of this.started) {
      try {
        s.stop(now + 0.01);
      } catch {
        /* never started or already stopped */
      }
    }
    this.started = [];
  }

  stop() {
    this.stoppedAt = this.position();
    this.playing = false;
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.silence();
    if (this.project) syncGraph(this.graph(), this.project, audioContext().currentTime);
  }
}

export const remixEngine = new RemixEngine();

// ---- offline export ------------------------------------------------------------------

export async function loadAllSources(p: RemixProject, tracks: Track[]): Promise<string[]> {
  const missing: string[] = [];
  const jobs: Promise<unknown>[] = [];
  for (const t of p.tracks)
    for (const c of t.clips) {
      if (c.type !== 'audio') continue;
      const track = tracks.find((x) => x.id === c.trackId);
      if (!track) {
        missing.push(`Track #${c.trackId} is no longer in the library`);
        continue;
      }
      jobs.push(requestSource(track, c.stem, p.bpm, c.semitones));
    }
  await Promise.all(jobs);
  return missing;
}

export async function renderProject(
  p: RemixProject,
  tracks: Track[],
  range: { start: number; end: number },
  tail = true,
): Promise<AudioBuffer> {
  await loadAllSources(p, tracks);
  const drums = new Map<string, AudioBuffer>();
  await Promise.all(p.voices.map(async (v) => drums.set(v.ref, await drumBuffer(v.ref))));
  const sr = audioContext().sampleRate;
  const spb = 60 / p.bpm;
  const seconds = (range.end - range.start) * spb + (tail ? Math.min(6, p.reverbSize + 1.5) : 0);
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  const g = buildGraph(ctx, ctx.destination);
  syncGraph(g, p, 0);
  const cycle = { ctxStart: 0, beatStart: range.start, beatEnd: range.end };
  scheduleAutomation(g, p, range.start, range.end, 0);
  const lookup: SourceLookup = (clip) => sources.get(clipSourceKey(clip, tracks.find((t) => t.id === clip.trackId), p.bpm));
  scheduleWindow(g, p, cycle, range.start, range.end, lookup, (ref) => drums.get(ref), []);
  return ctx.startRendering();
}

export function clipsOverlapping(p: RemixProject, beat: number): Clip[] {
  return p.tracks.flatMap((t) => t.clips.filter((c) => c.start <= beat && clipEnd(c) > beat));
}
