"""HTTP API used by the Electron frontend. Bound to 127.0.0.1 and protected by a per-launch token."""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from . import __version__
from .audio_io import BROWSER_DECODABLE, decode, read_metadata, write_audio
from .config import AUDIO_EXTENSIONS, CACHE_DIR, SAMPLES_DIR, STEM_NAMES, settings
from .db import db
from .exporter import export_stems, recorder, save_render, stem_paths, unique_path
from .jobs import jobs
from .keys import camelot, key_name
from .soundcloud import SoundCloudError, add_to_wishlist, soundcloud
from .stretch import engine_name, stretched_file

TOKEN = os.environ.get("STEMDECK_TOKEN", "")
OPEN_PATHS = {"/health", "/soundcloud/callback"}

app = FastAPI(title="StemDeck engine", version=__version__)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def require_token(request: Request, call_next):
    if TOKEN and request.method != "OPTIONS" and request.url.path not in OPEN_PATHS:
        supplied = request.headers.get("x-stemdeck-token") or request.query_params.get("token")
        if supplied != TOKEN:
            return JSONResponse({"detail": "Invalid token"}, status_code=401)
    return await call_next(request)


@app.on_event("startup")
def _startup() -> None:
    jobs.start()


@app.on_event("shutdown")
def _shutdown() -> None:
    jobs.stop()
    recorder.stop()


# ---- helpers -------------------------------------------------------------------


def _track_or_404(track_id: int) -> dict:
    track = db.track(track_id)
    if not track:
        raise HTTPException(404, "Track not found")
    return track


def _public_track(t: dict) -> dict:
    t = dict(t)
    t["key_name"] = key_name(t.get("key_pc"), t.get("key_mode"))
    t["camelot"] = camelot(t.get("key_pc"), t.get("key_mode"))
    t["stems"] = list(STEM_NAMES) if t.get("stem_status") == "done" else []
    t["is_remix"] = bool(t.get("is_remix"))
    t.pop("stem_dir", None)
    return t


def _import_file(path: Path, is_remix: bool = False, preset: dict | None = None) -> int | None:
    key = str(path.resolve())
    if db.track_by_path(key):
        return None
    meta = read_metadata(path)
    track_id = db.insert_track(key, meta, is_remix=is_remix)
    if preset:
        db.update_track(track_id, **preset, analysis_status="done")
    else:
        jobs.enqueue(track_id, "analyze")
    if settings.get("auto_separate") and not is_remix:
        jobs.enqueue(track_id, "separate")
    return track_id


# ---- status & settings -------------------------------------------------------


@app.get("/health")
def health() -> dict:
    from .separation import device_info

    return {"ok": True, "version": __version__, "stretch_engine": engine_name(), **device_info()}


@app.get("/status")
def status() -> dict:
    return {"revision": db.revision, "jobs": jobs.snapshot(), "recording": recorder.active}


@app.get("/settings")
def get_settings() -> dict:
    return settings.all()


@app.put("/settings")
def put_settings(values: dict = Body(...)) -> dict:
    return settings.update(values)


# ---- library -------------------------------------------------------------------


class ImportRequest(BaseModel):
    paths: list[str]


@app.get("/tracks")
def list_tracks() -> list[dict]:
    return [_public_track(t) for t in db.tracks()]


@app.get("/tracks/{track_id}")
def get_track(track_id: int) -> dict:
    return _public_track(_track_or_404(track_id))


@app.post("/tracks/import")
def import_tracks(req: ImportRequest) -> dict:
    added, skipped, missing = [], 0, []
    for raw in req.paths:
        p = Path(raw).expanduser()
        if not p.exists():
            missing.append(raw)
            continue
        files = [p] if p.is_file() else sorted(f for f in p.rglob("*") if f.is_file())
        for f in files:
            if f.suffix.lower() not in AUDIO_EXTENSIONS:
                continue
            track_id = _import_file(f)
            if track_id is None:
                skipped += 1
            else:
                added.append(track_id)
    return {"added": added, "skipped": skipped, "missing": missing}


class TrackPatch(BaseModel):
    title: str | None = None
    artist: str | None = None
    bpm: float | None = Field(None, gt=20, lt=400)
    first_beat: float | None = None
    key_pc: int | None = Field(None, ge=0, le=11)
    key_mode: str | None = Field(None, pattern="^(major|minor)$")
    cues: list | None = None
    rating: int | None = Field(None, ge=0, le=5)


@app.patch("/tracks/{track_id}")
def patch_track(track_id: int, patch: TrackPatch) -> dict:
    _track_or_404(track_id)
    db.update_track(track_id, **patch.model_dump(exclude_none=True))
    return _public_track(db.track(track_id))


@app.post("/tracks/{track_id}/played")
def track_played(track_id: int) -> dict:
    db.execute("UPDATE tracks SET play_count = play_count + 1 WHERE id=?", (track_id,))
    return {"ok": True}


@app.delete("/tracks/{track_id}")
def delete_track(track_id: int) -> dict:
    track = _track_or_404(track_id)
    for job in db.query("SELECT id FROM jobs WHERE track_id=? AND status IN ('queued','running')", (track_id,)):
        jobs.cancel(job["id"])
    if track.get("stem_dir"):
        shutil.rmtree(track["stem_dir"], ignore_errors=True)
    db.delete_track(track_id)
    return {"ok": True}


@app.get("/tracks/{track_id}/audio")
def track_audio(track_id: int):
    track = _track_or_404(track_id)
    path = Path(track["path"])
    if not path.exists():
        raise HTTPException(404, "The original file has been moved or deleted")
    if path.suffix.lower() in BROWSER_DECODABLE:
        return FileResponse(path)
    cached = CACHE_DIR / "playback" / f"{track_id}_{path.stat().st_mtime_ns}.flac"
    if not cached.exists():
        write_audio(cached, decode(path, 44100, 2), 44100, "flac")
    return FileResponse(cached)


@app.get("/tracks/{track_id}/stems/{stem}")
def track_stem(track_id: int, stem: str):
    track = _track_or_404(track_id)
    paths = stem_paths(track)
    if stem not in paths:
        raise HTTPException(404, "Stem not available - separate the track first")
    return FileResponse(paths[stem])


@app.get("/tracks/{track_id}/stretched")
def track_stretched(
    track_id: int,
    stem: str = Query("original"),
    ratio: float = Query(1.0, gt=0.25, lt=4.0),
    semitones: float = Query(0.0, ge=-12, le=12),
):
    track = _track_or_404(track_id)
    source = Path(track["path"]) if stem == "original" else stem_paths(track).get(stem)
    if not source or not source.exists():
        raise HTTPException(404, "Source audio not available")
    return FileResponse(stretched_file(source, ratio, semitones))


# ---- jobs --------------------------------------------------------------------


class JobRequest(BaseModel):
    track_ids: list[int]
    quality: str | None = None


@app.post("/jobs/separate")
def queue_separation(req: JobRequest) -> dict:
    quality = req.quality if req.quality in ("fast", "high") else None
    ids = [jobs.enqueue(tid, "separate", quality) for tid in req.track_ids if db.track(tid)]
    return {"jobs": ids}


@app.post("/jobs/analyze")
def queue_analysis(req: JobRequest) -> dict:
    ids = []
    for tid in req.track_ids:
        if db.track(tid):
            db.update_track(tid, analysis_status="pending")
            ids.append(jobs.enqueue(tid, "analyze"))
    return {"jobs": ids}


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: int) -> dict:
    jobs.cancel(job_id)
    return {"ok": True}


@app.post("/jobs/cancel-all")
def cancel_all() -> dict:
    jobs.cancel_all()
    return {"ok": True}


# ---- export --------------------------------------------------------------------


class StemExport(BaseModel):
    track_id: int
    gains: dict[str, float]
    format: str = "wav"
    label: str = "Mix"
    tempo_ratio: float = Field(1.0, gt=0.25, lt=4.0)
    semitones: float = Field(0.0, ge=-12, le=12)
    start: float | None = None
    end: float | None = None
    separate: bool = False


@app.post("/export/stems")
def export_stem_mix(req: StemExport) -> dict:
    track = _track_or_404(req.track_id)
    try:
        files = export_stems(track, req.gains, req.format, req.label, req.tempo_ratio, req.semitones,
                             req.start, req.end, req.separate)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"files": files}


@app.post("/export/render")
async def export_render(
    request: Request,
    name: str = Query(...),
    format: str = Query("wav"),
    add_to_library: bool = Query(True),
    bpm: float | None = Query(None),
    key_pc: int | None = Query(None),
    key_mode: str | None = Query(None),
) -> dict:
    body = await request.body()
    if len(body) < 44:
        raise HTTPException(400, "Empty render")
    path = save_render(body, name, "mp3" if format == "mp3" else "wav")
    track_id = None
    if add_to_library:
        preset = None
        if bpm:
            preset = {"bpm": round(bpm, 2), "first_beat": 0.0, "key_pc": key_pc,
                      "key_mode": key_mode if key_mode in ("major", "minor") else None}
        track_id = _import_file(path, is_remix=True, preset=preset)
    return {"file": str(path), "track_id": track_id}


class RecordingStart(BaseModel):
    sample_rate: int = Field(..., ge=8000, le=192000)
    channels: int = Field(2, ge=1, le=2)
    format: str = "wav"
    name: str = ""


@app.post("/recording/start")
def recording_start(req: RecordingStart) -> dict:
    name = req.name or time.strftime("DJ Set %Y-%m-%d %H-%M")
    path = recorder.start(req.sample_rate, req.channels, req.format, name)
    return {"file": str(path)}


@app.post("/recording/chunk")
async def recording_chunk(request: Request) -> dict:
    try:
        recorder.write(await request.body())
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"ok": True}


@app.post("/recording/stop")
def recording_stop() -> dict:
    path = recorder.stop()
    return {"file": str(path) if path else None}


# ---- projects ------------------------------------------------------------------


class ProjectBody(BaseModel):
    name: str
    data: dict


@app.get("/projects")
def list_projects() -> list[dict]:
    return db.query("SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC")


@app.get("/projects/{project_id}")
def get_project(project_id: int) -> dict:
    row = db.one("SELECT * FROM projects WHERE id=?", (project_id,))
    if not row:
        raise HTTPException(404, "Project not found")
    row["data"] = json.loads(row["data"])
    return row


@app.post("/projects")
def create_project(body: ProjectBody) -> dict:
    now = time.time()
    cur = db.execute("INSERT INTO projects (name, data, created_at, updated_at) VALUES (?,?,?,?)",
                     (body.name, json.dumps(body.data), now, now))
    return {"id": cur.lastrowid}


@app.put("/projects/{project_id}")
def update_project(project_id: int, body: ProjectBody) -> dict:
    cur = db.execute("UPDATE projects SET name=?, data=?, updated_at=? WHERE id=?",
                     (body.name, json.dumps(body.data), time.time(), project_id))
    if cur.rowcount == 0:
        raise HTTPException(404, "Project not found")
    return {"id": project_id}


@app.delete("/projects/{project_id}")
def delete_project(project_id: int) -> dict:
    db.execute("DELETE FROM projects WHERE id=?", (project_id,))
    return {"ok": True}


# ---- samples (drum pads) -------------------------------------------------------


@app.get("/samples")
def list_samples() -> list[dict]:
    return db.query("SELECT id, name FROM samples ORDER BY name COLLATE NOCASE")


@app.post("/samples/import")
def import_samples(req: ImportRequest) -> dict:
    added = []
    for raw in req.paths:
        p = Path(raw)
        files = [p] if p.is_file() else sorted(p.rglob("*")) if p.is_dir() else []
        for f in files:
            if f.is_file() and f.suffix.lower() in AUDIO_EXTENSIONS:
                target = unique_path(SAMPLES_DIR / f.name)
                shutil.copy2(f, target)
                cur = db.execute("INSERT INTO samples (name, path, created_at) VALUES (?,?,?)",
                                 (f.stem, str(target), time.time()))
                added.append({"id": cur.lastrowid, "name": f.stem})
    return {"added": added}


@app.get("/samples/{sample_id}/audio")
def sample_audio(sample_id: int):
    row = db.one("SELECT * FROM samples WHERE id=?", (sample_id,))
    if not row or not Path(row["path"]).exists():
        raise HTTPException(404, "Sample not found")
    path = Path(row["path"])
    if path.suffix.lower() in BROWSER_DECODABLE:
        return FileResponse(path)
    cached = CACHE_DIR / "playback" / f"sample_{sample_id}.wav"
    if not cached.exists():
        write_audio(cached, decode(path, 44100, 2), 44100, "wav")
    return FileResponse(cached)


@app.delete("/samples/{sample_id}")
def delete_sample(sample_id: int) -> dict:
    row = db.one("SELECT * FROM samples WHERE id=?", (sample_id,))
    if row:
        Path(row["path"]).unlink(missing_ok=True)
        db.execute("DELETE FROM samples WHERE id=?", (sample_id,))
    return {"ok": True}


# ---- SoundCloud (optional) -----------------------------------------------------


def _sc(fn, *args):
    try:
        return fn(*args)
    except SoundCloudError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/soundcloud/status")
def sc_status() -> dict:
    return soundcloud.status()


@app.get("/soundcloud/authorize")
def sc_authorize() -> dict:
    return {"url": _sc(soundcloud.authorize_url)}


@app.get("/soundcloud/callback", response_class=HTMLResponse)
def sc_callback(code: str = "", state: str = "", error: str = "") -> str:
    style = "font-family:sans-serif;background:#07080d;color:#e8ecff;padding:48px;text-align:center"
    if error or not code:
        return f"<body style='{style}'><h2>SoundCloud sign-in was cancelled</h2><p>{error}</p></body>"
    try:
        soundcloud.complete(code, state)
    except Exception as exc:  # noqa: BLE001
        return f"<body style='{style}'><h2>Sign-in failed</h2><p>{exc}</p></body>"
    return f"<body style='{style}'><h2>Connected to SoundCloud</h2><p>You can close this window.</p></body>"


@app.post("/soundcloud/disconnect")
def sc_disconnect() -> dict:
    soundcloud.disconnect()
    return {"ok": True}


@app.get("/soundcloud/likes")
def sc_likes() -> list[dict]:
    return _sc(soundcloud.likes)


@app.get("/soundcloud/playlists")
def sc_playlists() -> list[dict]:
    return _sc(soundcloud.playlists)


class WishlistAdd(BaseModel):
    items: list[dict]
    source: str = ""


@app.post("/wishlist")
def wishlist_add(req: WishlistAdd) -> dict:
    return {"added": add_to_wishlist(req.items, req.source)}


@app.get("/wishlist")
def wishlist() -> list[dict]:
    return db.query("SELECT * FROM wishlist ORDER BY added_at DESC")


@app.delete("/wishlist/{item_id}")
def wishlist_delete(item_id: int) -> dict:
    db.execute("DELETE FROM wishlist WHERE id=?", (item_id,))
    return {"ok": True}


class UploadRequest(BaseModel):
    path: str
    title: str
    sharing: str = Field("private", pattern="^(private|public)$")
    description: str = ""


@app.post("/soundcloud/upload")
def sc_upload(req: UploadRequest) -> dict:
    path = Path(req.path)
    if not path.is_file():
        raise HTTPException(404, "File not found")
    return _sc(soundcloud.upload, path, req.title, req.sharing, req.description)
