import { create } from 'zustand';
import { api } from '../api';
import { reportError, useApp } from '../store/app';
import { ACTIONS, type MidiAction } from './actions';

export interface MidiMapping {
  id: string;
  device: string; // input name, '' = any device
  type: 'cc' | 'note';
  channel: number; // 0-15
  number: number;
  action: string;
  mode: 'absolute' | 'relative';
}

interface MidiState {
  supported: boolean;
  devices: string[];
  mappings: MidiMapping[];
  learning: string | null;
  last: string;
  setMappings(m: MidiMapping[]): void;
  learn(action: string | null): void;
}

export const useMidi = create<MidiState>((set) => ({
  supported: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
  devices: [],
  mappings: [],
  learning: null,
  last: '',
  setMappings: (mappings) => {
    set({ mappings });
    void api.saveSettings({ midi_mappings: mappings }).catch((e) => reportError(e, 'Could not save MIDI mappings'));
  },
  learn: (learning) => set({ learning }),
}));

const actionById = new Map<string, MidiAction>(ACTIONS.map((a) => [a.id, a]));
let access: MIDIAccess | null = null;

function describe(type: string, ch: number, num: number, value: number) {
  return `${type.toUpperCase()} ch${ch + 1} #${num} = ${value}`;
}

function handle(deviceName: string, data: Uint8Array) {
  if (data.length < 2) return;
  const status = data[0] & 0xf0;
  const channel = data[0] & 0x0f;
  const number = data[1];
  const value = data[2] ?? 0;
  let type: 'cc' | 'note';
  let pressed: boolean;
  if (status === 0x90 || status === 0x80) {
    type = 'note';
    pressed = status === 0x90 && value > 0;
  } else if (status === 0xb0) {
    type = 'cc';
    pressed = value > 63;
  } else return;

  const state = useMidi.getState();
  useMidi.setState({ last: `${deviceName}: ${describe(type, channel, number, value)}` });

  if (state.learning) {
    if (type === 'note' && !pressed) return; // learn on press, ignore the release
    const action = actionById.get(state.learning);
    const mapping: MidiMapping = {
      id: Math.random().toString(36).slice(2),
      device: deviceName,
      type,
      channel,
      number,
      action: state.learning,
      mode: action?.kind === 'relative' ? 'relative' : 'absolute',
    };
    const rest = state.mappings.filter((m) => m.action !== mapping.action && !(m.device === deviceName && m.type === type && m.channel === channel && m.number === number));
    state.setMappings([...rest, mapping]);
    useMidi.setState({ learning: null });
    useApp.getState().toast(`Mapped ${describe(type, channel, number, value).split(' =')[0]} → ${action?.label ?? mapping.action}`, 'success');
    return;
  }

  for (const m of state.mappings) {
    if (m.type !== type || m.channel !== channel || m.number !== number) continue;
    if (m.device && m.device !== deviceName) continue;
    const action = actionById.get(m.action);
    if (!action) continue;
    try {
      if (action.kind === 'button') {
        action.run(pressed ? 1 : 0);
      } else if (m.mode === 'relative' || action.kind === 'relative') {
        // Two's complement relative encoders: 1..63 clockwise, 65..127 counter-clockwise.
        const delta = value < 64 ? value : value - 128;
        action.run(delta);
      } else {
        action.run(value / 127);
      }
    } catch (e) {
      console.error('MIDI action failed', m.action, e);
    }
  }
}

function attach() {
  if (!access) return;
  const names: string[] = [];
  access.inputs.forEach((input) => {
    names.push(input.name || input.id);
    input.onmidimessage = (e) => e.data && handle(input.name || input.id, e.data);
  });
  useMidi.setState({ devices: names });
}

let started = false;
export async function initMidi() {
  if (started) return;
  started = true;
  const saved = useApp.getState().settings?.midi_mappings;
  if (Array.isArray(saved)) useMidi.setState({ mappings: saved as MidiMapping[] });
  if (!useMidi.getState().supported) return;
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
    access.onstatechange = attach;
    attach();
  } catch {
    useMidi.setState({ supported: false });
  }
}

export function exportMappings(): string {
  return JSON.stringify({ app: 'StemDeck', version: 1, mappings: useMidi.getState().mappings }, null, 2);
}

export function importMappings(json: string) {
  const data = JSON.parse(json);
  const list = Array.isArray(data) ? data : data.mappings;
  if (!Array.isArray(list)) throw new Error('Not a StemDeck mapping file');
  const valid = list.filter((m: MidiMapping) => m && typeof m.action === 'string' && typeof m.number === 'number');
  useMidi.getState().setMappings(valid.map((m: MidiMapping) => ({ ...m, id: m.id || Math.random().toString(36).slice(2) })));
  return valid.length;
}
