# StemDeck roadmap

Ideas considered during development, roughly in order of value for a beginner remixer/DJ.
✅ = already built.

## Built in the first release
- ✅ Stem Lab, Remix Studio, DJ mode, MIDI learn, optional SoundCloud (see README)
- ✅ Precise tempo/grid analysis (phase-coherent tempo refinement, kick-band grid phase) and drum-robust key detection
- ✅ DJ auto-gain from measured loudness, channel/master meters, beat jump, one-button **Blend** transitions
- ✅ Remix clip fades, volume automation (alongside filter sweeps), metronome, "+ all stems", autosave/recovery, per-track stem export
- ✅ Library track editor and BPM-range search (`120-128`, half/double time aware)

## Next up
1. **Headphone pre-listen (split cue).** Needs a second audio output. Chromium's `AudioContext.setSinkId()` makes a second context feasible: route each deck's pre-fader signal to a "cue" context on another device (a USB headset or the second output pair of a controller). Requires the deck worklet to run in both contexts or a shared-memory bridge.
2. **Key shift on DJ decks** (transpose ±semitones while key lock is on, like "Pitch 'n Time" key sync). The worklet already time-stretches; adding a resampling stage after WSOLA gives pitch shifting.
3. **Crates / playlists** for preparing DJ sets, plus a "prepare" queue.
4. **Best-possible acapellas**: optional 2-stem vocal models (MDX-Net / BS-Roformer via `audio-separator`) as a "Vocals HQ" mode. Slow on CPU (several × track length), so offered per track.
5. **6-stem mode** (`htdemucs_6s`: adds guitar and piano) for melodic material.
6. **Sampler pads in DJ mode** (one-shots, air horns, your drum samples) and an FX unit (echo out, flanger, bit-crush) per deck.
7. **Beat-grid editor for tracks with tempo changes** (variable-tempo grid; the current grid is constant-tempo, which fits almost all electronic music).
8. **Watch folders**: auto-import new purchases from your downloads folder.
9. **Waveform colouring by frequency** (Serato-style) for tracks that haven't been separated.
10. **Remix Studio**: time signature other than 4/4, clip reverse, per-clip pitch envelope, send FX automation, sidechain "ducking" of stems under the kick.
11. **Auto-update and crash reporting** in the packaged app.

## Explicitly out of scope
- Downloading, ripping or caching audio from SoundCloud or any streaming service.
- Real-time stem separation on CPU during DJ playback (not feasible on weak hardware; stems are prepared ahead of time instead).
