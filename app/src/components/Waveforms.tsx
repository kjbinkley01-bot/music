import { useEffect, useRef, useState } from 'react';
import type { Deck } from '../audio/Deck';
import { PEAKS_PER_SEC } from '../audio/loader';
import { clamp, fmtTime } from '../music';
import { STEM_COLOR, type StemName } from '../types';
import { useCanvas, useRaf, useSubscribe } from './Controls';

/** Draw peaks for [t0, t1] seconds into a rect, one bar per pixel column (mirrored). */
export function drawPeaks(
  ctx: CanvasRenderingContext2D,
  peaks: Float32Array,
  t0: number,
  t1: number,
  x: number,
  w: number,
  mid: number,
  half: number,
  color: string,
  mode: 'mirror' | 'up' = 'mirror',
) {
  if (!peaks.length || w <= 0 || t1 <= t0) return;
  ctx.fillStyle = color;
  const binsPerPx = ((t1 - t0) * PEAKS_PER_SEC) / w;
  for (let px = 0; px < w; px++) {
    const b0 = Math.floor((t0 + (px / w) * (t1 - t0)) * PEAKS_PER_SEC);
    const b1 = Math.max(b0 + 1, Math.floor(b0 + binsPerPx));
    if (b1 <= 0 || b0 >= peaks.length) continue;
    let m = 0;
    for (let b = Math.max(0, b0); b < b1 && b < peaks.length; b++) if (peaks[b] > m) m = peaks[b];
    const h = Math.max(0.5, Math.min(1, m) * half);
    if (mode === 'mirror') ctx.fillRect(x + px, mid - h, 1, h * 2);
    else ctx.fillRect(x + px, mid - h, 1, h);
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, deck: Deck, t0: number, t1: number, w: number, h: number, alpha = 1) {
  if (!deck.bpm) return;
  const spb = deck.beatLength;
  const pxPerSec = w / (t1 - t0);
  // Thin out the grid when zoomed out: beats need 6px, bars 6px, otherwise draw nothing.
  const beatPx = spb * pxPerSec;
  if (beatPx * 4 < 6) return;
  const step = beatPx < 6 ? 4 : 1;
  const firstBeat = Math.ceil(deck.beatAt(t0) / step) * step;
  for (let b = firstBeat; ; b += step) {
    const t = deck.timeOfBeat(b);
    if (t > t1) break;
    const x = Math.round((t - t0) * pxPerSec) + 0.5;
    const bar = ((b % 4) + 4) % 4 === 0;
    ctx.fillStyle = bar ? `rgba(255,255,255,${0.32 * alpha})` : `rgba(255,255,255,${0.1 * alpha})`;
    ctx.fillRect(x, 0, 1, h);
    if (bar && beatPx * 4 > 34) {
      ctx.fillStyle = `rgba(255,255,255,${0.45 * alpha})`;
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(String(Math.floor(b / 4) + 1), x + 3, 10);
    }
  }
}

function stemColor(name: string, deck: Deck) {
  const base = STEM_COLOR[name as StemName] ?? STEM_COLOR.original;
  const silent = deck.soloStem ? deck.soloStem !== name : deck.stemMute[name];
  return silent ? 'rgba(255,255,255,0.08)' : base;
}

// ---- Stem Lab: one lane per stem, zoomable, drag to select a loop --------------------

export function StemLanes({ deck, onLoopSelect }: { deck: Deck; onLoopSelect(start: number, end: number): void }) {
  useSubscribe(deck);
  const [view, setView] = useState({ start: 0, span: 0 });
  const wrap = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; t: number; moved: boolean } | null>(null);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const duration = deck.duration;
  const span = view.span || duration;
  const t0 = view.start;
  const t1 = t0 + span;
  const lanes = deck.sources.length ? deck.sources : [];

  useEffect(() => setView({ start: 0, span: 0 }), [deck.track?.id]);

  const canvas = useCanvas(
    (ctx, w, h) => {
      if (!lanes.length) return;
      const laneH = h / lanes.length;
      lanes.forEach((s, i) => {
        const top = i * laneH;
        ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.015)' : 'rgba(0,0,0,0.12)';
        ctx.fillRect(0, top, w, laneH);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, top, w, laneH);
        ctx.clip();
        ctx.translate(0, top);
        drawGrid(ctx, deck, t0, t1, w, laneH, 0.7);
        ctx.restore();
        drawPeaks(ctx, s.peaks, t0, t1, 0, w, top + laneH / 2, laneH / 2 - 4, stemColor(s.name, deck));
      });
      if (deck.loop) {
        const x0 = ((deck.loop.start - t0) / span) * w;
        const x1 = ((deck.loop.end - t0) / span) * w;
        ctx.fillStyle = 'rgba(90,209,255,0.12)';
        ctx.fillRect(x0, 0, x1 - x0, h);
        ctx.fillStyle = 'rgba(90,209,255,0.8)';
        ctx.fillRect(x0, 0, 1.5, h);
        ctx.fillRect(x1 - 1.5, 0, 1.5, h);
      }
      if (sel) {
        const x0 = ((Math.min(sel.a, sel.b) - t0) / span) * w;
        const x1 = ((Math.max(sel.a, sel.b) - t0) / span) * w;
        ctx.fillStyle = 'rgba(185,140,255,0.18)';
        ctx.fillRect(x0, 0, x1 - x0, h);
      }
    },
    [deck.version, t0, span, sel],
  );

  useRaf(() => {
    const el = overlay.current;
    if (!el || !duration) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(w * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
    const ctx = el.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pos = deck.position;
    const x = ((pos - t0) / span) * w;
    if (x >= 0 && x <= w) {
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(90,209,255,0.9)';
      ctx.shadowBlur = 8;
      ctx.fillRect(Math.round(x) - 1, 0, 2, h);
    }
    // Follow the playhead when zoomed in.
    if (deck.playing && view.span && (pos > t1 - span * 0.05 || pos < t0)) {
      setView((v) => ({ ...v, start: clamp(pos - v.span * 0.1, 0, Math.max(0, duration - v.span)) }));
    }
  }, !!duration);

  const timeAt = (clientX: number) => {
    const rect = wrap.current!.getBoundingClientRect();
    return clamp(t0 + ((clientX - rect.left) / rect.width) * span, 0, duration);
  };

  if (!lanes.length) return <div className="empty">Load a track to see its waveform</div>;

  return (
    <div
      ref={wrap}
      style={{ position: 'relative', height: '100%', cursor: 'text' }}
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, t: timeAt(e.clientX), moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (Math.abs(e.clientX - d.x) > 4) d.moved = true;
        if (d.moved) setSel({ a: d.t, b: timeAt(e.clientX) });
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.moved && sel) {
          let a = Math.min(sel.a, sel.b);
          let b = Math.max(sel.a, sel.b);
          if (deck.quantize && deck.bpm) {
            a = deck.snapToBeat(a);
            b = Math.max(a + deck.beatLength, deck.snapToBeat(b));
          }
          onLoopSelect(a, b);
        } else {
          deck.seek(timeAt(e.clientX));
        }
        setSel(null);
      }}
      onWheel={(e) => {
        if (!duration) return;
        const rect = wrap.current!.getBoundingClientRect();
        const frac = (e.clientX - rect.left) / rect.width;
        if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          const factor = e.deltaY > 0 ? 1.25 : 0.8;
          const nextSpan = clamp(span * factor, 2, duration);
          const anchor = t0 + frac * span;
          const start = clamp(anchor - frac * nextSpan, 0, duration - nextSpan);
          setView({ start, span: nextSpan >= duration ? 0 : nextSpan });
        } else {
          setView((v) => ({ ...v, start: clamp(v.start + (e.deltaX / rect.width) * span, 0, duration - span) }));
        }
      }}
    >
      <canvas ref={canvas} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      <canvas ref={overlay} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
      <div className="faint mono" style={{ position: 'absolute', right: 8, bottom: 4, fontSize: 10, pointerEvents: 'none' }}>
        {view.span ? `${fmtTime(t0)} – ${fmtTime(t1)} · scroll to zoom` : 'scroll to zoom · drag to loop'}
      </div>
    </div>
  );
}

// ---- Overview strip (whole track), click to seek ------------------------------------------

export function Overview({ deck, height = 38, color }: { deck: Deck; height?: number; color?: string }) {
  useSubscribe(deck);
  const overlay = useRef<HTMLCanvasElement>(null);
  const canvas = useCanvas(
    (ctx, w, h) => {
      if (!deck.duration) return;
      if (deck.sources.length > 1) {
        for (const s of deck.sources) drawPeaks(ctx, s.peaks, 0, deck.duration, 0, w, h / 2, h / 2 - 2, withAlpha(stemColor(s.name, deck), 0.55));
      } else {
        drawPeaks(ctx, deck.overview, 0, deck.duration, 0, w, h / 2, h / 2 - 2, color ?? 'rgba(127,184,255,0.7)');
      }
      for (const c of deck.cues) {
        const x = (c.time / deck.duration) * w;
        ctx.fillStyle = CUE_COLORS[c.index % CUE_COLORS.length];
        ctx.fillRect(x, 0, 2, h);
      }
    },
    [deck.version],
  );
  useRaf(() => {
    const el = overlay.current;
    if (!el || !deck.duration) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (el.width !== w) {
      el.width = w;
      el.height = h;
    }
    const ctx = el.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    const x = (deck.position / deck.duration) * w;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, x, h);
    ctx.fillStyle = '#fff';
    ctx.fillRect(Math.round(x), 0, 2, h);
    if (deck.loop) {
      ctx.fillStyle = 'rgba(90,209,255,0.3)';
      const a = (deck.loop.start / deck.duration) * w;
      ctx.fillRect(a, 0, Math.max(2, ((deck.loop.end - deck.loop.start) / deck.duration) * w), h);
    }
  }, !!deck.duration);
  return (
    <div
      style={{ position: 'relative', height, cursor: 'pointer', borderRadius: 8, overflow: 'hidden', background: 'rgba(0,0,0,0.25)' }}
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (deck.duration) deck.seek(((e.clientX - rect.left) / rect.width) * deck.duration);
      }}
    >
      <canvas ref={canvas} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      <canvas ref={overlay} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
    </div>
  );
}

export const CUE_COLORS = ['#ff5f7a', '#ffb547', '#f4e04d', '#4fe3a1', '#35d9c8', '#5ad1ff', '#8b7bff', '#e36bff'];

function withAlpha(color: string, a: number) {
  if (!color.startsWith('#')) return color;
  const n = parseInt(color.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---- DJ: scrolling waveform centred on the playhead -----------------------------------------

export function ScrollingWaveform({ deck, accent, zoom = 1 }: { deck: Deck; accent: string; zoom?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; pos: number; wasPlaying: boolean } | null>(null);
  useSubscribe(deck);
  useRaf(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
    const ctx = el.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!deck.duration) return;
    // Seconds visible scale with tempo so beats keep the same on-screen spacing on both decks.
    const span = (8 / zoom) * (deck.bpm ? 128 / deck.effectiveBpm : 1);
    const pos = deck.position;
    const t0 = pos - span / 2;
    const t1 = pos + span / 2;
    if (deck.loop) {
      const x0 = ((deck.loop.start - t0) / span) * w;
      const x1 = ((deck.loop.end - t0) / span) * w;
      ctx.fillStyle = 'rgba(90,209,255,0.13)';
      ctx.fillRect(x0, 0, x1 - x0, h);
    }
    drawGrid(ctx, deck, t0, t1, w, h, 0.9);
    const mid = h / 2;
    if (deck.sources.length > 1) {
      // Layered stems: low-end stems at the back, vocals on top.
      for (const name of ['bass', 'drums', 'other', 'vocals']) {
        const s = deck.sources.find((x) => x.name === name);
        if (s) drawPeaks(ctx, s.peaks, t0, t1, 0, w, mid, mid - 3, withAlpha(stemColor(name, deck), 0.78));
      }
    } else {
      drawPeaks(ctx, deck.overview, t0, t1, 0, w, mid, mid - 3, withAlpha(accent, 0.85));
    }
    for (const c of deck.cues) {
      if (c.time < t0 || c.time > t1) continue;
      const x = ((c.time - t0) / span) * w;
      ctx.fillStyle = CUE_COLORS[c.index % CUE_COLORS.length];
      ctx.fillRect(x - 1, 0, 2, h);
      ctx.beginPath();
      ctx.moveTo(x - 6, 0);
      ctx.lineTo(x + 6, 0);
      ctx.lineTo(x, 8);
      ctx.fill();
      ctx.fillStyle = '#0a0c14';
      ctx.font = 'bold 8px sans-serif';
      ctx.fillText(String(c.index + 1), x - 2.5, 6);
    }
    if (deck.cuePoint >= t0 && deck.cuePoint <= t1) {
      const x = ((deck.cuePoint - t0) / span) * w;
      ctx.fillStyle = '#ffc15a';
      ctx.beginPath();
      ctx.moveTo(x - 5, h);
      ctx.lineTo(x + 5, h);
      ctx.lineTo(x, h - 7);
      ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.shadowColor = accent;
    ctx.shadowBlur = 10;
    ctx.fillRect(Math.round(w / 2) - 1, 0, 2, h);
    ctx.shadowBlur = 0;
  });
  return (
    <canvas
      ref={ref}
      style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }}
      title="Drag to scrub"
      onPointerDown={(e) => {
        if (!deck.duration) return;
        (e.target as Element).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, pos: deck.position, wasPlaying: deck.playing };
        if (deck.playing) deck.pause();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const w = (e.target as HTMLCanvasElement).clientWidth;
        const span = (8 / zoom) * (deck.bpm ? 128 / deck.effectiveBpm : 1);
        deck.seek(d.pos - ((e.clientX - d.x) / w) * span);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d?.wasPlaying) void deck.play();
      }}
    />
  );
}
