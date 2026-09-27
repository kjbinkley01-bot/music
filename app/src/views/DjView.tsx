import { useEffect, useMemo, useRef, useState } from 'react';
import type { Deck } from '../audio/Deck';
import { Camelot, Fader, Knob, useRaf, useSubscribe } from '../components/Controls';
import { IconPause, IconPlay, IconRecord, IconSync } from '../components/Icons';
import { CUE_COLORS, Overview, ScrollingWaveform } from '../components/Waveforms';
import { dj, useDj } from '../dj/engine';
import { camelotName, fmtBpm, fmtTime, keyName, shiftKey, trackKey } from '../music';
import { trackById, useApp } from '../store/app';
import { STEMS, STEM_LABEL } from '../types';
import { type CompatRef, LibraryTable, TRACK_MIME } from './LibraryTable';

const ACCENT = ['#5ad1ff', '#ff8a5c'];

/** Key after the deck's speed change when key lock is off (varispeed shifts pitch). */
function effectiveKey(deck: Deck) {
  const k = deck.track ? trackKey(deck.track) : null;
  if (!k || deck.keyLock) return k;
  return shiftKey(k, 12 * Math.log2(deck.rate));
}

function DeckTime({ deck }: { deck: Deck }) {
  const ref = useRef<HTMLDivElement>(null);
  useRaf(() => {
    if (!ref.current) return;
    const p = deck.position;
    const beat = deck.bpm ? Math.floor(deck.beatAt(p)) : 0;
    const barInfo = deck.bpm ? ` · ${Math.floor(beat / 4) + 1}.${(((beat % 4) + 4) % 4) + 1}` : '';
    ref.current.textContent = `${fmtTime(p)} / -${fmtTime(deck.duration - p)}${barInfo}`;
  });
  return <div ref={ref} className="mono muted" style={{ fontSize: 12 }} />;
}

function DeckPanel({ index }: { index: 0 | 1 }) {
  const engine = dj();
  const deck = engine.decks[index];
  useSubscribe(deck);
  const [over, setOver] = useState(false);
  const accent = ACCENT[index];
  const t = deck.track;
  const eKey = effectiveKey(deck);
  const other = engine.other(deck);

  return (
    <div
      className="glass panel"
      style={{ padding: 12, gap: 10, outline: over ? `2px dashed ${accent}` : 'none', ['--c' as string]: accent }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TRACK_MIME)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = Number(e.dataTransfer.getData(TRACK_MIME));
        const track = trackById(id);
        if (track) void engine.loadTrack(index, track);
      }}
    >
      <div className="row">
        <div className="mono" style={{ fontSize: 22, fontWeight: 800, color: accent, width: 26 }}>
          {deck.id}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="ellipsis" style={{ fontWeight: 700, fontSize: 14 }}>
            {deck.loading ? `Loading… ${Math.round(deck.loading * 100)}%` : t ? t.title : 'Drop a track here'}
          </div>
          <div className="ellipsis muted">{t?.artist || (t ? 'Unknown artist' : 'or use the A / B buttons in the library')}</div>
        </div>
        <div className="col" style={{ alignItems: 'flex-end', gap: 2 }}>
          <div className="mono" style={{ fontSize: 20, fontWeight: 800 }}>
            {fmtBpm(deck.effectiveBpm ? Math.round(deck.effectiveBpm * 10) / 10 : null)}
          </div>
          <Camelot code={camelotName(eKey)} name={keyName(eKey)} />
        </div>
      </div>
      <DeckTime deck={deck} />
      <Overview deck={deck} height={34} color={accent} />
      <div className="row" style={{ alignItems: 'stretch', gap: 12 }}>
        <div className="col" style={{ gap: 8, flex: 1 }}>
          <div className="row">
            <button
              className="btn big"
              style={{ width: 64, borderColor: '#ffc15a', color: '#ffd896' }}
              onPointerDown={() => deck.cueDown()}
              onPointerUp={() => deck.cueUp()}
              onPointerLeave={() => deck.cueUp()}
              disabled={!t}
              title="Cue — hold to preview"
            >
              CUE
            </button>
            <button className={`btn big ${deck.playing ? 'on' : ''}`} style={{ width: 64, ['--c' as string]: 'var(--ok)' }} onClick={() => deck.togglePlay()} disabled={!t}>
              {deck.playing ? <IconPause size={20} /> : <IconPlay size={20} />}
            </button>
            <button className="btn big" onClick={() => deck.syncTo(other)} disabled={!t || !other.track} title="Match tempo and beat phase to the other deck">
              <IconSync size={16} /> SYNC
            </button>
            <div className="col" style={{ gap: 4 }}>
              <button className={`btn sm ${deck.keyLock ? 'on' : ''}`} onClick={() => deck.setKeyLock(!deck.keyLock)} title="Keep pitch when changing tempo">
                Key lock
              </button>
              <button className={`btn sm ${deck.quantize ? 'on' : ''}`} onClick={() => deck.setQuantize(!deck.quantize)} title="Snap cues and loops to the beat grid">
                Quantize
              </button>
            </div>
            <div className="col" style={{ gap: 4 }}>
              <button className="btn sm" onPointerDown={() => deck.setNudge(0.04)} onPointerUp={() => deck.setNudge(0)} onPointerLeave={() => deck.setNudge(0)} title="Nudge faster (hold)">
                ▶▶
              </button>
              <button className="btn sm" onPointerDown={() => deck.setNudge(-0.04)} onPointerUp={() => deck.setNudge(0)} onPointerLeave={() => deck.setNudge(0)} title="Nudge slower (hold)">
                ◀◀
              </button>
            </div>
          </div>
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 4 }}>
              {Array.from({ length: 8 }, (_, i) => {
                const cue = deck.cues.find((c) => c.index === i);
                const col = CUE_COLORS[i];
                return (
                  <button
                    key={i}
                    className="btn sm"
                    disabled={!t}
                    style={cue ? { background: `${col}33`, borderColor: col, color: '#fff' } : undefined}
                    onClick={(e) => (e.shiftKey ? void deck.deleteHotCue(i) : deck.hotCue(i))}
                    title={cue ? `Hot cue ${i + 1} at ${fmtTime(cue.time, true)} — click to jump, shift-click to clear` : `Set hot cue ${i + 1} here`}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="row" style={{ gap: 4 }}>
              {[1, 2, 4, 8, 16].map((b) => (
                <button key={b} className={`btn sm grow ${deck.loop?.beats === b ? 'on' : ''}`} disabled={!t?.bpm} onClick={() => deck.beatLoop(b)} title={`${b}-beat loop`}>
                  {b}
                </button>
              ))}
              <button className="btn sm" disabled={!deck.loop} onClick={() => deck.resizeLoop(0.5)} title="Halve loop">
                ÷2
              </button>
              <button className="btn sm" disabled={!deck.loop} onClick={() => deck.resizeLoop(2)} title="Double loop">
                ×2
              </button>
            </div>
          </div>
          <div>
            <div className="row" style={{ gap: 4 }}>
              {STEMS.map((s) => {
                const has = deck.hasStem(s);
                const on = has && !deck.stemMute[s];
                return (
                  <button
                    key={s}
                    className={`btn sm grow stem-${s} ${on ? 'on' : ''}`}
                    disabled={!has}
                    onClick={() => deck.toggleMute(s)}
                    title={has ? `Toggle ${STEM_LABEL[s].toLowerCase()}` : 'Separate this track in Stem Lab to use stems'}
                  >
                    {STEM_LABEL[s]}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="col" style={{ alignItems: 'center', gap: 4 }}>
          <span className="knob-label">Pitch</span>
          <Fader value={deck.pitchFader} min={-1} max={1} onChange={(v) => deck.setPitchFader(v)} length={150} centerDetent defaultValue={0} invert title="Double-click to reset" />
          <span className="mono" style={{ fontSize: 11 }}>
            {deck.rate >= 1 ? '+' : ''}
            {((deck.rate - 1) * 100).toFixed(1)}%
          </span>
          <select className="select sm" value={deck.pitchRange} onChange={(e) => deck.setPitchRange(Number(e.target.value))}>
            <option value={0.08}>±8%</option>
            <option value={0.16}>±16%</option>
            <option value={0.5}>±50%</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function Channel({ deck, accent }: { deck: Deck; accent: string }) {
  useSubscribe(deck);
  const eq = (band: 'high' | 'mid' | 'low', label: string) => (
    <Knob size={32} value={deck.eq[band]} min={-26} max={6} defaultValue={0} onChange={(v) => deck.setEq(band, v)} label={label} color={accent} format={(v) => (v <= -25.5 ? 'KILL' : `${v.toFixed(1)} dB`)} />
  );
  return (
    <div className="col" style={{ alignItems: 'center', gap: 6 }}>
      <div className="mono" style={{ color: accent, fontWeight: 800 }}>
        {deck.id}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 6px' }}>
        {eq('high', 'High')}
        {eq('mid', 'Mid')}
        {eq('low', 'Low')}
        <Knob size={32} value={deck.filter} min={-1} max={1} bipolar onChange={(v) => deck.setFilter(v)} label="Filter" color="#b98cff" format={(v) => (Math.abs(v) < 0.04 ? 'OFF' : v < 0 ? `LP ${Math.round(-v * 100)}` : `HP ${Math.round(v * 100)}`)} />
      </div>
      <Fader value={deck.volume} max={1} onChange={(v) => deck.setVolume(v)} length={110} defaultValue={1} title="Channel volume" />
    </div>
  );
}

function Mixer() {
  const engine = dj();
  const { xfade, curve, recording, recordSeconds, recordPeak, recordFormat, masterVolume } = useDj();
  return (
    <div className="glass panel" style={{ padding: 10, alignItems: 'center', gap: 8, width: 250 }}>
      <div className="row" style={{ width: '100%' }}>
        <span className="panel-title grow">Mixer</span>
        <Knob value={masterVolume} min={0} max={1} defaultValue={0.9} onChange={(v) => engine.setMasterVolume(v)} size={26} title="Master volume" format={(v) => `Master ${Math.round(v * 100)}%`} />
      </div>
      <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
        <Channel deck={engine.decks[0]} accent={ACCENT[0]} />
        <Channel deck={engine.decks[1]} accent={ACCENT[1]} />
      </div>
      <Fader orientation="horizontal" value={xfade} min={-1} max={1} onChange={(v) => engine.setCrossfader(v)} length={180} centerDetent defaultValue={0} title="Crossfader (Shift + ← / →)" />
      <div className="seg sm">
        <button className={curve === 'smooth' ? 'on' : ''} onClick={() => engine.setCurve('smooth')}>
          Smooth
        </button>
        <button className={curve === 'sharp' ? 'on' : ''} onClick={() => engine.setCurve('sharp')}>
          Sharp
        </button>
      </div>
      <div className="row">
        <button className={`btn ${recording ? 'on' : ''}`} style={{ ['--c' as string]: 'var(--bad)' }} onClick={() => (recording ? void engine.stopRecording() : void engine.startRecording())}>
          <IconRecord size={12} style={{ color: 'var(--bad)' }} /> {recording ? fmtTime(recordSeconds) : 'Record'}
        </button>
        <select className="select sm" value={recordFormat} disabled={recording} onChange={(e) => useDj.setState({ recordFormat: e.target.value as 'wav' | 'mp3' })}>
          <option value="wav">WAV</option>
          <option value="mp3">MP3</option>
        </select>
      </div>
      {recording && (
        <div className="progress" style={{ width: '100%' }}>
          <div style={{ width: `${Math.min(100, recordPeak * 100)}%`, background: recordPeak > 0.97 ? 'var(--bad)' : undefined }} />
        </div>
      )}
    </div>
  );
}

function useDjKeys(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const engine = dj();
    const [a, b] = engine.decks;
    const cueKeys: Record<string, [Deck, number]> = {
      KeyQ: [a, 0], KeyW: [a, 1], KeyE: [a, 2], KeyR: [a, 3],
      KeyU: [b, 0], KeyI: [b, 1], KeyO: [b, 2], KeyP: [b, 3],
    };
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea') || e.ctrlKey || e.metaKey) return;
      if (e.repeat) return;
      const c = cueKeys[e.code];
      if (c) return e.shiftKey ? void c[0].deleteHotCue(c[1]) : c[0].hotCue(c[1]);
      switch (e.code) {
        case 'KeyZ': return a.togglePlay();
        case 'KeyX': return a.cueDown();
        case 'KeyA': return a.syncTo(b);
        case 'KeyS': return a.setNudge(-0.04);
        case 'KeyD': return a.setNudge(0.04);
        case 'KeyF': return a.beatLoop(4);
        case 'KeyM': return b.togglePlay();
        case 'KeyN': return b.cueDown();
        case 'KeyK': return b.syncTo(a);
        case 'KeyJ': return b.setNudge(-0.04);
        case 'KeyL': return b.setNudge(0.04);
        case 'KeyH': return b.beatLoop(4);
        case 'ArrowLeft':
        case 'ArrowRight':
          if (e.shiftKey) {
            e.preventDefault();
            engine.setCrossfader(useDj.getState().xfade + (e.code === 'ArrowLeft' ? -0.1 : 0.1));
          }
      }
    };
    const up = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyX': return a.cueUp();
        case 'KeyN': return b.cueUp();
        case 'KeyS':
        case 'KeyD': return a.setNudge(0);
        case 'KeyJ':
        case 'KeyL': return b.setNudge(0);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [active]);
}

export function DjView() {
  const engine = dj();
  const view = useApp((s) => s.view);
  const [a, b] = engine.decks;
  useSubscribe(a);
  useSubscribe(b);
  useDjKeys(view === 'dj');
  const [zoom, setZoom] = useState(1);

  // Harmonic hints are based on whatever is loaded (playing decks first).
  const refs: CompatRef[] = useMemo(() => {
    const decks = [a, b].filter((d) => d.track && d.bpm);
    const playing = decks.filter((d) => d.playing);
    return (playing.length ? playing : decks).map((d) => ({ key: effectiveKey(d), bpm: d.effectiveBpm }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.version, b.version]);

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto auto minmax(150px, 1fr)', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, height: '100%' }}>
      <div className="glass" style={{ padding: 6, position: 'relative' }}>
        {[a, b].map((d, i) => (
          <div key={d.id} style={{ height: 72, borderBottom: i === 0 ? '1px solid var(--line)' : undefined }}>
            <ScrollingWaveform deck={d} accent={ACCENT[i]} zoom={zoom} />
          </div>
        ))}
        <div className="seg sm" style={{ position: 'absolute', right: 10, top: 10 }}>
          {[0.5, 1, 2].map((z) => (
            <button key={z} className={zoom === z ? 'on' : ''} onClick={() => setZoom(z)}>
              {z === 0.5 ? '−' : z === 1 ? '1×' : '+'}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', gap: 10 }}>
        <DeckPanel index={0} />
        <Mixer />
        <DeckPanel index={1} />
      </div>
      <div className="glass panel">
        <LibraryTable
          compact={false}
          compatWith={refs}
          onOpen={(t) => void engine.loadTrack(!a.track ? 0 : !b.track ? 1 : a.playing ? 1 : 0, t)}
          extraActions={(t) => (
            <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
              <button className="btn sm" style={{ color: ACCENT[0] }} onClick={() => void engine.loadTrack(0, t)}>
                A
              </button>
              <button className="btn sm" style={{ color: ACCENT[1] }} onClick={() => void engine.loadTrack(1, t)}>
                B
              </button>
            </span>
          )}
        />
      </div>
    </div>
  );
}
