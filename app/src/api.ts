import type { EngineHealth, EngineState, Job, Settings, Track } from './types';

/**
 * Client for the local Python engine. Inside Electron the port and token come from the main
 * process; in a plain browser (npm run dev:web) pass ?engine=http://127.0.0.1:47821&token=... .
 */
let base = '';
let token = '';

export function configureEngine(state: Pick<EngineState, 'port' | 'token'>) {
  base = `http://127.0.0.1:${state.port}`;
  token = state.token;
}

export function browserEngineFromUrl(): EngineState {
  const q = new URLSearchParams(location.search);
  const url = new URL(q.get('engine') || 'http://127.0.0.1:47821');
  return { port: Number(url.port), token: q.get('token') || '', ready: true, error: '', logPath: '' };
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, raw?: BodyInit): Promise<T> {
  const headers: Record<string, string> = { 'x-stemdeck-token': token };
  let payload: BodyInit | undefined = raw;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(base + path, { method, headers, body: payload });
  } catch {
    throw new ApiError('Cannot reach the StemDeck audio engine', 0);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    } catch {
      /* not json */
    }
    throw new ApiError(detail || `HTTP ${res.status}`, res.status);
  }
  const type = res.headers.get('content-type') || '';
  return (type.includes('application/json') ? res.json() : res.arrayBuffer()) as Promise<T>;
}

const get = <T>(p: string) => request<T>('GET', p);
const post = <T>(p: string, body?: unknown) => request<T>('POST', p, body ?? {});

export const api = {
  health: () => get<EngineHealth>('/health'),
  status: () => get<{ revision: number; jobs: Job[]; recording: boolean }>('/status'),
  settings: () => get<Settings>('/settings'),
  saveSettings: (s: Partial<Settings>) => request<Settings>('PUT', '/settings', s),

  tracks: () => get<Track[]>('/tracks'),
  importPaths: (paths: string[]) => post<{ added: number[]; skipped: number; missing: string[] }>('/tracks/import', { paths }),
  patchTrack: (id: number, patch: Partial<Track>) => request<Track>('PATCH', `/tracks/${id}`, patch),
  deleteTrack: (id: number) => request<{ ok: boolean }>('DELETE', `/tracks/${id}`),
  markPlayed: (id: number) => post(`/tracks/${id}/played`),
  audio: (id: number) => get<ArrayBuffer>(`/tracks/${id}/audio`),
  stem: (id: number, stem: string) => get<ArrayBuffer>(`/tracks/${id}/stems/${stem}`),
  stretched: (id: number, stem: string, ratio: number, semitones: number) =>
    get<ArrayBuffer>(`/tracks/${id}/stretched?stem=${stem}&ratio=${ratio.toFixed(5)}&semitones=${semitones}`),

  separate: (trackIds: number[], quality?: string) => post<{ jobs: number[] }>('/jobs/separate', { track_ids: trackIds, quality }),
  analyze: (trackIds: number[]) => post<{ jobs: number[] }>('/jobs/analyze', { track_ids: trackIds }),
  cancelJob: (id: number) => post(`/jobs/${id}/cancel`),
  cancelAll: () => post('/jobs/cancel-all'),

  exportStems: (body: {
    track_id: number;
    gains: Record<string, number>;
    format: string;
    label: string;
    tempo_ratio?: number;
    semitones?: number;
    start?: number | null;
    end?: number | null;
    separate?: boolean;
  }) => post<{ files: string[] }>('/export/stems', body),
  exportRender: (wav: Blob, q: { name: string; format: string; add_to_library: boolean; bpm?: number; key_pc?: number | null; key_mode?: string | null }) => {
    const params = new URLSearchParams();
    Object.entries(q).forEach(([k, v]) => v !== undefined && v !== null && params.set(k, String(v)));
    return request<{ file: string; track_id: number | null }>('POST', `/export/render?${params}`, undefined, wav);
  },

  recordingStart: (sample_rate: number, format: string) => post<{ file: string }>('/recording/start', { sample_rate, channels: 2, format }),
  recordingChunk: (pcm: ArrayBuffer) => request('POST', '/recording/chunk', undefined, pcm),
  recordingStop: () => post<{ file: string | null }>('/recording/stop'),

  projects: () => get<{ id: number; name: string; updated_at: number }[]>('/projects'),
  project: (id: number) => get<{ id: number; name: string; data: unknown }>(`/projects/${id}`),
  createProject: (name: string, data: unknown) => post<{ id: number }>('/projects', { name, data }),
  saveProject: (id: number, name: string, data: unknown) => request<{ id: number }>('PUT', `/projects/${id}`, { name, data }),
  deleteProject: (id: number) => request('DELETE', `/projects/${id}`),

  samples: () => get<{ id: number; name: string }[]>('/samples'),
  importSamples: (paths: string[]) => post<{ added: { id: number; name: string }[] }>('/samples/import', { paths }),
  sampleAudio: (id: number) => get<ArrayBuffer>(`/samples/${id}/audio`),
  deleteSample: (id: number) => request('DELETE', `/samples/${id}`),

  scStatus: () => get<{ configured: boolean; connected: boolean; username: string; redirect_uri: string }>('/soundcloud/status'),
  scAuthorize: () => get<{ url: string }>('/soundcloud/authorize'),
  scDisconnect: () => post('/soundcloud/disconnect'),
  scLikes: () => get<ScTrack[]>('/soundcloud/likes'),
  scPlaylists: () => get<{ id: number; title: string; tracks: ScTrack[] }[]>('/soundcloud/playlists'),
  scUpload: (path: string, title: string, sharing: string) => post<{ permalink_url: string }>('/soundcloud/upload', { path, title, sharing }),
  wishlist: () => get<(ScTrack & { id: number; source: string })[]>('/wishlist'),
  wishlistAdd: (items: ScTrack[], source: string) => post<{ added: number }>('/wishlist', { items, source }),
  wishlistDelete: (id: number) => request('DELETE', `/wishlist/${id}`),
};

export interface ScTrack {
  sc_id: number;
  title: string;
  artist: string;
  permalink_url: string | null;
  purchase_url: string | null;
  artwork_url: string | null;
  bpm: number | null;
}
