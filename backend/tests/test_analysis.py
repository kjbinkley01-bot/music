import numpy as np
import pytest
from conftest import make_song

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


@pytest.mark.parametrize(
    "bpm,root,minor,offset,camelot_num",
    [(124, 220.0, True, 0.12, 8), (126, 261.63, False, 0.31, 8), (174, 196.0, True, 0.2, 6), (128, 196.0, False, 0.4, 9)],
)
def test_analyze_songs(tmp_path, bpm, root, minor, offset, camelot_num):
    """Exact BPM, beat-accurate grid (not locked to the off-beat hats) and the right Camelot number."""
    from stemdeck_backend.keys import camelot

    r = analyze(str(make_song(tmp_path / "song.wav", bpm, root, minor, offset=offset)))
    assert r["bpm"] == bpm
    period = 60 / bpm
    err = (r["first_beat"] - offset % period + period / 2) % period - period / 2
    assert abs(err) < 0.015
    assert int(camelot(r["key_pc"], r["key_mode"])[:-1]) == camelot_num
