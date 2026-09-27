"""Musical key helpers: standard names, Camelot wheel and compatibility."""

from __future__ import annotations

NOTE_NAMES = ("C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")

# Camelot number for each pitch class. Major keys use the "B" ring, minor keys the "A" ring.
_MAJOR_CAMELOT = {0: 8, 7: 9, 2: 10, 9: 11, 4: 12, 11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7}
_MINOR_CAMELOT = {9: 8, 4: 9, 11: 10, 6: 11, 1: 12, 8: 1, 3: 2, 10: 3, 5: 4, 0: 5, 7: 6, 2: 7}


def key_name(pc: int | None, mode: str | None) -> str:
    if pc is None or mode is None:
        return ""
    return f"{NOTE_NAMES[pc % 12]}{'m' if mode == 'minor' else ''}"


def camelot(pc: int | None, mode: str | None) -> str:
    if pc is None or mode is None:
        return ""
    if mode == "minor":
        return f"{_MINOR_CAMELOT[pc % 12]}A"
    return f"{_MAJOR_CAMELOT[pc % 12]}B"


def relative_major_pc(pc: int, mode: str) -> int:
    """Pitch class of the relative major (A minor -> C)."""
    return (pc + 3) % 12 if mode == "minor" else pc % 12


def semitones_to_match(src_pc: int, src_mode: str, dst_pc: int, dst_mode: str) -> int:
    """Smallest pitch shift (-6..+5) that moves the source key onto the target key's scale."""
    diff = (relative_major_pc(dst_pc, dst_mode) - relative_major_pc(src_pc, src_mode)) % 12
    return diff - 12 if diff > 5 else diff
