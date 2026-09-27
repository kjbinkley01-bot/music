import { type ReactNode, memo, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Camelot, Modal } from '../components/Controls';
import { IconSearch } from '../components/Icons';
import { type Key, bpmMatch, camelotName, fmtBpm, fmtTime, keyCompatibility, keyName, trackKey } from '../music';
import { reportError, useApp } from '../store/app';
import type { Job, Track } from '../types';

export const TRACK_MIME = 'application/x-stemdeck-track';

type SortKey = 'added' | 'title' | 'artist' | 'bpm' | 'key' | 'duration' | 'energy';
type Filter = 'all' | 'stems' | 'remixes' | 'compatible';

export interface CompatRef {
  key: Key | null;
  bpm: number;
}

interface Props {
  selectedId?: number | null;
  onSelect?(t: Track): void;
  onOpen?(t: Track): void;
  compatWith?: CompatRef[];
  compact?: boolean;
  extraActions?: (t: Track) => ReactNode;
}

function compatOf(t: Track, refs: CompatRef[] | undefined): 'perfect' | 'good' | null {
  if (!refs?.length) return null;
  let best: 'perfect' | 'good' | null = null;
  for (const r of refs) {
    const k = keyCompatibility(trackKey(t), r.key);
    const tempo = bpmMatch(r.bpm, t.bpm, 0.06);
    if (tempo === null) continue;
    if (k === 'perfect') return 'perfect';
    if (k === 'good') best = 'good';
  }
  return best;
}

export function StemBadge({ track, job }: { track: Track; job?: Job }) {
  if (job?.status === 'running' && job.kind === 'separate')
    return (
      <span className="row" style={{ gap: 6 }} title={job.message}>
        <div className="progress" style={{ width: 70 }}>
          <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
        </div>
        <span className="mono faint" style={{ fontSize: 11 }}>
          {Math.round(job.progress * 100)}%
        </span>
      </span>
    );
  switch (track.stem_status) {
    case 'done':
      return <span className="chip ok">{track.stem_quality === 'high' ? 'HQ stems' : 'Stems'}</span>;
    case 'queued':
      return <span className="chip busy">Queued</span>;
    case 'processing':
      return <span className="chip busy">Starting…</span>;
    case 'error':
      return (
        <span className="chip bad" title={track.error || ''}>
          Failed
        </span>
      );
    default:
      return <span className="chip">—</span>;
  }
}

export const LibraryTable = memo(function LibraryTable({ selectedId, onSelect, onOpen, compatWith, compact, extraActions }: Props) {
  const tracks = useApp((s) => s.tracks);
  const jobs = useApp((s) => s.jobs);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'added', dir: -1 });
  const [filter, setFilter] = useState<Filter>('all');
  const [menu, setMenu] = useState<{ x: number; y: number; track: Track } | null>(null);
  const [editing, setEditing] = useState<Track | null>(null);
  // Row virtualisation: only rows near the viewport are rendered, so libraries with thousands
  // of tracks scroll smoothly on slow machines.
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', update);
    };
  }, []);

  const jobByTrack = useMemo(() => {
    const m = new Map<number, Job>();
    for (const j of jobs) if (j.kind === 'separate' && (j.status === 'running' || !m.has(j.track_id))) m.set(j.track_id, j);
    return m;
  }, [jobs]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    // "120-128" filters by BPM range (half/double time included); "8A" or "am" by key
    const range = /^(\d{2,3})\s*-\s*(\d{2,3})$/.exec(q);
    const inRange = (bpm: number | null) =>
      !!bpm && !!range && [bpm, bpm * 2, bpm / 2].some((b) => b >= Number(range[1]) && b <= Number(range[2]));
    let list = tracks.filter(
      (t) =>
        !q ||
        (range
          ? inRange(t.bpm)
          : t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.camelot.toLowerCase() === q || t.key_name.toLowerCase() === q),
    );
    if (filter === 'stems') list = list.filter((t) => t.stem_status === 'done');
    if (filter === 'remixes') list = list.filter((t) => t.is_remix);
    if (filter === 'compatible') list = list.filter((t) => compatOf(t, compatWith));
    const val = (t: Track): number | string => {
      switch (sort.key) {
        case 'title':
          return t.title.toLowerCase();
        case 'artist':
          return t.artist.toLowerCase();
        case 'bpm':
          return t.bpm ?? 0;
        case 'key':
          return t.camelot ? parseInt(t.camelot, 10) * 2 + (t.camelot.endsWith('B') ? 1 : 0) : 99;
        case 'duration':
          return t.duration;
        case 'energy':
          return t.energy ?? 0;
        default:
          return t.added_at;
      }
    };
    return [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [tracks, query, sort, filter, compatWith]);

  const header = (key: SortKey, label: string, cls = '') => (
    <th className={cls} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : key === 'added' ? -1 : 1 }))}>
      {label}
      {sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  const run = async (fn: () => Promise<unknown>, label: string) => {
    setMenu(null);
    try {
      await fn();
      await useApp.getState().refreshTracks();
    } catch (e) {
      reportError(e, label);
    }
  };

  const rowH = compact ? 46 : 33;
  const renderRow = (t: Track) => {
    const c = compatOf(t, compatWith);
    return (
      <tr
        key={t.id}
        style={{ height: rowH }}
        className={`${t.id === selectedId ? 'selected' : ''} ${c ? `compat-${c}` : ''}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(TRACK_MIME, String(t.id));
          e.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={() => onSelect?.(t)}
        onDoubleClick={() => onOpen?.(t)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, track: t });
        }}
      >
        <td style={{ maxWidth: compact ? 200 : 280 }}>
          <div className="ellipsis" title={t.path}>
            {t.is_remix && <span className="chip warn" style={{ marginRight: 6 }}>Remix</span>}
            {t.title}
          </div>
          {compact && t.artist && (
            <div className="ellipsis faint" style={{ fontSize: 11 }}>
              {t.artist}
            </div>
          )}
        </td>
        {!compact && (
          <td className="ellipsis muted" style={{ maxWidth: 180 }}>
            {t.artist}
          </td>
        )}
        <td className="num">{t.analysis_status === 'pending' ? <span className="faint">…</span> : fmtBpm(t.bpm)}</td>
        <td>
          <Camelot code={t.camelot} name={compact ? undefined : t.key_name} />
        </td>
        {!compact && <td className="num muted">{fmtTime(t.duration)}</td>}
        {!compact && <td className="num muted">{t.energy ? t.energy.toFixed(0) : '—'}</td>}
        <td>
          <StemBadge track={t} job={jobByTrack.get(t.id)} />
        </td>
        {extraActions && <td style={{ textAlign: 'right' }}>{extraActions(t)}</td>}
      </tr>
    );
  };

  return (
    <div className="col" style={{ height: '100%', gap: 0 }} onClick={() => menu && setMenu(null)}>
      <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
        <div className="row grow" style={{ position: 'relative' }}>
          <IconSearch size={14} style={{ position: 'absolute', left: 9, color: 'var(--text-faint)' }} />
          <input className="input sm grow" style={{ paddingLeft: 28 }} placeholder="Search title, artist, key (8A) or BPM range (120-128)…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="seg sm">
          {(['all', 'stems', 'remixes', ...(compatWith?.length ? ['compatible'] : [])] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'stems' ? 'Stems' : f === 'remixes' ? 'Remixes' : 'Harmonic'}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-body" ref={scroller}>
        {rows.length === 0 ? (
          <div className="empty">
            {tracks.length === 0 ? (
              <>
                <h3>Your library is empty</h3>
                <div>Add files or a folder, or drag audio files onto the window.</div>
              </>
            ) : (
              <div>No tracks match.</div>
            )}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                {header('title', 'Title')}
                {!compact && header('artist', 'Artist')}
                {header('bpm', 'BPM', 'num')}
                {header('key', 'Key')}
                {!compact && header('duration', 'Time', 'num')}
                {!compact && header('energy', 'Nrg', 'num')}
                <th>Stems</th>
                {extraActions && <th />}
              </tr>
            </thead>
            <tbody>
              {(() => {
                const first = Math.max(0, Math.floor(viewport.top / rowH) - 10);
                const last = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / rowH) + 10);
                return (
                  <>
                    {first > 0 && <tr style={{ height: first * rowH }} aria-hidden />}
                    {rows.slice(first, last).map((t) => renderRow(t))}
                    {last < rows.length && <tr style={{ height: (rows.length - last) * rowH }} aria-hidden />}
                  </>
                );
              })()}
            </tbody>
          </table>
        )}
      </div>
      {editing && <TrackEditor track={editing} onClose={() => setEditing(null)} />}
      {menu && (
        <div className="glass" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 70, padding: 5, minWidth: 210 }} onClick={(e) => e.stopPropagation()}>
          {[
            { label: 'Separate stems (fast)', run: () => run(() => api.separate([menu.track.id], 'fast'), 'Queue failed') },
            { label: 'Separate stems (high quality)', run: () => run(() => api.separate([menu.track.id], 'high'), 'Queue failed') },
            { label: 'Re-analyse BPM & key', run: () => run(() => api.analyze([menu.track.id]), 'Analysis failed') },
            { label: 'Edit track info…', run: () => (setMenu(null), setEditing(menu.track)) },
            { label: 'Show file in folder', run: () => (setMenu(null), window.stemdeck?.showItem(menu.track.path)) },
            {
              label: 'Remove from library',
              danger: true,
              run: () => {
                if (confirm(`Remove “${menu.track.title}” from the library? Stems are deleted; your original file is kept.`))
                  void run(() => api.deleteTrack(menu.track.id), 'Remove failed');
                else setMenu(null);
              },
            },
          ].map((item) => (
            <button key={item.label} className={`btn ghost sm ${item.danger ? 'danger' : ''}`} style={{ width: '100%', justifyContent: 'flex-start' }} onClick={item.run}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

const KEY_OPTIONS: Key[] = Array.from({ length: 24 }, (_, i) => ({ pc: i % 12, mode: i < 12 ? ('minor' as const) : ('major' as const) })).sort(
  (a, b) => parseInt(camelotName(a)) - parseInt(camelotName(b)) || (a.mode === 'minor' ? -1 : 1),
);

/** Fix detection mistakes by hand: title, artist, BPM, grid offset and key. */
function TrackEditor({ track, onClose }: { track: Track; onClose(): void }) {
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const [bpm, setBpm] = useState(track.bpm ? String(track.bpm) : '');
  const [firstBeat, setFirstBeat] = useState(String(track.first_beat ?? 0));
  const [key, setKey] = useState(track.key_pc != null && track.key_mode ? `${track.key_pc}:${track.key_mode}` : '');
  const save = async () => {
    const patch: Partial<Track> = { title: title.trim() || track.title, artist: artist.trim() };
    const b = Number(bpm);
    if (b > 20 && b < 400) patch.bpm = b;
    const fb = Number(firstBeat);
    if (Number.isFinite(fb)) patch.first_beat = fb;
    if (key) {
      const [pc, mode] = key.split(':');
      patch.key_pc = Number(pc);
      patch.key_mode = mode as Track['key_mode'];
    }
    try {
      useApp.getState().patchTrackLocal(await api.patchTrack(track.id, patch));
      onClose();
    } catch (e) {
      reportError(e, 'Could not save');
    }
  };
  return (
    <Modal title="Edit track info" onClose={onClose} width={460}>
      <div className="form-grid" style={{ gridTemplateColumns: '110px 1fr' }}>
        <label>Title</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label>Artist</label>
        <input className="input" value={artist} onChange={(e) => setArtist(e.target.value)} />
        <label>BPM</label>
        <input className="input mono" value={bpm} onChange={(e) => setBpm(e.target.value)} />
        <label>First beat (s)</label>
        <input className="input mono" value={firstBeat} onChange={(e) => setFirstBeat(e.target.value)} />
        <div className="hint">Where beat 1 of the grid sits. Stem Lab’s grid tools set this visually.</div>
        <label>Key</label>
        <select className="select" value={key} onChange={(e) => setKey(e.target.value)}>
          {!key && <option value="">Unknown</option>}
          {KEY_OPTIONS.map((k) => (
            <option key={`${k.pc}:${k.mode}`} value={`${k.pc}:${k.mode}`}>
              {camelotName(k)} · {keyName(k)}
            </option>
          ))}
        </select>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  );
}
