import { memo, useEffect, useRef, useState } from 'react';
import { Knob, useRaf } from '../components/Controls';
import { drawPeaks } from '../components/Waveforms';
import { keyCompatibility, semitonesToMatch, shiftKey, trackKey } from '../music';
import { trackById, useApp } from '../store/app';
import { STEM_COLOR, STEM_LABEL, type StemName, type Track } from '../types';
import { TRACK_MIME } from '../views/LibraryTable';
import { clipSourceKey, getLoadedSource, remixEngine, useSources } from './engine';
import { type AudioClip, type AutoPoint, type Clip, type RemixProject, type RemixTrack, type SourceStem, clipEnd, newTrack, projectLength, uid } from './model';
import { snapBeat, useRemix } from './store';

export const STEM_MIME = 'application/x-stemdeck-stem';
const HEADER_W = 232;
const RULER_H = 28;
const AUTO_H = 56;

function laneHeight(t: RemixTrack) {
  return t.kind === 'audio' ? 66 : 50;
}

/** Create an audio clip for a library track stem, positioned at `beat`. */
export function makeAudioClip(track: Track, stem: SourceStem, beat: number, project: RemixProject, autoKey: boolean): AudioClip {
  const bpm = track.bpm || project.bpm;
  const beats = Math.max(1, Math.floor(((track.duration - (track.first_beat || 0)) * bpm) / 60));
  const semis = autoKey && project.key ? semitonesToMatch(trackKey(track), project.key) : 0;
  return { id: uid(), type: 'audio', start: beat, length: beats, gain: 1, trackId: track.id, stem, offset: 0, semitones: semis, loopLen: null };
}

// ---- clip views ---------------------------------------------------------------------------

const ClipBody = memo(function ClipBody({ clip, project, width, height, color }: { clip: Clip; project: RemixProject; width: number; height: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const version = useSources((s) => s.version);
  const track = clip.type === 'audio' ? trackById(clip.trackId) : undefined;
  const srcKey = clip.type === 'audio' ? clipSourceKey(clip, track, project.bpm) : '';
  const pattern = clip.type === 'pattern' ? project.patterns.find((p) => p.id === clip.patternId) : undefined;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = Math.max(1, Math.min(Math.round(width), 4096));
    const h = Math.max(1, Math.round(height));
    el.width = w;
    el.height = h;
    const ctx = el.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    const spb = 60 / project.bpm;
    if (clip.type === 'audio') {
      const src = getLoadedSource(srcKey);
      if (!src) return;
      const pxPerBeat = w / clip.length;
      const seg = (fromBeat: number, beats: number, x: number) => {
        const t0 = src.firstBeatSec + fromBeat * spb;
        drawPeaks(ctx, src.peaks, t0, t0 + beats * spb, x, beats * pxPerBeat, h / 2, h / 2 - 2, color);
      };
      if (clip.loopLen) {
        for (let b = 0; b < clip.length; b += clip.loopLen) seg(clip.offset, Math.min(clip.loopLen, clip.length - b), b * pxPerBeat);
      } else seg(clip.offset, clip.length, 0);
    } else if (clip.type === 'pattern' && pattern) {
      const steps = clip.length * 4;
      const sw = w / steps;
      const rows = pattern.steps.length;
      const rh = h / rows;
      ctx.fillStyle = color;
      for (let k = 0; k < steps; k++)
        for (let v = 0; v < rows; v++) {
          const vel = pattern.steps[v][k % 16];
          if (vel) {
            ctx.globalAlpha = 0.35 + vel * 0.65;
            ctx.fillRect(k * sw + 0.5, v * rh + 0.5, Math.max(1, sw - 1), Math.max(1, rh - 1));
          }
        }
      ctx.globalAlpha = 1;
    } else if (clip.type === 'riser') {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      const rising = clip.variant === 'riser';
      g.addColorStop(0, rising ? 'rgba(155,225,93,0.05)' : 'rgba(155,225,93,0.7)');
      g.addColorStop(1, rising ? 'rgba(155,225,93,0.7)' : 'rgba(155,225,93,0.03)');
      ctx.fillStyle = g;
      ctx.beginPath();
      if (rising) {
        ctx.moveTo(0, h - 2);
        ctx.lineTo(w, 2);
        ctx.lineTo(w, h - 2);
      } else {
        ctx.moveTo(0, 2);
        ctx.lineTo(0, h - 2);
        ctx.lineTo(clip.variant === 'impact' ? Math.min(w, w * 0.4) : w, h - 2);
      }
      ctx.fill();
    }
  }, [clip, width, height, color, version, srcKey, pattern, project.bpm]);

  return <canvas ref={ref} style={{ position: 'absolute', inset: '16px 0 0 0', width: '100%', height: 'calc(100% - 16px)', pointerEvents: 'none' }} />;
});

function clipLabel(clip: Clip, project: RemixProject): string {
  if (clip.type === 'audio') {
    const t = trackById(clip.trackId);
    const stem = clip.stem === 'original' ? 'Full mix' : STEM_LABEL[clip.stem as StemName];
    return `${stem} · ${t?.title ?? 'missing track'}${clip.semitones ? ` (${clip.semitones > 0 ? '+' : ''}${clip.semitones})` : ''}`;
  }
  if (clip.type === 'pattern') return project.patterns.find((p) => p.id === clip.patternId)?.name ?? 'Pattern';
  return clip.variant === 'riser' ? 'Riser' : clip.variant === 'downlifter' ? 'Downlifter' : 'Impact';
}

function clipColor(clip: Clip, track: RemixTrack) {
  if (clip.type === 'audio') return STEM_COLOR[clip.stem];
  return track.color;
}

type DragMode = 'move' | 'left' | 'right';

function ClipView({ clip, track, trackIndex, project, zoom, height }: { clip: Clip; track: RemixTrack; trackIndex: number; project: RemixProject; zoom: number; height: number }) {
  const selected = useRemix((s) => s.selectedClip === clip.id);
  const loading = useSources((s) => s.loading);
  const drag = useRef<{ mode: DragMode; x: number; y: number; orig: Clip; trackIndex: number; copied: boolean } | null>(null);
  const color = clipColor(clip, track);
  const lib = clip.type === 'audio' ? trackById(clip.trackId) : undefined;
  const srcReady = clip.type !== 'audio' || !!getLoadedSource(clipSourceKey(clip, lib, project.bpm));
  const clash =
    clip.type === 'audio' && project.key && lib ? keyCompatibility(shiftKey(trackKey(lib), clip.semitones), project.key) === 'clash' : false;
  const width = clip.length * zoom;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const mode: DragMode = x < 7 ? 'left' : x > rect.width - 7 ? 'right' : 'move';
    const store = useRemix.getState();
    store.select(clip.id, track.id);
    store.checkpoint();
    drag.current = { mode, x: e.clientX, y: e.clientY, orig: structuredClone(clip), trackIndex, copied: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { snap, edit } = useRemix.getState();
    const dBeats = (e.clientX - d.x) / zoom;
    const o = d.orig;
    if (d.mode === 'move') {
      // Alt-drag duplicates the clip and moves the copy.
      if (e.altKey && !d.copied) {
        d.copied = true;
        edit((p) => p.tracks[d.trackIndex].clips.push({ ...structuredClone(o), id: uid() }), { structural: false, history: false });
      }
      const start = Math.max(0, snapBeat(o.start + dBeats, snap || 0));
      // Vertical movement to another track of the same kind.
      const rowsMoved = Math.round((e.clientY - d.y) / height);
      edit(
        (p) => {
          let from = p.tracks.findIndex((t) => t.clips.some((c) => c.id === o.id));
          if (from < 0) return;
          const c = p.tracks[from].clips.find((x) => x.id === o.id)!;
          c.start = start;
          const target = d.trackIndex + rowsMoved;
          if (target !== from && p.tracks[target] && p.tracks[target].kind === p.tracks[from].kind) {
            p.tracks[from].clips = p.tracks[from].clips.filter((x) => x.id !== o.id);
            p.tracks[target].clips.push(c);
            from = target;
          }
        },
        { structural: false, history: false },
      );
    } else if (d.mode === 'left') {
      const minStart = Math.max(0, o.start - (o.type === 'audio' && !o.loopLen ? o.offset + 64 : 1e9));
      const start = Math.min(clipEnd(o) - 0.25, Math.max(minStart, snapBeat(o.start + dBeats, snap || 0)));
      edit(
        (p) => {
          const c = p.tracks.flatMap((t) => t.clips).find((x) => x.id === o.id);
          if (!c) return;
          const delta = start - o.start;
          c.start = start;
          c.length = o.length - delta;
          if (c.type === 'audio' && o.type === 'audio') c.offset = c.loopLen ? o.offset : o.offset + delta;
        },
        { structural: false, history: false },
      );
    } else {
      const end = Math.max(o.start + 0.25, snapBeat(clipEnd(o) + dBeats, snap || 0));
      edit(
        (p) => {
          const c = p.tracks.flatMap((t) => t.clips).find((x) => x.id === o.id);
          if (c) c.length = end - o.start;
        },
        { structural: false, history: false },
      );
    }
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    // Commit: reschedule playback once, at the end of the gesture.
    useRemix.getState().edit(() => undefined, { structural: true, history: false });
  };

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => e.stopPropagation()}
      title={clash ? 'Key clash with the project key — use “Match key” in the clip inspector' : undefined}
      style={{
        position: 'absolute',
        left: clip.start * zoom,
        width: Math.max(4, width),
        top: 3,
        bottom: 3,
        borderRadius: 7,
        background: `linear-gradient(180deg, ${color}40, ${color}1c)`,
        border: `1px solid ${selected ? '#fff' : `${color}aa`}`,
        boxShadow: selected ? `0 0 0 1px #fff, 0 0 16px ${color}66` : undefined,
        overflow: 'hidden',
        cursor: 'grab',
      }}
    >
      <div className="ellipsis" style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 6px', color: '#fff', textShadow: '0 1px 2px #000', pointerEvents: 'none', position: 'relative', zIndex: 1 }}>
        {clash && <span style={{ color: 'var(--bad)' }}>⚠ </span>}
        {clip.type === 'audio' && clip.loopLen ? '⟲ ' : ''}
        {clipLabel(clip, project)}
        {!srcReady && (loading ? ' · stretching…' : ' · unavailable')}
      </div>
      <ClipBody clip={clip} project={project} width={width} height={height - 6} color={color} />
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, cursor: 'ew-resize' }} />
      <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 6, cursor: 'ew-resize' }} />
    </div>
  );
}

// ---- automation lane ------------------------------------------------------------------------

function AutomationLane({ track, index, zoom, width }: { track: RemixTrack; index: number; zoom: number; width: number }) {
  const drag = useRef<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const h = AUTO_H;
  const toY = (v: number) => ((1 - (v + 1) / 2) * (h - 8)) + 4;
  const fromEvent = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const { snap } = useRemix.getState();
    return {
      beat: Math.max(0, snapBeat((e.clientX - r.left) / zoom, snap ? Math.min(snap, 0.25) : 0)),
      value: Math.max(-1, Math.min(1, 1 - ((e.clientY - r.top - 4) / (h - 8)) * 2)),
    };
  };
  const setPoints = (fn: (pts: AutoPoint[]) => AutoPoint[], history: boolean) =>
    useRemix.getState().edit(
      (p) => {
        const t = p.tracks[index];
        t.auto = fn(t.auto).sort((a, b) => a.beat - b.beat);
      },
      { structural: true, history },
    );
  const pts = track.auto;
  const path = pts.length
    ? `M 0 ${toY(pts[0].value)} ` + pts.map((p) => `L ${p.beat * zoom} ${toY(p.value)}`).join(' ') + ` L ${width} ${toY(pts[pts.length - 1].value)}`
    : `M 0 ${toY(track.filter)} L ${width} ${toY(track.filter)}`;
  return (
    <svg
      ref={ref}
      width={width}
      height={h}
      style={{ display: 'block', background: 'rgba(185,140,255,0.05)', borderTop: '1px dashed rgba(185,140,255,0.25)', cursor: 'crosshair' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const pt = fromEvent(e);
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        setPoints((list) => [...list, pt], true);
        drag.current = pt.beat;
      }}
      onPointerMove={(e) => {
        if (drag.current === null) return;
        const pt = fromEvent(e);
        const was = drag.current;
        drag.current = pt.beat;
        setPoints((list) => list.map((p) => (Math.abs(p.beat - was) < 1e-6 ? pt : p)), false);
      }}
      onPointerUp={() => (drag.current = null)}
    >
      <line x1={0} x2={width} y1={toY(0)} y2={toY(0)} stroke="rgba(255,255,255,0.08)" />
      <path d={path} stroke="#b98cff" strokeWidth={2} fill="none" />
      {pts.map((p, i) => (
        <circle
          key={i}
          cx={p.beat * zoom}
          cy={toY(p.value)}
          r={5}
          fill="#b98cff"
          stroke="#fff"
          strokeWidth={1}
          style={{ cursor: 'move' }}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.button === 2) return;
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
            useRemix.getState().checkpoint();
            drag.current = p.beat;
            (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setPoints((list) => list.filter((_, j) => j !== i), true);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setPoints((list) => list.filter((_, j) => j !== i), true);
          }}
        >
          <title>{`${p.value < 0 ? 'Low pass' : p.value > 0 ? 'High pass' : 'Open'} ${Math.round(Math.abs(p.value) * 100)}% — right-click to delete`}</title>
        </circle>
      ))}
    </svg>
  );
}

// ---- track header -------------------------------------------------------------------------------

function TrackHeader({ track, index, height }: { track: RemixTrack; index: number; height: number }) {
  const edit = useRemix((s) => s.edit);
  const selected = useRemix((s) => s.selectedTrack === track.id);
  const set = (fn: (t: RemixTrack) => void, structural = false) => edit((p) => fn(p.tracks[index]), { structural });
  const automated = track.autoOn && track.auto.length > 0;
  return (
    <div
      onPointerDown={() => useRemix.getState().select(useRemix.getState().selectedClip, track.id)}
      style={{
        height,
        padding: '6px 8px',
        borderLeft: `3px solid ${track.color}`,
        background: selected ? 'rgba(90,209,255,0.07)' : 'rgba(10,12,20,0.92)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div className="row" style={{ gap: 4 }}>
        <input
          className="input sm grow"
          style={{ background: 'transparent', border: '1px solid transparent', fontWeight: 700, padding: '0 4px' }}
          value={track.name}
          onChange={(e) => set((t) => (t.name = e.target.value))}
        />
        <button className={`btn sm icon ${track.mute ? 'on' : ''}`} style={{ ['--c' as string]: 'var(--bad)' }} onClick={() => set((t) => (t.mute = !t.mute))} title="Mute">
          M
        </button>
        <button className={`btn sm icon ${track.solo ? 'on' : ''}`} style={{ ['--c' as string]: 'var(--warn)' }} onClick={() => set((t) => (t.solo = !t.solo))} title="Solo">
          S
        </button>
        <button className={`btn sm icon ${track.showAuto ? 'on' : ''}`} style={{ ['--c' as string]: '#b98cff' }} onClick={() => set((t) => (t.showAuto = !t.showAuto))} title="Show filter automation lane">
          A
        </button>
      </div>
      <div className="row" style={{ gap: 6, justifyContent: 'space-between' }}>
        <Knob size={24} value={track.volume} min={0} max={1.2} defaultValue={0.85} onChange={(v) => set((t) => (t.volume = v))} label="Vol" format={(v) => `${Math.round(v * 100)}%`} />
        <Knob size={24} value={track.pan} min={-1} max={1} bipolar onChange={(v) => set((t) => (t.pan = v))} label="Pan" format={(v) => (Math.abs(v) < 0.02 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)} />
        <Knob
          size={24}
          value={track.filter}
          min={-1}
          max={1}
          bipolar
          color="#b98cff"
          disabled={automated}
          onChange={(v) => set((t) => (t.filter = v))}
          label="Filt"
          title={automated ? 'Controlled by automation' : undefined}
          format={(v) => (Math.abs(v) < 0.04 ? 'Off' : v < 0 ? `LP ${Math.round(-v * 100)}` : `HP ${Math.round(v * 100)}`)}
        />
        <Knob size={24} value={track.reverb} min={0} max={1} onChange={(v) => set((t) => (t.reverb = v))} label="Verb" color="#35d9c8" format={(v) => `${Math.round(v * 100)}%`} />
        <Knob size={24} value={track.delay} min={0} max={1} onChange={(v) => set((t) => (t.delay = v))} label="Dly" color="#ffb547" format={(v) => `${Math.round(v * 100)}%`} />
      </div>
    </div>
  );
}

// ---- timeline -------------------------------------------------------------------------------------

export function Timeline({ autoKey }: { autoKey: boolean }) {
  const project = useRemix((s) => s.project);
  const zoom = useRemix((s) => s.zoom);
  const scroller = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [rulerDrag, setRulerDrag] = useState<{ a: number; b: number } | null>(null);
  const totalBeats = Math.max(64 * 4, Math.ceil((projectLength(project) + 64) / 16) * 16);
  const width = totalBeats * zoom;

  useRaf(() => {
    const el = playhead.current;
    if (!el) return;
    const beat = remixEngine.position();
    const x = beat * zoom;
    el.style.transform = `translateX(${x}px)`;
    const sc = scroller.current;
    if (sc && follow && remixEngine.playing) {
      const view = sc.clientWidth - HEADER_W;
      const rel = x - sc.scrollLeft;
      if (rel > view * 0.85 || rel < 0) sc.scrollLeft = Math.max(0, x - view * 0.15);
    }
  });

  const beatFromClient = (clientX: number) => {
    const sc = scroller.current!;
    const r = sc.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - HEADER_W + sc.scrollLeft) / zoom);
  };

  const dropOnLane = (e: React.DragEvent, trackIndex: number | null) => {
    const raw = e.dataTransfer.getData(STEM_MIME) || e.dataTransfer.getData(TRACK_MIME);
    if (!raw) return;
    e.preventDefault();
    const { trackId, stem } = raw.startsWith('{') ? (JSON.parse(raw) as { trackId: number; stem: SourceStem }) : { trackId: Number(raw), stem: 'original' as SourceStem };
    const lib = trackById(trackId);
    if (!lib) return;
    const { snap, edit } = useRemix.getState();
    const beat = snapBeat(beatFromClient(e.clientX), snap || 1);
    const clip = makeAudioClip(lib, stem, beat, useRemix.getState().project, autoKey);
    edit((p) => {
      let t = trackIndex !== null ? p.tracks[trackIndex] : undefined;
      if (!t || t.kind !== 'audio') {
        t = newTrack('audio', stem === 'original' ? lib.title : `${STEM_LABEL[stem as StemName]} – ${lib.title}`.slice(0, 40), p.tracks.length);
        p.tracks.push(t);
      }
      t.clips.push(clip);
    });
    useRemix.getState().select(clip.id);
  };

  const laneDoubleClick = (e: React.MouseEvent, t: RemixTrack, i: number) => {
    const { snap, edit, selectedPattern } = useRemix.getState();
    const beat = snapBeat(beatFromClient(e.clientX), Math.max(snap, 1));
    if (t.kind === 'drums') {
      const pat = project.patterns.find((p) => p.id === selectedPattern) ?? project.patterns[0];
      if (!pat) return;
      const id = uid();
      edit((p) => p.tracks[i].clips.push({ id, type: 'pattern', patternId: pat.id, start: Math.floor(beat / 4) * 4, length: 4, gain: 1 }));
      useRemix.getState().select(id);
    } else if (t.kind === 'fx') {
      const id = uid();
      edit((p) => p.tracks[i].clips.push({ id, type: 'riser', variant: 'riser', start: beat, length: 16, gain: 0.8 }));
      useRemix.getState().select(id);
    }
  };

  const bars = totalBeats / 4;
  const loop = project.loop;

  return (
    <div ref={scroller} style={{ position: 'relative', overflow: 'auto', height: '100%' }} onPointerDown={() => useRemix.getState().select(null)}>
      <div style={{ width: HEADER_W + width, position: 'relative', minHeight: '100%' }}>
        {/* Ruler */}
        <div style={{ position: 'sticky', top: 0, zIndex: 5, display: 'flex', height: RULER_H }}>
          <div
            style={{ position: 'sticky', left: 0, zIndex: 6, width: HEADER_W, flex: 'none', background: 'rgba(10,12,20,0.97)', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px' }}
          >
            <label className="row faint" style={{ fontSize: 11, gap: 4 }}>
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow playhead
            </label>
          </div>
          <div
            style={{ position: 'relative', width, background: 'rgba(12,14,24,0.95)', borderBottom: '1px solid var(--line)', cursor: 'pointer' }}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.target as Element).setPointerCapture(e.pointerId);
              const b = snapBeat(beatFromClient(e.clientX), Math.max(useRemix.getState().snap, 1));
              setRulerDrag({ a: b, b });
            }}
            onPointerMove={(e) => {
              if (!rulerDrag || !(e.buttons & 1)) return;
              setRulerDrag({ ...rulerDrag, b: snapBeat(beatFromClient(e.clientX), Math.max(useRemix.getState().snap, 1)) });
            }}
            onPointerUp={() => {
              if (!rulerDrag) return;
              const a = Math.min(rulerDrag.a, rulerDrag.b);
              const b = Math.max(rulerDrag.a, rulerDrag.b);
              setRulerDrag(null);
              if (b - a >= 1) useRemix.getState().edit((p) => ((p.loop = { start: a, end: b }), (p.loopOn = true)), { structural: true });
              else remixEngine.setPosition(a);
            }}
            title="Click to move the playhead · drag to set the loop"
          >
            {Array.from({ length: bars }, (_, i) =>
              zoom * 4 >= 22 || i % 4 === 0 ? (
                <div key={i} style={{ position: 'absolute', left: i * 4 * zoom, top: 0, bottom: 0, borderLeft: '1px solid rgba(255,255,255,0.18)', paddingLeft: 3, fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>
                  {i + 1}
                </div>
              ) : null,
            )}
            {loop && (
              <div
                style={{
                  position: 'absolute',
                  left: loop.start * zoom,
                  width: (loop.end - loop.start) * zoom,
                  bottom: 0,
                  height: 8,
                  borderRadius: 3,
                  background: project.loopOn ? 'rgba(90,209,255,0.55)' : 'rgba(255,255,255,0.15)',
                }}
              />
            )}
            {rulerDrag && (
              <div style={{ position: 'absolute', left: Math.min(rulerDrag.a, rulerDrag.b) * zoom, width: Math.abs(rulerDrag.b - rulerDrag.a) * zoom, top: 0, bottom: 0, background: 'rgba(90,209,255,0.2)' }} />
            )}
          </div>
        </div>

        {/* Tracks */}
        {project.tracks.map((t, i) => {
          const h = laneHeight(t);
          return (
            <div key={t.id} style={{ borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'flex' }}>
                <div style={{ position: 'sticky', left: 0, zIndex: 4, width: HEADER_W, flex: 'none' }}>
                  <TrackHeader track={t} index={i} height={h} />
                </div>
                <div
                  style={{
                    position: 'relative',
                    width,
                    height: h,
                    backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.07) 0 1px, transparent 1px ${zoom * 4}px), repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0 1px, transparent 1px ${zoom}px)`,
                    opacity: t.mute ? 0.5 : 1,
                  }}
                  onDragOver={(e) => {
                    if (t.kind === 'audio' && (e.dataTransfer.types.includes(STEM_MIME) || e.dataTransfer.types.includes(TRACK_MIME))) e.preventDefault();
                  }}
                  onDrop={(e) => dropOnLane(e, i)}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    useRemix.getState().select(null, t.id);
                    remixEngine.setPosition(snapBeat(beatFromClient(e.clientX), useRemix.getState().snap || 0));
                  }}
                  onDoubleClick={(e) => laneDoubleClick(e, t, i)}
                >
                  {t.clips.map((c) => (
                    <ClipView key={c.id} clip={c} track={t} trackIndex={i} project={project} zoom={zoom} height={h} />
                  ))}
                  {t.clips.length === 0 && (
                    <div className="faint" style={{ position: 'absolute', left: 12, top: h / 2 - 8, fontSize: 11, pointerEvents: 'none' }}>
                      {t.kind === 'audio' ? 'Drag stems here from the browser' : t.kind === 'drums' ? 'Double-click to add a drum pattern' : 'Double-click to add a riser (or use FX tools below)'}
                    </div>
                  )}
                </div>
              </div>
              {t.showAuto && (
                <div style={{ display: 'flex' }}>
                  <div style={{ position: 'sticky', left: 0, zIndex: 4, width: HEADER_W, flex: 'none', height: AUTO_H, background: 'rgba(10,12,20,0.92)', padding: '6px 10px', borderLeft: '3px solid #b98cff' }}>
                    <div style={{ fontSize: 11, fontWeight: 700 }}>Filter automation</div>
                    <div className="row" style={{ gap: 4, marginTop: 4 }}>
                      <button className={`btn sm ${t.autoOn ? 'on' : ''}`} style={{ ['--c' as string]: '#b98cff' }} onClick={() => useRemix.getState().edit((p) => (p.tracks[i].autoOn = !p.tracks[i].autoOn))}>
                        {t.autoOn ? 'On' : 'Off'}
                      </button>
                      <button className="btn sm" disabled={!t.auto.length} onClick={() => useRemix.getState().edit((p) => (p.tracks[i].auto = []))}>
                        Clear
                      </button>
                    </div>
                  </div>
                  <AutomationLane track={t} index={i} zoom={zoom} width={width} />
                </div>
              )}
            </div>
          );
        })}

        {/* Drop zone for a new track */}
        <div style={{ display: 'flex', height: 60 }}>
          <div style={{ position: 'sticky', left: 0, width: HEADER_W, flex: 'none', background: 'rgba(10,12,20,0.6)' }} />
          <div
            className="faint"
            style={{ width, display: 'flex', alignItems: 'center', paddingLeft: 14, fontSize: 11 }}
            onDragOver={(e) => (e.dataTransfer.types.includes(STEM_MIME) || e.dataTransfer.types.includes(TRACK_MIME)) && e.preventDefault()}
            onDrop={(e) => dropOnLane(e, null)}
          >
            Drop here to create a new track
          </div>
        </div>

        {/* Loop shading + playhead over the lanes */}
        {loop && project.loopOn && (
          <div style={{ position: 'absolute', top: RULER_H, bottom: 0, left: HEADER_W + loop.start * zoom, width: (loop.end - loop.start) * zoom, background: 'rgba(90,209,255,0.05)', pointerEvents: 'none', borderLeft: '1px solid rgba(90,209,255,0.4)', borderRight: '1px solid rgba(90,209,255,0.4)' }} />
        )}
        <div
          ref={playhead}
          style={{ position: 'absolute', top: 0, bottom: 0, left: HEADER_W - 1, width: 2, background: '#fff', boxShadow: '0 0 10px rgba(90,209,255,0.9)', pointerEvents: 'none', zIndex: 3 }}
        />
      </div>
    </div>
  );
}

export function useTrackLookup() {
  return useApp((s) => s.tracks);
}
