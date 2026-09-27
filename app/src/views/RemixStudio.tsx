import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { BUILTIN_SOUNDS, previewDrum } from '../audio/drums';
import { encodeWav } from '../audio/wav';
import { Camelot, Knob, Modal, useRaf } from '../components/Controls';
import { IconCopy, IconExport, IconFolder, IconLoop, IconPlay, IconPlus, IconRedo, IconSave, IconSplit, IconStop, IconTrash, IconUndo } from '../components/Icons';
import { camelotName, fmtBpm, keyCompatibility, keyName, semitonesToMatch, shiftKey, trackKey, type Key } from '../music';
import { remixEngine, renderProject, stretchRatio, useSources } from '../remix/engine';
import { type AudioClip, type Clip, type RemixProject, STEPS, barsBeats, clipEnd, newPattern, newProject, newTrack, projectLength, uid } from '../remix/model';
import { STEM_MIME, Timeline, makeAudioClip } from '../remix/Timeline';
import { cloneClip, findClip, preloadProject, snapBeat, useRemix } from '../remix/store';
import { reportError, trackById, useApp } from '../store/app';
import { STEMS, STEM_COLOR, STEM_LABEL, type StemName, type Track } from '../types';

const ALL_KEYS: Key[] = [];
for (let pc = 0; pc < 12; pc++) for (const mode of ['minor', 'major'] as const) ALL_KEYS.push({ pc, mode });
ALL_KEYS.sort((a, b) => parseInt(camelotName(a)) - parseInt(camelotName(b)) || (a.mode === 'minor' ? -1 : 1));

const FADES = [0, 0.5, 1, 2, 4, 8, 16];

// ---- toolbar pieces ---------------------------------------------------------------------------

function Position() {
  const ref = useRef<HTMLSpanElement>(null);
  useRaf(() => {
    if (ref.current) ref.current.textContent = barsBeats(remixEngine.position());
  });
  return <span ref={ref} className="mono" style={{ fontSize: 15, minWidth: 64, display: 'inline-block' }} />;
}

function PlayButton() {
  const [playing, setPlaying] = useState(false);
  useRaf(() => playing !== remixEngine.playing && setPlaying(remixEngine.playing));
  return (
    <button className={`btn big ${playing ? 'on' : ''}`} style={{ ['--c' as string]: 'var(--ok)', width: 52 }} onClick={() => (remixEngine.playing ? remixEngine.stop() : void remixEngine.play())} title="Play / stop (Space)">
      {playing ? <IconStop size={16} /> : <IconPlay size={18} />}
    </button>
  );
}

function MetronomeButton() {
  const [on, setOn] = useState(remixEngine.metronome);
  return (
    <button
      className={`btn sm ${on ? 'on' : ''}`}
      title="Metronome click while playing (not included in exports)"
      onClick={() => {
        remixEngine.metronome = !on;
        setOn(!on);
        if (remixEngine.playing) void remixEngine.play(remixEngine.position());
      }}
    >
      Click
    </button>
  );
}

function BpmInput() {
  const bpm = useRemix((s) => s.project.bpm);
  const [text, setText] = useState(String(bpm));
  useEffect(() => setText(String(bpm)), [bpm]);
  const apply = () => {
    const v = Math.round(Number(text) * 100) / 100;
    if (v >= 60 && v <= 200 && v !== bpm) {
      useRemix.getState().edit((p) => (p.bpm = v));
      preloadProject(useRemix.getState().project);
    } else setText(String(bpm));
  };
  return (
    <label className="row" style={{ gap: 4 }} title="Project tempo — every clip is time-stretched to it">
      <input className="input sm mono" style={{ width: 58 }} value={text} onChange={(e) => setText(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      <span className="faint" style={{ fontSize: 10 }}>
        BPM
      </span>
    </label>
  );
}

function clashingClips(p: RemixProject): AudioClip[] {
  if (!p.key) return [];
  const out: AudioClip[] = [];
  for (const t of p.tracks)
    for (const c of t.clips) {
      if (c.type !== 'audio') continue;
      const lib = trackById(c.trackId);
      if (lib && keyCompatibility(shiftKey(trackKey(lib), c.semitones), p.key) === 'clash') out.push(c);
    }
  return out;
}

function KeySelect() {
  const project = useRemix((s) => s.project);
  const clashes = clashingClips(project);
  const matchAll = () => {
    useRemix.getState().edit((p) => {
      for (const t of p.tracks)
        for (const c of t.clips) {
          if (c.type !== 'audio') continue;
          const lib = trackById(c.trackId);
          if (lib && p.key) c.semitones = semitonesToMatch(trackKey(lib), p.key);
        }
    });
    preloadProject(useRemix.getState().project);
  };
  return (
    <div className="row" style={{ gap: 6 }}>
      <select
        className="select sm"
        style={{ width: 96 }}
        value={project.key ? `${project.key.pc}:${project.key.mode}` : ''}
        onChange={(e) => {
          const [pc, mode] = e.target.value.split(':');
          useRemix.getState().edit((p) => (p.key = e.target.value ? { pc: Number(pc), mode: mode as Key['mode'] } : null), { structural: false });
        }}
        title="Project key — used for key-clash warnings and auto pitch-matching"
      >
        <option value="">No key</option>
        {ALL_KEYS.map((k) => (
          <option key={`${k.pc}:${k.mode}`} value={`${k.pc}:${k.mode}`}>
            {camelotName(k)} · {keyName(k)}
          </option>
        ))}
      </select>
      {clashes.length > 0 && (
        <button className="btn sm" style={{ borderColor: 'var(--bad)', color: '#ffb3c0' }} onClick={matchAll} title="Pitch-shift every clip onto the project key">
          ⚠ {clashes.length} clash{clashes.length > 1 ? 'es' : ''} · Match all
        </button>
      )}
    </div>
  );
}

/** Lay out every stem of a track on its own new track, aligned at the playhead's bar. */
function addAllStems(track: Track) {
  const s = useRemix.getState();
  const start = Math.floor(remixEngine.position() / 4) * 4;
  const clips = track.stems.map((stem) => makeAudioClip(track, stem, start, s.project, true));
  s.edit((p) => {
    track.stems.forEach((stem, i) => {
      const t = newTrack('audio', `${STEM_LABEL[stem]} – ${track.title}`.slice(0, 40), p.tracks.length);
      t.color = STEM_COLOR[stem];
      t.clips.push(clips[i]);
      p.tracks.push(t);
    });
  });
}

// ---- browser --------------------------------------------------------------------------------

function Browser() {
  const tracks = useApp((s) => s.tracks);
  const projectKey = useRemix((s) => s.project.key);
  const projectBpm = useRemix((s) => s.project.bpm);
  const [q, setQ] = useState('');
  const list = useMemo(
    () => tracks.filter((t) => !q || `${t.title} ${t.artist}`.toLowerCase().includes(q.toLowerCase())),
    [tracks, q],
  );
  const drag = (e: React.DragEvent, trackId: number, stem: string) => {
    e.dataTransfer.setData(STEM_MIME, JSON.stringify({ trackId, stem }));
    e.dataTransfer.effectAllowed = 'copy';
  };
  return (
    <div className="glass panel" style={{ width: 270 }}>
      <div className="panel-head">
        <span className="panel-title">Browser</span>
        <input className="input sm grow" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="panel-body" style={{ padding: 8 }}>
        {list.length === 0 && <div className="empty">Add music in Stem Lab first.</div>}
        {list.map((t) => {
          const compat = keyCompatibility(trackKey(t), projectKey);
          return (
            <div key={t.id} style={{ padding: '7px 8px', borderRadius: 9, marginBottom: 4, background: 'rgba(255,255,255,0.025)', border: '1px solid var(--line)' }}>
              <div className="row" style={{ gap: 6 }}>
                <div className="grow ellipsis" style={{ fontWeight: 600 }} title={`${t.artist} — ${t.title}`}>
                  {t.title}
                </div>
                <Camelot code={t.camelot} />
              </div>
              <div className="row faint" style={{ fontSize: 11, gap: 6, marginTop: 2 }}>
                <span className="grow ellipsis">{t.artist}</span>
                <span className="mono">{fmtBpm(t.bpm)}</span>
                {t.bpm && Math.abs(stretchRatio(t, projectBpm) - 1) > 0.2 && <span title={`Needs a ${Math.round(stretchRatio(t, projectBpm) * 100)}% tempo change — may sound unnatural`}>⚠</span>}
                {projectKey && compat === 'clash' && <span style={{ color: 'var(--bad)' }}>key</span>}
              </div>
              <div className="row" style={{ gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                {t.stems.length ? (
                  STEMS.map((s) => (
                    <span key={s} className={`chip stem-${s}`} draggable onDragStart={(e) => drag(e, t.id, s)} style={{ cursor: 'grab', borderColor: 'var(--c)', color: 'var(--c)' }} title="Drag onto the timeline">
                      {STEM_LABEL[s]}
                    </span>
                  ))
                ) : (
                  <span className="faint" style={{ fontSize: 11 }}>
                    No stems yet ·
                  </span>
                )}
                <span className="chip stem-original" draggable onDragStart={(e) => drag(e, t.id, 'original')} style={{ cursor: 'grab' }} title="Drag the full mix onto the timeline">
                  Full mix
                </span>
                {t.stems.length > 0 && (
                  <button className="btn sm ghost" style={{ height: 20, padding: '0 6px' }} onClick={() => addAllStems(t)} title="Add all four stems on their own tracks, lined up at the playhead">
                    + all
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- bottom panels ----------------------------------------------------------------------------

function ClipInspector() {
  const project = useRemix((s) => s.project);
  const selected = useRemix((s) => s.selectedClip);
  const found = findClip(project, selected);
  const errors = useSources((s) => s.errors);
  if (!found) return <div className="empty">Select a clip to edit it. Double-click a drum or FX lane to add clips.</div>;
  const { clip } = found;
  const edit = (fn: (c: Clip) => void, structural = true) =>
    useRemix.getState().edit((p) => {
      const f = findClip(p, clip.id);
      if (f) fn(f.clip);
    }, { structural });

  const common = (
    <>
      <label>Gain</label>
      <div className="row">
        <input type="range" min={0} max={1.5} step={0.01} value={clip.gain} onChange={(e) => edit((c) => (c.gain = Number(e.target.value)))} className="grow" />
        <span className="mono" style={{ width: 44 }}>
          {Math.round(clip.gain * 100)}%
        </span>
      </div>
      <label>Position / length</label>
      <div className="row">
        <span className="mono">{barsBeats(clip.start)}</span>
        <input className="input sm mono" style={{ width: 70 }} type="number" min={0.25} step={1} value={clip.length} onChange={(e) => Number(e.target.value) > 0 && edit((c) => (c.length = Number(e.target.value)))} />
        <span className="faint">beats</span>
      </div>
      {clip.type !== 'pattern' && (
        <>
          <label>Fade in / out</label>
          <div className="row">
            <select className="select sm" value={clip.fadeIn ?? 0} onChange={(e) => edit((c) => (c.fadeIn = Number(e.target.value)))} title="Fade in">
              {FADES.map((f) => (
                <option key={f} value={f}>
                  in: {f ? `${f} beat${f > 1 ? 's' : ''}` : 'none'}
                </option>
              ))}
            </select>
            <select className="select sm" value={clip.fadeOut ?? 0} onChange={(e) => edit((c) => (c.fadeOut = Number(e.target.value)))} title="Fade out">
              {FADES.map((f) => (
                <option key={f} value={f}>
                  out: {f ? `${f} beat${f > 1 ? 's' : ''}` : 'none'}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </>
  );

  if (clip.type === 'audio') {
    const lib = trackById(clip.trackId);
    const orig = lib ? trackKey(lib) : null;
    const now = shiftKey(orig, clip.semitones);
    const compat = keyCompatibility(now, project.key);
    const errKey = Object.keys(errors).find((k) => k.startsWith(`${clip.trackId}:${clip.stem}:`));
    return (
      <div className="form-grid" style={{ gridTemplateColumns: '130px 1fr 130px 1fr', padding: 14, gap: '10px 14px' }}>
        <label>Source</label>
        <div className="ellipsis">{lib ? `${lib.artist ? `${lib.artist} — ` : ''}${lib.title}` : 'Missing from library'}</div>
        <label>Stem</label>
        <select className="select sm" value={clip.stem} onChange={(e) => edit((c) => ((c as AudioClip).stem = e.target.value as AudioClip['stem']))}>
          {(lib?.stems ?? []).map((s) => (
            <option key={s} value={s}>
              {STEM_LABEL[s as StemName]}
            </option>
          ))}
          <option value="original">Full mix</option>
        </select>
        {common}
        <label>Pitch</label>
        <div className="row">
          <input type="range" min={-12} max={12} step={1} value={clip.semitones} onChange={(e) => edit((c) => ((c as AudioClip).semitones = Number(e.target.value)))} className="grow" />
          <span className="mono" style={{ width: 34 }}>
            {clip.semitones > 0 ? '+' : ''}
            {clip.semitones}
          </span>
        </div>
        <label>Key</label>
        <div className="row">
          <Camelot code={camelotName(now)} name={keyName(now)} />
          {project.key && <span className={`chip ${compat === 'clash' ? 'bad' : compat === 'unknown' ? '' : 'ok'}`}>{compat === 'clash' ? 'Clashes' : compat === 'perfect' ? 'Same key' : compat === 'good' ? 'Compatible' : '?'}</span>}
          <button className="btn sm" disabled={!project.key || !orig} onClick={() => edit((c) => ((c as AudioClip).semitones = semitonesToMatch(orig, project.key)))}>
            Match key
          </button>
        </div>
        <label>Loop</label>
        <div className="row" style={{ gap: 4 }}>
          {[null, 1, 2, 4, 8, 16].map((b) => (
            <button key={String(b)} className={`btn sm ${clip.loopLen === b ? 'on' : ''}`} onClick={() => edit((c) => ((c as AudioClip).loopLen = b))}>
              {b === null ? 'Off' : `${b}`}
            </button>
          ))}
        </div>
        <label>Source offset</label>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm" onClick={() => edit((c) => ((c as AudioClip).offset -= 4))}>
            −1 bar
          </button>
          <button className="btn sm" onClick={() => edit((c) => ((c as AudioClip).offset -= 1))}>
            −1 beat
          </button>
          <span className="mono" style={{ minWidth: 40, textAlign: 'center' }}>
            {clip.offset}
          </span>
          <button className="btn sm" onClick={() => edit((c) => ((c as AudioClip).offset += 1))}>
            +1 beat
          </button>
          <button className="btn sm" onClick={() => edit((c) => ((c as AudioClip).offset += 4))}>
            +1 bar
          </button>
        </div>
        {errKey && (
          <div style={{ gridColumn: '1 / -1', color: 'var(--bad)' }}>
            Could not prepare this clip: {errors[errKey]}
          </div>
        )}
      </div>
    );
  }
  if (clip.type === 'pattern') {
    return (
      <div className="form-grid" style={{ gridTemplateColumns: '130px 1fr 130px 1fr', padding: 14, gap: '10px 14px' }}>
        <label>Pattern</label>
        <select className="select sm" value={clip.patternId} onChange={(e) => edit((c) => (c.type === 'pattern' ? (c.patternId = e.target.value) : undefined))}>
          {project.patterns.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {common}
      </div>
    );
  }
  return (
    <div className="form-grid" style={{ gridTemplateColumns: '130px 1fr 130px 1fr', padding: 14, gap: '10px 14px' }}>
      <label>Type</label>
      <div className="seg sm">
        {(['riser', 'downlifter', 'impact'] as const).map((v) => (
          <button key={v} className={clip.variant === v ? 'on' : ''} onClick={() => edit((c) => (c.type === 'riser' ? (c.variant = v) : undefined))}>
            {v}
          </button>
        ))}
      </div>
      {common}
    </div>
  );
}

function DrumSequencer() {
  const project = useRemix((s) => s.project);
  const selectedPattern = useRemix((s) => s.selectedPattern);
  const [samples, setSamples] = useState<{ id: number; name: string }[]>([]);
  const stepRef = useRef<HTMLDivElement>(null);
  const pattern = project.patterns.find((p) => p.id === selectedPattern) ?? project.patterns[0];
  const edit = useRemix((s) => s.edit);

  useEffect(() => {
    void api.samples().then(setSamples).catch(() => undefined);
  }, []);

  useRaf(() => {
    const el = stepRef.current;
    if (!el) return;
    const step = remixEngine.playing ? Math.floor((remixEngine.position() * 4) % STEPS) : -1;
    el.style.transform = `translateX(${step * 100}%)`;
    el.style.opacity = step < 0 ? '0' : '1';
  });

  if (!pattern) return null;
  const pIndex = project.patterns.indexOf(pattern);

  const importSamples = async () => {
    const paths = (await window.stemdeck?.openFiles({ title: 'Import drum samples' })) ?? [];
    if (!paths.length) return;
    try {
      await api.importSamples(paths);
      setSamples(await api.samples());
    } catch (e) {
      reportError(e, 'Import failed');
    }
  };

  const addToTimeline = () => {
    const beat = Math.floor(remixEngine.position() / 4) * 4;
    const id = uid();
    edit((p) => {
      let t = p.tracks.find((x) => x.kind === 'drums');
      if (!t) {
        t = newTrack('drums', 'Drums', p.tracks.length);
        p.tracks.push(t);
      }
      t.clips.push({ id, type: 'pattern', patternId: pattern.id, start: beat, length: 16, gain: 1 });
    });
    useRemix.getState().select(id);
  };

  return (
    <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8, height: '100%', overflow: 'auto' }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg sm">
          {project.patterns.map((p) => (
            <button key={p.id} className={p.id === pattern.id ? 'on' : ''} onClick={() => useRemix.getState().set({ selectedPattern: p.id })}>
              {p.name}
            </button>
          ))}
        </div>
        <button
          className="btn sm"
          onClick={() => {
            const np = newPattern(`Pattern ${String.fromCharCode(65 + project.patterns.length)}`, project.voices.length);
            edit((p) => p.patterns.push(np), { structural: false });
            useRemix.getState().set({ selectedPattern: np.id });
          }}
        >
          <IconPlus size={12} /> New
        </button>
        <button
          className="btn sm"
          onClick={() => {
            const np = { ...structuredClone(pattern), id: uid(), name: `${pattern.name} copy` };
            edit((p) => p.patterns.push(np), { structural: false });
            useRemix.getState().set({ selectedPattern: np.id });
          }}
        >
          <IconCopy size={12} /> Duplicate
        </button>
        <input className="input sm" style={{ width: 150 }} value={pattern.name} onChange={(e) => edit((p) => (p.patterns[pIndex].name = e.target.value), { structural: false, history: false })} />
        <button
          className="btn sm ghost"
          disabled={project.patterns.length < 2}
          onClick={() =>
            edit((p) => {
              p.patterns.splice(pIndex, 1);
              for (const t of p.tracks) t.clips = t.clips.filter((c) => c.type !== 'pattern' || c.patternId !== pattern.id);
              useRemix.getState().set({ selectedPattern: p.patterns[0].id });
            })
          }
        >
          <IconTrash size={12} />
        </button>
        <div className="spacer" />
        <span className="faint" style={{ fontSize: 11 }}>
          Swing
        </span>
        <input type="range" min={0} max={0.5} step={0.01} value={project.swing} onChange={(e) => edit((p) => (p.swing = Number(e.target.value)))} style={{ width: 90 }} />
        <button className="btn sm" onClick={importSamples}>
          Import samples
        </button>
        <button className="btn sm primary" onClick={addToTimeline}>
          Add 4 bars at playhead
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '170px 34px 1fr', gap: '4px 8px', alignItems: 'center' }}>
        {project.voices.map((voice, v) => (
          <div key={v} style={{ display: 'contents' }}>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn sm icon ghost" title="Preview" onClick={() => previewDrum(voice.ref, voice.gain)}>
                ▶
              </button>
              <select
                className="select sm grow"
                value={voice.ref}
                onChange={(e) => {
                  const opt = e.target.selectedOptions[0];
                  edit((p) => (p.voices[v] = { ...p.voices[v], ref: e.target.value, name: opt.text }));
                }}
              >
                <optgroup label="Built-in">
                  {BUILTIN_SOUNDS.map((s) => (
                    <option key={s} value={`builtin:${s}`}>
                      {s}
                    </option>
                  ))}
                </optgroup>
                {samples.length > 0 && (
                  <optgroup label="Your samples">
                    {samples.map((s) => (
                      <option key={s.id} value={`sample:${s.id}`}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
            <Knob size={24} value={voice.gain} min={0} max={1.2} defaultValue={0.8} onChange={(g) => edit((p) => (p.voices[v].gain = g), { structural: false, history: false })} />
            <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: `repeat(${STEPS}, 1fr)`, gap: 3 }}>
              {v === 0 && (
                <div
                  ref={stepRef}
                  style={{ position: 'absolute', left: 0, top: -2, height: `calc(${project.voices.length * 100}% + ${(project.voices.length - 1) * 4 + 4}px)`, width: `calc((100% - ${(STEPS - 1) * 3}px) / ${STEPS})`, borderRadius: 5, border: '1px solid rgba(255,255,255,0.5)', pointerEvents: 'none', transition: 'transform 0.05s linear', marginRight: 3 }}
                />
              )}
              {Array.from({ length: STEPS }, (_, s) => {
                const vel = pattern.steps[v]?.[s] ?? 0;
                return (
                  <button
                    key={s}
                    onClick={(e) =>
                      edit((p) => {
                        const row = p.patterns[pIndex].steps[v];
                        row[s] = row[s] ? 0 : e.shiftKey ? 0.5 : 1;
                      })
                    }
                    onContextMenu={(e) => {
                      e.preventDefault();
                      edit((p) => (p.patterns[pIndex].steps[v][s] = 0));
                    }}
                    title="Click: toggle · Shift+click: soft hit · Right-click: clear"
                    style={{
                      height: 22,
                      borderRadius: 5,
                      cursor: 'pointer',
                      border: '1px solid rgba(255,255,255,0.1)',
                      background: vel ? `rgba(255,181,71,${0.35 + vel * 0.6})` : s % 4 === 0 ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)',
                      boxShadow: vel ? '0 0 10px rgba(255,181,71,0.45)' : undefined,
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FxPanel() {
  const project = useRemix((s) => s.project);
  const edit = useRemix((s) => s.edit);
  const [variant, setVariant] = useState<'riser' | 'downlifter' | 'impact'>('riser');
  const [bars, setBars] = useState(4);
  const [placement, setPlacement] = useState<'end' | 'start'>('end');

  const insert = () => {
    const pos = snapBeat(remixEngine.position(), 4);
    const length = variant === 'impact' ? 4 : bars * 4;
    const start = placement === 'end' && variant !== 'impact' ? Math.max(0, pos - length) : pos;
    const id = uid();
    edit((p) => {
      let t = p.tracks.find((x) => x.kind === 'fx');
      if (!t) {
        t = newTrack('fx', 'FX', p.tracks.length);
        p.tracks.push(t);
      }
      t.clips.push({ id, type: 'riser', variant, start, length, gain: 0.8 });
    });
    useRemix.getState().select(id);
  };

  return (
    <div style={{ padding: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
      <div className="col">
        <div className="panel-title">Build-up tool</div>
        <div className="row">
          <div className="seg sm">
            {(['riser', 'downlifter', 'impact'] as const).map((v) => (
              <button key={v} className={variant === v ? 'on' : ''} onClick={() => setVariant(v)}>
                {v}
              </button>
            ))}
          </div>
          {variant !== 'impact' && (
            <select className="select sm" value={bars} onChange={(e) => setBars(Number(e.target.value))}>
              {[1, 2, 4, 8, 16].map((b) => (
                <option key={b} value={b}>
                  {b} bar{b > 1 ? 's' : ''}
                </option>
              ))}
            </select>
          )}
          {variant !== 'impact' && (
            <select className="select sm" value={placement} onChange={(e) => setPlacement(e.target.value as 'end' | 'start')}>
              <option value="end">ending at playhead</option>
              <option value="start">starting at playhead</option>
            </select>
          )}
          <button className="btn sm primary" onClick={insert}>
            Insert
          </button>
        </div>
        <div className="faint" style={{ fontSize: 11.5 }}>
          Tip: place a riser ending right where the drop starts, then open a track's <b>A</b> lane and draw a filter sweep (low pass to open) for a classic build.
        </div>
      </div>
      <div className="row" style={{ gap: 22, alignItems: 'flex-start' }}>
        <Knob value={project.reverbSize} min={0.4} max={6} defaultValue={2.2} onChange={(v) => edit((p) => (p.reverbSize = v), { structural: false, history: false })} label="Reverb size" format={(v) => `${v.toFixed(1)} s`} color="#35d9c8" />
        <div className="col" style={{ gap: 4 }}>
          <span className="knob-label">Delay time</span>
          <select className="select sm" value={project.delayDivision} onChange={(e) => edit((p) => (p.delayDivision = Number(e.target.value)), { structural: false })}>
            <option value={0.25}>1/16</option>
            <option value={0.5}>1/8</option>
            <option value={0.75}>3/16 (dotted 1/8)</option>
            <option value={1}>1/4</option>
            <option value={1.5}>3/8 (dotted 1/4)</option>
            <option value={2}>1/2</option>
          </select>
        </div>
        <Knob value={project.delayFeedback} min={0} max={0.9} defaultValue={0.35} onChange={(v) => edit((p) => (p.delayFeedback = v), { structural: false, history: false })} label="Feedback" format={(v) => `${Math.round(v * 100)}%`} color="#ffb547" />
        <Knob value={project.masterVolume} min={0} max={1.2} defaultValue={0.9} onChange={(v) => edit((p) => (p.masterVolume = v), { structural: false, history: false })} label="Master" format={(v) => `${Math.round(v * 100)}%`} />
      </div>
    </div>
  );
}

// ---- dialogs ------------------------------------------------------------------------------------

function OpenDialog({ onClose }: { onClose(): void }) {
  const [list, setList] = useState<{ id: number; name: string; updated_at: number }[] | null>(null);
  useEffect(() => {
    void api.projects().then(setList).catch((e) => reportError(e));
  }, []);
  const open = async (id: number) => {
    try {
      const res = await api.project(id);
      const data = { ...newProject(), ...(res.data as RemixProject) };
      useRemix.getState().load(id, data);
      onClose();
    } catch (e) {
      reportError(e, 'Could not open project');
    }
  };
  return (
    <Modal title="Open remix project" onClose={onClose} width={520}>
      {!list ? (
        <div className="muted">Loading…</div>
      ) : list.length === 0 ? (
        <div className="muted">No saved projects yet.</div>
      ) : (
        <table className="table">
          <tbody>
            {list.map((p) => (
              <tr key={p.id} onDoubleClick={() => open(p.id)}>
                <td>{p.name}</td>
                <td className="faint">{new Date(p.updated_at * 1000).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn sm" onClick={() => open(p.id)}>
                    Open
                  </button>{' '}
                  <button
                    className="btn sm ghost"
                    onClick={async () => {
                      if (!confirm(`Delete project “${p.name}”?`)) return;
                      await api.deleteProject(p.id);
                      setList(list.filter((x) => x.id !== p.id));
                    }}
                  >
                    <IconTrash size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function ExportDialog({ onClose }: { onClose(): void }) {
  const project = useRemix((s) => s.project);
  const [name, setName] = useState(project.name);
  const [format, setFormat] = useState<'wav' | 'mp3'>('wav');
  const [range, setRange] = useState<'song' | 'loop'>(project.loopOn && project.loop ? 'loop' : 'song');
  const [addToLibrary, setAddToLibrary] = useState(true);
  const [trackStems, setTrackStems] = useState(false);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [sc, setSc] = useState<{ connected: boolean } | null>(null);
  const length = projectLength(project);

  useEffect(() => {
    void api.scStatus().then(setSc).catch(() => undefined);
  }, []);

  const run = async () => {
    try {
      const r = range === 'loop' && project.loop ? project.loop : { start: 0, end: length };
      if (r.end - r.start <= 0) throw new Error('Nothing to export — add some clips first');
      setStatus('Preparing clips (time-stretching may take a moment)…');
      const tracks = useApp.getState().tracks;
      const buffer = await renderProject(project, tracks, r, range === 'song');
      setStatus('Encoding…');
      const res = await api.exportRender(encodeWav(buffer), {
        name,
        format,
        add_to_library: addToLibrary,
        bpm: project.bpm,
        key_pc: project.key?.pc ?? null,
        key_mode: project.key?.mode ?? null,
      });
      if (trackStems) {
        const withClips = project.tracks.filter((t) => t.clips.length);
        for (const [i, t] of withClips.entries()) {
          setStatus(`Rendering track ${i + 1} of ${withClips.length}: ${t.name}…`);
          const solo: RemixProject = { ...project, tracks: project.tracks.map((x) => ({ ...x, solo: x.id === t.id, mute: false })) };
          const buf = await renderProject(solo, tracks, r, range === 'song');
          await api.exportRender(encodeWav(buf), { name: `${name} - ${t.name}`, format, add_to_library: false });
        }
      }
      setResult(res.file);
      setStatus('');
      await useApp.getState().refreshTracks();
      useApp.getState().toast(`Exported “${name}”${addToLibrary ? ' — it’s now in your DJ library' : ''}`, 'success', {
        label: 'Show',
        run: () => window.stemdeck?.showItem(res.file),
      });
    } catch (e) {
      setStatus('');
      reportError(e, 'Export failed');
    }
  };

  return (
    <Modal title="Export remix" onClose={onClose} width={520}>
      <div className="form-grid" style={{ gridTemplateColumns: '130px 1fr' }}>
        <label>Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        <label>Format</label>
        <div className="seg">
          <button className={format === 'wav' ? 'on' : ''} onClick={() => setFormat('wav')}>
            WAV
          </button>
          <button className={format === 'mp3' ? 'on' : ''} onClick={() => setFormat('mp3')}>
            MP3
          </button>
        </div>
        <label>Range</label>
        <div className="seg">
          <button className={range === 'song' ? 'on' : ''} onClick={() => setRange('song')}>
            Whole song ({barsBeats(length).split('.')[0]} bars)
          </button>
          <button className={range === 'loop' ? 'on' : ''} disabled={!project.loop} onClick={() => setRange('loop')}>
            Loop region
          </button>
        </div>
        <label>Library</label>
        <label className="row">
          <input type="checkbox" checked={addToLibrary} onChange={(e) => setAddToLibrary(e.target.checked)} /> Add to my library (shows up in DJ mode)
        </label>
        <label>Stems</label>
        <label className="row">
          <input type="checkbox" checked={trackStems} onChange={(e) => setTrackStems(e.target.checked)} /> Also export every track as its own file
        </label>
      </div>
      {status && <div className="muted" style={{ marginTop: 14 }}>{status}</div>}
      {result && (
        <div className="row" style={{ marginTop: 14 }}>
          <span className="grow ellipsis muted">{result}</span>
          <button className="btn sm" onClick={() => window.stemdeck?.showItem(result)}>
            Show
          </button>
          {sc?.connected && (
            <button
              className="btn sm"
              onClick={async () => {
                try {
                  const r = await api.scUpload(result, name, 'private');
                  useApp.getState().toast('Uploaded to SoundCloud (private)', 'success', r.permalink_url ? { label: 'Open', run: () => window.stemdeck?.openExternal(r.permalink_url) } : undefined);
                } catch (e) {
                  reportError(e, 'Upload failed');
                }
              }}
            >
              Upload to SoundCloud
            </button>
          )}
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button className="btn primary" onClick={run} disabled={!!status}>
          <IconExport /> {status ? 'Working…' : 'Export'}
        </button>
      </div>
    </Modal>
  );
}

// ---- main view -------------------------------------------------------------------------------------

type Bottom = 'clip' | 'drums' | 'fx';
export const AUTOSAVE_KEY = 'stemdeck.remix.autosave';

export function RemixStudio() {
  const project = useRemix((s) => s.project);
  const dirty = useRemix((s) => s.dirty);
  const snap = useRemix((s) => s.snap);
  const zoom = useRemix((s) => s.zoom);
  const canUndo = useRemix((s) => s.past.length > 0);
  const canRedo = useRemix((s) => s.future.length > 0);
  const selectedClip = useRemix((s) => s.selectedClip);
  const loading = useSources((s) => s.loading);
  const view = useApp((s) => s.view);
  const tracks = useApp((s) => s.tracks);
  const [bottom, setBottom] = useState<Bottom>('clip');
  const [dialog, setDialog] = useState<'open' | 'export' | null>(null);
  const [autoKey, setAutoKey] = useState(true);

  // Autosave unsaved work every 15 s so a crash or power cut never loses a remix.
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = useRemix.getState();
      if (!s.dirty) return;
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ id: s.projectId, project: s.project, time: Date.now() }));
      } catch {
        /* storage full or unavailable */
      }
    }, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let saved: { id: number | null; project: RemixProject; time: number } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null');
    } catch {
      saved = null;
    }
    if (!saved?.project) return;
    const data = saved;
    useApp.getState().toast(`Unsaved remix “${data.project.name}” from ${new Date(data.time).toLocaleString()} was recovered.`, 'info', {
      label: 'Restore',
      run: () => {
        useRemix.getState().load(data.id, { ...newProject(), ...data.project });
        useRemix.setState({ dirty: true });
        useApp.getState().setView('remix');
      },
    });
  }, []);

  // Library edits (BPM/grid fixes) change how clips stretch; keep the engine in sync.
  useEffect(() => {
    remixEngine.update(useRemix.getState().project, tracks, false);
  }, [tracks]);

  useEffect(() => {
    if (selectedClip) setBottom((b) => (b === 'fx' ? b : 'clip'));
  }, [selectedClip]);

  // Stop remix playback when switching to DJ mode.
  useEffect(() => {
    if (view === 'dj' && remixEngine.playing) remixEngine.stop();
  }, [view]);

  const splitAtPlayhead = () => {
    const s = useRemix.getState();
    const f = findClip(s.project, s.selectedClip);
    const at = snapBeat(remixEngine.position(), s.snap || 0);
    if (!f || at <= f.clip.start || at >= clipEnd(f.clip)) return;
    const right = cloneClip(f.clip, at);
    right.length = clipEnd(f.clip) - at;
    if (right.type === 'audio' && f.clip.type === 'audio' && !right.loopLen) right.offset = f.clip.offset + (at - f.clip.start);
    s.edit((p) => {
      const g = findClip(p, f.clip.id)!;
      g.clip.length = at - g.clip.start;
      g.track.clips.push(right);
    });
  };

  const duplicate = () => {
    const s = useRemix.getState();
    const f = findClip(s.project, s.selectedClip);
    if (!f) return;
    const copy = cloneClip(f.clip, clipEnd(f.clip));
    s.edit((p) => findClip(p, f.clip.id)!.track.clips.push(copy));
    s.select(copy.id);
  };

  const remove = () => {
    const s = useRemix.getState();
    if (!s.selectedClip) return;
    const id = s.selectedClip;
    s.edit((p) => p.tracks.forEach((t) => (t.clips = t.clips.filter((c) => c.id !== id))));
    s.select(null);
  };

  const paste = () => {
    const s = useRemix.getState();
    if (!s.clipboard) return;
    const at = snapBeat(remixEngine.position(), s.snap || 0);
    const copy = cloneClip(s.clipboard, at);
    s.edit((p) => {
      const kind = copy.type === 'audio' ? 'audio' : copy.type === 'pattern' ? 'drums' : 'fx';
      let t = p.tracks.find((x) => x.id === s.selectedTrack && x.kind === kind) ?? p.tracks.find((x) => x.kind === kind);
      if (!t) {
        t = newTrack(kind, kind === 'audio' ? 'Stems' : kind === 'drums' ? 'Drums' : 'FX', p.tracks.length);
        p.tracks.push(t);
      }
      t.clips.push(copy);
    });
    s.select(copy.id);
  };

  useEffect(() => {
    if (view !== 'remix') return;
    const onKey = (e: KeyboardEvent) => {
      const s = useRemix.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyS') {
        // Save works even while typing in a field (e.g. the project name)
        e.preventDefault();
        void s.save();
        return;
      }
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (remixEngine.playing) remixEngine.stop();
        else void remixEngine.play();
      } else if (mod && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && e.code === 'KeyY') {
        e.preventDefault();
        s.redo();
      } else if (mod && e.code === 'KeyC') {
        const f = findClip(s.project, s.selectedClip);
        if (f) s.set({ clipboard: structuredClone(f.clip) });
      } else if (mod && e.code === 'KeyV') paste();
      else if (mod && e.code === 'KeyD') {
        e.preventDefault();
        duplicate();
      } else if (e.code === 'Delete' || e.code === 'Backspace') remove();
      else if (e.code === 'KeyS' && !mod) splitAtPlayhead();
      else if (e.code === 'Home') remixEngine.setPosition(0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);

  const newProjectClick = () => {
    if (dirty && !confirm('Discard unsaved changes to this remix?')) return;
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      /* ignore */
    }
    const p = newProject();
    useRemix.getState().load(null, p);
  };

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) 250px', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, height: '100%' }}>
      <div className="glass row" style={{ padding: '8px 12px', gap: 8, flexWrap: 'wrap' }}>
        <PlayButton />
        <button className="btn icon" title="Back to start (Home)" onClick={() => remixEngine.setPosition(project.loopOn && project.loop ? project.loop.start : 0)}>
          ⏮
        </button>
        <button className={`btn icon ${project.loopOn ? 'on' : ''}`} title="Loop the region set on the ruler" onClick={() => useRemix.getState().edit((p) => (p.loopOn = !p.loopOn), { structural: true, history: false })}>
          <IconLoop />
        </button>
        <Position />
        <MetronomeButton />
        <BpmInput />
        <KeySelect />
        <button className={`btn sm ${autoKey ? 'on' : ''}`} onClick={() => setAutoKey(!autoKey)} title="Pitch-shift new clips onto the project key automatically">
          Auto key
        </button>
        <select className="select sm" style={{ width: 74 }} value={snap} onChange={(e) => useRemix.getState().set({ snap: Number(e.target.value) })} title="Snap to grid">
          <option value={4}>⌗ Bar</option>
          <option value={1}>⌗ Beat</option>
          <option value={0.5}>⌗ 1/8</option>
          <option value={0.25}>⌗ 1/16</option>
          <option value={0}>⌗ Off</option>
        </select>
        <input type="range" min={6} max={120} value={zoom} onChange={(e) => useRemix.getState().set({ zoom: Number(e.target.value) })} style={{ width: 64 }} title="Zoom" />
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm icon" disabled={!canUndo} onClick={() => useRemix.getState().undo()} title="Undo (Ctrl+Z)">
            <IconUndo size={13} />
          </button>
          <button className="btn sm icon" disabled={!canRedo} onClick={() => useRemix.getState().redo()} title="Redo (Ctrl+Y)">
            <IconRedo size={13} />
          </button>
          <button className="btn sm icon" disabled={!selectedClip} onClick={splitAtPlayhead} title="Split clip at playhead (S)">
            <IconSplit size={13} />
          </button>
          <button className="btn sm icon" disabled={!selectedClip} onClick={duplicate} title="Duplicate clip (Ctrl+D)">
            <IconCopy size={13} />
          </button>
          <button className="btn sm icon" disabled={!selectedClip} onClick={remove} title="Delete clip (Del)">
            <IconTrash size={13} />
          </button>
        </div>
        <select
          className="select sm"
          style={{ width: 88 }}
          value=""
          title="Add a track"
          onChange={(e) => {
            const kind = e.target.value as 'audio' | 'drums' | 'fx';
            if (kind) useRemix.getState().edit((p) => p.tracks.push(newTrack(kind, kind === 'audio' ? `Stems ${p.tracks.length + 1}` : kind === 'drums' ? 'Drums' : 'FX', p.tracks.length)));
          }}
        >
          <option value="">+ Track</option>
          <option value="audio">Audio (stems)</option>
          <option value="drums">Drums</option>
          <option value="fx">FX / risers</option>
        </select>
        {loading > 0 && (
          <span className="chip busy" title={`Time-stretching ${loading} clip source${loading > 1 ? 's' : ''} to the project tempo`}>
            ⟳ {loading}
          </span>
        )}
        <div className="spacer" />
        <input className="input sm" style={{ width: 130 }} value={project.name} title="Project name" onChange={(e) => useRemix.getState().edit((p) => (p.name = e.target.value), { structural: false, history: false })} />
        <button className="btn sm icon" onClick={newProjectClick} title="New project">
          <IconPlus size={13} />
        </button>
        <button className="btn sm icon" onClick={() => setDialog('open')} title="Open project">
          <IconFolder size={13} />
        </button>
        <button className={`btn sm icon ${dirty ? 'on' : ''}`} onClick={() => void useRemix.getState().save()} title={dirty ? 'Save — unsaved changes (Ctrl+S)' : 'Save (Ctrl+S)'}>
          <IconSave size={13} />
        </button>
        <button className="btn sm primary" onClick={() => setDialog('export')}>
          <IconExport size={13} /> Export
        </button>
      </div>
      <div style={{ display: 'flex', gap: 12, minHeight: 0, minWidth: 0 }}>
        <Browser />
        <div className="glass panel grow">
          <Timeline autoKey={autoKey} />
        </div>
      </div>
      <div className="glass panel">
        <div className="panel-head" style={{ minHeight: 40, padding: '6px 12px' }}>
          <div className="seg sm">
            <button className={bottom === 'clip' ? 'on' : ''} onClick={() => setBottom('clip')}>
              Clip
            </button>
            <button className={bottom === 'drums' ? 'on' : ''} onClick={() => setBottom('drums')}>
              Drum sequencer
            </button>
            <button className={bottom === 'fx' ? 'on' : ''} onClick={() => setBottom('fx')}>
              FX & build-ups
            </button>
          </div>
          <div className="spacer" />
          <span className="faint" style={{ fontSize: 11 }}>
            {project.tracks.reduce((n, t) => n + t.clips.length, 0)} clips · {fmtBpm(project.bpm)} BPM · {project.key ? `${camelotName(project.key)} ${keyName(project.key)}` : 'no key set'}
          </span>
        </div>
        <div className="panel-body">
          {bottom === 'clip' && <ClipInspector />}
          {bottom === 'drums' && <DrumSequencer />}
          {bottom === 'fx' && <FxPanel />}
        </div>
      </div>
      {dialog === 'open' && <OpenDialog onClose={() => setDialog(null)} />}
      {dialog === 'export' && <ExportDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
