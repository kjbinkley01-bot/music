"""Filesystem locations and user settings."""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path


def _default_data_dir() -> Path:
    if os.environ.get("STEMDECK_DATA"):
        return Path(os.environ["STEMDECK_DATA"])
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "StemDeck"


DATA_DIR = _default_data_dir()
STEMS_DIR = DATA_DIR / "stems"
CACHE_DIR = DATA_DIR / "cache"
SAMPLES_DIR = DATA_DIR / "samples"
MODELS_DIR = DATA_DIR / "models"
DB_PATH = DATA_DIR / "library.db"
SETTINGS_PATH = DATA_DIR / "settings.json"

for _d in (DATA_DIR, STEMS_DIR, CACHE_DIR, SAMPLES_DIR, MODELS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# Demucs downloads its weights through torch.hub; keep them inside our data folder.
os.environ.setdefault("TORCH_HOME", str(MODELS_DIR))

AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".aif", ".aiff", ".m4a", ".aac", ".ogg", ".opus", ".wma"}
STEM_NAMES = ("vocals", "drums", "bass", "other")

DEFAULT_SETTINGS: dict = {
    "output_dir": str(Path.home() / "Music" / "StemDeck"),
    "quality": "fast",  # fast | high
    "threads": max(1, (os.cpu_count() or 2) - 1),
    "use_gpu": True,
    "stem_format": "flac",  # flac | wav
    "mp3_bitrate": 320,
    "auto_separate": False,
    "reduce_transparency": False,
    "soundcloud_client_id": "",
    "soundcloud_client_secret": "",
    "midi_mappings": [],
}


class Settings:
    """Thread-safe JSON settings file with defaults for missing keys."""

    def __init__(self, path: Path = SETTINGS_PATH):
        self._path = path
        self._lock = threading.Lock()
        self._data = dict(DEFAULT_SETTINGS)
        if path.exists():
            try:
                self._data.update(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                pass

    def get(self, key: str):
        with self._lock:
            return self._data.get(key, DEFAULT_SETTINGS.get(key))

    def all(self) -> dict:
        with self._lock:
            return dict(self._data)

    def update(self, values: dict) -> dict:
        with self._lock:
            for key, value in values.items():
                if key in DEFAULT_SETTINGS:
                    self._data[key] = value
            self._data["threads"] = max(1, min(int(self._data["threads"]), os.cpu_count() or 1))
            if self._data["quality"] not in ("fast", "high"):
                self._data["quality"] = "fast"
            if self._data["stem_format"] not in ("flac", "wav"):
                self._data["stem_format"] = "flac"
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._data, indent=2), encoding="utf-8")
            tmp.replace(self._path)
            return dict(self._data)

    def output_dir(self) -> Path:
        path = Path(self.get("output_dir")).expanduser()
        path.mkdir(parents=True, exist_ok=True)
        return path


settings = Settings()
