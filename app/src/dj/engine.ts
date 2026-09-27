import { api } from '../api';
import { audioContext, ensureAudio, masterBus, masterOut } from '../audio/context';
import { Deck } from '../audio/Deck';
import { loadTrackSources } from '../audio/loader';
import { reportError, useApp } from '../store/app';
import type { Track } from '../types';
import { create } from 'zustand';

export type XfadeCurve = 'smooth' | 'sharp';

export interface BlendState {
  to: 0 | 1;
  bars: number;
  progress: number;
}

interface DjUi {
  blend: BlendState | null;
  blendBars: number;
  xfade: number;
  curve: XfadeCurve;
  recording: boolean;
  recordSeconds: number;
  recordPeak: number;
  recordFormat: 'wav' | 'mp3';
  masterVolume: number;
}

export const useDj = create<DjUi>(() => ({
  blend: null,
  blendBars: 16,
  xfade: 0,
  curve: 'smooth',
  recording: false,
  recordSeconds: 0,
  recordPeak: 0,
  recordFormat: 'wav',
  masterVolume: 0.9,
}));

class DjEngine {
  readonly decks: [Deck, Deck];
  private sideA: GainNode;
  private sideB: GainNode;
  private master: GainNode;
  readonly masterAnalyser: AnalyserNode;
  private blendTimer: number | null = null;
  private recorder: AudioWorkletNode | null = null;
  private uploads: Promise<unknown> = Promise.resolve();
  private recordStart = 0;
  private recordTimer: number | null = null;

  constructor() {
    const ctx = audioContext();
    this.master = ctx.createGain();
    this.master.gain.value = 0.81;
    this.master.connect(masterBus());
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.master.connect(this.masterAnalyser);
    this.sideA = ctx.createGain();
    this.sideB = ctx.createGain();
    this.sideA.connect(this.master);
    this.sideB.connect(this.master);
    this.decks = [new Deck('A', this.sideA), new Deck('B', this.sideB)];
    this.setCrossfader(0);
  }

  other(deck: Deck): Deck {
    return deck === this.decks[0] ? this.decks[1] : this.decks[0];
  }

  async loadTrack(index: 0 | 1, track: Track) {
    const deck = this.decks[index];
    if (deck.playing && !confirm(`Deck ${deck.id} is playing. Load “${track.title}” anyway?`)) return;
    try {
      await ensureAudio();
      deck.pause();
      deck.setLoading(0.01);
      const sources = await loadTrackSources(track, (p) => deck.setLoading(Math.max(0.01, p)));
      await deck.load(track, sources);
      void api.markPlayed(track.id).catch(() => undefined);
    } catch (e) {
      reportError(e, `Could not load “${track.title}”`);
    } finally {
      deck.setLoading(0);
    }
  }

  setCrossfader(x: number) {
    const v = Math.max(-1, Math.min(1, x));
    const { curve } = useDj.getState();
    const t = (v + 1) / 2;
    let a: number;
    let b: number;
    if (curve === 'smooth') {
      a = Math.cos((t * Math.PI) / 2);
      b = Math.sin((t * Math.PI) / 2);
    } else {
      // Scratch-style: both full until the very edges.
      a = t > 0.92 ? Math.max(0, (1 - t) / 0.08) : 1;
      b = t < 0.08 ? Math.max(0, t / 0.08) : 1;
    }
    const now = audioContext().currentTime;
    this.sideA.gain.setTargetAtTime(a, now, 0.005);
    this.sideB.gain.setTargetAtTime(b, now, 0.005);
    useDj.setState({ xfade: v });
  }

  setCurve(curve: XfadeCurve) {
    useDj.setState({ curve });
    this.setCrossfader(useDj.getState().xfade);
  }

  setMasterVolume(v: number) {
    this.master.gain.setTargetAtTime(v * v, audioContext().currentTime, 0.01);
    useDj.setState({ masterVolume: v });
  }

  // ---- automatic transition ------------------------------------------------------------

  /**
   * Beginner-friendly transition: starts the incoming deck in sync, then over N bars moves the
   * crossfader across and swaps the bass halfway (incoming bass fades in as outgoing bass fades
   * out) so the two kick drums never fight. Calling it again cancels.
   */
  async startBlend(to: 0 | 1, bars = useDj.getState().blendBars) {
    if (useDj.getState().blend) return this.cancelBlend();
    const incoming = this.decks[to];
    const outgoing = this.other(incoming);
    if (!incoming.track) return;
    if (outgoing.playing && outgoing.bpm && incoming.bpm) incoming.syncTo(outgoing);
    const eqIn = incoming.eq.low;
    const eqOut = outgoing.eq.low;
    if (outgoing.playing) incoming.setEq('low', -26);
    if (!incoming.playing) {
      await incoming.play();
      if (outgoing.playing && outgoing.bpm && incoming.bpm) incoming.syncTo(outgoing); // re-align phase now it's running
    }
    const bpm = outgoing.playing && outgoing.effectiveBpm ? outgoing.effectiveBpm : incoming.effectiveBpm || 120;
    const duration = (bars * 4 * 60 * 1000) / bpm;
    const x0 = useDj.getState().xfade;
    const x1 = to === 1 ? 1 : -1;
    const start = performance.now();
    const smooth = (t: number) => t * t * (3 - 2 * t);
    useDj.setState({ blend: { to, bars, progress: 0 } });
    this.blendTimer = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / duration);
      this.setCrossfader(x0 + (x1 - x0) * smooth(t));
      const swap = Math.min(1, Math.max(0, (t - 0.4) / 0.2)); // bass swap between 40% and 60%
      if (outgoing.playing) {
        incoming.setEq('low', -26 + (Math.max(eqIn, -26) + 26) * swap);
        outgoing.setEq('low', eqOut + (-26 - eqOut) * swap);
      }
      useDj.setState({ blend: { to, bars, progress: t } });
      if (t >= 1) {
        this.cancelBlend();
        if (outgoing.playing) outgoing.pause();
        outgoing.setEq('low', eqOut);
      }
    }, 30);
  }

  cancelBlend() {
    if (this.blendTimer != null) clearInterval(this.blendTimer);
    this.blendTimer = null;
    useDj.setState({ blend: null });
  }

  // ---- master recording --------------------------------------------------------------

  async startRecording() {
    if (useDj.getState().recording) return;
    const ctx = await ensureAudio();
    try {
      await api.recordingStart(ctx.sampleRate, useDj.getState().recordFormat);
    } catch (e) {
      return reportError(e, 'Could not start recording');
    }
    if (!this.recorder) {
      this.recorder = new AudioWorkletNode(ctx, 'recorder-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      const sink = ctx.createGain();
      sink.gain.value = 0;
      masterOut().connect(this.recorder);
      this.recorder.connect(sink).connect(ctx.destination);
      this.recorder.port.onmessage = (e) => {
        if (e.data.type === 'chunk') {
          const data: Int16Array = e.data.data;
          useDj.setState({ recordPeak: e.data.peak });
          // Keep chunks strictly ordered: each upload waits for the previous one.
          this.uploads = this.uploads.then(() =>
            api.recordingChunk(data.buffer as ArrayBuffer).catch((err) => reportError(err, 'Recording upload failed')),
          );
        }
      };
    }
    this.recorder.port.postMessage({ type: 'start' });
    this.recordStart = performance.now();
    useDj.setState({ recording: true, recordSeconds: 0 });
    this.recordTimer = window.setInterval(
      () => useDj.setState({ recordSeconds: (performance.now() - this.recordStart) / 1000 }),
      500,
    );
  }

  async stopRecording() {
    if (!this.recorder || !useDj.getState().recording) return;
    const stopped = new Promise<void>((resolve) => {
      const prev = this.recorder!.port.onmessage;
      this.recorder!.port.onmessage = (e) => {
        prev?.call(this.recorder!.port, e);
        if (e.data.type === 'stopped') {
          this.recorder!.port.onmessage = prev;
          resolve();
        }
      };
    });
    this.recorder.port.postMessage({ type: 'stop' });
    await stopped;
    if (this.recordTimer) clearInterval(this.recordTimer);
    useDj.setState({ recording: false });
    await this.uploads;
    try {
      const { file } = await api.recordingStop();
      if (file) {
        useApp.getState().toast(`Recording saved: ${file.split(/[\\/]/).pop()}`, 'success', {
          label: 'Show',
          run: () => window.stemdeck?.showItem(file),
        });
      }
    } catch (e) {
      reportError(e, 'Could not finish recording');
    }
  }
}

let engine: DjEngine | null = null;
export function dj(): DjEngine {
  if (!engine) engine = new DjEngine();
  return engine;
}
