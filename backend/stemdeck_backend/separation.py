"""Stem separation with Demucs, run in a child process so it can be cancelled and never blocks the API.

Fast mode:  htdemucs, no random shifts, small overlap  (~1-3x track length on a 4-core CPU)
High mode:  htdemucs_ft (four fine-tuned models), 1 shift, 25% overlap  (~4-8x slower than fast)
"""

from __future__ import annotations

import multiprocessing as mp
import os
import queue as queue_mod
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .config import STEM_NAMES

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


def device_info() -> dict:
    try:
        import torch
    except ImportError:
        return {"torch": False, "cuda": False, "device": "unavailable"}
    cuda = bool(torch.cuda.is_available())
    return {
        "torch": True,
        "cuda": cuda,
        "device": torch.cuda.get_device_name(0) if cuda else "CPU",
    }


def run_separation(req: SeparationRequest, report: Callable[[float, str], None]) -> dict[str, str]:
    """Separate one file into vocals/drums/bass/other. Blocking; call from a worker process."""
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    from .audio_io import decode, write_audio

    torch.set_num_threads(max(1, int(req.threads)))
    preset = QUALITY_PRESETS.get(req.quality, QUALITY_PRESETS["fast"])
    device = pick_device(req.use_gpu)

    report(0.01, f"Loading model {preset['model']} (first run downloads it)")
    model = get_model(preset["model"])
    model.eval()
    sr = model.samplerate

    report(0.03, "Decoding audio")
    audio = decode(req.source, sr=sr, channels=model.audio_channels)
    mix = torch.from_numpy(audio.T.copy())
    ref = mix.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    mix = (mix - mean) / std

    n_models = len(getattr(model, "models", [model]))
    passes = n_models * max(1, preset["shifts"])
    length = mix.shape[-1]
    best = [0.0]

    def on_chunk(info: dict) -> None:
        if info.get("state") != "end":
            return
        model_idx = info.get("model_idx_in_bag", 0)
        shift_idx = info.get("shift_idx", 0)
        seg_len = int(sr * float(getattr(model, "segment", 7.8) or 7.8))
        frac = min(1.0, (info.get("segment_offset", 0) + seg_len) / length)
        done = (model_idx * max(1, preset["shifts"]) + shift_idx + frac) / passes
        if done > best[0]:
            best[0] = done
            report(0.05 + 0.9 * done, f"Separating on {device.upper()}")

    with torch.no_grad():
        sources = apply_model(
            model, mix[None], device=device, shifts=preset["shifts"], split=True,
            overlap=preset["overlap"], progress=False, num_workers=0, callback=on_chunk,
        )[0]
    sources = sources * std + mean

    report(0.96, "Writing stems")
    out_dir = Path(req.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, str] = {}
    for name, tensor in zip(model.sources, sources):
        if name not in STEM_NAMES:
            continue
        paths[name] = str(write_audio(out_dir / name, tensor.cpu().numpy().T, sr, req.stem_format))
    report(1.0, "Done")
    return paths


def _child(req: SeparationRequest, q: mp.Queue) -> None:
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
