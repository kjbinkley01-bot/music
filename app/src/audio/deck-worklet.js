/* global sampleRate, registerProcessor, AudioWorkletProcessor */
/**
 * DeckProcessor: plays up to 4 stems in perfect sync, mixing them with per-stem gains before any
 * time processing (so stems can never drift apart), then changes speed in one of two ways:
 *   - key lock ON:  WSOLA time stretching (tempo changes, pitch stays)
 *   - key lock OFF: varispeed resampling (like a turntable: tempo and pitch change together)
 *
 * Audio is held as Int16 to halve memory use (a 6 minute track with 4 stems ~ 250 MB as floats).
 */

const FRAME = 2048; // WSOLA frame length (~46 ms)
const HOP = FRAME / 2; // synthesis hop, 50% overlap with a periodic Hann window sums to 1
const SEARCH = 384; // +/- samples searched for the best splice point
const DECIM = 4; // correlation is computed on every 4th sample to keep CPU low
const Q_SIZE = 8192; // output queue (per channel), power of two
const Q_MASK = Q_SIZE - 1;
const INV16 = 1 / 32768;

const HANN = new Float32Array(FRAME);
for (let i = 0; i < FRAME; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stems = []; // [{ l: Int16Array, r: Int16Array }]
    this.length = 0;
    this.gain = [];
    this.target = [];
    this.pos = 0; // nominal read position in samples
    this.playing = false;
    this.rate = 1;
    this.keyLock = true;
    this.loopStart = -1;
    this.loopEnd = -1;
    this.blocks = 0;
    // WSOLA state
    this.ola = [new Float32Array(FRAME), new Float32Array(FRAME)];
    this.qL = new Float32Array(Q_SIZE);
    this.qR = new Float32Array(Q_SIZE);
    this.qRead = 0;
    this.qWrite = 0;
    this.prevIp = 0;
    this.fresh = true;
    this.frameL = new Float32Array(FRAME);
    this.frameR = new Float32Array(FRAME);
    this.tmpl = new Float32Array(HOP / DECIM);
    this.region = new Float32Array((HOP + 2 * SEARCH) / DECIM + 1);
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.stems = m.stems;
        this.length = m.length;
        this.gain = m.stems.map((_, i) => (m.gains ? m.gains[i] : 1));
        this.target = this.gain.slice();
        this.pos = 0;
        this.playing = false;
        this.loopStart = this.loopEnd = -1;
        this.reset();
        this.report(true);
        break;
      case 'unload':
        this.stems = [];
        this.length = 0;
        this.playing = false;
        this.report(true);
        break;
      case 'play':
        if (this.length) {
          if (this.pos >= this.length) this.pos = 0;
          this.playing = true;
          this.reset();
        }
        this.report(true);
        break;
      case 'pause':
        this.playing = false;
        this.report(true);
        break;
      case 'seek':
        this.pos = Math.max(0, Math.min(this.length, m.pos));
        this.reset();
        this.report(true);
        break;
      case 'rate':
        this.rate = Math.max(0.25, Math.min(4, m.rate));
        break;
      case 'keylock':
        if (this.keyLock !== m.on) {
          this.keyLock = m.on;
          this.reset();
        }
        break;
      case 'gains':
        for (let i = 0; i < m.gains.length && i < this.target.length; i++) this.target[i] = m.gains[i];
        break;
      case 'loop':
        this.loopStart = m.start;
        this.loopEnd = m.end;
        if (m.end > m.start && m.jump && (this.pos >= m.end || this.pos < m.start)) {
          this.pos = m.start;
          this.reset();
        }
        break;
    }
  }

  reset() {
    this.qRead = this.qWrite = 0;
    this.ola[0].fill(0);
    this.ola[1].fill(0);
    this.fresh = true;
  }

  report(force) {
    if (!force && ++this.blocks % 6 !== 0) return;
    const queued = this.keyLock ? (this.qWrite - this.qRead) * this.rate : 0;
    this.port.postMessage({ type: 'pos', pos: Math.max(0, this.pos - queued), playing: this.playing });
  }

  loopActive() {
    return this.loopEnd > this.loopStart && this.loopStart >= 0;
  }

  /** Mixed mono sample (for correlation) at integer index. */
  mono(i) {
    if (i < 0 || i >= this.length) return 0;
    let s = 0;
    const stems = this.stems;
    for (let k = 0; k < stems.length; k++) {
      const g = this.gain[k];
      if (g > 0.0001) s += g * (stems[k].l[i] + stems[k].r[i]);
    }
    return s;
  }

  /** Read FRAME mixed stereo samples starting at integer index into frameL/frameR, windowed. */
  readFrame(start) {
    const fl = this.frameL;
    const fr = this.frameR;
    fl.fill(0);
    fr.fill(0);
    const from = Math.max(0, -start);
    const to = Math.min(FRAME, this.length - start);
    for (let k = 0; k < this.stems.length; k++) {
      const g = this.gain[k] * INV16;
      if (g < 1e-7) continue;
      const l = this.stems[k].l;
      const r = this.stems[k].r;
      for (let i = from; i < to; i++) {
        fl[i] += l[start + i] * g;
        fr[i] += r[start + i] * g;
      }
    }
    for (let i = 0; i < FRAME; i++) {
      fl[i] *= HANN[i];
      fr[i] *= HANN[i];
    }
  }

  /** Find the offset around `target` whose start best continues the previous frame. */
  bestSplice(target) {
    const natural = this.prevIp + HOP;
    const tn = HOP / DECIM;
    const tmpl = this.tmpl;
    for (let j = 0; j < tn; j++) tmpl[j] = this.mono(natural + j * DECIM);
    const base = target - SEARCH;
    const region = this.region;
    const rn = region.length;
    for (let j = 0; j < rn; j++) region[j] = this.mono(base + j * DECIM);
    let best = 0;
    let bestScore = -Infinity;
    const candidates = (2 * SEARCH) / DECIM;
    for (let c = 0; c <= candidates && c + tn <= rn; c++) {
      let dot = 0;
      let energy = 1e-9;
      for (let j = 0; j < tn; j++) {
        const v = region[c + j];
        dot += tmpl[j] * v;
        energy += v * v;
      }
      const score = dot / Math.sqrt(energy);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return base + best * DECIM;
  }

  synthStep() {
    const target = Math.round(this.pos);
    const ip = this.fresh ? target : this.bestSplice(target);
    this.fresh = false;
    this.readFrame(ip);
    const ol = this.ola[0];
    const or = this.ola[1];
    const fl = this.frameL;
    const fr = this.frameR;
    for (let i = 0; i < FRAME; i++) {
      ol[i] += fl[i];
      or[i] += fr[i];
    }
    for (let i = 0; i < HOP; i++) {
      this.qL[this.qWrite & Q_MASK] = ol[i];
      this.qR[this.qWrite & Q_MASK] = or[i];
      this.qWrite++;
    }
    ol.copyWithin(0, HOP);
    or.copyWithin(0, HOP);
    ol.fill(0, FRAME - HOP);
    or.fill(0, FRAME - HOP);
    this.prevIp = ip;
    this.pos += HOP * this.rate;
    if (this.loopActive() && this.pos >= this.loopEnd) {
      this.pos = this.loopStart + (this.pos - this.loopEnd);
      this.fresh = true; // overlap-add crossfades the jump smoothly
    }
  }

  smoothGains(n) {
    // ~10 ms glide so mutes and fader moves never click
    const a = 1 - Math.exp(-n / (0.01 * sampleRate));
    for (let k = 0; k < this.gain.length; k++) this.gain[k] += (this.target[k] - this.gain[k]) * a;
  }

  processKeyLock(outL, outR, n) {
    this.smoothGains(n);
    while (this.qWrite - this.qRead < n) this.synthStep();
    for (let i = 0; i < n; i++) {
      outL[i] = this.qL[this.qRead & Q_MASK];
      outR[i] = this.qR[this.qRead & Q_MASK];
      this.qRead++;
    }
  }

  processVarispeed(outL, outR, n) {
    const stems = this.stems;
    const len = this.length;
    const g0 = this.gain.slice();
    this.smoothGains(n);
    let pos = this.pos;
    const loop = this.loopActive();
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      let l = 0;
      let r = 0;
      if (idx >= 0 && idx + 1 < len) {
        for (let k = 0; k < stems.length; k++) {
          const g = (g0[k] + (this.gain[k] - g0[k]) * t) * INV16;
          if (g < 1e-7) continue;
          const sl = stems[k].l;
          const sr = stems[k].r;
          l += (sl[idx] + (sl[idx + 1] - sl[idx]) * frac) * g;
          r += (sr[idx] + (sr[idx + 1] - sr[idx]) * frac) * g;
        }
      }
      outL[i] = l;
      outR[i] = r;
      pos += this.rate;
      if (loop && pos >= this.loopEnd) pos = this.loopStart + (pos - this.loopEnd);
    }
    this.pos = pos;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];
    const n = outL.length;
    if (!this.playing || !this.length) {
      outL.fill(0);
      outR.fill(0);
      return true;
    }
    if (this.keyLock) this.processKeyLock(outL, outR, n);
    else this.processVarispeed(outL, outR, n);
    if (this.pos >= this.length && !this.loopActive()) {
      this.playing = false;
      this.pos = this.length;
      this.port.postMessage({ type: 'ended' });
      this.report(true);
    } else {
      this.report(false);
    }
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);

/** Taps the master bus and ships 16-bit interleaved PCM to the main thread in ~0.5 s chunks. */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.chunk = new Int16Array(Math.round(sampleRate * 0.5) * 2);
    this.fill = 0;
    this.peak = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'start') {
        this.active = true;
        this.fill = 0;
      } else if (e.data.type === 'stop') {
        this.flush();
        this.active = false;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (this.fill === 0) return;
    const data = this.chunk.slice(0, this.fill);
    this.port.postMessage({ type: 'chunk', data, peak: this.peak }, [data.buffer]);
    this.fill = 0;
    this.peak = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!this.active || !input || input.length === 0) return true;
    const l = input[0];
    const r = input[1] || input[0];
    for (let i = 0; i < l.length; i++) {
      const a = Math.max(-1, Math.min(1, l[i]));
      const b = Math.max(-1, Math.min(1, r[i]));
      this.peak = Math.max(this.peak, Math.abs(a), Math.abs(b));
      this.chunk[this.fill++] = a < 0 ? a * 32768 : a * 32767;
      this.chunk[this.fill++] = b < 0 ? b * 32768 : b * 32767;
      if (this.fill >= this.chunk.length) this.flush();
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
