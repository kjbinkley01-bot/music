import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

# Isolate all app data in a temp folder before the package is imported.
_DATA = tempfile.mkdtemp(prefix="stemdeck_test_")
os.environ["STEMDECK_DATA"] = _DATA
os.environ.pop("STEMDECK_TOKEN", None)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def make_click_track(path: Path, bpm: float = 124.0, seconds: float = 16.0, sr: int = 44100, offset: float = 0.25) -> Path:
    """Kick drum on every beat over an A minor pad: easy ground truth for BPM/key tests."""
    t = np.arange(int(sr * seconds)) / sr
    y = np.zeros_like(t)
    beat = 60.0 / bpm
    n = int(0.15 * sr)
    tt = np.arange(n) / sr
    kick = np.sin(2 * np.pi * (50 + 100 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 20)
    k = 0
    while True:
        s = int((offset + k * beat) * sr)
        if s + n > len(y):
            break
        y[s : s + n] += kick
        k += 1
    for f in (220.0, 261.63, 329.63):
        y += 0.08 * np.sin(2 * np.pi * f * t)
    sf.write(str(path), np.stack([y, y], axis=1) * 0.5, sr)
    return path


@pytest.fixture(scope="session")
def data_dir() -> Path:
    return Path(_DATA)


@pytest.fixture(scope="session")
def click_track(tmp_path_factory) -> Path:
    return make_click_track(tmp_path_factory.mktemp("audio") / "Test Artist - Click Track.wav")
