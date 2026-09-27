import { api } from '../api';
import { clamp } from '../music';
import type { Cue, StemName, Track } from '../types';
import { audioContext, ensureAudio } from './context';
import { type LoadedSource, sumPeaks, toInt16 } from './loader';

type Listener = () => void;

export interface DeckLoop {
  start: number;
  end: number;
  beats: number | null;
}

/**
 * One playback deck: a DeckProcessor worklet (stem mix + tempo) followed by
 * trim -> 3-band EQ -> filter -> channel fader. Used by both Stem Lab and DJ mode.
 */
export class Deck {
  readonly id: string;
  readonly output: GainNode;
  readonly trim: GainNode;
  readonly fader: GainNode;
  private node: AudioWorkletNode | null = null;
  private eqLow: BiquadFilterNode;
  private eqMid: BiquadFilterNode;
  private eqHigh: BiquadFilterNode;
  private hp: BiquadFilterNode;
  private lp: BiquadFilterNode;
  private listeners = new Set<Listener>();
  private endListeners = new Set<Listener>();

  track: Track | null = null;
  sources: LoadedSource[] = [];
  overview: Float32Array = new Float32Array(0);
  duration = 0;
  loading = 0; // 0 = idle, otherwise progress 0..1
  playing = false;
  rate = 1;
  pitchRange = 0.08;
  keyLock = true;
  quantize = true;
  loop: DeckLoop | null = null;
  cuePoint = 0;
  stemGain: Record<string, number> = {};
  stemMute: Record<string, boolean> = {};
  soloStem: string | null = null;
  eq = { low: 0, mid: 0, high: 0 }; // dB, -26 (kill) .. +6
  filter = 0; // -1 (low pass) .. 0 (off) .. +1 (high pass)
  volume = 1;
  private basePos = 0; // seconds
  private baseTime = 0; // performance.now() at basePos
  private nudge = 0;

  constructor(id: string, destination?: AudioNode) {
    this.id = id;
    const ctx = audioContext();
    this.trim = ctx.createGain();
    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 180;
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.7;
    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 3200;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 10;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 22000;
    this.fader = ctx.createGain();
    this.output = ctx.createGain();
    this.trim.connect(this.eqLow).connect(this.eqMid).connect(this.eqHigh).connect(this.hp).connect(this.lp);
    this.lp.connect(this.fader).connect(this.output);
    if (destination) this.output.connect(destination);
  }

  // ---- subscriptions ----------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onEnded(fn: Listener): () => void {
    this.endListeners.add(fn);
    return () => this.endListeners.delete(fn);
  }

  /** Increments on every state change; handy as a React effect dependency. */
  version = 0;

  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  private async ensureNode(): Promise<AudioWorkletNode> {
    if (this.node) return this.node;
    await ensureAudio();
    const node = new AudioWorkletNode(audioContext(), 'deck-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'pos') {
        const sr = audioContext().sampleRate;
        this.basePos = m.pos / sr;
        this.baseTime = performance.now();
        if (m.playing !== this.playing) {
          this.playing = m.playing;
          this.emit();
        }
      } else if (m.type === 'ended') {
        this.playing = false;
        this.emit();
        this.endListeners.forEach((l) => l());
      }
    };
    node.connect(this.trim);
    this.node = node;
    return node;
  }

  private post(msg: Record<string, unknown>, transfer: Transferable[] = []) {
    this.node?.port.postMessage(msg, transfer);
  }

  // ---- loading ----------------------------------------------------------------

  async load(track: Track, sources: LoadedSource[]) {
    const node = await this.ensureNode();
    const sr = audioContext().sampleRate;
    const length = Math.max(...sources.map((s) => s.buffer.length));
    const transfer: Transferable[] = [];
    const stems = sources.map((s) => {
      const l = toInt16(s.buffer.getChannelData(0));
      const r = s.buffer.numberOfChannels > 1 ? toInt16(s.buffer.getChannelData(1)) : l;
      transfer.push(l.buffer);
      if (r !== l) transfer.push(r.buffer);
      return { l, r };
    });
    this.track = track;
    this.sources = sources;
    this.overview = sources.length === 1 ? sources[0].peaks : sumPeaks(sources.map((s) => s.peaks));
    this.duration = length / sr;
    this.stemGain = Object.fromEntries(sources.map((s) => [s.name, 1]));
    this.stemMute = {};
    this.soloStem = null;
    this.loop = null;
    this.playing = false;
    this.basePos = 0;
    this.cuePoint = track.first_beat && track.first_beat < 2 ? track.first_beat : 0;
    node.port.postMessage({ type: 'load', stems, length, gains: sources.map(() => 1) }, transfer);
    this.post({ type: 'rate', rate: this.rate });
    this.post({ type: 'keylock', on: this.keyLock });
    this.seek(this.cuePoint);
    // Release the float copies; the worklet owns the audio now.
    this.sources = sources.map((s) => ({ ...s, buffer: null as unknown as AudioBuffer }));
    this.emit();
  }

  unload() {
    this.post({ type: 'unload' });
    this.track = null;
    this.sources = [];
    this.overview = new Float32Array(0);
    this.duration = 0;
    this.playing = false;
    this.loop = null;
    this.emit();
  }

  setLoading(p: number) {
    this.loading = p;
    this.emit();
  }

  updateTrack(track: Track) {
    if (this.track && this.track.id === track.id) {
      this.track = track;
      this.emit();
    }
  }

  // ---- transport --------------------------------------------------------------

  get position(): number {
    if (!this.playing) return this.basePos;
    let p = this.basePos + ((performance.now() - this.baseTime) / 1000) * this.rate * (1 + this.nudge);
    if (this.loop && p >= this.loop.end) {
      const len = this.loop.end - this.loop.start;
      p = this.loop.start + ((p - this.loop.end) % len);
    }
    return Math.min(p, this.duration);
  }

  async play() {
    if (!this.track) return;
    this.previewing = false;
    await ensureAudio();
    this.post({ type: 'play' });
    this.playing = true;
    this.baseTime = performance.now();
    this.emit();
  }

  pause() {
    this.basePos = this.position;
    this.post({ type: 'pause' });
    this.playing = false;
    this.emit();
  }

  togglePlay() {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(sec: number) {
    const sr = audioContext().sampleRate;
    const t = clamp(sec, 0, this.duration || 0);
    this.basePos = t;
    this.baseTime = performance.now();
    this.post({ type: 'seek', pos: t * sr });
    this.emit();
  }

  private previewing = false;
  private cueHeld = false;

  /**
   * CDJ-style cue. Playing: jump back to the cue point and stop. Stopped: set the cue point here
   * (snapped to the beat when quantize is on) and preview from it for as long as it is held.
   */
  cueDown() {
    if (!this.track) return;
    if (this.playing && !this.previewing) {
      this.pause();
      this.seek(this.cuePoint);
      return;
    }
    const here = this.quantize ? this.snapToBeat(this.position) : this.position;
    if (Math.abs(here - this.cuePoint) > 0.01) this.cuePoint = here;
    this.seek(this.cuePoint);
    this.cueHeld = true;
    void this.play().then(() => {
      this.previewing = true;
      if (!this.cueHeld) this.cueUp(); // released before playback actually started
    });
  }

  cueUp() {
    this.cueHeld = false;
    if (!this.previewing) return;
    this.previewing = false;
    this.pause();
    this.seek(this.cuePoint);
  }

  // ---- tempo ------------------------------------------------------------------

  setRate(rate: number) {
    this.rate = clamp(rate, 0.5, 2);
    this.basePos = this.position;
    this.baseTime = performance.now();
    this.post({ type: 'rate', rate: this.rate * (1 + this.nudge) });
    this.emit();
  }

  /** Pitch fader value -1..1 mapped over the pitch range (e.g. +/-8%). */
  setPitchFader(v: number) {
    this.setRate(1 + clamp(v, -1, 1) * this.pitchRange);
  }

  get pitchFader(): number {
    return clamp((this.rate - 1) / this.pitchRange, -1, 1);
  }

  setKeyLock(on: boolean) {
    this.keyLock = on;
    this.post({ type: 'keylock', on });
    this.emit();
  }

  /** Temporary speed bend for beat matching by ear (like pushing a jog wheel). */
  setNudge(amount: number) {
    this.basePos = this.position;
    this.baseTime = performance.now();
    this.nudge = amount;
    this.post({ type: 'rate', rate: this.rate * (1 + amount) });
  }

  get bpm(): number {
    return this.track?.bpm || 0;
  }

  get effectiveBpm(): number {
    return this.bpm * this.rate;
  }

  get beatLength(): number {
    return this.bpm ? 60 / this.bpm : 0.5;
  }

  beatAt(t: number): number {
    return (t - (this.track?.first_beat || 0)) / this.beatLength;
  }

  timeOfBeat(b: number): number {
    return (this.track?.first_beat || 0) + b * this.beatLength;
  }

  snapToBeat(t: number): number {
    if (!this.bpm) return t;
    return this.timeOfBeat(Math.round(this.beatAt(t)));
  }

  /** Match tempo to another deck (choosing half/double time if closer) and align beat phase. */
  syncTo(other: Deck) {
    if (!this.bpm || !other.bpm) return;
    const targetBpm = other.effectiveBpm;
    let best = targetBpm / this.bpm;
    for (const m of [0.5, 2]) {
      const r = (targetBpm * m) / this.bpm;
      if (Math.abs(r - 1) < Math.abs(best - 1)) best = r;
    }
    if (Math.abs(best - 1) > this.pitchRange) this.pitchRange = Math.abs(best - 1) > 0.16 ? 0.5 : 0.16;
    this.setRate(best);
    if (other.playing) {
      const frac = (x: number) => x - Math.floor(x);
      // factor converts the other deck's beats into ours (0.5 or 2 when mixing half/double time)
      const factor = (this.bpm * best) / targetBpm;
      let delta = frac(other.beatAt(other.position) * factor) - frac(this.beatAt(this.position));
      if (delta > 0.5) delta -= 1;
      if (delta < -0.5) delta += 1;
      this.seek(this.position + delta * this.beatLength);
    }
  }

  // ---- loops & cues -------------------------------------------------------------

  setLoop(start: number, end: number, beats: number | null = null, jump = true) {
    if (end - start < 0.01) return;
    this.loop = { start, end, beats };
    const sr = audioContext().sampleRate;
    this.post({ type: 'loop', start: start * sr, end: end * sr, jump });
    this.emit();
  }

  clearLoop() {
    this.loop = null;
    this.post({ type: 'loop', start: -1, end: -1 });
    this.emit();
  }

  beatLoop(beats: number) {
    if (this.loop && this.loop.beats === beats) return this.clearLoop();
    const pos = this.position;
    const start = this.quantize && this.bpm ? this.timeOfBeat(Math.floor(this.beatAt(pos) + 1e-3)) : pos;
    this.setLoop(start, start + beats * this.beatLength, beats, false);
  }

  resizeLoop(factor: number) {
    if (!this.loop) return;
    const len = (this.loop.end - this.loop.start) * factor;
    if (len < 0.02 || len > 120) return;
    const beats = this.loop.beats ? this.loop.beats * factor : null;
    this.setLoop(this.loop.start, this.loop.start + len, beats, false);
  }

  get cues(): Cue[] {
    return this.track?.cues || [];
  }

  async setHotCue(index: number, time = this.position) {
    if (!this.track) return;
    const t = this.quantize ? this.snapToBeat(time) : time;
    const cues = [...this.cues.filter((c) => c.index !== index), { index, time: t }].sort((a, b) => a.index - b.index);
    await this.saveCues(cues);
  }

  async deleteHotCue(index: number) {
    await this.saveCues(this.cues.filter((c) => c.index !== index));
  }

  hotCue(index: number) {
    const c = this.cues.find((x) => x.index === index);
    if (!c) return void this.setHotCue(index);
    this.seek(c.time);
    if (!this.playing) void this.play();
  }

  private async saveCues(cues: Cue[]) {
    if (!this.track) return;
    this.track = { ...this.track, cues };
    this.emit();
    this.track = await api.patchTrack(this.track.id, { cues });
    this.emit();
  }

  // ---- stems ------------------------------------------------------------------

  private pushGains() {
    const anySolo = this.soloStem !== null;
    const gains = this.sources.map((s) => {
      if (anySolo) return s.name === this.soloStem ? this.stemGain[s.name] ?? 1 : 0;
      return this.stemMute[s.name] ? 0 : this.stemGain[s.name] ?? 1;
    });
    this.post({ type: 'gains', gains });
    this.emit();
  }

  setStemGain(name: string, g: number) {
    this.stemGain[name] = clamp(g, 0, 1.5);
    this.pushGains();
  }

  toggleMute(name: StemName | string) {
    this.stemMute[name] = !this.stemMute[name];
    this.pushGains();
  }

  toggleSolo(name: StemName | string) {
    this.soloStem = this.soloStem === name ? null : name;
    this.pushGains();
  }

  /** Mute everything except the given stems (e.g. ['vocals'] for an acapella). */
  setStemPreset(keep: string[] | null) {
    this.soloStem = null;
    for (const s of this.sources) this.stemMute[s.name] = keep ? !keep.includes(s.name) : false;
    this.pushGains();
  }

  hasStem(name: string) {
    return this.sources.some((s) => s.name === name);
  }

  // ---- mixer ------------------------------------------------------------------

  setEq(band: 'low' | 'mid' | 'high', db: number) {
    this.eq[band] = clamp(db, -26, 6);
    const node = band === 'low' ? this.eqLow : band === 'mid' ? this.eqMid : this.eqHigh;
    // Full left is a kill: drop far enough that the band disappears.
    const value = this.eq[band] <= -25.5 ? -60 : this.eq[band];
    node.gain.setTargetAtTime(value, audioContext().currentTime, 0.01);
    this.emit();
  }

  setFilter(v: number) {
    this.filter = clamp(v, -1, 1);
    const t = audioContext().currentTime;
    const f = this.filter;
    const dead = 0.04;
    // Exponential sweep: 20 kHz -> 150 Hz for low pass, 10 Hz -> 6 kHz for high pass.
    const lpFreq = f < -dead ? 20000 * Math.pow(150 / 20000, (-f - dead) / (1 - dead)) : 22000;
    const hpFreq = f > dead ? 10 * Math.pow(6000 / 10, (f - dead) / (1 - dead)) : 10;
    this.lp.frequency.setTargetAtTime(lpFreq, t, 0.02);
    this.hp.frequency.setTargetAtTime(hpFreq, t, 0.02);
    const q = Math.abs(f) > dead ? 1.2 : 0.707;
    this.lp.Q.setTargetAtTime(q, t, 0.02);
    this.hp.Q.setTargetAtTime(q, t, 0.02);
    this.emit();
  }

  setVolume(v: number) {
    this.volume = clamp(v, 0, 1.2);
    // Squared curve feels natural on a fader.
    this.fader.gain.setTargetAtTime(this.volume * this.volume, audioContext().currentTime, 0.01);
    this.emit();
  }

  setTrim(db: number) {
    this.trim.gain.setTargetAtTime(Math.pow(10, db / 20), audioContext().currentTime, 0.01);
  }
}
