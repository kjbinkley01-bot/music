import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Deck } from '../audio/Deck';
import { masterBus } from '../audio/context';
import { loadTrackSources } from '../audio/loader';
import { Camelot, Fader, Modal, useRaf, useSubscribe } from '../components/Controls';
import { IconExport, IconFolder, IconLoop, IconMusic, IconPause, IconPlay, IconPlus, IconStop, IconX } from '../components/Icons';
import { StemLanes } from '../components/Waveforms';
import { clamp, fmtBpm, fmtTime } from '../music';
import { reportError, trackById, useApp } from '../store/app';
import { STEMS, STEM_LABEL, type StemName, type Track } from '../types';
import { LibraryTable } from './LibraryTable';

let labDeck: Deck | null = null;
export function stemLabDeck(): Deck {
  if (!labDeck) {
    labDeck = new Deck('lab', masterBus());
    labDeck.autoGain = false; // Stem Lab plays files at their true level, like the exports
  }
  return labDeck;
}

export async function importWithDialog(kind: 'files' | 'folder') {
  const bridge = window.stemdeck;
  let paths: string[] = [];
  if (bridge) {
    if (kind === 'files') paths = await bridge.openFiles();
    else {
      const folder = await bridge.openFolder({ title: 'Add a music folder' });
      if (folder) paths = [folder];
    }
  } else {
    const p = prompt(kind === 'files' ? 'Full path of an audio file:' : 'Full path of a music folder:');
    if (p) paths = [p];
  }
  if (paths.length) await importPaths(paths);
}

export async function importPaths(paths: string[]) {
  const app = useApp.getState();
  try {
    const res = await api.importPaths(paths);
    await app.refreshTracks();
    const parts = [`Added ${res.added.length} track${res.added.length === 1 ? '' : 's'}`];
    if (res.skipped) parts.push(`${res.skipped} already in library`);
    if (res.missing.length) parts.push(`${res.missing.length} not found`);
    app.toast(parts.join(' · '), res.added.length ? 'success' : 'info');
  } catch (e) {
    reportError(e, 'Import failed');
  }
}

async function openInLab(track: Track) {
  const deck = stemLabDeck();
  try {
    deck.pause();
    deck.setLoading(0.01);
    const sources = await loadTrackSources(track, (p) => deck.setLoading(Math.max(0.01, p)));
    await deck.load(track, sources);
    useApp.getState().selectTrack(track.id);
  } catch (e) {
    reportError(e, `Could not open “${track.title}”`);
  } finally {
    deck.setLoading(0);
  }
}

// ---- queue ------------------------------------------------------------------------------

function Queue() {
  const jobs = useApp((s) => s.jobs);
  const separations = jobs.filter((j) => j.kind === 'separate');
  const analysing = jobs.filter((j) => j.kind === 'analyze' && (j.status === 'queued' || j.status === 'running')).length;
  if (!separations.length && !analysing) return null;
  return (
    <div style={{ borderTop: '1px solid var(--line)', maxHeight: 190, overflow: 'auto', padding: '8px 12px' }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="panel-title">Processing queue</span>
        {analysing > 0 && <span className="chip busy">Analysing {analysing}</span>}
        <div className="spacer" />
        {separations.some((j) => j.status === 'queued' || j.status === 'running') && (
          <button className="btn sm ghost" onClick={() => void api.cancelAll()}>
            Cancel all
          </button>
        )}
      </div>
      {separations.map((j) => {
        const elapsed = j.started_at ? Date.now() / 1000 - j.started_at : 0;
        const eta = j.status === 'running' && j.progress > 0.08 ? (elapsed / j.progress) * (1 - j.progress) : null;
        return (
          <div key={j.id} className="row" style={{ padding: '4px 0' }}>
            <div className="grow ellipsis">
              {j.title} <span className="faint">{j.quality === 'high' ? '· HQ' : '· fast'}</span>
            </div>
            {j.status === 'running' ? (
              <>
                <span className="faint ellipsis" style={{ maxWidth: 170, fontSize: 11 }}>
                  {j.message}
                  {eta ? ` · ~${fmtTime(eta)} left` : ''}
                </span>
                <div className="progress" style={{ width: 110 }}>
                  <div style={{ width: `${Math.round(j.progress * 100)}%` }} />
                </div>
              </>
            ) : (
              <span className={`chip ${j.status === 'done' ? 'ok' : j.status === 'error' ? 'bad' : j.status === 'queued' ? 'busy' : ''}`} title={j.message}>
                {j.status}
              </span>
            )}
            {(j.status === 'queued' || j.status === 'running') && (
              <button className="btn sm ghost icon" title="Cancel" onClick={() => void api.cancelJob(j.id)}>
                <IconX size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- player -------------------------------------------------------------------------------

function TimeReadout({ deck }: { deck: Deck }) {
  const ref = useRef<HTMLSpanElement>(null);
  useRaf(() => {
    if (ref.current) ref.current.textContent = `${fmtTime(deck.position, true)} / ${fmtTime(deck.duration)}`;
  });
  return <span ref={ref} className="mono" style={{ fontSize: 15, minWidth: 120 }} />;
}

function TapTempo({ onBpm }: { onBpm(bpm: number): void }) {
  const taps = useRef<number[]>([]);
  const [bpm, setBpm] = useState<number | null>(null);
  return (
    <>
      <button
        className="btn sm"
        title="Tap along to the beat (at least 4 taps)"
        onClick={() => {
          const now = performance.now();
          taps.current = [...taps.current.filter((t) => now - t < 2500), now].slice(-8);
          const t = taps.current;
          if (t.length >= 4) setBpm(Math.round(((60000 * (t.length - 1)) / (t[t.length - 1] - t[0])) * 10) / 10);
        }}
      >
        Tap
      </button>
      {bpm && (
        <button className="btn sm primary" title="Use the tapped tempo" onClick={() => onBpm(bpm)}>
          Set {bpm}
        </button>
      )}
    </>
  );
}

function GridTools({ deck, track }: { deck: Deck; track: Track }) {
  const patch = async (p: Partial<Track>) => {
    try {
      const t = await api.patchTrack(track.id, p);
      useApp.getState().patchTrackLocal(t);
      deck.updateTrack(t);
    } catch (e) {
      reportError(e, 'Could not update track');
    }
  };
  const bpm = track.bpm || 120;
  const spb = 60 / bpm;
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
      <span className="faint" style={{ fontSize: 11 }}>
        Beat grid
      </span>
      <button className="btn sm" onClick={() => patch({ bpm: bpm / 2 })} title="Halve BPM">
        ½×
      </button>
      <button className="btn sm" onClick={() => patch({ bpm: bpm * 2 })} title="Double BPM">
        2×
      </button>
      <button className="btn sm" title="Move grid earlier (10 ms)" onClick={() => patch({ first_beat: track.first_beat - 0.01 })}>
        ◀ 10ms
      </button>
      <button className="btn sm" title="Move grid later (10 ms)" onClick={() => patch({ first_beat: track.first_beat + 0.01 })}>
        10ms ▶
      </button>
      <button className="btn sm" title="Shift bar numbering by one beat" onClick={() => patch({ first_beat: track.first_beat + spb })}>
        +1 beat
      </button>
      <button className="btn sm" title="Make the current playhead position beat 1 of bar 1" onClick={() => patch({ first_beat: deck.position })}>
        Downbeat here
      </button>
      <TapTempo onBpm={(b) => patch({ bpm: b })} />
    </div>
  );
}

const PRESETS: { label: string; keep: StemName[] | null }[] = [
  { label: 'All', keep: null },
  { label: 'Acapella', keep: ['vocals'] },
  { label: 'Instrumental', keep: ['drums', 'bass', 'other'] },
  { label: 'Drums', keep: ['drums'] },
  { label: 'Bass', keep: ['bass'] },
  { label: 'Melody', keep: ['other'] },
];

function ExportDialog({ deck, track, onClose }: { deck: Deck; track: Track; onClose(): void }) {
  const [format, setFormat] = useState<'wav' | 'mp3'>('wav');
  const [what, setWhat] = useState<string>('Current mix');
  const [region, setRegion] = useState<'full' | 'loop'>(deck.loop ? 'loop' : 'full');
  const [applyTempo, setApplyTempo] = useState(Math.abs(deck.rate - 1) > 0.001);
  const [semitones, setSemitones] = useState(0);
  const [busy, setBusy] = useState(false);
  const hasStems = deck.sources.length > 1;

  const gainsFor = (choice: string): Record<string, number> => {
    if (choice === 'Current mix') {
      return Object.fromEntries(
        STEMS.map((s) => [s, deck.soloStem ? (deck.soloStem === s ? deck.stemGain[s] ?? 1 : 0) : deck.stemMute[s] ? 0 : deck.stemGain[s] ?? 1]),
      );
    }
    const preset = PRESETS.find((p) => p.label === choice);
    return Object.fromEntries(STEMS.map((s) => [s, !preset?.keep || preset.keep.includes(s) ? 1 : 0]));
  };

  const run = async () => {
    setBusy(true);
    try {
      const separate = what === 'Each stem (separate files)';
      const res = await api.exportStems({
        track_id: track.id,
        gains: separate ? gainsFor('All') : gainsFor(what),
        format,
        label: what === 'Current mix' ? 'Custom Mix' : what,
        tempo_ratio: applyTempo ? deck.rate : 1,
        semitones,
        start: region === 'loop' && deck.loop ? deck.loop.start : null,
        end: region === 'loop' && deck.loop ? deck.loop.end : null,
        separate,
      });
      const first = res.files[0];
      useApp.getState().toast(`Exported ${res.files.length} file${res.files.length > 1 ? 's' : ''}`, 'success', {
        label: 'Show',
        run: () => window.stemdeck?.showItem(first),
      });
      onClose();
    } catch (e) {
      reportError(e, 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Export — ${track.title}`} onClose={onClose} width={520}>
      <div className="form-grid" style={{ gridTemplateColumns: '130px 1fr' }}>
        <label>What</label>
        <select className="select" value={what} onChange={(e) => setWhat(e.target.value)} disabled={!hasStems}>
          <option>Current mix</option>
          {PRESETS.slice(1).map((p) => (
            <option key={p.label}>{p.label}</option>
          ))}
          <option>Each stem (separate files)</option>
        </select>
        {!hasStems && <div className="hint">Separate the track to export individual stems.</div>}
        <label>Format</label>
        <div className="seg">
          <button className={format === 'wav' ? 'on' : ''} onClick={() => setFormat('wav')}>
            WAV (24-bit)
          </button>
          <button className={format === 'mp3' ? 'on' : ''} onClick={() => setFormat('mp3')}>
            MP3
          </button>
        </div>
        <label>Region</label>
        <div className="seg">
          <button className={region === 'full' ? 'on' : ''} onClick={() => setRegion('full')}>
            Whole track
          </button>
          <button className={region === 'loop' ? 'on' : ''} disabled={!deck.loop} onClick={() => setRegion('loop')}>
            Loop only
          </button>
        </div>
        <label>Tempo</label>
        <label className="row">
          <input type="checkbox" checked={applyTempo} onChange={(e) => setApplyTempo(e.target.checked)} />
          Apply current speed ({Math.round(deck.rate * 100)}% → {fmtBpm(deck.effectiveBpm)} BPM)
        </label>
        <label>Transpose</label>
        <div className="row">
          <input type="range" min={-12} max={12} step={1} value={semitones} onChange={(e) => setSemitones(Number(e.target.value))} className="grow" />
          <span className="mono" style={{ width: 40 }}>
            {semitones > 0 ? `+${semitones}` : semitones}
          </span>
        </div>
        <div className="hint">Tempo and pitch changes are rendered with the high quality engine (Rubber Band when installed).</div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={run} disabled={busy}>
          <IconExport /> {busy ? 'Exporting…' : 'Export'}
        </button>
      </div>
    </Modal>
  );
}

function Player() {
  const deck = stemLabDeck();
  useSubscribe(deck);
  const selectedId = useApp((s) => s.selectedTrackId);
  const liveTrack = useApp((s) => s.tracks.find((t) => t.id === deck.track?.id));
  const [exporting, setExporting] = useState(false);
  const track = deck.track;

  // Keep deck metadata (BPM, grid, stem status) in sync with the library.
  useEffect(() => {
    if (liveTrack && track && liveTrack !== track && liveTrack.id === track.id) deck.updateTrack(liveTrack);
  }, [liveTrack, track, deck]);

  const selected = trackById(selectedId);
  const stemsNowReady = track && liveTrack?.stem_status === 'done' && deck.sources.length === 1;

  if (!track) {
    return (
      <div className="empty">
        <IconMusic size={36} />
        <h3>Stem player</h3>
        <div>Double-click a track in the library to open it here.</div>
        {selected && (
          <button className="btn primary" onClick={() => openInLab(selected)}>
            Open “{selected.title}”
          </button>
        )}
      </div>
    );
  }

  const presetActive = (keep: StemName[] | null) =>
    !deck.soloStem && deck.sources.every((s) => (keep ? keep.includes(s.name as StemName) : true) === !deck.stemMute[s.name]);

  return (
    <div className="col" style={{ height: '100%', gap: 0 }}>
      <div className="panel-head" style={{ gap: 14 }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="ellipsis" style={{ fontWeight: 700, fontSize: 15 }}>
            {track.title}
          </div>
          <div className="ellipsis muted">{track.artist || 'Unknown artist'}</div>
        </div>
        <div className="col" style={{ gap: 2, alignItems: 'flex-end' }}>
          <span className="mono" style={{ fontSize: 16, fontWeight: 700 }}>
            {fmtBpm(deck.effectiveBpm)} <span className="faint" style={{ fontSize: 11 }}>BPM</span>
          </span>
          <Camelot code={track.camelot} name={track.key_name} />
        </div>
        <button className="btn" onClick={() => setExporting(true)}>
          <IconExport /> Export
        </button>
      </div>
      {stemsNowReady && (
        <div className="row" style={{ padding: '8px 14px', background: 'rgba(79,227,161,0.08)', borderBottom: '1px solid var(--line)' }}>
          <span className="grow">Stems are ready for this track.</span>
          <button className="btn sm primary" onClick={() => openInLab(liveTrack!)}>
            Reload with stems
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 160, position: 'relative' }}>
        {deck.loading > 0 ? (
          <div className="empty">
            Loading audio… {Math.round(deck.loading * 100)}%
          </div>
        ) : (
          <StemLanes deck={deck} onLoopSelect={(a, b) => deck.setLoop(a, b, null, true)} />
        )}
      </div>
      <div className="row" style={{ padding: '10px 14px', borderTop: '1px solid var(--line)', gap: 12, flexWrap: 'wrap' }}>
        <button className="btn big primary" onClick={() => deck.togglePlay()} title="Play / pause (Space)">
          {deck.playing ? <IconPause size={20} /> : <IconPlay size={20} />}
        </button>
        <button
          className="btn big"
          title="Stop and return to start"
          onClick={() => {
            deck.pause();
            deck.seek(deck.loop ? deck.loop.start : 0);
          }}
        >
          <IconStop size={16} />
        </button>
        <TimeReadout deck={deck} />
        <div className="row" style={{ gap: 4 }}>
          <IconLoop size={14} className="faint" />
          {[1, 2, 4, 8, 16].map((b) => (
            <button key={b} className={`btn sm ${deck.loop?.beats === b ? 'on' : ''}`} onClick={() => deck.beatLoop(b)} disabled={!track.bpm}>
              {b}
            </button>
          ))}
          <button className="btn sm" disabled={!deck.loop} onClick={() => deck.clearLoop()}>
            Off
          </button>
        </div>
        <div className="spacer" />
        <div className="row" style={{ gap: 8 }}>
          <span className="faint" style={{ fontSize: 11 }}>
            Speed
          </span>
          <input
            type="range"
            min={50}
            max={150}
            step={1}
            value={Math.round(deck.rate * 100)}
            onChange={(e) => deck.setRate(Number(e.target.value) / 100)}
            onDoubleClick={() => deck.setRate(1)}
            style={{ width: 140 }}
            title="Double-click to reset"
          />
          <span className="mono" style={{ width: 44 }}>
            {Math.round(deck.rate * 100)}%
          </span>
          <button className={`btn sm ${deck.keyLock ? 'on' : ''}`} onClick={() => deck.setKeyLock(!deck.keyLock)} title="Keep the original pitch when changing speed">
            Key lock
          </button>
        </div>
      </div>
      <div style={{ padding: '4px 14px 12px', borderTop: '1px solid var(--line)' }}>
        <div className="row" style={{ margin: '8px 0', flexWrap: 'wrap' }}>
          {PRESETS.map((p) => (
            <button key={p.label} className={`btn sm ${presetActive(p.keep) ? 'on' : ''}`} disabled={deck.sources.length < 2} onClick={() => deck.setStemPreset(p.keep)}>
              {p.label}
            </button>
          ))}
          <div className="spacer" />
          <GridTools deck={deck} track={track} />
        </div>
        {deck.sources.length > 1 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            {deck.sources.map((s, i) => {
              const silent = deck.soloStem ? deck.soloStem !== s.name : deck.stemMute[s.name];
              return (
                <div key={s.name} className={`glass stem-${s.name}`} style={{ padding: '8px 10px', opacity: silent ? 0.55 : 1 }}>
                  <div className="row">
                    <span className="stem-dot" />
                    <b className="grow">{STEM_LABEL[s.name as StemName]}</b>
                    <span className="kbd">{i + 1}</span>
                  </div>
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className={`btn sm ${deck.soloStem === s.name ? 'on' : ''}`} onClick={() => deck.toggleSolo(s.name)} title={`Solo (Shift+${i + 1})`}>
                      S
                    </button>
                    <button className={`btn sm ${deck.stemMute[s.name] ? 'on' : ''}`} style={{ ['--c' as string]: 'var(--bad)' }} onClick={() => deck.toggleMute(s.name)} title={`Mute (${i + 1})`}>
                      M
                    </button>
                    <Fader orientation="horizontal" length={92} max={1.5} value={deck.stemGain[s.name] ?? 1} defaultValue={1} onChange={(v) => deck.setStemGain(s.name, v)} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="row muted" style={{ padding: '6px 0' }}>
            <span className="grow">This track hasn't been separated yet — you're hearing the original mix.</span>
            {track.stem_status === 'none' || track.stem_status === 'error' ? (
              <>
                <button className="btn sm" onClick={() => void api.separate([track.id], 'fast').then(() => useApp.getState().poll())}>
                  Separate (fast)
                </button>
                <button className="btn sm" onClick={() => void api.separate([track.id], 'high').then(() => useApp.getState().poll())}>
                  Separate (HQ)
                </button>
              </>
            ) : (
              <span className="chip busy">{track.stem_status === 'done' ? 'Stems ready' : 'Separating…'}</span>
            )}
          </div>
        )}
      </div>
      {exporting && <ExportDialog deck={deck} track={track} onClose={() => setExporting(false)} />}
    </div>
  );
}

export function StemLab() {
  const selectedId = useApp((s) => s.selectedTrackId);
  const tracks = useApp((s) => s.tracks);
  const view = useApp((s) => s.view);
  const unsplit = useMemo(() => tracks.filter((t) => t.stem_status === 'none' || t.stem_status === 'error'), [tracks]);

  // Keyboard shortcuts while Stem Lab is visible.
  useEffect(() => {
    if (view !== 'lab') return;
    const deck = stemLabDeck();
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        deck.togglePlay();
      } else if (/^Digit[1-4]$/.test(e.code) && deck.sources.length > 1) {
        const s = deck.sources[Number(e.code.slice(5)) - 1];
        if (s) (e.shiftKey ? deck.toggleSolo(s.name) : deck.toggleMute(s.name));
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        const beats = e.shiftKey ? 4 : 1;
        deck.seek(clamp(deck.position + (e.code === 'ArrowLeft' ? -beats : beats) * deck.beatLength, 0, deck.duration));
      } else if (e.code === 'KeyL') {
        if (deck.loop) deck.clearLoop();
        else deck.beatLoop(4);
      } else if (e.code === 'BracketLeft') deck.resizeLoop(0.5);
      else if (e.code === 'BracketRight') deck.resizeLoop(2);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [view]);

  // Pause the preview when leaving Stem Lab so it never plays over a DJ set.
  useEffect(() => {
    if (view !== 'lab' && labDeck?.playing) labDeck.pause();
  }, [view]);

  const selected = trackById(selectedId);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(460px, 44%) minmax(0, 1fr)', gap: 12, height: '100%' }}>
      <div className="glass panel">
        <div className="panel-head">
          <span className="panel-title">Library</span>
          <span className="faint">{tracks.length}</span>
          <div className="spacer" />
          <button className="btn sm" onClick={() => importWithDialog('files')}>
            <IconPlus size={14} /> Files
          </button>
          <button className="btn sm" onClick={() => importWithDialog('folder')}>
            <IconFolder size={14} /> Folder
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <LibraryTable selectedId={selectedId} onSelect={(t) => useApp.getState().selectTrack(t.id)} onOpen={openInLab} />
        </div>
        <div className="row" style={{ padding: '8px 12px', borderTop: '1px solid var(--line)' }}>
          <button className="btn sm" disabled={!selected} onClick={() => selected && openInLab(selected)}>
            <IconPlay size={12} /> Open in player
          </button>
          <button className="btn sm" disabled={!selected || selected.stem_status === 'queued' || selected.stem_status === 'processing'} onClick={() => selected && void api.separate([selected.id]).then(() => useApp.getState().poll())}>
            Separate selected
          </button>
          <div className="spacer" />
          <button
            className="btn sm"
            disabled={!unsplit.length}
            onClick={() => void api.separate(unsplit.map((t) => t.id)).then(() => useApp.getState().poll())}
            title="Queue every track that doesn't have stems yet"
          >
            Separate all ({unsplit.length})
          </button>
        </div>
        <Queue />
      </div>
      <div className="glass panel">
        <Player />
      </div>
    </div>
  );
}
