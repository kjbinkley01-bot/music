"""Exporting stem mixes, saving rendered remixes and streaming DJ recordings to disk."""

from __future__ import annotations

import io
import re
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from .audio_io import decode, transcode_to_mp3, write_audio
from .config import STEM_NAMES, settings
from .stretch import stretch_array

EXPORT_SR = 44100


def safe_name(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip().rstrip(".")
    return name[:150] or "untitled"


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(2, 1000):
        candidate = path.with_name(f"{path.stem} ({i}){path.suffix}")
        if not candidate.exists():
            return candidate
    return path.with_name(f"{path.stem} {int(time.time())}{path.suffix}")


def stem_paths(track: dict) -> dict[str, Path]:
    if not track.get("stem_dir"):
        return {}
    folder = Path(track["stem_dir"])
    out = {}
    for name in STEM_NAMES:
        for ext in (".flac", ".wav"):
            p = folder / f"{name}{ext}"
            if p.exists():
                out[name] = p
                break
    return out


def export_stems(
    track: dict,
    gains: dict[str, float],
    fmt: str = "wav",
    label: str = "Mix",
    tempo_ratio: float = 1.0,
    semitones: float = 0.0,
    start: float | None = None,
    end: float | None = None,
    separate: bool = False,
) -> list[str]:
    """Mix the chosen stems (or the original if not separated) and write them to the output folder."""
    fmt = fmt if fmt in ("wav", "mp3", "flac") else "wav"
    stems = stem_paths(track)
    sources: dict[str, Path] = {n: p for n, p in stems.items() if gains.get(n, 0) > 0}
    if not stems:
        sources = {"original": Path(track["path"])}
        gains = {"original": max((g for g in gains.values()), default=1.0) or 1.0}
    if not sources:
        raise ValueError("Select at least one stem to export")

    base = safe_name(f"{track['artist']} - {track['title']}" if track.get("artist") else track["title"])
    folder = settings.output_dir() / "Exports"
    bitrate = int(settings.get("mp3_bitrate"))

    def load(path: Path) -> np.ndarray:
        audio = decode(path, sr=EXPORT_SR, channels=2)
        s = int(max(0.0, start or 0.0) * EXPORT_SR)
        e = int(end * EXPORT_SR) if end else len(audio)
        return audio[s:e]

    def finish(audio: np.ndarray, name: str) -> str:
        audio = stretch_array(audio, EXPORT_SR, tempo_ratio, semitones)
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        if peak > 0.999:  # summed stems can clip; normalise just under full scale instead
            audio = audio * (0.999 / peak)
        target = unique_path(folder / f"{name}.{fmt}")
        return str(write_audio(target, audio, EXPORT_SR, fmt, bitrate))

    if separate:
        return [finish(load(p) * gains.get(n, 1.0), f"{base} ({n.capitalize()})") for n, p in sources.items()]

    mix: np.ndarray | None = None
    for name, path in sources.items():
        audio = load(path) * float(gains.get(name, 1.0))
        if mix is None:
            mix = audio
        else:
            n = min(len(mix), len(audio))
            mix = mix[:n] + audio[:n]
    return [finish(mix, f"{base} ({safe_name(label)})")]


def save_render(wav_bytes: bytes, name: str, fmt: str, subfolder: str = "Remixes") -> Path:
    """Persist a WAV rendered by the frontend, converting to MP3 if requested."""
    folder = settings.output_dir() / subfolder
    folder.mkdir(parents=True, exist_ok=True)
    wav_target = unique_path(folder / f"{safe_name(name)}.wav")
    audio, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=True)
    sf.write(str(wav_target), audio, sr, subtype="PCM_24")
    if fmt != "mp3":
        return wav_target
    mp3_target = unique_path(wav_target.with_suffix(".mp3"))
    transcode_to_mp3(wav_target, mp3_target, int(settings.get("mp3_bitrate")))
    wav_target.unlink(missing_ok=True)
    return mp3_target


class Recorder:
    """Appends 16-bit PCM chunks from the DJ master output to a WAV file."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._file: sf.SoundFile | None = None
        self._path: Path | None = None
        self._fmt = "wav"

    @property
    def active(self) -> bool:
        return self._file is not None

    def start(self, sr: int, channels: int, fmt: str, name: str) -> Path:
        with self._lock:
            if self._file:
                self._file.close()
            folder = settings.output_dir() / "Recordings"
            folder.mkdir(parents=True, exist_ok=True)
            self._path = unique_path(folder / f"{safe_name(name)}.wav")
            self._file = sf.SoundFile(str(self._path), "w", samplerate=sr, channels=channels, subtype="PCM_16")
            self._fmt = fmt
            return self._path

    def write(self, pcm: bytes) -> None:
        with self._lock:
            if not self._file:
                raise RuntimeError("Not recording")
            data = np.frombuffer(pcm, dtype="<i2").reshape(-1, self._file.channels)
            self._file.write(data)

    def stop(self) -> Path | None:
        with self._lock:
            if not self._file or not self._path:
                return None
            self._file.close()
            self._file = None
            path = self._path
        if self._fmt == "mp3":
            mp3 = unique_path(path.with_suffix(".mp3"))
            transcode_to_mp3(path, mp3, int(settings.get("mp3_bitrate")))
            path.unlink(missing_ok=True)
            return mp3
        return path


recorder = Recorder()
