import { create } from 'zustand';
import { api } from '../api';
import { reportError, useApp } from '../store/app';
import { type Clip, type RemixProject, type RemixTrack, newProject, uid } from './model';
import { pruneSources, remixEngine, requestSource, useSources } from './engine';

type Draft = (p: RemixProject) => void;

interface RemixState {
  project: RemixProject;
  projectId: number | null;
  dirty: boolean;
  past: RemixProject[];
  future: RemixProject[];
  selectedClip: string | null;
  selectedTrack: string | null;
  selectedPattern: string;
  clipboard: Clip | null;
  snap: number; // beats; 0 = off
  zoom: number; // pixels per beat
  /** Apply an edit. `structural` edits (clips, tempo, patterns) reschedule playback. */
  edit(fn: Draft, opts?: { structural?: boolean; history?: boolean }): void;
  /** Push an undo point without changing anything (call at the start of a drag gesture). */
  checkpoint(): void;
  undo(): void;
  redo(): void;
  load(id: number | null, project: RemixProject): void;
  save(asNew?: boolean): Promise<void>;
  select(clip: string | null, track?: string | null): void;
  set(partial: Partial<Pick<RemixState, 'snap' | 'zoom' | 'selectedPattern' | 'clipboard'>>): void;
}

const MAX_HISTORY = 80;

export const useRemix = create<RemixState>((set, get) => {
  const initial = newProject();
  return {
    project: initial,
    projectId: null,
    dirty: false,
    past: [],
    future: [],
    selectedClip: null,
    selectedTrack: null,
    selectedPattern: initial.patterns[0].id,
    clipboard: null,
    snap: 1,
    zoom: 28,
    edit: (fn, opts = {}) => {
      const { structural = true, history = true } = opts;
      const prev = get().project;
      const next = structuredClone(prev);
      fn(next);
      set({
        project: next,
        dirty: true,
        past: history ? [...get().past, prev].slice(-MAX_HISTORY) : get().past,
        future: history ? [] : get().future,
      });
      remixEngine.update(next, useApp.getState().tracks, structural);
      if (structural) preloadProject(next);
    },
    checkpoint: () => set({ past: [...get().past, get().project].slice(-MAX_HISTORY), future: [] }),
    undo: () => {
      const { past, project, future } = get();
      if (!past.length) return;
      const prev = past[past.length - 1];
      set({ project: prev, past: past.slice(0, -1), future: [project, ...future], dirty: true });
      remixEngine.update(prev, useApp.getState().tracks, true);
      preloadProject(prev);
    },
    redo: () => {
      const { past, project, future } = get();
      if (!future.length) return;
      const next = future[0];
      set({ project: next, past: [...past, project], future: future.slice(1), dirty: true });
      remixEngine.update(next, useApp.getState().tracks, true);
      preloadProject(next);
    },
    load: (id, project) => {
      remixEngine.stop();
      remixEngine.setPosition(0);
      set({
        project,
        projectId: id,
        dirty: false,
        past: [],
        future: [],
        selectedClip: null,
        selectedPattern: project.patterns[0]?.id ?? '',
      });
      const tracks = useApp.getState().tracks;
      pruneSources(project, tracks);
      remixEngine.update(project, tracks, true);
      preloadProject(project);
    },
    save: async (asNew = false) => {
      const { project, projectId } = get();
      try {
        if (projectId && !asNew) await api.saveProject(projectId, project.name, project);
        else {
          const { id } = await api.createProject(project.name, project);
          set({ projectId: id });
        }
        set({ dirty: false });
        useApp.getState().toast(`Saved “${project.name}”`, 'success');
      } catch (e) {
        reportError(e, 'Save failed');
      }
    },
    select: (clip, track) => set({ selectedClip: clip, ...(track !== undefined ? { selectedTrack: track } : {}) }),
    set: (partial) => set(partial),
  };
});

/** Start fetching / stretching every audio clip's source in the background. */
export function preloadProject(p: RemixProject) {
  const tracks = useApp.getState().tracks;
  for (const t of p.tracks)
    for (const c of t.clips) {
      if (c.type !== 'audio') continue;
      const track = tracks.find((x) => x.id === c.trackId);
      if (track) void requestSource(track, c.stem, p.bpm, c.semitones);
    }
}

// When a stretched buffer arrives while playing, reschedule so the clip is heard straight away.
useSources.subscribe((s, prev) => {
  if (s.version !== prev.version && remixEngine.playing) {
    remixEngine.update(useRemix.getState().project, useApp.getState().tracks, true);
  }
});

export function findClip(p: RemixProject, id: string | null): { track: RemixTrack; clip: Clip } | null {
  if (!id) return null;
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return { track, clip };
  }
  return null;
}

export function cloneClip(c: Clip, start: number): Clip {
  return { ...structuredClone(c), id: uid(), start };
}

export function snapBeat(beat: number, snap: number): number {
  return snap > 0 ? Math.round(beat / snap) * snap : beat;
}
