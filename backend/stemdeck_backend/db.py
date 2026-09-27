"""SQLite storage for the library, jobs, projects, samples and the SoundCloud wishlist."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    genre TEXT NOT NULL DEFAULT '',
    duration REAL NOT NULL DEFAULT 0,
    bpm REAL,
    first_beat REAL NOT NULL DEFAULT 0,
    key_pc INTEGER,
    key_mode TEXT,
    key_confidence REAL,
    energy REAL,
    loudness REAL,
    analysis_status TEXT NOT NULL DEFAULT 'pending',
    stem_status TEXT NOT NULL DEFAULT 'none',
    stem_quality TEXT,
    stem_dir TEXT,
    is_remix INTEGER NOT NULL DEFAULT 0,
    cues TEXT NOT NULL DEFAULT '[]',
    rating INTEGER NOT NULL DEFAULT 0,
    play_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    added_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    quality TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    progress REAL NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    started_at REAL,
    finished_at REAL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS wishlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sc_id INTEGER UNIQUE,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    permalink_url TEXT,
    purchase_url TEXT,
    artwork_url TEXT,
    bpm REAL,
    source TEXT NOT NULL DEFAULT '',
    added_at REAL NOT NULL
);
"""

TRACK_JSON_FIELDS = ("cues",)


class Database:
    def __init__(self, path: Path = DB_PATH):
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.executescript(SCHEMA)
            self._migrate()
            # Jobs interrupted by a crash or shutdown go back to the queue.
            self._conn.execute("UPDATE jobs SET status='queued', progress=0 WHERE status='running'")
            self._conn.execute(
                "UPDATE tracks SET stem_status='queued' WHERE stem_status='processing'"
            )
        self.revision = 0

    def _migrate(self) -> None:
        """Add columns introduced after the first release to existing libraries."""
        have = {r[1] for r in self._conn.execute("PRAGMA table_info(tracks)").fetchall()}
        for column, decl in (("loudness", "REAL"),):
            if column not in have:
                self._conn.execute(f"ALTER TABLE tracks ADD COLUMN {column} {decl}")

    def bump(self) -> None:
        self.revision += 1

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, tuple(params))

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, tuple(params)).fetchall()]

    def one(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        with self._lock:
            row = self._conn.execute(sql, tuple(params)).fetchone()
            return dict(row) if row else None

    # ---- tracks -------------------------------------------------------------

    @staticmethod
    def _decode_track(row: dict | None) -> dict | None:
        if row is None:
            return None
        for field in TRACK_JSON_FIELDS:
            try:
                row[field] = json.loads(row[field] or "[]")
            except ValueError:
                row[field] = []
        return row

    def tracks(self) -> list[dict]:
        return [self._decode_track(r) for r in self.query("SELECT * FROM tracks ORDER BY added_at DESC, id DESC")]

    def track(self, track_id: int) -> dict | None:
        return self._decode_track(self.one("SELECT * FROM tracks WHERE id=?", (track_id,)))

    def track_by_path(self, path: str) -> dict | None:
        return self._decode_track(self.one("SELECT * FROM tracks WHERE path=?", (path,)))

    def insert_track(self, path: str, meta: dict, is_remix: bool = False) -> int:
        cur = self.execute(
            "INSERT INTO tracks (path, title, artist, album, genre, duration, is_remix, added_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (
                path,
                meta.get("title", ""),
                meta.get("artist", ""),
                meta.get("album", ""),
                meta.get("genre", ""),
                meta.get("duration", 0.0),
                1 if is_remix else 0,
                time.time(),
            ),
        )
        self.bump()
        return int(cur.lastrowid)

    def update_track(self, track_id: int, **fields: Any) -> None:
        if not fields:
            return
        for field in TRACK_JSON_FIELDS:
            if field in fields and not isinstance(fields[field], str):
                fields[field] = json.dumps(fields[field])
        cols = ", ".join(f"{k}=?" for k in fields)
        self.execute(f"UPDATE tracks SET {cols} WHERE id=?", (*fields.values(), track_id))
        self.bump()

    def delete_track(self, track_id: int) -> None:
        self.execute("DELETE FROM tracks WHERE id=?", (track_id,))
        self.bump()

    # ---- jobs ---------------------------------------------------------------

    def add_job(self, track_id: int, kind: str, quality: str | None = None) -> int:
        existing = self.one(
            "SELECT id FROM jobs WHERE track_id=? AND kind=? AND status IN ('queued','running')",
            (track_id, kind),
        )
        if existing:
            return int(existing["id"])
        cur = self.execute(
            "INSERT INTO jobs (track_id, kind, quality, created_at) VALUES (?,?,?,?)",
            (track_id, kind, quality, time.time()),
        )
        self.bump()
        return int(cur.lastrowid)

    def next_job(self, kind: str) -> dict | None:
        return self.one(
            "SELECT * FROM jobs WHERE status='queued' AND kind=? ORDER BY id LIMIT 1", (kind,)
        )

    def update_job(self, job_id: int, **fields: Any) -> None:
        cols = ", ".join(f"{k}=?" for k in fields)
        self.execute(f"UPDATE jobs SET {cols} WHERE id=?", (*fields.values(), job_id))

    def active_jobs(self) -> list[dict]:
        return self.query(
            "SELECT j.*, t.title, t.artist FROM jobs j JOIN tracks t ON t.id=j.track_id"
            " WHERE j.status IN ('queued','running')"
            " OR (j.finished_at IS NOT NULL AND j.finished_at > ?)"
            " ORDER BY j.id",
            (time.time() - 30,),
        )


db = Database()
