import { dj, useDj } from '../dj/engine';
import { remixEngine } from '../remix/engine';
import { stemLabDeck } from '../views/StemLab';

/**
 * Everything a MIDI control can be mapped to.
 *  button:     receives 1 on press, 0 on release
 *  continuous: receives 0..1 (knobs, faders)
 *  relative:   receives a signed step count (endless encoders, jog wheels)
 */
export interface MidiAction {
  id: string;
  label: string;
  group: string;
  kind: 'button' | 'continuous' | 'relative';
  run(v: number): void;
}

const press = (fn: () => void) => (v: number) => {
  if (v > 0) fn();
};

function deckActions(i: 0 | 1): MidiAction[] {
  const name = i === 0 ? 'A' : 'B';
  const d = () => dj().decks[i];
  const group = `Deck ${name}`;
  const a = (id: string, label: string, kind: MidiAction['kind'], run: (v: number) => void): MidiAction => ({
    id: `deck${name}.${id}`,
    label,
    group,
    kind,
    run,
  });
  const list: MidiAction[] = [
    a('play', 'Play / pause', 'button', press(() => d().togglePlay())),
    a('cue', 'Cue (hold to preview)', 'button', (v) => (v > 0 ? d().cueDown() : d().cueUp())),
    a('sync', 'Sync', 'button', press(() => d().syncTo(dj().other(d())))),
    a('pitch', 'Pitch fader', 'continuous', (v) => d().setPitchFader(v * 2 - 1)),
    a('volume', 'Channel volume', 'continuous', (v) => d().setVolume(v)),
    a('eqHigh', 'EQ high', 'continuous', (v) => d().setEq('high', v < 0.5 ? -26 + v * 52 : (v - 0.5) * 12)),
    a('eqMid', 'EQ mid', 'continuous', (v) => d().setEq('mid', v < 0.5 ? -26 + v * 52 : (v - 0.5) * 12)),
    a('eqLow', 'EQ low', 'continuous', (v) => d().setEq('low', v < 0.5 ? -26 + v * 52 : (v - 0.5) * 12)),
    a('filter', 'Filter', 'continuous', (v) => d().setFilter(v * 2 - 1)),
    a('jog', 'Jog wheel (nudge / scrub)', 'relative', (steps) => {
      const deck = d();
      if (deck.playing) {
        deck.setNudge(Math.max(-0.2, Math.min(0.2, steps * 0.02)));
        clearTimeout(jogTimers[i]);
        jogTimers[i] = window.setTimeout(() => deck.setNudge(0), 90);
      } else {
        deck.seek(deck.position + steps * 0.01);
      }
    }),
    a('nudgeBack', 'Nudge slower (hold)', 'button', (v) => d().setNudge(v > 0 ? -0.04 : 0)),
    a('nudgeFwd', 'Nudge faster (hold)', 'button', (v) => d().setNudge(v > 0 ? 0.04 : 0)),
    a('keylock', 'Key lock toggle', 'button', press(() => d().setKeyLock(!d().keyLock))),
    a('gain', 'Channel gain', 'continuous', (v) => d().setGain(v * 24 - 12)),
    a('jumpBack', 'Beat jump back (1 bar)', 'button', press(() => d().beatJump(-4))),
    a('jumpFwd', 'Beat jump forward (1 bar)', 'button', press(() => d().beatJump(4))),
    a('blend', `Blend to deck ${name}`, 'button', press(() => void dj().startBlend(i))),
    a('loopHalf', 'Loop ÷2', 'button', press(() => d().resizeLoop(0.5))),
    a('loopDouble', 'Loop ×2', 'button', press(() => d().resizeLoop(2))),
    a('loopOff', 'Loop exit', 'button', press(() => d().clearLoop())),
  ];
  for (const beats of [1, 2, 4, 8, 16]) list.push(a(`loop${beats}`, `Beat loop ${beats}`, 'button', press(() => d().beatLoop(beats))));
  for (let c = 0; c < 8; c++) list.push(a(`hotcue${c + 1}`, `Hot cue ${c + 1}`, 'button', press(() => d().hotCue(c))));
  for (const stem of ['vocals', 'drums', 'bass', 'other']) {
    list.push(a(`stem.${stem}`, `Stem ${stem === 'other' ? 'melody' : stem} on/off`, 'button', press(() => d().toggleMute(stem))));
  }
  return list;
}

const jogTimers: number[] = [0, 0];

export const ACTIONS: MidiAction[] = [
  ...deckActions(0),
  ...deckActions(1),
  { id: 'mixer.crossfader', label: 'Crossfader', group: 'Mixer', kind: 'continuous', run: (v) => dj().setCrossfader(v * 2 - 1) },
  { id: 'mixer.master', label: 'Master volume', group: 'Mixer', kind: 'continuous', run: (v) => dj().setMasterVolume(v) },
  {
    id: 'mixer.record',
    label: 'Record on/off',
    group: 'Mixer',
    kind: 'button',
    run: press(() => (useDj.getState().recording ? void dj().stopRecording() : void dj().startRecording())),
  },
  { id: 'lab.play', label: 'Stem Lab play / pause', group: 'Stem Lab', kind: 'button', run: press(() => stemLabDeck().togglePlay()) },
  {
    id: 'remix.play',
    label: 'Remix play / stop',
    group: 'Remix Studio',
    kind: 'button',
    run: press(() => (remixEngine.playing ? remixEngine.stop() : void remixEngine.play())),
  },
];
