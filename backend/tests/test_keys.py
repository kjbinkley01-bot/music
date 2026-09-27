from stemdeck_backend.keys import camelot, key_name, semitones_to_match


def test_camelot_wheel():
    assert camelot(9, "minor") == "8A"  # A minor
    assert camelot(0, "major") == "8B"  # C major
    assert camelot(7, "major") == "9B"  # G major
    assert camelot(4, "minor") == "9A"  # E minor
    assert camelot(None, None) == ""


def test_key_name():
    assert key_name(9, "minor") == "Am"
    assert key_name(6, "major") == "F#"


def test_semitones_to_match_relative_keys_need_no_shift():
    assert semitones_to_match(9, "minor", 0, "major") == 0  # Am -> C
    assert semitones_to_match(0, "major", 2, "major") == 2  # C -> D
    assert semitones_to_match(0, "major", 10, "major") == -2  # C -> Bb (down is shorter)
