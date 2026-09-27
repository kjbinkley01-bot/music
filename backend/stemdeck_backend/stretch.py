"""High quality time stretching and pitch shifting.

Uses the Rubber Band command line tool (R3 "fine" engine) when available, otherwise falls back
to librosa's phase vocoder, which is noticeably lower quality on drums but always works.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sys
import tempfile
import threading
from functools import lru_cache
from pathlib import Path

import numpy as np
import soundfile as sf

from .audio_io import run
from .config import CACHE_DIR


@lru_cache(maxsize=1)
def rubberband_exe() -> str | None:
    names = ["rubberband.exe", "rubberband-r3.exe"] if sys.platform == "win32" else ["rubberband", "rubberband-r3"]
    here = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    candidates = [os.environ.get("STEMDECK_RUBBERBAND", "")]
    for base in (here / "bin", here.parent / "bin", Path(sys.executable).parent / "bin"):
        candidates += [str(base / n) for n in names]
    for c in candidates:
        if c and Path(c).is_file():
            return c
    for n in names:
        found = shutil.which(n)
        if found:
            return found
    return None


def engine_name() -> str:
    return "Rubber Band (high quality)" if rubberband_exe() else "Phase vocoder (install Rubber Band for HQ)"


def stretch_array(audio: np.ndarray, sr: int, tempo_ratio: float = 1.0, semitones: float = 0.0) -> np.ndarray:
    """tempo_ratio > 1 speeds up. audio is (frames, channels) float32."""
    if abs(tempo_ratio - 1.0) < 1e-4 and abs(semitones) < 1e-4:
        return audio
    exe = rubberband_exe()
    if exe:
        with tempfile.TemporaryDirectory(prefix="stemdeck_rb_") as tmp:
            src, dst = Path(tmp) / "in.wav", Path(tmp) / "out.wav"
            sf.write(str(src), audio, sr, subtype="FLOAT")
            run([exe, "-3", "-q", "-T", f"{tempo_ratio:.6f}", "-p", f"{semitones:.4f}", str(src), str(dst)])
            out, _ = sf.read(str(dst), dtype="float32", always_2d=True)
            return out
    import librosa

    channels = []
    for ch in audio.T:
        y = ch
        if abs(tempo_ratio - 1.0) >= 1e-4:
            y = librosa.effects.time_stretch(y, rate=tempo_ratio)
        if abs(semitones) >= 1e-4:
            y = librosa.effects.pitch_shift(y, sr=sr, n_steps=semitones)
        channels.append(y)
    n = min(len(c) for c in channels)
    return np.stack([c[:n] for c in channels], axis=1).astype(np.float32)


_pool = None
_pool_lock = threading.Lock()


def _render(source: str, out: str, tempo_ratio: float, semitones: float) -> None:
    from .audio_io import decode

    audio = decode(source, sr=44100, channels=2)
    result = stretch_array(audio, 44100, tempo_ratio, semitones)
    tmp = Path(out).with_suffix(".tmp.flac")
    sf.write(str(tmp), np.clip(result, -1, 1), 44100, subtype="PCM_16", format="FLAC")
    tmp.replace(out)


def _executor():
    """Two worker processes (so a few clips stretch in parallel), recycled every 16 renders so
    librosa/numpy memory is returned to the system. Keeps heavy DSP out of the API process."""
    global _pool
    with _pool_lock:
        if _pool is None:
            import multiprocessing as mp
            from concurrent.futures import ProcessPoolExecutor

            from .procutil import exit_with_parent

            extra = {"max_tasks_per_child": 16} if sys.version_info >= (3, 11) else {}
            _pool = ProcessPoolExecutor(max_workers=2, mp_context=mp.get_context("spawn"), initializer=exit_with_parent, **extra)
        return _pool


def shutdown() -> None:
    global _pool
    with _pool_lock:
        if _pool is not None:
            for proc in list((getattr(_pool, "_processes", None) or {}).values()):
                proc.terminate()
            _pool.shutdown(wait=False, cancel_futures=True)
            _pool = None


def stretched_file(source: Path, tempo_ratio: float, semitones: float) -> Path:
    """Stretch a file once and cache the result (keyed by path, mtime and parameters)."""
    tempo_ratio = round(float(tempo_ratio), 5)
    semitones = round(float(semitones), 3)
    stat = source.stat()
    key = hashlib.sha1(
        f"{source}|{stat.st_mtime_ns}|{tempo_ratio}|{semitones}|{bool(rubberband_exe())}".encode()
    ).hexdigest()[:20]
    out = CACHE_DIR / "stretch" / f"{key}.flac"
    if out.exists():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    _executor().submit(_render, str(source), str(out), tempo_ratio, semitones).result()
    return out
