import { useEffect, useState } from 'react';
import { api, browserEngineFromUrl, configureEngine } from './api';
import { Modal, Toasts, ViewVisible } from './components/Controls';
import { IconCloud, IconDisc, IconGear, IconMidi, IconSliders, IconWave } from './components/Icons';
import { useDj } from './dj/engine';
import { initMidi } from './midi/midi';
import { useRemix } from './remix/store';
import { type View, useApp } from './store/app';
import type { EngineState } from './types';
import { DjView } from './views/DjView';
import { MidiView } from './views/MidiView';
import { AUTOSAVE_KEY, RemixStudio } from './views/RemixStudio';
import { SettingsView } from './views/SettingsView';
import { SoundCloudView } from './views/SoundCloudView';
import { StemLab, importPaths } from './views/StemLab';

const TABS: { id: View; label: string; icon: typeof IconWave }[] = [
  { id: 'lab', label: 'Stem Lab', icon: IconWave },
  { id: 'remix', label: 'Remix Studio', icon: IconSliders },
  { id: 'dj', label: 'DJ', icon: IconDisc },
  { id: 'midi', label: 'MIDI', icon: IconMidi },
  { id: 'soundcloud', label: 'SoundCloud', icon: IconCloud },
  { id: 'settings', label: 'Settings', icon: IconGear },
];

function useEngine() {
  const [state, setState] = useState<EngineState | null>(null);
  const [healthy, setHealthy] = useState(false);

  useEffect(() => {
    const bridge = window.stemdeck;
    if (!bridge) {
      setState(browserEngineFromUrl());
      return;
    }
    void bridge.engineState().then(setState);
    return bridge.onEngineState(setState);
  }, []);

  useEffect(() => {
    if (state?.error) setHealthy(false); // engine crashed or failed: show the splash with details
    if (!state || state.error || !state.port || !state.ready) return;
    configureEngine(state);
    setHealthy(false);
    let cancelled = false;
    let timer = 0;
    const probe = async () => {
      try {
        const health = await api.health();
        if (cancelled) return;
        useApp.setState({ health });
        await useApp.getState().refreshSettings();
        await useApp.getState().poll();
        setHealthy(true);
      } catch {
        if (!cancelled) timer = window.setTimeout(probe, 400);
      }
    };
    void probe();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state]);

  return { state, healthy };
}

function Splash({ state }: { state: EngineState | null }) {
  const [restarting, setRestarting] = useState(false);
  return (
    <div className="splash">
      <div className="glass">
        <div className="brand" style={{ justifyContent: 'center', fontSize: 22, marginBottom: 12 }}>
          <span className="brand-mark" style={{ width: 30, height: 30 }} /> StemDeck
        </div>
        {state?.error ? (
          <>
            <p>The audio engine couldn’t start.</p>
            <pre>{state.error}</pre>
            <p className="muted" style={{ fontSize: 12 }}>
              Full log: {state.logPath}. In development, make sure the Python environment is set up (see README).
            </p>
            <button
              className="btn primary"
              disabled={restarting}
              onClick={async () => {
                setRestarting(true);
                await window.stemdeck?.restartEngine();
                setRestarting(false);
              }}
            >
              {restarting ? 'Restarting…' : 'Try again'}
            </button>
          </>
        ) : (
          <p className="muted">Starting the audio engine…</p>
        )}
      </div>
    </div>
  );
}

function StatusBar() {
  const health = useApp((s) => s.health);
  const jobs = useApp((s) => s.jobs);
  const recording = useApp((s) => s.recording);
  const running = jobs.find((j) => j.status === 'running' && j.kind === 'separate');
  const queued = jobs.filter((j) => j.status === 'queued' && j.kind === 'separate').length;
  return (
    <div className="statusbar">
      <span>
        <span className={`dot ${running ? 'busy' : ''}`} />
        {running ? `Separating “${running.title}” ${Math.round(running.progress * 100)}%${queued ? ` · ${queued} queued` : ''}` : 'Engine ready'}
      </span>
      {recording && (
        <span style={{ color: 'var(--bad)' }}>
          <span className="dot bad" />
          Recording
        </span>
      )}
      <div className="spacer" />
      {health && (
        <>
          <span title="Stem separation device">{health.cuda ? `GPU: ${health.device}` : health.torch ? 'CPU separation' : 'Demucs not installed'}</span>
          <span title="Time-stretch engine used for exports and remix clips">{health.stretch_engine}</span>
          <span className="faint">v{health.version}</span>
        </>
      )}
      <span className="faint">Press ? for shortcuts</span>
    </div>
  );
}

function Shortcuts({ onClose }: { onClose(): void }) {
  const rows: [string, string][] = [
    ['Ctrl + 1…6', 'Switch section'],
    ['Space', 'Play / pause (Stem Lab, Remix Studio)'],
    ['1 – 4 / Shift + 1 – 4', 'Mute / solo stems (Stem Lab)'],
    ['← / →', 'Jump one beat (Shift: one bar)'],
    ['L, [ , ]', 'Loop 4 beats, halve, double'],
    ['Ctrl + Z / Ctrl + Y', 'Undo / redo (Remix Studio)'],
    ['Ctrl + C / V / D', 'Copy / paste / duplicate clip'],
    ['S / Delete', 'Split clip at playhead / delete clip'],
    ['Ctrl + S', 'Save remix project'],
    ['DJ deck A', 'Z play · X cue · A sync · Q–R hot cues 1–4'],
    ['DJ deck B', 'M play · N cue · K sync · U–P hot cues 1–4'],
    ['DJ mixer', 'Shift + ← / → crossfader · C / , nudge'],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={560}>
      <table className="table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>
                <span className="kbd">{k}</span>
              </td>
              <td className="muted">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

export function App() {
  const { state, healthy } = useEngine();
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const reduce = useApp((s) => s.settings?.reduce_transparency);
  const [dragging, setDragging] = useState(false);
  const [help, setHelp] = useState(false);

  // Poll job progress and library changes.
  useEffect(() => {
    if (!healthy) return;
    const id = window.setInterval(() => void useApp.getState().poll().catch(() => undefined), 1000);
    void initMidi();
    return () => clearInterval(id);
  }, [healthy]);

  // Ask before closing with an unsaved remix or while recording (Electron shows a dialog).
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      const remix = useRemix.getState();
      if (remix.dirty) {
        try {
          localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ id: remix.projectId, project: remix.project, time: Date.now() }));
        } catch {
          /* ignore */
        }
      }
      if (remix.dirty || useDj.getState().recording) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if ((e.ctrlKey || e.metaKey) && /^Digit[1-6]$/.test(e.code)) {
        e.preventDefault();
        setView(TABS[Number(e.code.slice(5)) - 1].id);
      } else if (e.key === '?') setHelp((h) => !h);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView]);

  if (!healthy) {
    return (
      <>
        <div className="backdrop" />
        <Splash state={state} />
      </>
    );
  }

  const acceptsFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

  return (
    <div
      className={`app${reduce ? ' reduce-transparency' : ''}`}
      onDragOver={(e) => {
        if (!acceptsFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null) setDragging(false);
      }}
      onDrop={(e) => {
        if (!acceptsFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        const bridge = window.stemdeck;
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => (bridge ? bridge.pathForFile(f) : ''))
          .filter(Boolean);
        if (paths.length) void importPaths(paths);
      }}
    >
      <div className="backdrop" />
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" /> StemDeck
        </div>
        <nav className="tabs">
          {TABS.map((t, i) => (
            <button key={t.id} className={`tab ${view === t.id ? 'active' : ''}`} onClick={() => setView(t.id)} title={`Ctrl+${i + 1}`}>
              <t.icon size={14} /> {t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
      </header>
      <main className="main">
        {/* Views stay mounted so decks, timelines and players keep their state when you switch. */}
        {(
          [
            ['lab', <StemLab key="lab" />],
            ['remix', <RemixStudio key="remix" />],
            ['dj', <DjView key="dj" />],
          ] as const
        ).map(([id, el]) => (
          <div key={id} style={{ display: view === id ? 'block' : 'none', height: '100%' }}>
            <ViewVisible.Provider value={view === id}>{el}</ViewVisible.Provider>
          </div>
        ))}
        {view === 'midi' && <MidiView />}
        {view === 'soundcloud' && <SoundCloudView />}
        {view === 'settings' && <SettingsView />}
      </main>
      <StatusBar />
      <Toasts />
      {dragging && <div className="drop-hint">Drop audio files or folders to add them to your library</div>}
      {help && <Shortcuts onClose={() => setHelp(false)} />}
    </div>
  );
}
