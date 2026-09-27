"""BPM, beat grid and key detection with librosa (CPU only, a few seconds per track)."""

from __future__ import annotations

import numpy as np

from .audio_io import decode

ANALYSIS_SR = 22050
HOP = 512
FINE_HOP = 128  # ~6 ms resolution for the grid phase
ONSET_LAG = 0.008  # spectral-flux peaks trail the actual transient by about this much

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
    """Krumhansl-Kessler key estimate on the harmonic part of the signal.

    Drums are removed first (HPSS) and pitches below C2 ignored: tuned kick drums otherwise drag
    the estimate towards whatever note the kick happens to sit on. When the best key and its
    relative major/minor score almost the same, the one whose tonic is stronger in the bass wins.
    """
    import librosa

    # Constant-Q spectrogram from C2 up; median-filter HPSS on it is ~20x cheaper than on an STFT.
    bpo = 36
    cqt = np.abs(librosa.cqt(y, sr=sr, hop_length=HOP * 4, fmin=librosa.note_to_hz("C2"), n_bins=bpo * 5, bins_per_octave=bpo))
    harmonic, _ = librosa.decompose.hpss(cqt, kernel_size=(17, 17), margin=(2.0, 1.0))
    chroma = librosa.feature.chroma_cqt(C=harmonic, sr=sr, bins_per_octave=bpo, n_octaves=5)
    profile = chroma.sum(axis=1)
    if not np.any(profile):
        return 0, "major", 0.0
    profile = (profile - profile.mean()) / (profile.std() + 1e-9)
    scores: dict[tuple[int, str], float] = {}
    for mode, template in (("major", _MAJOR), ("minor", _MINOR)):
        t = (template - template.mean()) / template.std()
        for pc in range(12):
            scores[(pc, mode)] = float(np.dot(profile, np.roll(t, pc)) / 12)
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    (pc, mode), best = ranked[0]
    runner_up = ranked[1][1]
    rel = ((pc + 9) % 12, "minor") if mode == "major" else ((pc + 3) % 12, "major")
    if scores[rel] > best * 0.9:
        bass = librosa.feature.chroma_cqt(C=harmonic[:bpo], sr=sr, bins_per_octave=bpo, n_octaves=1).sum(axis=1)
        if bass[rel[0]] > bass[pc] * 1.1:
            (pc, mode), best = rel, scores[rel]
    confidence = max(0.0, min(1.0, (best - runner_up) * 4 + best * 0.5))
    return pc, mode, round(confidence, 3)


def estimate_energy(y: np.ndarray, onset_env: np.ndarray) -> float:
    """Rough 1-10 energy rating from loudness and rhythmic density."""
    rms = float(np.sqrt(np.mean(y**2)) + 1e-9)
    loudness = np.clip((20 * np.log10(rms) + 24) / 16, 0, 1)  # -24 dBFS (quiet) .. -8 dBFS (loud master)
    # share of frames with a clear onset: busy drums and percussion score high
    busy = float(np.mean(onset_env > np.median(onset_env) * 2.5))
    return round(float(1 + 9 * np.clip(0.55 * loudness + 0.45 * np.clip(busy * 2.5, 0, 1), 0, 1)), 1)


def estimate_loudness(y: np.ndarray, sr: int) -> float:
    """Approximate programme loudness in dBFS: RMS over the louder half of 400 ms blocks.

    A simplified take on EBU R128 gating: quiet intros and breakdowns don't drag the value down,
    so two tracks with the same number sound about equally loud. Used for DJ auto-gain.
    """
    block = int(0.4 * sr)
    n = len(y) // block
    if n == 0:
        return -60.0
    power = np.mean(y[: n * block].reshape(n, block) ** 2, axis=1)
    loud = power[power >= np.median(power)]
    return round(float(10 * np.log10(np.mean(loud) + 1e-12)), 2)


def refine_tempo(onset_env: np.ndarray, frame_rate: float, coarse_bpm: float, phase_env: np.ndarray | None = None) -> tuple[float, float]:
    """Precise tempo and grid phase from the whole track.

    librosa's tempo estimate is quantised to whole onset-frame lags (about +/-2% at 120 BPM),
    which is far too coarse for beat matching. Here we evaluate the Fourier magnitude of the
    onset envelope at candidate beat frequencies around the coarse estimate: a steady beat
    adds up coherently over the entire track, so the peak is extremely sharp (resolution
    ~ 60 / track length BPM). The phase at the peak gives the first beat position; it is taken
    from `phase_env` (a kick/bass band envelope) when given, because bright off-beat hi-hats
    would otherwise pull the grid onto the "and" of each beat.
    """
    # Eight minutes is plenty for sub-0.01 BPM precision and keeps DJ-mix length files cheap.
    limit = int(8 * 60 * frame_rate)
    o = onset_env[:limit] - onset_env[:limit].mean()
    t = np.arange(len(o)) / frame_rate

    def score(bpms: np.ndarray) -> np.ndarray:
        # Evaluated a few candidates at a time: the full (candidates x frames) matrix of complex
        # exponentials would need hundreds of MB for a long track.
        out = np.empty(len(bpms))
        for i in range(0, len(bpms), 8):
            f = bpms[i : i + 8, None] / 60.0
            # fundamental plus the 2nd harmonic (off-beats) for robustness
            out[i : i + 8] = np.abs(np.exp(-2j * np.pi * f * t) @ o) + 0.5 * np.abs(np.exp(-4j * np.pi * f * t) @ o)
        return out

    lo, hi = coarse_bpm * 0.94, coarse_bpm * 1.06
    grid = np.arange(lo, hi, 0.05)
    best = float(grid[int(np.argmax(score(grid)))])
    fine = np.arange(best - 0.06, best + 0.06, 0.002)
    bpm = float(fine[int(np.argmax(score(fine)))])
    p = o if phase_env is None else phase_env[: len(o)] - phase_env.mean()
    phase = np.angle(np.exp(-2j * np.pi * (bpm / 60.0) * t[: len(p)]) @ p)
    period = 60.0 / bpm
    first_beat = float((-phase / (2 * np.pi) * period) % period)
    return bpm, first_beat


def warm_up() -> None:
    """Run the analysis pipeline once on a synthetic beat so numba compiles librosa's kernels."""
    import librosa

    sr = ANALYSIS_SR
    t = np.arange(sr * 4) / sr
    y = (np.sin(2 * np.pi * 220 * t) * 0.2 + (np.mod(t, 0.5) < 0.02) * 0.8).astype(np.float32)
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    librosa.feature.tempo(onset_envelope=env, sr=sr, hop_length=HOP)
    librosa.onset.onset_strength(y=y, sr=sr, hop_length=FINE_HOP, n_mels=24, fmax=180)
    detect_key(y, sr)


def analyze(path: str) -> dict:
    import librosa

    y = decode(path, sr=ANALYSIS_SR, channels=1)[:, 0]
    if y.size < ANALYSIS_SR:
        raise ValueError("Audio is too short to analyse")
    onset_env = librosa.onset.onset_strength(y=y, sr=ANALYSIS_SR, hop_length=HOP)
    coarse = float(np.atleast_1d(librosa.feature.tempo(onset_envelope=onset_env, sr=ANALYSIS_SR, hop_length=HOP))[0])
    fine_env = librosa.onset.onset_strength(y=y, sr=ANALYSIS_SR, hop_length=FINE_HOP)
    low_env = librosa.onset.onset_strength(y=y, sr=ANALYSIS_SR, hop_length=FINE_HOP, n_mels=24, fmax=180)
    bpm, first_beat = refine_tempo(fine_env, ANALYSIS_SR / FINE_HOP, fold_bpm(coarse) or 120.0, low_env)
    bpm = fold_bpm(bpm)
    if abs(bpm - round(bpm)) < 0.05:
        bpm = float(round(bpm))
    first_beat = (first_beat - ONSET_LAG) % (60.0 / bpm)
    key_pc, key_mode, key_conf = detect_key(y, ANALYSIS_SR)
    return {
        "bpm": round(bpm, 2),
        "first_beat": round(first_beat, 4),
        "key_pc": key_pc,
        "key_mode": key_mode,
        "key_confidence": key_conf,
        "energy": estimate_energy(y, onset_env),
        "loudness": estimate_loudness(y, ANALYSIS_SR),
        "duration": round(y.size / ANALYSIS_SR, 3),
    }
