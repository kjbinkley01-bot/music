import { create } from 'zustand';
import { api } from '../api';
import type { EngineHealth, Job, Settings, Track } from '../types';

export type View = 'lab' | 'remix' | 'dj' | 'soundcloud' | 'midi' | 'settings';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
  action?: { label: string; run: () => void };
}

interface AppState {
  view: View;
  health: EngineHealth | null;
  tracks: Track[];
  jobs: Job[];
  settings: Settings | null;
  recording: boolean;
  revision: number;
  selectedTrackId: number | null;
  toasts: Toast[];
  setView(v: View): void;
  selectTrack(id: number | null): void;
  refreshTracks(): Promise<void>;
  refreshSettings(): Promise<void>;
  updateSettings(s: Partial<Settings>): Promise<void>;
  poll(): Promise<void>;
  toast(text: string, kind?: Toast['kind'], action?: Toast['action']): void;
  dismissToast(id: number): void;
  patchTrackLocal(t: Track): void;
}

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  view: 'lab',
  health: null,
  tracks: [],
  jobs: [],
  settings: null,
  recording: false,
  revision: -1,
  selectedTrackId: null,
  toasts: [],
  setView: (view) => set({ view }),
  selectTrack: (selectedTrackId) => set({ selectedTrackId }),
  refreshTracks: async () => {
    const tracks = await api.tracks();
    set({ tracks });
  },
  refreshSettings: async () => {
    set({ settings: await api.settings() });
  },
  updateSettings: async (s) => {
    try {
      set({ settings: await api.saveSettings(s) });
    } catch (e) {
      get().toast(`Could not save settings: ${(e as Error).message}`, 'error');
    }
  },
  poll: async () => {
    const status = await api.status();
    const changed = status.revision !== get().revision;
    set({ jobs: status.jobs, recording: status.recording, revision: status.revision });
    if (changed) await get().refreshTracks();
  },
  toast: (text, kind = 'info', action) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, text, action }].slice(-4) });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  patchTrackLocal: (t) => set({ tracks: get().tracks.map((x) => (x.id === t.id ? t : x)) }),
}));

export const trackById = (id: number | null | undefined) =>
  id == null ? undefined : useApp.getState().tracks.find((t) => t.id === id);

export function reportError(e: unknown, prefix = '') {
  const msg = e instanceof Error ? e.message : String(e);
  useApp.getState().toast(prefix ? `${prefix}: ${msg}` : msg, 'error');
}
