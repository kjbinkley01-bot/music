export const STEMS = ['vocals', 'drums', 'bass', 'other'] as const;
export type StemName = (typeof STEMS)[number];

export const STEM_LABEL: Record<StemName, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Melody',
};

export const STEM_COLOR: Record<StemName | 'original', string> = {
  vocals: '#ff5c9a',
  drums: '#ffb547',
  bass: '#8b7bff',
  other: '#35d9c8',
  original: '#7fb8ff',
};

export interface Cue {
  index: number;
  time: number;
  label?: string;
}

export interface Track {
  id: number;
  path: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration: number;
  bpm: number | null;
  first_beat: number;
  key_pc: number | null;
  key_mode: 'major' | 'minor' | null;
  key_confidence: number | null;
  key_name: string;
  camelot: string;
  energy: number | null;
  loudness: number | null;
  analysis_status: 'pending' | 'done' | 'error';
  stem_status: 'none' | 'queued' | 'processing' | 'done' | 'error';
  stem_quality: 'fast' | 'high' | null;
  stems: StemName[];
  is_remix: boolean;
  cues: Cue[];
  rating: number;
  play_count: number;
  error: string | null;
  added_at: number;
}

export interface Job {
  id: number;
  track_id: number;
  kind: 'analyze' | 'separate';
  quality: string | null;
  status: 'queued' | 'running' | 'done' | 'error' | 'canceled';
  progress: number;
  message: string;
  title: string;
  artist: string;
  started_at: number | null;
}

export interface Settings {
  output_dir: string;
  quality: 'fast' | 'high';
  threads: number;
  use_gpu: boolean;
  stem_format: 'flac' | 'wav';
  mp3_bitrate: number;
  auto_separate: boolean;
  reduce_transparency: boolean;
  soundcloud_client_id: string;
  soundcloud_client_secret: string;
  midi_mappings: unknown[];
}

export interface EngineHealth {
  ok: boolean;
  version: string;
  stretch_engine: string;
  torch: boolean;
  cuda: boolean;
  device: string;
}

export interface EngineState {
  port: number;
  token: string;
  ready: boolean;
  error: string;
  logPath: string;
}

export interface Bridge {
  engineState(): Promise<EngineState>;
  restartEngine(): Promise<EngineState>;
  onEngineState(cb: (s: EngineState) => void): () => void;
  openFiles(opts?: { title?: string }): Promise<string[]>;
  openFolder(opts?: { title?: string }): Promise<string | null>;
  openJson(): Promise<string | null>;
  saveJson(name: string, content: string): Promise<boolean>;
  showItem(p: string): Promise<void>;
  openPath(p: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  pathForFile(file: File): string;
  platform: string;
}

declare global {
  interface Window {
    stemdeck?: Bridge;
  }
}
