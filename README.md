# StemDeck

A free desktop app for **stem separation, remixing and DJing** — a do-it-yourself alternative to Serato Stems, Lalal.ai and Moises that runs entirely on your own Windows PC, on the CPU.

> **Name:** StemDeck works well. If you want alternatives: *Splitwave*, *Fourfold* (four stems), or *Unmix*.

| Section | What it does |
|---|---|
| **Stem Lab** | Import files/folders → auto BPM, beat grid and key (standard + Camelot) → split into vocals / drums / bass / melody in a background queue → play stems with solo/mute/volume, loop regions, change speed without changing pitch → export any combination (acapella, instrumental, drums only…) as WAV or MP3. |
| **Remix Studio** | Multi-track timeline. Drag stems from any tracks; they're time-stretched to the project tempo and can be pitch-shifted onto the project key (with clash warnings). Snap to bars/beats, split, copy, loop and rearrange clips; per-track volume, pan, mute, solo, filter with drawable automation, reverb and delay sends; riser / downlifter / impact build-up tool; 8-voice drum step sequencer with your own samples; undo/redo; save/open projects; export to WAV/MP3 (goes straight into your DJ library). |
| **DJ** | Two decks with scrolling stem-coloured waveforms and beat grids, play/cue (hold to preview), sync (tempo + phase, handles half/double time), pitch fader (±8/16/50%), key lock, 3-band EQ with kills, filter, crossfader (smooth/sharp), 8 hot cues, beat loops, live stem toggles, nudge, harmonic-mixing highlights in the library, master recording to WAV/MP3. |
| **MIDI** | MIDI learn for every deck/mixer function, including relative jog wheels. Save/load mappings as JSON. |
| **SoundCloud** *(optional)* | Official API only: OAuth sign-in, browse likes & playlists as metadata, build a wishlist with links to buy each track, upload your remixes privately. Never downloads or caches audio. |

Everything works with just keyboard and mouse — press **?** in the app for shortcuts.

---

## What's realistic on a CPU (honest version)

| Task | On a typical 4-core laptop CPU | Notes |
|---|---|---|
| BPM / key analysis | 2–6 s per track | Runs in its own queue, so imports get BPM/key while separations run. |
| Stem separation — **Fast** (`htdemucs`) | ≈ 1–3× the song length (a 4-min song ≈ 4–12 min) | The best CPU trade-off for 4 stems. |
| Stem separation — **High quality** (`htdemucs_ft`) | ≈ 4–6× slower than Fast | Four fine-tuned models. Great for acapellas; queue it overnight. |
| Real-time stem playback, tempo change with key lock | Easy | Custom AudioWorklet (see Architecture). |
| Remix clip stretching (Rubber Band R3) | A few seconds per clip per tempo change | Cached on disk, so each (stem, tempo, pitch) combination is only rendered once. |

Things that are **not** realistic, and what StemDeck does instead:

* **Real-time stem separation while DJing** (what Serato/rekordbox do with a GPU/NPU) — not feasible on a weak CPU. StemDeck separates ahead of time; separated tracks then have instant, glitch-free stem toggles on the decks.
* **Studio-grade real-time key lock at extreme tempo changes** — the live key lock uses a lightweight WSOLA stretcher that sounds good within about ±10%. Exports and remix clips always use the high-quality Rubber Band engine.
* **Headphone cueing (split cue)** needs an audio interface or DJ controller with two outputs. Web Audio in Electron can only target one output device per app today, so there's no pre-listen yet — see *Future ideas*.
* A **GPU is used automatically** if you have an NVIDIA card with the CUDA build of PyTorch (≈10–20× faster separation), but it's never required.

---

## Setup (Windows, development mode)

You need two things installed first:

1. **Python 3.11** — from [python.org](https://www.python.org/downloads/windows/). During install tick **"Add python.exe to PATH"**. (3.10 and 3.12 also work; 3.11 is the safest for PyTorch.)
2. **Node.js 20 LTS or newer** — from [nodejs.org](https://nodejs.org/).

Then, in a terminal (PowerShell or Command Prompt) in the project folder:

```bat
scripts\setup_windows.bat
```

That script:

1. creates a private Python environment in `backend\.venv` (nothing is installed system-wide),
2. installs **PyTorch (CPU build)**, Demucs, librosa, FastAPI and friends (~1.5 GB download),
3. downloads the **Rubber Band** command-line tool into `backend\bin` for high-quality time-stretching (optional — if it fails the app still works with a lower-quality stretcher; see below),
4. runs `npm install` for the desktop app.

Start the app:

```bat
scripts\run_dev.bat
```

Electron starts the Python engine for you. The **first** separation downloads the Demucs model (~80 MB for Fast, ~320 MB for High quality) into `%APPDATA%\StemDeck\models`.

### Manual setup (if you prefer to type the commands)

```bat
cd backend
py -3.11 -m venv .venv
.venv\Scripts\activate
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements-dev.txt
cd ..\app
npm install
npm run dev
```

**NVIDIA GPU?** Replace the torch line with the CUDA command from [pytorch.org](https://pytorch.org/get-started/locally/) (e.g. `pip install torch --index-url https://download.pytorch.org/whl/cu124`). StemDeck detects it automatically; the status bar shows *GPU: …*.

**Rubber Band manually:** download `rubberband-3.x-gpl-executable-windows.zip` from [breakfastquay.com/rubberband](https://breakfastquay.com/rubberband/), and copy `rubberband.exe` **and the .dll files next to it** into `backend\bin\`. The status bar should then read *Rubber Band (high quality)*. You can also point `STEMDECK_RUBBERBAND` at the exe.

### Building a single installer

```bat
scripts\build_windows.bat
```

This bundles Python, PyTorch, Demucs, ffmpeg and Rubber Band into `backend\dist\stemdeck-engine` with PyInstaller, then electron-builder wraps everything into `app\release\StemDeck Setup 0.1.0.exe`. The installed app needs no Python. (Expect an installer of roughly 600–900 MB, mostly PyTorch.)

### Running the tests

```bat
scripts\run_tests.bat
```

(Backend: pytest with synthetic audio — analysis accuracy, the whole HTTP API, export, recording. Frontend: TypeScript type-check plus unit tests for the music-theory helpers and the time-stretch worklet.)

---

## Using StemDeck

### Stem Lab
1. **Files** / **Folder**, or drag audio onto the window. MP3, WAV, FLAC, AIFF, M4A, OGG are supported.
2. BPM, key and energy appear within seconds. Wrong BPM? Use **½× / 2×**, **Tap**, or nudge the grid (**◀ 10ms / 10ms ▶**, **+1 beat**, **Downbeat here**) under the player.
3. Right-click a track → **Separate stems (fast / high quality)**, or **Separate all**. Progress and time remaining show in the queue; the app stays responsive and you can keep working.
4. Double-click a track to open it. Drag across the waveform to loop a region (snaps to beats), scroll to zoom, **1–4** mute stems, **Shift+1–4** solo.
5. **Export** → current mix, a preset (Acapella, Instrumental, Drums…), or each stem separately; whole track or loop; optionally at the new speed and/or transposed.

### Remix Studio
* Set the project **BPM** and **key**, then drag stem chips from the **Browser** onto a track (or onto the empty area to create one). Clips are stretched to the project tempo in the background ("Stretching…").
* **Auto key** pitch-shifts new clips onto the project key. Clips that clash show ⚠; **Match all** fixes them.
* Drag clips to move (Alt-drag copies, drag up/down to change track), drag edges to trim. **S** splits at the playhead, **Ctrl+D** duplicates, **Ctrl+C / Ctrl+V** copy/paste at the playhead, **Delete** removes, **Ctrl+Z / Ctrl+Y** undo/redo.
* Click the ruler to move the playhead; drag on it to set the loop.
* Track knobs: volume, pan, filter (left = low-pass, right = high-pass), reverb and delay sends. Press **A** on a track to draw filter automation (click to add points, drag to move, right-click to delete) — perfect for sweeps.
* **Drum sequencer**: 16-step patterns with built-in kick/snare/clap/hats/etc. or your own samples (Import samples). Double-click a Drums lane to drop a pattern clip.
* **FX & build-ups**: insert risers, downlifters and impacts (e.g. a 4-bar riser ending at the drop).
* **Save** (Ctrl+S) / **Open** projects. **Export** renders WAV/MP3 into `Music\StemDeck\Remixes` and adds it to your library — it appears in DJ mode automatically (filter: *Remixes*).

### DJ
* Load tracks with the **A / B** buttons, double-click, or drag a row onto a deck.
* **CUE**: while playing jumps back to the cue point; while stopped sets the cue (snapped to the beat with Quantize) and previews while held.
* **SYNC** matches tempo and aligns beats to the other deck. Or beat-match by ear with the pitch fader and the ◀◀ / ▶▶ nudge buttons.
* **Hot cues** 1–8: click to set/jump, Shift-click to clear. **Beat loops** 1–16 beats, ÷2 / ×2.
* **Stems**: toggle vocals/drums/bass/melody live on separated tracks — e.g. drop the vocals on deck A while deck B's acapella comes in.
* The library highlights tracks that are **key-compatible (Camelot) and within ~6% BPM** of what's loaded (green bar; *Harmonic* filter).
* **Record** writes the master output to `Music\StemDeck\Recordings` (streamed to disk, so long sets are fine).

Keyboard (DJ): Deck A — **Z** play, **X** cue, **A** sync, **Q W E R** hot cues, **S/D** nudge, **F** 4-beat loop. Deck B — **M** play, **N** cue, **K** sync, **U I O P** hot cues, **J/L** nudge, **H** 4-beat loop. **Shift+←/→** crossfader.

### MIDI controllers
Open **MIDI**, click **Learn** next to a function, then move the knob / press the button. Mappings save automatically; **Save to file** shares them.

### SoundCloud (optional)
SoundCloud requires every app to apply for API access. After approval, create an app at soundcloud.com/you/apps with the redirect URI shown in the SoundCloud tab (`http://127.0.0.1:47821/soundcloud/callback`), then paste the client ID and secret there. StemDeck uses only the official API: likes/playlists as metadata for a buy-list, and uploads of your own remixes (private by default). It never streams, downloads or caches SoundCloud audio.

---

## Architecture

```
┌────────────────────────── Electron ──────────────────────────┐
│  React UI (Vite + TypeScript, zustand)                        │
│   Web Audio graph:                                            │
│    DeckProcessor AudioWorklet ─ stems mixed sample-accurately │
│      → WSOLA key lock / varispeed → EQ → filter → fader       │
│    Remix scheduler (look-ahead) / OfflineAudioContext export  │
│    Recorder worklet → 16-bit PCM chunks → engine → WAV/MP3    │
│  Web MIDI (MIDI learn)                                        │
└──────────────┬────────────────────────────────────────────────┘
               │ HTTP on 127.0.0.1 + per-launch token
┌──────────────▼──────────── Python engine (FastAPI) ───────────┐
│  SQLite library · jobs · projects · samples · wishlist        │
│  Analysis queue (librosa: beat grid, Krumhansl key, energy)   │
│  Separation queue (Demucs in a child process: cancellable,    │
│    low priority, progress callbacks, CPU threads setting)     │
│  Rubber Band R3 stretch/pitch (cached) · ffmpeg decode/encode │
│  SoundCloud OAuth 2.1 PKCE (optional)                         │
└───────────────────────────────────────────────────────────────┘
```

Key decisions:

* **Electron over Tauri.** Tauri uses the system WebView2 (Chromium on Windows, so similar), but Electron guarantees the same Chromium everywhere — Web MIDI, AudioWorklet, AAC/MP3 decoding and `OfflineAudioContext` all behave identically, and bundling a Python sidecar is well-trodden with electron-builder. Tauri would save ~100 MB of an installer that's dominated by PyTorch anyway.
* **Demucs vs. audio-separator.** For four stems, Demucs `htdemucs` / `htdemucs_ft` are still the best open models, and calling Demucs directly gives precise progress and a small dependency tree. `audio-separator` shines for *two*-stem vocal models (MDX / Roformer). Those are an easy future addition for "best possible acapella" (see below).
* **Why a custom AudioWorklet?** Playing four stems as separate media elements drifts out of phase. The worklet mixes all stems from one read position (they can never drift), stores audio as 16-bit to halve RAM (~250 MB for a 6-minute 4-stem track), and implements both DJ-style varispeed and a WSOLA key lock.
* **Stems cached on disk** under `%APPDATA%\StemDeck\stems\<track>_<quality>\` as FLAC (or WAV), so each track is processed once. Stretched remix clips are cached in `%APPDATA%\StemDeck\cache\stretch`.

### Folder structure

```
backend/
  stemdeck_backend/
    app.py          HTTP API
    analysis.py     BPM, beat grid, key, energy
    separation.py   Demucs runner (child process)
    jobs.py         analysis + separation queues
    stretch.py      Rubber Band / phase-vocoder fallback, cache
    exporter.py     stem mix export, remix save, recorder
    audio_io.py     ffmpeg decode/encode, metadata
    db.py, config.py, keys.py, soundcloud.py
  tests/            pytest suite (synthetic audio)
  stemdeck-engine.spec   PyInstaller bundle
app/
  electron/         main process (engine sidecar, dialogs) + preload bridge
  src/
    audio/          AudioContext, deck worklet, Deck class, loaders, drums, WAV
    remix/          project model, scheduler/renderer, timeline, store
    dj/             two-deck engine, crossfader, recording
    midi/           Web MIDI + action registry
    views/          Stem Lab, Remix Studio, DJ, MIDI, SoundCloud, Settings
scripts/            setup / run / build / test (Windows .bat)
```

Your data lives in `%APPDATA%\StemDeck` (library database, stems, cache, samples, settings, `engine.log`). Exports go to `Music\StemDeck` (changeable in Settings). Your original music files are never modified.

---

## Troubleshooting

* **"The audio engine couldn't start"** — the splash shows the error and the log path (`%APPDATA%\StemDeck\engine.log`). Usually the venv is missing: rerun `scripts\setup_windows.bat`. To use a different Python, set `STEMDECK_PYTHON` to its `python.exe`.
* **Separation fails with "exited unexpectedly"** — normally out of memory. Close other apps, lower CPU threads, or use Fast mode for long tracks.
* **Stuttering playback while separating** — lower *CPU threads* in Settings (leave 1–2 cores free), or turn on *Reduce transparency*.
* **Port 47821 in use** — StemDeck picks another port automatically; only the SoundCloud redirect needs the fixed port.
* **F12** opens developer tools if you want to see console errors.

## Future ideas
See [ROADMAP.md](ROADMAP.md).

## Legal
Use StemDeck with music you own or have the rights to use. Rubber Band is GPL; Demucs is MIT; ffmpeg (via imageio-ffmpeg) is LGPL/GPL.
