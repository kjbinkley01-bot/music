"""Stem separation with Demucs, run in a child process so it can be cancelled and never blocks the API.

Fast mode:  htdemucs, no random shifts, small overlap  (~1-3x track length on a 4-core CPU)
High mode:  htdemucs_ft (four fine-tuned models), 1 shift, 25% overlap  (~4-8x slower than fast)
"""

from __future__ import annotations

import multiprocessing as mp
import os
import queue as queue_mod
import threading
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .config import STEM_NAMES

CHUNK_SECONDS = 8 * 60
OVERLAP_SECONDS = 4

QUALITY_PRESETS = {
    "fast": {"model": "htdemucs", "shifts": 0, "overlap": 0.1},
    "high": {"model": "htdemucs_ft", "shifts": 1, "overlap": 0.25},
}


@dataclass
class SeparationRequest:
    source: str
    out_dir: str
    quality: str = "fast"
    threads: int = 2
    use_gpu: bool = True
    stem_format: str = "flac"


def pick_device(use_gpu: bool) -> str:
    import torch

    if use_gpu and torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _probe_device(q: mp.Queue) -> None:
    try:
        import torch
    except ImportError:
        q.put({"torch": False, "cuda": False, "device": "unavailable"})
        return
    cuda = bool(torch.cuda.is_available())
    q.put({"torch": True, "cuda": cuda, "device": torch.cuda.get_device_name(0) if cuda else "CPU"})


_device: dict | None = None
_device_lock = threading.Lock()


def device_info() -> dict:
    """CPU/GPU capabilities, probed once in a throwaway process.

    Importing torch costs ~200 MB and a second or more; doing it in a child keeps the API
    process small (the separation child imports torch itself when it runs).
    """
    global _device
    with _device_lock:
        if _device is None:
            ctx = mp.get_context("spawn")
            q: mp.Queue = ctx.Queue()
            proc = ctx.Process(target=_probe_device, args=(q,), daemon=True)
            proc.start()
            try:
                _device = q.get(timeout=120)
            except queue_mod.Empty:
                _device = {"torch": False, "cuda": False, "device": "unavailable"}
            proc.join(timeout=5)
        return dict(_device)


def run_separation(req: SeparationRequest, report: Callable[[float, str], None]) -> dict[str, str]:
    """Separate one file into vocals/drums/bass/other. Blocking; call from a worker process."""
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    import numpy as np
    import soundfile as sf

    from .audio_io import decode

    torch.set_num_threads(max(1, int(req.threads)))
    preset = QUALITY_PRESETS.get(req.quality, QUALITY_PRESETS["fast"])
    device = pick_device(req.use_gpu)

    report(0.01, f"Loading model {preset['model']} (first run downloads it)")
    model = get_model(preset["model"])
    model.eval()
    sr = model.samplerate

    report(0.03, "Decoding audio")
    audio = decode(req.source, sr=sr, channels=model.audio_channels)
    length = audio.shape[0]
    ref = audio.mean(axis=1)
    mean, std = float(ref.mean()), float(ref.std()) + 1e-8

    # Long files (DJ mixes) are processed in chunks with a crossfaded overlap so memory stays
    # bounded: Demucs otherwise holds four full-length output stems in RAM (~10 GB for an hour).
    chunk = CHUNK_SECONDS * sr
    overlap = OVERLAP_SECONDS * sr
    starts = list(range(0, max(1, length - overlap), chunk - overlap)) if length > chunk else [0]
    n_models = len(getattr(model, "models", [model]))
    passes = n_models * max(1, preset["shifts"])
    seg_len = int(sr * float(getattr(model, "segment", 7.8) or 7.8))
    best = [0.0]

    out_dir = Path(req.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    subtype = "PCM_24" if req.stem_format == "wav" else "PCM_16"
    writers = {
        name: sf.SoundFile(str(out_dir / f"{name}.{req.stem_format}"), "w", samplerate=sr,
                           channels=model.audio_channels, subtype=subtype, format=req.stem_format.upper())
        for name in model.sources if name in STEM_NAMES
    }
    tails: dict[str, np.ndarray] = {}
    fade_in = np.linspace(0.0, 1.0, overlap, dtype=np.float32)[:, None]

    try:
        for ci, start in enumerate(starts):
            end = min(length, start + chunk)
            piece = torch.from_numpy(((audio[start:end] - mean) / std).T.copy())
            piece_len = end - start

            def on_chunk(info: dict, ci: int = ci, piece_len: int = piece_len) -> None:
                if info.get("state") != "end":
                    return
                frac = min(1.0, (info.get("segment_offset", 0) + seg_len) / piece_len)
                inner = (info.get("model_idx_in_bag", 0) * max(1, preset["shifts"]) + info.get("shift_idx", 0) + frac) / passes
                done = (ci + inner) / len(starts)
                if done > best[0]:
                    best[0] = done
                    report(0.05 + 0.9 * done, f"Separating on {device.upper()}")

            with torch.no_grad():
                sources = apply_model(
                    model, piece[None], device=device, shifts=preset["shifts"], split=True,
                    overlap=preset["overlap"], progress=False, num_workers=0, callback=on_chunk,
                )[0]
            last = end >= length
            for name, tensor in zip(model.sources, sources):
                if name not in writers:
                    continue
                stem = np.clip(tensor.cpu().numpy().T * std + mean, -1.0, 1.0).astype(np.float32)
                if name in tails:  # crossfade with the previous chunk's overlap region
                    head = stem[:overlap]
                    stem[:overlap] = tails[name] * (1.0 - fade_in[: len(head)]) + head * fade_in[: len(head)]
                if last:
                    writers[name].write(stem)
                else:
                    writers[name].write(stem[:-overlap])
                    tails[name] = stem[-overlap:]
            del sources, piece
    finally:
        for w in writers.values():
            w.close()
    report(1.0, "Done")
    return {name: str(out_dir / f"{name}.{req.stem_format}") for name in writers}


def _child(req: SeparationRequest, q: mp.Queue) -> None:
    from .procutil import exit_with_parent

    exit_with_parent()
    try:
        # Lower our priority so the UI and audio playback stay smooth while we crunch.
        if hasattr(os, "nice"):
            os.nice(5)
        elif os.name == "nt":  # pragma: no cover - Windows only
            import ctypes

            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
        paths = run_separation(req, lambda p, msg: q.put(("progress", p, msg)))
        q.put(("done", paths, ""))
    except BaseException as exc:  # noqa: BLE001 - report everything to the parent
        q.put(("error", f"{type(exc).__name__}: {exc}", traceback.format_exc()))


class SeparationProcess:
    """Runs one separation in a child process, forwarding progress to a callback."""

    def __init__(self, req: SeparationRequest):
        ctx = mp.get_context("spawn")
        self._queue: mp.Queue = ctx.Queue()
        self._proc = ctx.Process(target=_child, args=(req, self._queue), daemon=True)

    def run(self, on_progress: Callable[[float, str], None], should_cancel: Callable[[], bool]) -> dict[str, str]:
        self._proc.start()
        try:
            while True:
                if should_cancel():
                    raise InterruptedError("Cancelled")
                try:
                    kind, payload, extra = self._queue.get(timeout=0.25)
                except queue_mod.Empty:
                    if not self._proc.is_alive():
                        raise RuntimeError(
                            f"Separation process exited unexpectedly (code {self._proc.exitcode}). "
                            "This usually means the computer ran out of memory."
                        ) from None
                    continue
                if kind == "progress":
                    on_progress(payload, extra)
                elif kind == "done":
                    return payload
                else:
                    raise RuntimeError(payload)
        finally:
            if self._proc.is_alive():
                self._proc.terminate()
            self._proc.join(timeout=5)
