"""Background queues: one for analysis (quick) and one for stem separation (slow).

They run independently so a freshly imported track gets its BPM and key within seconds
even while a long separation is running.
"""

from __future__ import annotations

import logging
import multiprocessing as mp
import shutil
import threading
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from . import analysis
from .config import STEMS_DIR, settings
from .db import db
from .separation import SeparationProcess, SeparationRequest

log = logging.getLogger("stemdeck.jobs")


class JobManager:
    def __init__(self) -> None:
        self._wake = {"analyze": threading.Event(), "separate": threading.Event()}
        self._cancel: set[int] = set()
        self._live: dict[int, dict] = {}  # job id -> {"progress", "message"} for cheap polling
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._pool: ProcessPoolExecutor | None = None

    # ---- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        if self._threads:
            return
        for kind, target in (("analyze", self._analysis_loop), ("separate", self._separation_loop)):
            t = threading.Thread(target=target, name=f"stemdeck-{kind}", daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        self._stop.set()
        for event in self._wake.values():
            event.set()
        self._cancel.update(self._live.keys())
        if self._pool:
            self._pool.shutdown(wait=False, cancel_futures=True)

    # ---- public API -----------------------------------------------------------

    def enqueue(self, track_id: int, kind: str, quality: str | None = None) -> int:
        if kind == "separate":
            quality = quality or settings.get("quality")
            db.update_track(track_id, stem_status="queued", error=None)
        job_id = db.add_job(track_id, kind, quality)
        self._wake[kind].set()
        return job_id

    def cancel(self, job_id: int) -> None:
        job = db.one("SELECT * FROM jobs WHERE id=?", (job_id,))
        if not job:
            return
        if job["status"] == "queued":
            db.update_job(job_id, status="canceled", finished_at=time.time())
            if job["kind"] == "separate":
                self._reset_stem_status(job["track_id"])
        elif job["status"] == "running":
            self._cancel.add(job_id)

    def cancel_all(self) -> None:
        for job in db.query("SELECT id FROM jobs WHERE status IN ('queued','running')"):
            self.cancel(job["id"])

    def snapshot(self) -> list[dict]:
        jobs = db.active_jobs()
        for job in jobs:
            live = self._live.get(job["id"])
            if live:
                job.update(live)
        return jobs

    # ---- workers --------------------------------------------------------------

    def _reset_stem_status(self, track_id: int) -> None:
        track = db.track(track_id)
        if track:
            done = bool(track["stem_dir"]) and Path(track["stem_dir"]).exists()
            db.update_track(track_id, stem_status="done" if done else "none")

    def _next(self, kind: str) -> dict | None:
        while not self._stop.is_set():
            job = db.next_job(kind)
            if job:
                return job
            self._wake[kind].wait(timeout=2.0)
            self._wake[kind].clear()
        return None

    def _analysis_loop(self) -> None:
        while (job := self._next("analyze")) is not None:
            track = db.track(job["track_id"])
            if not track:
                db.update_job(job["id"], status="error", message="Track missing", finished_at=time.time())
                continue
            db.update_job(job["id"], status="running", started_at=time.time(), message="Analysing")
            try:
                if self._pool is None:
                    self._pool = ProcessPoolExecutor(max_workers=1, mp_context=mp.get_context("spawn"))
                result = self._pool.submit(analysis.analyze, track["path"]).result()
                duration = result.pop("duration")
                fields = {**result, "analysis_status": "done", "error": None}
                if not track["duration"]:
                    fields["duration"] = duration
                db.update_track(track["id"], **fields)
                db.update_job(job["id"], status="done", progress=1.0, message="", finished_at=time.time())
            except Exception as exc:  # noqa: BLE001
                log.exception("Analysis failed for %s", track["path"])
                if self._pool is not None and getattr(self._pool, "_broken", False):
                    self._pool = None
                db.update_track(track["id"], analysis_status="error", error=str(exc))
                db.update_job(job["id"], status="error", message=str(exc), finished_at=time.time())

    def _separation_loop(self) -> None:
        while (job := self._next("separate")) is not None:
            job_id = job["id"]
            track = db.track(job["track_id"])
            if not track:
                db.update_job(job_id, status="error", message="Track missing", finished_at=time.time())
                continue
            quality = job["quality"] or settings.get("quality")
            out_dir = STEMS_DIR / f"{track['id']}_{quality}"
            tmp_dir = out_dir.with_name(out_dir.name + ".partial")
            shutil.rmtree(tmp_dir, ignore_errors=True)
            db.update_job(job_id, status="running", started_at=time.time(), message="Starting")
            db.update_track(track["id"], stem_status="processing")
            self._live[job_id] = {"progress": 0.0, "message": "Starting"}
            last_write = [0.0]

            def on_progress(p: float, msg: str) -> None:
                self._live[job_id] = {"progress": round(p, 4), "message": msg}
                if time.time() - last_write[0] > 2:
                    last_write[0] = time.time()
                    db.update_job(job_id, progress=p, message=msg)

            req = SeparationRequest(
                source=track["path"],
                out_dir=str(tmp_dir),
                quality=quality,
                threads=int(settings.get("threads")),
                use_gpu=bool(settings.get("use_gpu")),
                stem_format=settings.get("stem_format"),
            )
            try:
                SeparationProcess(req).run(on_progress, lambda: job_id in self._cancel or self._stop.is_set())
                shutil.rmtree(out_dir, ignore_errors=True)
                tmp_dir.rename(out_dir)
                old_dir = track["stem_dir"]
                if old_dir and Path(old_dir) != out_dir:
                    shutil.rmtree(old_dir, ignore_errors=True)
                db.update_track(track["id"], stem_status="done", stem_dir=str(out_dir),
                                stem_quality=quality, error=None)
                db.update_job(job_id, status="done", progress=1.0, message="Done", finished_at=time.time())
            except InterruptedError:
                shutil.rmtree(tmp_dir, ignore_errors=True)
                if self._stop.is_set():
                    return  # shutting down: leave the job queued for next launch
                db.update_job(job_id, status="canceled", message="Cancelled", finished_at=time.time())
                self._reset_stem_status(track["id"])
            except Exception as exc:  # noqa: BLE001
                log.exception("Separation failed for %s", track["path"])
                shutil.rmtree(tmp_dir, ignore_errors=True)
                db.update_track(track["id"], stem_status="error", error=str(exc))
                db.update_job(job_id, status="error", message=str(exc), finished_at=time.time())
            finally:
                self._live.pop(job_id, None)
                self._cancel.discard(job_id)


jobs = JobManager()
