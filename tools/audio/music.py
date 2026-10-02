"""The park's music: one original theme (lib/theme.py) arranged per land, plus a public-domain shanty for the wharf.
Every piece is a seamless loop (periodic render) in the shared D-major pitch set, at 72 / 108 / 144 bpm (or a
beatless texture), so neighbouring lands never clash. Each function returns (mono loop, Piece)."""
import numpy as np
from lib.dsp import pfilter, chain, lp, hp, peak, shelf, SR
from lib.seq import Piece, voicing, chord_root, chord_pcs, n
from lib import inst
from lib.theme import THEME_A, THEME_B, THEME, flat, compound, SAILOR

PENTA = [2, 4, 6, 9, 11]          # D major pentatonic pitch classes


def _oneshot(y, secs, fade=.6):
    """Cut a (long, silent-tailed) render to `secs` with a cosine fade-out."""
    k = int(secs * SR); y = y[:k].copy(); f = int(fade * SR)
    y[-f:] *= np.cos(np.linspace(0, np.pi / 2, f)) ** 2
    return y


def _chord_at(chords, beat):
    for s, d, c in chords:
        if s <= beat < s + d:
            return c
    return chords[-1][2]


def _penta_step(m, k):
    """Move k pentatonic steps from midi m (m must be pentatonic)."""
    out = m
    step = 1 if k > 0 else -1
    for _ in range(abs(k)):
        out += step
        while out % 12 not in PENTA:
            out += step
    return out


# ------------------------------------------------------------------------------------------------ East Gate
def gate_welcome():
    """Arrival: celesta + harp theme over warm strings, flute takes the B half; little glock 'lamp-lighting'
    flourishes at phrase ends. 108 bpm, 16 bars."""
    P = Piece('gate_welcome', 108, 64, seed=11)
    P.track('cel', .9, .35); P.track('harp', .55, .3); P.track('str', .5, .45, eq=lp(5000))
    P.track('bass', .6, .2); P.track('fl', .8, .35); P.track('glk', .35, .5)
    mel, ch = flat(THEME)
    for s, d, m in mel:
        if s < 32:
            P.note('cel', inst.celesta, s, d, m + 12, .75)
            P.note('harp', inst.harp, s, d, m, .45)
        else:
            P.note('fl', inst.flute, s, d * .95, m + 12, .7, kind='flute')
            P.note('cel', inst.celesta, s, d, m, .35)
    prev = None
    for s, d, c in ch:
        v = voicing(c, 55, 72, prev); prev = v
        for m in v:
            P.note('str', inst.section, s, d + .1, m, .38, kind='viola', attack=.4, vib=8)
        P.note('bass', inst.section, s, d + .05, chord_root(c) + 36 + (12 if chord_root(c) < 2 else 0), .45,
               kind='cello', attack=.25)
        # harp arpeggio, eighths, up the chord
        arp = voicing(c, 62, 81, None, size=4)
        for i in range(int(d * 2)):
            P.note('harp', inst.harp, s + i * .5, .5, arp[i % 4], .28 + .08 * (i % 2 == 0))
    for b in (14, 30, 46, 62):    # lamp-lighting flourish: four rising glock notes
        for i, m in enumerate([n('A5'), n('B5'), n('D6'), n('E6')]):
            P.note('glk', inst.glock, b + i * .25, .25, m, .35 + .1 * i)
    y = P.mix(t60=1.8, damp=3000)
    return y, P


# ------------------------------------------------------------------------------------------------ Stillwater
def lake_hush():
    """The quiet heart: a wordless choir breathing through slow chords (no beat), a glass harmonica placing a
    few theme notes far apart. 60 bpm grid, 8 chords x 4 s = 32 s."""
    P = Piece('lake_hush', 60, 32, seed=21)
    P.track('ch', .9, .55, eq=chain(lp(4200), hp(90))); P.track('glass', .5, .6); P.track('low', .5, .4)
    prog = ['Dadd9', 'Bm7', 'Gmaj7', 'Asus', 'D', 'Em7', 'Gadd9', 'A']
    prev = None
    for i, c in enumerate(prog):
        v = voicing(c, 57, 74, prev, size=4); prev = v
        for m in v:
            P.note('ch', inst.choir, i * 4 - .6, 5.2, m, .42, vowel='o' if i % 2 else 'u', attack=1.4,
                   release=2.0, voices=3)
        P.note('low', inst.choir, i * 4 - .6, 5.2, chord_root(c) + 36 + (12 if chord_root(c) < 7 else 0), .35,
               vowel='u', attack=1.6, release=2.0, voices=2)
    for b, m in [(1, 'F#5'), (6, 'A5'), (9, 'B5'), (13.5, 'E5'), (17, 'A5'), (21, 'B5'), (26, 'D6'), (29.5, 'E5')]:
        P.note('glass', inst.glassharp, b, 2.6, n(m), .5)
    y = P.mix(t60=4.5, damp=2200, predelay=.04)
    return y, P


# ------------------------------------------------------------------------------------------------ Guildhollow
def guild_tavern():
    """Tavern jig, 6/8 at dotted-quarter 108: hurdy-gurdy then recorder on the theme, lute 'bass-chord' strums,
    a soft hurdy drone (D/A) and a frame drum. Grid unit = eighth note (324 per minute), 32 bars."""
    P = Piece('guild_tavern', 324, 192, seed=31)
    P.track('hg', .8, .25); P.track('rec', .85, .3); P.track('lute', .7, .2); P.track('drone', .22, .2)
    P.track('drum', .7, .15, eq=lp(5000)); P.track('tam', .3, .2)
    mel, ch = compound(THEME)                       # 96 eighths per pass
    for rep in range(2):
        o = rep * 96
        for s, d, m in mel:
            if rep == 0:
                P.note('hg', inst.reed, o + s, d * .92, m, .7, kind='hurdy')
            else:
                if d >= 3 and m + 12 <= n('E6'):     # ornament: turn on long notes (note, upper, note)
                    up = _penta_step(m, 1)
                    P.note('rec', inst.flute, o + s, .9, m + 12, .7, kind='recorder')
                    P.note('rec', inst.flute, o + s + 1, .9, up + 12, .55, kind='recorder')
                    P.note('rec', inst.flute, o + s + 2, d - 2.1, m + 12, .65, kind='recorder')
                else:
                    P.note('rec', inst.flute, o + s, d * .9, m + 12, .7, kind='recorder')
        for s, d, c in ch:
            root = chord_root(c) + 36
            if root < 40: root += 12
            v = voicing(c, 55, 67)
            for k in range(0, int(d), 3):             # each dotted-quarter: bass on 0, chord on 2
                b = o + s + k
                P.note('lute', inst.lute, b, 1.8, root + (7 if (k // 3) % 2 else 0), .62)
                for j, m in enumerate(v):
                    P.note('lute', inst.lute, b + 2 + j * .04, .9, m, .32)
    for b in range(0, 192, 6):
        P.hit('drum', inst.drum, b, .7, f=85, decay=.45, slap=.25)
        P.hit('drum', inst.drum, b + 3, .45, f=95, decay=.3, slap=.35)
        P.hit('drum', inst.drum, b + 5, .25, f=110, decay=.2, slap=.5)
        if b >= 96:
            P.hit('tam', inst.tambourine, b + 3, .5)
    P.note('drone', inst.reed, 0, 192, n('D3'), .5, kind='drone', attack=.01, release=.01)
    P.note('drone', inst.reed, 0, 192, n('A3'), .35, kind='drone', attack=.01, release=.01)
    y = P.mix(t60=1.1, damp=2500, predelay=.012)
    return y, P


def guild_fanfare():
    """One-shot fanfare from the castle walls: two 'brass' (filtered saw stack) voices in fifths, D major."""
    P = Piece('guild_fanfare', 108, 20, seed=33)
    P.track('br', 1.0, .45)
    line = [(0, .5, 'A4'), (.5, .5, 'A4'), (1, 1, 'D5'), (2, .5, 'A4'), (2.5, .5, 'D5'), (3, 1.5, 'F#5'),
            (4.5, .5, 'E5'), (5, .5, 'D5'), (5.5, .5, 'E5'), (6, 3, 'D5')]
    low = {'A4': 'D4', 'D5': 'F#4', 'F#5': 'A4', 'E5': 'A4'}
    cut = lambda t: 1 + 1.5 * np.minimum(1, t / .08) * np.exp(-t / .5)
    for s, d, p in line:
        P.note('br', inst.saw_stack, s, d * .92, n(p), .8, voices=3, detune=8, cutoff=1400, attack=.035,
               release=.18, cut_env=cut)
        P.note('br', inst.saw_stack, s, d * .92, n(low[p]), .6, voices=3, detune=8, cutoff=1100, attack=.04,
               release=.18, cut_env=cut)
    return _oneshot(P.mix(t60=2.4, damp=2500, predelay=.03), 6.0), P


# ------------------------------------------------------------------------------------------------ Frostmere
def frost_court():
    """Ice and glass: celesta + glass harmonica on the theme in B minor colours, a hushed low string bed,
    rare high glock sparkles. 72 bpm, 8 bars."""
    P = Piece('frost_court', 72, 32, seed=41)
    P.track('cel', .8, .5); P.track('glass', .55, .55); P.track('str', .35, .5, eq=lp(3500))
    P.track('spk', .25, .7)
    mel, _ = flat(THEME_A)
    prog = [(0, 4, 'Bm'), (4, 4, 'G'), (8, 4, 'D'), (12, 4, 'A'), (16, 4, 'Bm'), (20, 4, 'G'), (24, 2, 'Em'),
            (26, 2, 'A'), (28, 4, 'Bm')]
    for s, d, m in mel:
        P.note('cel', inst.celesta, s, d, m + 12, .7, decay=2.2)
    prev = None
    for s, d, c in prog:
        v = voicing(c, 62, 76, prev); prev = v
        for m in v:
            P.note('glass', inst.glassharp, s, d - .2, m, .35, attack=.6, release=1.4)
        P.note('str', inst.section, s, d + .2, chord_root(c) + 36 if chord_root(c) >= 4 else chord_root(c) + 48,
               .35, kind='cello', attack=.8, vib=5)
    rng = np.random.default_rng(4)
    for b in [3.5, 10.75, 15.5, 22.25, 27.5, 31]:
        P.note('spk', inst.glock, b, .5, int(rng.choice([n('F#6'), n('A6'), n('B6'), n('D7')])), .3)
    y = P.mix(t60=3.2, damp=3500, predelay=.03)
    return y, P


def frost_drum():
    """The Frost Fair's stern drum: a field-drum march cadence with bass drum, 72 bpm, 4 bars (13.3 s)."""
    P = Piece('frost_drum', 72, 16, seed=43)
    P.track('sn', .8, .2, eq=lp(6000)); P.track('bd', .9, .15)
    for bar in range(4):
        b = bar * 4
        P.hit('bd', inst.drum, b, .9, f=58, decay=.8, slap=.1, bend=1.3)
        P.hit('bd', inst.drum, b + 2, .7, f=58, decay=.8, slap=.1, bend=1.3)
        pat = [0, 1, 1.5, 2, 3] if bar % 2 == 0 else [0, .5, .75, 1, 2, 2.5, 3, 3.5]
        for i, t in enumerate(pat):
            P.hit('sn', inst.snare, b + t, .75 if t in (0, 2) else .45, tone=210, decay=.14, bright=6000)
    y = P.mix(t60=1.4, damp=2500)
    return y, P


# ------------------------------------------------------------------------------------------------ Meridian Rail
def meridian_signal():
    """Signal Plaza: warm synthwave at 108 bpm, B minor (Bm G D A), pulsing octave bass, gated pad, 16th arp,
    drum machine; the theme enters on a soft saw lead in bars 5-12."""
    P = Piece('meridian_signal', 108, 64, seed=51)
    P.track('kick', .9, 0); P.track('snr', .5, .25); P.track('hat', .3, .05); P.track('bass', .55, 0, eq=lp(1800))
    P.track('pad', .5, .35); P.track('arp', .35, .35); P.track('lead', .6, .4)
    prog = ['Bm', 'G', 'D', 'A', 'Bm', 'G', 'D', 'A', 'Bm', 'G', 'Em', 'D', 'Bm', 'G', 'D', 'A']
    prev = None
    for bar, c in enumerate(prog):
        b = bar * 4
        if bar == 10:        # theme bar 7 (Em7 -> A): half and half
            segs = [(b, 2, 'Em'), (b + 2, 2, 'A')]
        else:
            segs = [(b, 4, c)]
        for s, d, cc in segs:
            root = chord_root(cc) + 36
            if root < 38: root += 12
            for i in range(int(d * 2)):
                P.note('bass', inst.bass_synth, s + i * .5, .42, root + (12 if i % 2 else 0), .8, human=.002)
            v = voicing(cc, 59, 74, prev); prev = v
            for m in v:
                P.note('pad', inst.saw_stack, s, d - .05, m, .4, voices=5, detune=14, cutoff=1500, attack=.25,
                       release=.4)
            av = voicing(cc, 66, 83, None, size=4)
            for i in range(int(d * 4)):
                if bar >= 2:
                    P.note('arp', inst.saw_stack, s + i * .25, .2, av[[0, 1, 2, 3, 2, 1][i % 6]], .35, voices=1,
                           cutoff=2200, attack=.003, release=.08, human=.001)
        P.hit('kick', inst.kick, b, .9); P.hit('kick', inst.kick, b + 2, .85); P.hit('kick', inst.kick, b + 2.5, .5)
        P.hit('snr', inst.clap, b + 1, .7); P.hit('snr', inst.clap, b + 3, .7)
        P.hit('snr', inst.snare, b + 1, .3, tone=200, bright=4000); P.hit('snr', inst.snare, b + 3, .3, tone=200, bright=4000)
        for i in range(8):
            P.hit('hat', inst.hat, b + i * .5, .6 if i % 2 else .35, human=.002)
    mel, _ = flat(THEME_A)
    for s, d, m in mel:
        P.note('lead', inst.saw_stack, 16 + s, d * .95, m + 12, .55, voices=2, detune=7, cutoff=2400, attack=.03,
               release=.3)
    # sidechain-style pump on the pad (periodic, follows the kick on every beat)
    L = P.L; beat = L / 64
    ph = (np.arange(L) % beat) / beat
    P.tracks['pad']['buf'] *= .55 + .45 * np.minimum(1, ph / .35) ** 1.5
    y = P.mix(t60=1.5, damp=4000, predelay=.03)
    return y, P


# ------------------------------------------------------------------------------------------------ Wanderers' Hall
def wanderers_hall():
    """A great glass pavilion: soft flue organ on the theme harmony, glass harmonica melody high and slow,
    distant choir; huge reverb. 72 bpm, 8 bars."""
    P = Piece('wanderers_hall', 72, 32, seed=61)
    P.track('org', .55, .6, eq=lp(3500)); P.track('glass', .55, .65); P.track('ch', .3, .7, eq=lp(3500))
    mel, ch = flat(THEME_A)
    prev = None
    for s, d, c in ch:
        v = voicing(c, 55, 71, prev, size=4); prev = v
        for m in v:
            P.note('org', inst.organ, s, d - .05, m, .45, stops=((1, 1.0), (2, .35), (4, .1), (.5, .3)),
                   attack=.15, release=.6)
        P.note('org', inst.organ, s, d - .05, chord_root(c) + 36 if chord_root(c) >= 5 else chord_root(c) + 48, .5,
               stops=((1, 1.0), (2, .2), (.5, .5)), attack=.2, release=.6)
        P.note('ch', inst.choir, s, d, voicing(c, 64, 72, None, size=1)[0] if voicing(c, 64, 72, None, size=1) else 66,
               .3, vowel='a', attack=.9, voices=3)
    for s, d, m in mel:
        P.note('glass', inst.glassharp, s, d * .9, m + 12, .45, attack=.12, release=1.0)
    y = P.mix(t60=4.8, damp=3000, predelay=.05)
    return y, P


DOOR_PHRASES = [  # twelve doors, twelve worlds: (instrument, kwargs, notes [(beat, dur, pitch)]), 90 bpm
    ('musicbox', {}, [(0, .5, 'D6'), (.5, .5, 'F#6'), (1, .5, 'A6'), (1.5, .5, 'B6'), (2, 1.5, 'A6')]),
    ('harp', {}, [(0, .33, 'D4'), (.33, .33, 'A4'), (.66, .33, 'D5'), (1, .33, 'E5'), (1.33, 1.5, 'F#5')]),
    ('celesta', {}, [(0, .5, 'B5'), (.5, .5, 'A5'), (1, .5, 'F#5'), (1.5, 1.5, 'E5')]),
    ('glassharp', {}, [(0, 1, 'A5'), (.8, 1, 'D6'), (1.6, 1.8, 'E6')]),
    ('shakuhachi', {}, [(0, 1, 'B4'), (1, .5, 'A4'), (1.5, 1.6, 'F#4')]),
    ('choir', {'vowel': 'a'}, [(0, 2.6, 'D5'), (0, 2.6, 'A4'), (0, 2.6, 'F#4')]),
    ('koto', {}, [(0, .25, 'E5'), (.25, .25, 'F#5'), (.5, 1, 'A5'), (1.5, .5, 'F#5'), (2, 1.2, 'E5')]),
    ('glock', {}, [(0, .25, 'D6'), (.25, .25, 'E6'), (.5, .25, 'F#6'), (.75, .25, 'A6'), (1, 1.5, 'D7')]),
    ('handbell', {}, [(0, 1, 'A5'), (1, 1, 'F#5'), (2, 1.5, 'D5')]),
    ('flute', {'kind': 'flute'}, [(0, .5, 'F#5'), (.5, .5, 'E5'), (1, .5, 'D5'), (1.5, .5, 'B4'), (2, 1.2, 'D5')]),
    ('epiano', {}, [(0, .5, 'B4'), (.5, .5, 'D5'), (1, .5, 'F#5'), (1.5, 1.5, 'A5')]),
    ('strings', {}, [(0, 1, 'D5'), (1, 1, 'E5'), (2, 1.6, 'A4')]),
]


def door_phrase(i):
    name, kw, notes = DOOR_PHRASES[i]
    fn = {'musicbox': inst.musicbox, 'harp': inst.harp, 'celesta': inst.celesta, 'glassharp': inst.glassharp,
          'shakuhachi': lambda f, d, v, r: inst.flute(f, d, v, r, kind='shakuhachi'),
          'choir': lambda f, d, v, r, **k: inst.choir(f, d, v, r, voices=3, **k),
          'koto': inst.koto, 'glock': inst.glock,
          'handbell': lambda f, d, v, r: inst.bell(f, d, v, r, decay=2.0, kind='hand'),
          'flute': lambda f, d, v, r, **k: inst.flute(f, d, v, r, **k), 'epiano': inst.epiano,
          'strings': lambda f, d, v, r: inst.section(f, d, v, r, kind='violin', attack=.3)}[name]
    P = Piece('door%02d' % i, 90, 12, seed=70 + i)
    P.track('x', 1.0, .45)
    for b, d, p in notes:
        P.note('x', fn, b, d, n(p), .7, **kw)
    return _oneshot(P.mix(t60=3.0, damp=3000, predelay=.03), 3.6), P


# ------------------------------------------------------------------------------------------------ Brinewatch
def brine_shanty():
    """The Brine & Barrel: 'Drunken Sailor' (traditional, public domain) arranged in E dorian at 144 bpm:
    concertina lead with oom-pah chords and a stomping drum, then a fiddle takes the tune. 16 bars."""
    P = Piece('brine_shanty', 144, 64, seed=81)
    P.track('con', .75, .2); P.track('fid', .75, .25); P.track('chd', .5, .15); P.track('bass', .6, .1)
    P.track('stomp', .8, .12, eq=lp(3000)); P.track('tam', .25, .15)
    mel, ch = flat(SAILOR)
    for rep in range(2):
        o = rep * 32
        for s, d, m in mel:
            if rep == 0:
                P.note('con', inst.reed, o + s, d * .85, m, .75, kind='concertina')
            else:
                P.note('fid', inst.bowed, o + s, d * .9, m + 12, .7, kind='fiddle', attack=.04, release=.12, vib=10)
                P.note('con', inst.reed, o + s, d * .85, m, .45, kind='concertina')
        for s, d, c in ch:
            root = chord_root(c) + 36
            if root < 40: root += 12
            v = voicing(c, 55, 67)
            for k in range(0, int(d), 2):
                P.note('bass', inst.reed, o + s + k, .8, root, .7, kind='accordion')
                for m in v:
                    P.note('chd', inst.reed, o + s + k + 1, .6, m, .45, kind='accordion')
    for b in range(64):
        P.hit('stomp', inst.drum, b, .85 if b % 2 == 0 else .5, f=70 if b % 2 == 0 else 120, decay=.35, slap=.2)
        if b >= 32 and b % 2:
            P.hit('tam', inst.tambourine, b, .6)
    y = P.mix(t60=1.0, damp=2200, predelay=.01)
    return y, P


# ------------------------------------------------------------------------------------------------ Lantern Row
def lantern_market():
    """Night market: koto on the theme (pentatonic as written) with grace notes, shamisen pulse on open fifths,
    shakuhachi breathing long notes, a low bowed drone. 72 bpm, 8 bars (no Western chords)."""
    P = Piece('lantern_market', 72, 32, seed=91)
    P.track('koto', 1.0, .35); P.track('sham', .45, .25); P.track('shaku', .35, .45); P.track('drone', .25, .4)
    mel, _ = flat(THEME_A)
    for s, d, m in mel:
        if d >= 2:
            P.note('koto', inst.koto, s - .12, .12, _penta_step(m, -1), .35)   # grace note from below
        P.note('koto', inst.koto, s, d, m, .7)
        if d >= 2:   # koto 'echo' an octave below on the off-beat
            P.note('koto', inst.koto, s + 1, d - 1, m - 12, .3)
    roots = [n('D3'), n('D3'), n('B2'), n('A2'), n('D3'), n('B2'), n('E3'), n('D3')]
    for bar, r in enumerate(roots):
        for i, (t, k) in enumerate([(0, 0), (1.5, 7), (2, 12), (3, 7)]):
            P.note('sham', inst.shamisen, bar * 4 + t, .5, r + k if (r + k) % 12 in PENTA else r + 12, .5 - .1 * (i % 2))
    for s, d, p in [(4, 3.5, 'D5'), (13, 2.5, 'A4'), (20, 3.5, 'F#5'), (28, 3.5, 'E5')]:
        P.note('shaku', inst.flute, s, d, n(p), .6, kind='shakuhachi')
    P.note('drone', inst.bowed, 0, 32, n('D3'), .4, kind='cello', attack=.01, release=.01, vib=3)
    y = P.mix(t60=2.0, damp=2500, predelay=.02)
    return y, P


# ------------------------------------------------------------------------------------------------ Rosewick
def rosewick_waltz():
    """The Moonlit Promenade: a slow string waltz (3/4, q = 108) on the theme; violins lead, violas on 2 and 3,
    cello on 1, harp rolls at phrase starts. 16 bars."""
    P = Piece('rosewick_waltz', 108, 48, seed=101)
    P.track('vln', .8, .35); P.track('vla', .45, .3, eq=lp(4000)); P.track('vc', .6, .25); P.track('harp', .45, .35)
    mel, ch = compound(THEME_A)                     # 48 quarter beats = 16 bars of 3/4
    for s, d, m in mel:
        P.note('vln', inst.section, s, d * .97, m + 12, .62, kind='violin', attack=.14, vib=14, voices=3)
    prev = None
    for s, d, c in ch:
        v = voicing(c, 55, 69, prev); prev = v
        root = chord_root(c) + 36
        if root < 40: root += 12
        for bar in range(0, int(d), 3):
            b = s + bar
            P.note('vc', inst.section, b, 1.8, root, .6, kind='cello', attack=.06, voices=2)
            for k in (1, 2):
                for m in v:
                    P.note('vla', inst.section, b + k, .7, m, .38, kind='viola', attack=.04, release=.15, voices=2)
    for b in (0, 12, 24, 36):
        c = _chord_at(ch, b)
        for i, m in enumerate(voicing(c, 50, 79, None, size=6) or []):
            P.note('harp', inst.harp, b + i * .12, 2, m, .4)
    y = P.mix(t60=2.2, damp=3000, predelay=.025)
    return y, P


def carousel_organ():
    """Pavilion of Wings: a band-organ waltz (q = 144) on the full theme: pipe melody doubled by glockenspiel,
    oom-pah-pah bass and chord pipes, bass drum on 1 and a light snare. 32 bars = 40 s."""
    P = Piece('carousel_organ', 144, 96, seed=111)
    P.track('pipe', .8, .2); P.track('glk', .35, .2); P.track('acc', .45, .15); P.track('bass', .6, .1)
    P.track('bd', .55, .1, eq=lp(2000)); P.track('sn', .2, .1)
    mel, ch = compound(THEME)
    for s, d, m in mel:
        P.note('pipe', inst.reed, s, d * .9, m + 12, .7, kind='bandorgan')
        P.note('glk', inst.glock, s, d, m + 12, .45, decay=.9)
    prev = None
    for s, d, c in ch:
        v = voicing(c, 57, 69, prev); prev = v
        root = chord_root(c) + 36
        if root < 40: root += 12
        for bar in range(0, int(d), 3):
            b = s + bar
            P.note('bass', inst.reed, b, .9, root, .7, kind='bandorgan')
            P.hit('bd', inst.drum, b, .7, f=60, decay=.4, slap=.15)
            for k in (1, 2):
                P.hit('sn', inst.snare, b + k, .3, tone=220, decay=.08)
                for m in v:
                    P.note('acc', inst.reed, b + k, .55, m, .4, kind='bandorgan')
    y = P.mix(t60=.9, damp=2500, predelay=.01)
    return y, P


LOOPS = {
    'gate_welcome': gate_welcome, 'lake_hush': lake_hush, 'guild_tavern': guild_tavern, 'frost_court': frost_court,
    'frost_drum': frost_drum, 'meridian_signal': meridian_signal, 'wanderers_hall': wanderers_hall,
    'brine_shanty': brine_shanty, 'lantern_market': lantern_market, 'rosewick_waltz': rosewick_waltz,
    'carousel_organ': carousel_organ,
}
