"""The Lanternfall theme: one original 16-bar melody (D major pentatonic notes only: D E F# A B), re-orchestrated
per land so the tune stays while the instruments change. Harmony from D major (D G A Bm Em).

Bars are (chords, melody): chords = [(beat_in_bar, name)], melody = [(dur_quarters, 'F#4' | None for rest)].
Written by the sound-music agent for this project (no existing melody was copied)."""
from .seq import n

THEME_A = [
    ([(0, 'D')],               [(2, 'F#4'), (1, 'A4'), (1, 'B4')]),
    ([(0, 'G')],               [(3, 'D5'), (1, 'B4')]),
    ([(0, 'Bm')],              [(2, 'A4'), (1, 'F#4'), (1, 'E4')]),
    ([(0, 'A')],               [(3, 'E4'), (1, None)]),
    ([(0, 'D')],               [(2, 'F#4'), (1, 'A4'), (1, 'B4')]),
    ([(0, 'Bm')],              [(1, 'D5'), (1, 'E5'), (2, 'F#5')]),
    ([(0, 'Em7'), (2, 'A')],   [(1, 'B4'), (1, 'D5'), (2, 'E5')]),
    ([(0, 'D')],               [(4, 'D5')]),
]
THEME_B = [
    ([(0, 'G')],               [(2, 'B4'), (1, 'D5'), (1, 'B4')]),
    ([(0, 'D')],               [(2, 'A4'), (2, 'F#4')]),
    ([(0, 'Bm')],              [(1, 'F#4'), (1, 'A4'), (2, 'B4')]),
    ([(0, 'A')],               [(3, 'A4'), (1, None)]),
    ([(0, 'G')],               [(2, 'B4'), (1, 'D5'), (1, 'E5')]),
    ([(0, 'D')],               [(2, 'F#5'), (1, 'E5'), (1, 'D5')]),
    ([(0, 'Em'), (2, 'A')],    [(1, 'E5'), (1, 'D5'), (1, 'B4'), (1, 'A4')]),
    ([(0, 'D')],               [(4, 'D4')]),
]
THEME = THEME_A + THEME_B


def flat(bars, bar_beats=4, transpose=0):
    """-> (melody [(beat, dur, midi)], chords [(beat, dur, name)]) on a 4/4 quarter-note grid."""
    mel, ch = [], []
    for i, (chords, notes) in enumerate(bars):
        t = i * bar_beats
        for k, (cb, name) in enumerate(chords):
            end = chords[k + 1][0] if k + 1 < len(chords) else bar_beats
            ch.append((t + cb, end - cb, name))
        for d, p in notes:
            if p:
                mel.append((t, d, n(p) + transpose))
            t += d
    return mel, ch


def _map_pos(p):
    """Position in a 4/4 bar (quarters, 0..4) -> position in a 6-unit bar (6/8 eighths or 2x3/4 quarters).
    Each half bar becomes three units; a pair of quarters becomes long-short (2 + 1)."""
    half, r = divmod(p, 2)
    return 3 * half + (0 if r == 0 else 2 if r == 1 else 3)


def compound(bars, transpose=0):
    """Theme in a compound/triple metre: each 4/4 bar -> 6 units (jig: 6/8 eighths; waltz: two 3/4 bars)."""
    mel, ch = flat(bars, 4, transpose)
    def m(t):
        bar, p = divmod(t, 4)
        return bar * 6 + _map_pos(p)
    mel = [(m(s), m(s + d) - m(s), p) for s, d, p in mel]
    ch = [(m(s), m(s + d) - m(s), c) for s, d, c in ch]
    return mel, ch


# Drunken Sailor (traditional sea shanty, first printed 1839; public domain), set by us in E dorian so every note
# is in the park's shared D-major pitch set. Two 4-bar halves; 4/4 with q = 1 beat.
SAILOR = [
    ([(0, 'Em')], [(1, 'B4'), (.5, 'B4'), (.5, 'B4'), (1, 'B4'), (.5, 'B4'), (.5, 'B4')]),
    ([(0, 'Em')], [(1, 'B4'), (1, 'E4'), (1, 'G4'), (1, 'B4')]),
    ([(0, 'D')],  [(1, 'A4'), (.5, 'A4'), (.5, 'A4'), (1, 'A4'), (.5, 'A4'), (.5, 'A4')]),
    ([(0, 'D')],  [(1, 'A4'), (1, 'D4'), (1, 'F#4'), (1, 'A4')]),
    ([(0, 'Em')], [(1, 'B4'), (.5, 'B4'), (.5, 'B4'), (1, 'B4'), (.5, 'B4'), (.5, 'B4')]),
    ([(0, 'Em')], [(1, 'B4'), (1, 'C#5'), (1, 'D5'), (1, 'E5')]),
    ([(0, 'D')],  [(1, 'D5'), (1, 'B4'), (1, 'A4'), (1, 'F#4')]),
    ([(0, 'Em')], [(2, 'E4'), (2, 'E4')]),
]
