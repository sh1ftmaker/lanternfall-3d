"""Tiny loop sequencer: notes are placed on a beat grid into tracks of exactly L samples (circular), so a piece
rendered here loops with no seam. Every note is kept in `notes` for the piano roll and the note checks."""
import numpy as np
from .dsp import SR, mtof, add_at, pfilter, circ_conv, reverb_ir, chain

PC = {'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8,
      'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11}
NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
D_MAJOR = {2, 4, 6, 7, 9, 11, 1}          # the park's shared pitch-class set (D major / B minor / E dorian)


def n(name):
    """'F#4' -> midi 66"""
    i = 2 if len(name) > 2 and name[1] in '#b' else 1
    return PC[name[:i]] + 12 * (int(name[i:]) + 1)


def nn(m):
    return NAMES[m % 12] + str(m // 12 - 1)


CHORDS = {  # pitch classes, root first
    'D': [2, 6, 9], 'G': [7, 11, 2], 'A': [9, 1, 4], 'Bm': [11, 2, 6], 'Em': [4, 7, 11], 'F#m': [6, 9, 1],
    'A7': [9, 1, 4, 7], 'Em7': [4, 7, 11, 2], 'Bm7': [11, 2, 6, 9], 'Gmaj7': [7, 11, 2, 6], 'Dmaj7': [2, 6, 9, 1],
    'Asus': [9, 2, 4], 'D/F#': [2, 6, 9], 'Gadd9': [7, 11, 2, 9], 'Dadd9': [2, 6, 9, 4],
}


def chord_pcs(c):
    return CHORDS[c]


def chord_root(c):
    return 6 if c == 'D/F#' else CHORDS[c][0]


def voicing(chord, lo, hi, prev=None, size=3):
    """Close-ish voicing of `size` notes inside [lo, hi] with smooth voice-leading from `prev`."""
    pcs = chord_pcs(chord)
    cands = [m for m in range(lo, hi + 1) if m % 12 in pcs]
    best, bcost = None, 1e9
    for i in range(len(cands) - size + 1):
        v = cands[i:i + size]
        if len({m % 12 for m in v}) < min(size, len(pcs)):
            continue
        span = v[-1] - v[0]
        cost = span * .2 + (sum(abs(a - b) for a, b in zip(v, prev)) if prev else abs(np.mean(v) - (lo + hi) / 2))
        if cost < bcost:
            best, bcost = v, cost
    return best


class Piece:
    def __init__(self, name, bpm, beats, seed=1, swing=0.0):
        self.name, self.bpm, self.seed, self.swing = name, bpm, seed, swing
        self.beats = beats                                    # total beats in the loop
        self.L = int(round(beats * 60.0 / bpm * SR))
        self.tracks = {}
        self.notes = []                                       # (track, beat, dur, midi, vel)
        self.rng = np.random.default_rng(seed)

    def b2s(self, beat):
        return int(round(beat * 60.0 / self.bpm * SR))

    def track(self, name, gain=1.0, send=0.0, eq=None):
        if name not in self.tracks:
            self.tracks[name] = dict(buf=np.zeros(self.L), gain=gain, send=send, eq=eq)
        return self.tracks[name]

    def note(self, track, inst, beat, dur, midi, vel=.8, human=0.008, **kw):
        """dur in beats; midi may be a float (microtones not used); human = timing jitter in seconds."""
        tr = self.tracks[track]
        if self.swing and abs((beat * 2) % 2 - 1) < 1e-6:      # off-beat eighths pushed late
            beat += self.swing
        start = self.b2s(beat) + int(self.rng.normal(0, human) * SR)
        x = inst(float(mtof(midi)), dur * 60.0 / self.bpm, vel, self.rng, **kw)
        add_at(tr['buf'], x, start)
        self.notes.append((track, beat, dur, midi, vel))

    def hit(self, track, fn, beat, vel=.8, human=0.004, **kw):
        tr = self.tracks[track]
        start = self.b2s(beat) + int(self.rng.normal(0, human) * SR)
        add_at(tr['buf'], fn(vel, self.rng, **kw), start)
        self.notes.append((track, beat, .25, -1, vel))

    def mix(self, t60=1.6, damp=2500, predelay=.02):
        ir = reverb_ir(t60=t60, seed=self.seed + 7, damp=damp, predelay=predelay)
        dry = np.zeros(self.L); send = np.zeros(self.L)
        for name, tr in self.tracks.items():
            x = tr['buf'] * tr['gain']
            if tr['eq'] is not None:
                x = pfilter(x, tr['eq'])
            dry += x
            send += x * tr['send']
        return dry + circ_conv(send, ir)
