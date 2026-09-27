import numpy as np

from stemdeck_backend.analysis import analyze, fit_grid, fold_bpm


def test_fold_bpm():
    assert fold_bpm(62) == 124
    assert fold_bpm(248) == 124
    assert fold_bpm(174) == 174


def test_fit_grid_recovers_tempo_and_phase():
    period = 60 / 128
    beats = 0.37 + np.arange(64) * period + np.random.default_rng(0).normal(0, 0.004, 64)
    bpm, first = fit_grid(beats, 128)
    assert bpm == 128
    assert abs(first - 0.37 % period) < 0.01


def test_analyze_click_track(click_track):
    result = analyze(str(click_track))
    assert abs(result["bpm"] - 124) < 0.5
    assert (result["key_pc"], result["key_mode"]) in {(9, "minor"), (0, "major")}  # A minor or relative C
    beat = 60 / 124
    phase_err = min(abs(result["first_beat"] - 0.25 % beat), beat - abs(result["first_beat"] - 0.25 % beat))
    assert phase_err < 0.04
