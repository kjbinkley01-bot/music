"""BPM, beat grid and key detection with librosa (CPU only, a few seconds per track)."""

from __future__ import annotations

import numpy as np

from .audio_io import decode

ANALYSIS_SR = 22050
HOP = 512

# Krumhansl-Kessler key profiles.
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def fold_bpm(bpm: float, low: float = 70.0, high: float = 180.0) -> float:
    if bpm <= 0:
        return 0.0
    while bpm < low:
        bpm *= 2
    while bpm >= high:
        bpm /= 2
    return bpm


def fit_grid(beat_times: np.ndarray, fallback_bpm: float) -> tuple[float, float]:
    """Fit a constant-tempo grid to detected beats. Returns (bpm, first_beat_seconds)."""
    if len(beat_times) < 8:
        bpm = fold_bpm(fallback_bpm) or 120.0
        return round(bpm, 2), float(beat_times[0] % (60 / bpm)) if len(beat_times) else 0.0
    intervals = np.diff(beat_times)
    period = float(np.median(intervals))
    # Least squares on beat index vs time is far more precise than the median interval.
    idx = np.round((beat_times - beat_times[0]) / period)
    slope, _ = np.polyfit(idx, beat_times, 1)
    bpm = fold_bpm(60.0 / slope)
    if abs(bpm - round(bpm)) < 0.06:
        bpm = float(round(bpm))
    period = 60.0 / bpm
    # Circular mean of beat phases gives a grid offset that is robust to outliers.
    angles = 2 * np.pi * (beat_times % period) / period
    phase = np.angle(np.mean(np.exp(1j * angles)))
    first_beat = float((phase % (2 * np.pi)) / (2 * np.pi) * period)
    return round(bpm, 2), round(first_beat, 4)


def detect_key(y: np.ndarray, sr: int) -> tuple[int, str, float]:
    import librosa

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP * 4)
    profile = chroma.sum(axis=1)
    if not np.any(profile):
        return 0, "major", 0.0
    profile = (profile - profile.mean()) / (profile.std() + 1e-9)
    scores = []
    for mode, template in (("major", _MAJOR), ("minor", _MINOR)):
        t = (template - template.mean()) / template.std()
        for pc in range(12):
            scores.append((float(np.dot(profile, np.roll(t, pc)) / 12), pc, mode))
    scores.sort(reverse=True)
    best, runner_up = scores[0], scores[1]
    confidence = max(0.0, min(1.0, (best[0] - runner_up[0]) * 4 + best[0] * 0.5))
    return best[1], best[2], round(confidence, 3)


def estimate_energy(y: np.ndarray, onset_env: np.ndarray) -> float:
    """Rough 1-10 energy rating from loudness and rhythmic density."""
    rms = float(np.sqrt(np.mean(y**2)) + 1e-9)
    loudness = np.clip((20 * np.log10(rms) + 30) / 22, 0, 1)  # -30 dBFS .. -8 dBFS
    density = np.clip(float(np.mean(onset_env)) / 2.0, 0, 1)
    return round(float(1 + 9 * (0.6 * loudness + 0.4 * density)), 1)


def analyze(path: str) -> dict:
    import librosa

    y = decode(path, sr=ANALYSIS_SR, channels=1)[:, 0]
    if y.size < ANALYSIS_SR:
        raise ValueError("Audio is too short to analyse")
    onset_env = librosa.onset.onset_strength(y=y, sr=ANALYSIS_SR, hop_length=HOP)
    tempo, beats = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=ANALYSIS_SR, hop_length=HOP, units="time"
    )
    tempo = float(np.atleast_1d(tempo)[0])
    bpm, first_beat = fit_grid(np.asarray(beats, dtype=float), tempo)
    key_pc, key_mode, key_conf = detect_key(y, ANALYSIS_SR)
    return {
        "bpm": bpm,
        "first_beat": first_beat,
        "key_pc": key_pc,
        "key_mode": key_mode,
        "key_confidence": key_conf,
        "energy": estimate_energy(y, onset_env),
        "duration": round(y.size / ANALYSIS_SR, 3),
    }
