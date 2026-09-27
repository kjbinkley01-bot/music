import { beforeAll, describe, expect, it, vi } from 'vitest';

// Stub the parts of the app that need a browser (AudioContext, fetch) before importing MIDI.
vi.mock('../src/api', () => ({ api: { saveSettings: vi.fn(async () => ({})) } }));
vi.mock('../src/store/app', () => ({
  useApp: { getState: () => ({ toast: vi.fn(), settings: { midi_mappings: [] } }) },
  reportError: vi.fn(),
}));

const calls: [string, number][] = [];
vi.mock('../src/midi/actions', () => ({
  ACTIONS: [
    { id: 'test.button', label: 'Button', group: 'T', kind: 'button', run: (v: number) => calls.push(['button', v]) },
    { id: 'test.knob', label: 'Knob', group: 'T', kind: 'continuous', run: (v: number) => calls.push(['knob', v]) },
    { id: 'test.jog', label: 'Jog', group: 'T', kind: 'relative', run: (v: number) => calls.push(['jog', v]) },
  ],
}));

let midi: typeof import('../src/midi/midi');
beforeAll(async () => {
  midi = await import('../src/midi/midi');
});

const msg = (...bytes: number[]) => Uint8Array.from(bytes);

describe('MIDI learn and dispatch', () => {
  it('learns a note and fires press/release', () => {
    midi.useMidi.getState().learn('test.button');
    midi.__test.handle('Pad', msg(0x90, 36, 100)); // note on ch1 learns
    expect(midi.useMidi.getState().learning).toBeNull();
    expect(midi.useMidi.getState().mappings).toMatchObject([{ type: 'note', channel: 0, number: 36, action: 'test.button' }]);
    midi.__test.handle('Pad', msg(0x90, 36, 90));
    midi.__test.handle('Pad', msg(0x80, 36, 0)); // note off
    midi.__test.handle('Pad', msg(0x90, 36, 0)); // note on with velocity 0 = release too
    expect(calls.splice(0)).toEqual([['button', 1], ['button', 0], ['button', 0]]);
  });

  it('ignores other devices when mapped to a specific one', () => {
    midi.__test.handle('Other controller', msg(0x90, 36, 100));
    expect(calls.splice(0)).toEqual([]);
  });

  it('maps CC knobs to 0..1 and relative encoders to signed steps', () => {
    midi.useMidi.getState().learn('test.knob');
    midi.__test.handle('Ctl', msg(0xb1, 7, 64)); // CC on channel 2
    midi.__test.handle('Ctl', msg(0xb1, 7, 127));
    midi.useMidi.getState().learn('test.jog');
    midi.__test.handle('Ctl', msg(0xb0, 20, 1));
    midi.__test.handle('Ctl', msg(0xb0, 20, 3));
    midi.__test.handle('Ctl', msg(0xb0, 20, 126));
    expect(calls.splice(0)).toEqual([['knob', 127 / 127], ['jog', 3], ['jog', -2]]);
  });

  it('re-learning a control replaces its previous mapping', () => {
    midi.useMidi.getState().learn('test.knob');
    midi.__test.handle('Pad', msg(0x90, 36, 100)); // take over the pad that was on test.button
    const maps = midi.useMidi.getState().mappings;
    expect(maps.filter((m) => m.number === 36 && m.type === 'note')).toHaveLength(1);
    expect(maps.find((m) => m.number === 36)!.action).toBe('test.knob');
  });

  it('round-trips mappings through JSON', () => {
    const json = midi.exportMappings();
    midi.useMidi.setState({ mappings: [] });
    expect(midi.importMappings(json)).toBeGreaterThan(0);
    expect(() => midi.importMappings('{"nope":1}')).toThrow();
  });
});
