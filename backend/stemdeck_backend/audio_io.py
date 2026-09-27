"""Decoding, encoding and metadata. ffmpeg (bundled by imageio-ffmpeg) handles every format."""

from __future__ import annotations

import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np
import soundfile as sf

# Hide the console window that would otherwise flash up for every ffmpeg call on Windows.
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

# Formats Chromium's decodeAudioData can read directly; everything else is transcoded for playback.
BROWSER_DECODABLE = {".mp3", ".wav", ".flac", ".ogg", ".opus", ".m4a", ".aac"}


@lru_cache(maxsize=1)
def ffmpeg_exe() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # pragma: no cover - depends on install
        raise RuntimeError("ffmpeg not found. Run: pip install imageio-ffmpeg") from exc


def run(cmd: list[str], input_bytes: bytes | None = None) -> bytes:
    proc = subprocess.run(
        cmd,
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=_NO_WINDOW,
        check=False,
    )
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise RuntimeError(f"{Path(cmd[0]).name} failed: {' | '.join(tail)}")
    return proc.stdout


def decode(path: str | Path, sr: int = 44100, channels: int = 2) -> np.ndarray:
    """Decode any audio file to float32 of shape (frames, channels)."""
    path = Path(path)
    if path.suffix.lower() in (".wav", ".flac", ".aif", ".aiff"):
        try:
            data, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
            if file_sr == sr:
                return _fit_channels(data, channels)
        except RuntimeError:
            pass
    raw = run(
        [ffmpeg_exe(), "-v", "error", "-nostdin", "-i", str(path), "-vn",
         "-f", "f32le", "-acodec", "pcm_f32le", "-ac", str(channels), "-ar", str(sr), "-"]
    )
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).copy()


def _fit_channels(data: np.ndarray, channels: int) -> np.ndarray:
    if data.shape[1] == channels:
        return data
    if channels == 1:
        return data.mean(axis=1, keepdims=True)
    if data.shape[1] == 1:
        return np.repeat(data, channels, axis=1)
    return data[:, :channels]


def write_audio(path: str | Path, audio: np.ndarray, sr: int, fmt: str = "wav", bitrate: int = 320) -> Path:
    """Write float audio (frames, channels) as wav, flac or mp3. Clips gently to avoid wrap-around."""
    path = Path(path)
    if path.suffix.lower() != "." + fmt:
        path = path.with_name(path.name + "." + fmt)
    path.parent.mkdir(parents=True, exist_ok=True)
    audio = np.clip(np.nan_to_num(audio), -1.0, 1.0).astype(np.float32)
    if fmt == "mp3":
        run(
            [ffmpeg_exe(), "-v", "error", "-nostdin", "-y",
             "-f", "f32le", "-ar", str(sr), "-ac", str(audio.shape[1]), "-i", "-",
             "-codec:a", "libmp3lame", "-b:a", f"{int(bitrate)}k", str(path)],
            input_bytes=audio.tobytes(),
        )
    else:
        subtype = "PCM_24" if fmt == "wav" else "PCM_16"
        sf.write(str(path), audio, sr, subtype=subtype, format=fmt.upper())
    return path


def transcode_to_mp3(src: Path, dst: Path, bitrate: int = 320) -> Path:
    run([ffmpeg_exe(), "-v", "error", "-nostdin", "-y", "-i", str(src),
         "-codec:a", "libmp3lame", "-b:a", f"{int(bitrate)}k", str(dst)])
    return dst


def read_metadata(path: str | Path) -> dict:
    """Title/artist/album/duration using mutagen, falling back to the file name."""
    path = Path(path)
    meta = {"title": path.stem, "artist": "", "album": "", "genre": "", "duration": 0.0}
    stem = path.stem
    if " - " in stem:
        artist, title = stem.split(" - ", 1)
        meta.update(artist=artist.strip(), title=title.strip())
    try:
        import mutagen

        f = mutagen.File(str(path), easy=True)
        if f is not None:
            if f.info is not None and getattr(f.info, "length", None):
                meta["duration"] = float(f.info.length)
            tags = f.tags or {}
            for key in ("title", "artist", "album", "genre"):
                value = tags.get(key) if hasattr(tags, "get") else None
                if value:
                    meta[key] = str(value[0] if isinstance(value, list) else value).strip()
    except Exception:
        pass
    if not meta["duration"]:
        try:
            meta["duration"] = float(sf.info(str(path)).duration)
        except Exception:
            pass
    return meta
