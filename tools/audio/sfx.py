"""Synthesised ambience textures (periodic loops) and one-shot effects. Field recordings are handled in beds.py."""
import numpy as np
from lib.dsp import (SR, TAU, samples, pnoise, band, pink, slow_lfo, pfilter, circ_conv, reverb_ir, add_at, filt,
                     lp, hp, bp, peak, chain, fade, mtof)
from lib import inst


def _t(n):
    return np.arange(n) / SR


def _norm(x, peak_db=-3.0):
    return x / (np.max(np.abs(x)) + 1e-12) * 10 ** (peak_db / 20)


def _pan(x, p):
    """mono -> stereo, p in [-1, 1], equal power"""
    a = (p + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)], 1)


# ======================================================================== periodic textures (L samples)
def wind(L, seed, lo=60, hi=900, gust=.6, whistle=0.0, ch=2):
    """Wind: band-limited pink noise with slow periodic gusts; optional faint whistle band (snow, heights)."""
    base = pnoise(L, seed, pink(lo, hi, 2), ch)
    g = 1 + gust * slow_lfo(L, seed + 1, (1, 2, 3, 5, 7))
    g2 = 1 + gust * slow_lfo(L, seed + 2, (2, 3, 4, 6))
    hi_band = pnoise(L, seed + 3, band(hi * .8, hi * 2.5, 2), ch) * .25
    x = base * g[:, None] + hi_band * (np.maximum(g2, 0) ** 2)[:, None]
    if whistle:
        wl = pnoise(L, seed + 4, lambda f: np.exp(-((f - 700) / 60) ** 2) + np.exp(-((f - 1050) / 80) ** 2), ch)
        x += whistle * wl * (np.maximum(g, 0) ** 3)[:, None]
    return x if ch == 2 else x[:, 0]


def leaves(L, seed):
    """Breeze in leaves: rustle = high-passed noise with fast random amplitude, swelling with the gusts."""
    x = pnoise(L, seed, band(1500, 7000, 2), 2)
    flick = np.abs(pnoise(L, seed + 1, band(4, 30, 2), 1))
    g = np.maximum(0, .4 + .6 * slow_lfo(L, seed + 2, (1, 2, 3)))
    return x * (flick * g)[:, None]


def crickets(L, seed, n=14, density=1.0, dist=1.0):
    """Field crickets: pulsed chirps (3-4 pulses of a 3.6-4.6 kHz carrier), each insect its own rate and place.
    Pulsed, low-level and low-passed so nothing is a sustained piercing tone."""
    rng = np.random.default_rng(seed)
    out = np.zeros((L, 2))
    for k in range(n):
        f = rng.uniform(3600, 4600)
        period = rng.uniform(.45, .9) / density
        npulse = rng.integers(2, 5)
        pl = samples(.014)
        pulse = np.sin(TAU * f * _t(pl)) * np.hanning(pl)
        chirp = np.zeros(samples(.03) * npulse + pl)
        for p in range(npulse):
            chirp[p * samples(.03):p * samples(.03) + pl] += pulse
        amp = rng.uniform(.2, 1) * (1 if rng.random() < .3 else .4)
        pan = rng.uniform(-.9, .9)
        mono = np.zeros(L)
        t = rng.uniform(0, period)
        on = rng.random() < .8
        while t < L / SR:
            if on:
                add_at(mono, chirp * amp * rng.uniform(.8, 1), int(t * SR))
            t += period * rng.uniform(.97, 1.03)
            if rng.random() < .03:
                on = not on
        out += _pan(mono, pan)
    out = pfilter(out, chain(lp(5200), lp(6500)))
    chorus = pnoise(L, seed + 9, lambda f: np.exp(-((f - 4200) / 350) ** 2), 2) * .05 * dist
    return out + chorus


def hum(L, seed, f0=120.0, level=1.0):
    """Neon / transformer hum: a few low harmonics with slow beating, plus a faint buzz band."""
    t = np.arange(L) / SR
    x = np.zeros(L)
    # integer cycles over the loop keep it periodic
    for k, a in [(1, 1), (2, .45), (3, .25), (5, .08)]:
        f = round(f0 * k * L / SR) * SR / L
        x += a * np.sin(TAU * f * t + k)
    x *= 1 + .1 * slow_lfo(L, seed, (3, 5))
    buzz = pnoise(L, seed + 1, lambda f: np.exp(-((f - 2400) / 500) ** 2), 1) * .03
    return np.stack([x + buzz, x * .9 + buzz], 1) * level


def chimes(L, seed, notes=(86, 88, 90, 93, 95, 98), rate=.6, width=.8):
    """Wind chimes tuned to D major pentatonic (D6 E6 F#6 A6 B6 D7): clusters of strikes when the gusts come."""
    rng = np.random.default_rng(seed)
    out = np.zeros((L, 2))
    g = np.maximum(0, slow_lfo(L, seed + 1, (1, 2, 3)))
    t = 0.0
    while t < L / SR:
        if rng.random() < g[int(t * SR)] * .9 + .1:
            m = rng.choice(notes)
            x = inst.bell(float(mtof(m)), .1, rng.uniform(.25, .7), rng, decay=1.6, kind='hand')
            add_at(out, _pan(x, rng.uniform(-width, width)), int(t * SR))
        t += rng.exponential(1 / rate)
    return pfilter(out, lp(7500))


def gurgle(L, seed, rate=3.0, lo=250, hi=1100):
    """Small water: random short resonant 'blips' (bubbles) with rising pitch, scattered over the loop."""
    rng = np.random.default_rng(seed)
    out = np.zeros((L, 2))
    t = 0.0
    while t < L / SR:
        f = rng.uniform(lo, hi); d = rng.uniform(.02, .07)
        n = samples(d)
        ff = f * (1 + .8 * _t(n) / d)
        x = np.sin(np.cumsum(TAU * ff / SR)) * np.exp(-_t(n) / (d / 3)) * rng.uniform(.2, 1)
        add_at(out, _pan(x, rng.uniform(-.8, .8)), int(t * SR))
        t += rng.exponential(1 / rate)
    return out


def lapping(L, seed, rate=.7, dark=900):
    """Water lapping: slow swells of low-passed noise (each a little wave meeting stone) plus bubbles."""
    rng = np.random.default_rng(seed)
    out = np.zeros((L, 2))
    t = 0.0
    while t < L / SR:
        d = rng.uniform(.5, 1.4)
        n = samples(d)
        e = np.sin(np.pi * np.minimum(1, _t(n) / d)) ** 2 * np.exp(-_t(n) / (d * .6))
        x = filt(rng.normal(size=(n, 2)), chain(bp(rng.uniform(250, dark), .7), lp(dark * 2)))
        add_at(out, x * e[:, None] * rng.uniform(.4, 1), int(t * SR))
        t += rng.exponential(1 / rate) + .2
    return out + gurgle(L, seed + 1, 2.0) * .15


def crackle(L, seed, rate=40.0, roar=.5):
    """Torch / brazier: dense tiny pops + a few bigger snaps over a soft low roar."""
    rng = np.random.default_rng(seed)
    out = np.zeros((L, 2))
    t = 0.0
    while t < L / SR:
        big = rng.random() < .06
        n = samples(.004 if not big else .02)
        x = rng.normal(size=n) * np.exp(-_t(n) / (.0008 if not big else .004)) * (rng.uniform(.1, .4) if not big else 1)
        add_at(out, _pan(x, rng.uniform(-.5, .5)), int(t * SR))
        t += rng.exponential(1 / rate)
    out = pfilter(out, chain(hp(500), lp(7000)))
    r = pnoise(L, seed + 1, pink(40, 400, 2), 2) * roar * .3 * (1 + .3 * slow_lfo(L, seed + 2, (3, 5, 8)))[:, None]
    return out + r


def babble(L, seed, voices=40, lp_hz=2500.0):
    """Fallback crowd murmur: many formant 'voices' with syllable-rate envelopes, unintelligible by design."""
    rng = np.random.default_rng(seed)
    out = np.zeros((L, 2))
    t = np.arange(L) / SR
    vowels = list(inst.VOWELS.values())
    for v in range(voices):
        f0 = rng.uniform(95, 230)
        cyc = max(1, int(round(rng.uniform(1.0, 3.0) * L / SR)))   # intonation cycles over the loop
        pitch = f0 * (1 + .12 * np.sin(TAU * cyc * t / (L / SR) + rng.uniform(0, TAU)))
        ph = np.cumsum(TAU * pitch / SR)
        src = sum(np.sin(ph * k) / k ** 1.2 for k in range(1, 18))
        syl = np.maximum(0, pnoise(L, seed * 100 + v, band(2.5, 6, 2), 1))
        talk = (pnoise(L, seed * 100 + v + 50, band(.05, .25, 2), 1) > .2).astype(float)
        talk = np.convolve(np.concatenate([talk[-2000:], talk]), np.ones(2000) / 2000, 'valid')[:L]
        fm = vowels[v % len(vowels)]
        y = sum(filt(src, bp(fc * rng.uniform(.9, 1.15), 4)) * 10 ** (g / 20) for fc, g, _ in fm[:3])
        out += _pan(y * syl * talk, rng.uniform(-.9, .9))
    return pfilter(out, chain(lp(lp_hz), hp(120)))


# ======================================================================== one-shots
def footstep(kind, seed):
    rng = np.random.default_rng(seed)
    if kind == 'stone':
        n = samples(.18)
        x = filt(rng.normal(size=n), chain(bp(rng.uniform(1500, 2600), 1.2), lp(7000))) * np.exp(-_t(n) / .012)
        x += np.sin(TAU * rng.uniform(90, 130) * _t(n)) * np.exp(-_t(n) / .025) * .5
        heel = np.roll(x * .5, samples(rng.uniform(.03, .05)))
        x = x + heel
    elif kind == 'wood':
        n = samples(.25)
        x = filt(rng.normal(size=n), chain(bp(rng.uniform(250, 450), 3), lp(4000))) * np.exp(-_t(n) / .04) * 2
        x += filt(rng.normal(size=n), bp(1800, 1.5)) * np.exp(-_t(n) / .006) * .4
        x += np.sin(TAU * rng.uniform(140, 190) * _t(n)) * np.exp(-_t(n) / .05) * .6
    elif kind == 'snow':
        n = samples(.32)
        x = np.zeros(n)
        for g in range(120):
            p = int(rng.beta(1.5, 3) * (n - 400))
            gl = rng.integers(40, 300)
            x[p:p + gl] += rng.normal(size=gl) * np.hanning(gl) * rng.uniform(.2, 1)
        x = filt(x, chain(hp(700), lp(6500), peak(2500, 4, 1)))
        x *= np.minimum(1, _t(n) / .02)
    else:  # grass
        n = samples(.3)
        x = filt(rng.normal(size=n), chain(bp(rng.uniform(2500, 4000), .8), lp(7000)))
        x *= np.sin(np.pi * np.minimum(1, _t(n) / .22)) ** 2
        x += filt(rng.normal(size=n), bp(300, 1)) * np.exp(-_t(n) / .02) * .4
    return fade(_norm(x, -3), .001, .03)


def firework_launch(seed):
    rng = np.random.default_rng(seed)
    n = samples(2.2)
    t = _t(n)
    thump = np.sin(TAU * np.cumsum(60 + 80 * np.exp(-t / .02)) / SR) * np.exp(-t / .08)
    nz = rng.normal(size=n)
    # rising whoosh: band-pass sweep approximated by summing short segments
    out = np.zeros(n)
    seg = samples(.05)
    for i in range(0, n - seg, seg // 2):
        fc = 400 + 2200 * (i / n) ** 1.5
        w = np.hanning(seg)
        out[i:i + seg] += filt(nz[i:i + seg], bp(fc, 2.5)) * w
    env = np.minimum(1, t / .05) * np.exp(-t / 1.2)
    x = thump * .8 + out * env * .6
    x = np.stack([x, x], 1)
    ir = reverb_ir(2.5, seed=seed, ch=2, damp=1500)
    from scipy.signal import fftconvolve
    y = x * .7 + fftconvolve(x, ir, axes=0)[:n] * .3
    return fade(_norm(y.mean(1), -3), .001, .2)


def firework_burst(seed, big=True):
    rng = np.random.default_rng(seed)
    n = samples(4.0)
    t = _t(n)
    boom = filt(rng.normal(size=n), chain(lp(rng.uniform(250, 500)), hp(25))) * np.exp(-t / (.25 if big else .12)) * 3
    boom += np.sin(TAU * np.cumsum(38 + 40 * np.exp(-t / .05)) / SR) * np.exp(-t / .3) * (1.2 if big else .5)
    crack = np.zeros(n)
    k = 0
    tt = rng.uniform(.15, .4)
    while tt < 3.0:
        m = samples(.003)
        add_at(crack, rng.normal(size=m) * np.exp(-_t(m) / .0006) * rng.uniform(.2, 1) * np.exp(-(tt - .3) / 1.1), int(tt * SR))
        tt += rng.exponential(1 / (60 if big else 25))
    crack = filt(crack, chain(hp(800), lp(7000)))
    x = boom + crack * 1.2
    ir = reverb_ir(3.0, seed=seed + 3, ch=1, damp=1200, predelay=.05)
    from scipy.signal import fftconvolve
    y = x + fftconvolve(x, ir)[:n] * .5
    return fade(_norm(y, -3), .001, .4)


def splash(seed, size=1.0):
    rng = np.random.default_rng(seed)
    n = samples(.9)
    t = _t(n)
    x = filt(rng.normal(size=n), chain(bp(rng.uniform(700, 1400), .6), lp(6000))) * np.exp(-t / (.08 * size))
    x *= np.minimum(1, t / .004)
    for k in range(rng.integers(4, 9)):       # droplets
        st = rng.uniform(.05, .6); d = rng.uniform(.015, .04); m = samples(d)
        f = rng.uniform(900, 2400)
        b = np.sin(np.cumsum(TAU * f * (1 + 1.2 * _t(m) / d) / SR)) * np.exp(-_t(m) / (d / 3))
        add_at(x, b * rng.uniform(.1, .35), int(st * SR))
    x += filt(rng.normal(size=n), lp(300)) * np.exp(-t / .1) * .5
    return fade(_norm(x, -3), .001, .1)


def oar(seed):
    rng = np.random.default_rng(seed)
    n = samples(1.4)
    t = _t(n)
    e = np.sin(np.pi * np.minimum(1, t / 1.0)) ** 1.5 * np.exp(-t / 1.2)
    x = filt(rng.normal(size=n), chain(bp(rng.uniform(400, 700), .7), lp(3000))) * e
    for k in range(10):
        st = rng.uniform(.1, 1.1); d = rng.uniform(.02, .06); m = samples(d)
        f = rng.uniform(300, 900)
        b = np.sin(np.cumsum(TAU * f * (1 + 1.0 * _t(m) / d) / SR)) * np.exp(-_t(m) / (d / 3))
        add_at(x, b * rng.uniform(.05, .2), int(st * SR))
    x += filt(rng.normal(size=n), bp(220, 3)) * np.exp(-((t - .05) / .05) ** 2) * .2   # oar knocks the gunwale
    return fade(_norm(x, -3), .01, .15)


def lantern_release(seed):
    """A hush as a wave of paper lanterns lifts off: airy swell, soft paper crinkles, one high glass note."""
    rng = np.random.default_rng(seed)
    n = samples(3.5)
    t = _t(n)
    air = filt(rng.normal(size=n), chain(bp(900, .5), lp(3500))) * np.sin(np.pi * t / 3.5) ** 2
    crink = np.zeros(n)
    for k in range(60):
        m = samples(.006)
        add_at(crink, rng.normal(size=m) * np.hanning(m) * rng.uniform(.1, .5), int(rng.uniform(.2, 3.0) * SR))
    crink = filt(crink, chain(hp(2000), lp(7000)))
    note = inst.glassharp(float(mtof(rng.choice([81, 83, 86]))), 1.2, .3, rng, attack=.5)[:n]
    x = air * .6 + crink * .5
    x[:note.size] += note * .5
    return fade(_norm(x, -3), .05, .5)


def ui_click(seed):
    rng = np.random.default_rng(seed)
    x = inst.woodblock(.8, rng, f=1400 + 200 * seed, decay=.012)[:samples(.08)]
    return fade(_norm(x, -3), .0005, .02)


def train_loop(L, seed):
    """Monorail running loop (mono, the engine moves and Doppler-shifts it): motor whine (two steady partials),
    rubber-tyre rumble, a faint rhythmic joint every 1 s, air rush."""
    rng = np.random.default_rng(seed)
    t = np.arange(L) / SR
    def ip(f):  # integer cycles per loop -> periodic
        return round(f * L / SR) * SR / L
    whine = (np.sin(TAU * ip(310) * t) * .5 + np.sin(TAU * ip(620) * t + 1) * .25 + np.sin(TAU * ip(930) * t) * .08)
    whine *= 1 + .05 * slow_lfo(L, seed, (2, 3))
    rumble = pnoise(L, seed + 1, pink(35, 260, 2), 1) * 1.2
    rush = pnoise(L, seed + 2, band(400, 3000, 1.5), 1) * .45
    joints = np.zeros(L)
    for k in range(int(L / SR)):
        for dt in (0, .09):
            m = samples(.05)
            add_at(joints, filt(rng.normal(size=m), lp(400)) * np.exp(-_t(m) / .01) * 1.5, int((k + dt) * SR))
    return whine * .25 + rumble + rush + joints


def anvil(seed):
    """Hammer on anvil: bright inharmonic ring, short so it does not pierce."""
    rng = np.random.default_rng(seed)
    n = samples(1.6)
    t = _t(n)
    f = rng.uniform(820, 980)
    x = sum(a * np.sin(TAU * f * r * t + rng.uniform(0, TAU)) * np.exp(-t / d)
            for r, a, d in [(1, 1, .35), (2.76, .5, .18), (5.4, .25, .08), (8.9, .1, .04)] if f * r < 9000)
    x += filt(rng.normal(size=n), chain(bp(3000, 1), lp(8000))) * np.exp(-t / .004) * .8
    return fade(_norm(filt(x, lp(8000)), -3), .0005, .2)


def strength_bell(seed):
    """High striker: wooden thunk, the puck's rattle up the rail, and the bell's ding."""
    rng = np.random.default_rng(seed)
    n = samples(2.6)
    x = np.zeros(n)
    x[:samples(.3)] += inst.drum(.9, rng, f=110, decay=.15, slap=.6)[:samples(.3)]
    for k in range(10):
        add_at(x, inst.woodblock(.15, rng, f=2000 + k * 60, decay=.004)[:samples(.03)], samples(.05 + k * .035))
    b = inst.bell(float(mtof(81)), .1, .9, rng, decay=1.5, kind='hand')[:n - samples(.45)]
    x[samples(.45):samples(.45) + b.size] += b
    return fade(_norm(x, -3), .001, .3)


def ship_bell(seed):
    rng = np.random.default_rng(seed)
    n = samples(4.0)
    x = np.zeros(n)
    for k, st in enumerate([0, .45, 1.6, 2.05]):      # two pairs: 'ding-ding, ding-ding'
        b = inst.bell(float(mtof(81)), .1, .9 - .1 * (k % 2), rng, decay=1.6, kind='ship')
        add_at(x, b[:n], samples(st))
    return fade(_norm(x[:n], -3), .001, .4)


def spire_bell(seed):
    """The Spire: a deep church-type bell (D3) struck three times, slow."""
    rng = np.random.default_rng(seed)
    n = samples(10.0)
    x = np.zeros(n)
    for st in (0, 2.4, 4.8):
        b = inst.bell(float(mtof(50)), .1, .9, rng, decay=5.0, kind='church')
        add_at(x, b[:n - samples(st)], samples(st))
    return fade(_norm(filt(x, lp(6000)), -3), .001, 1.5)


def shrine_bell(seed):
    """Shrine bell (suzu rope bell + one deep temple bell stroke)."""
    rng = np.random.default_rng(seed)
    n = samples(6.0)
    x = np.zeros(n)
    for k in range(14):     # suzu: a little jangle of small bells
        b = inst.bell(float(mtof(rng.choice([93, 95, 98]))), .05, rng.uniform(.1, .3), rng, decay=.4, kind='hand')
        add_at(x, b[:samples(1.0)], samples(rng.uniform(0, .6)))
    tb = inst.bell(float(mtof(45)), .1, 1.0, rng, decay=3.2, kind='temple')
    add_at(x, tb[:n - samples(1.0)], samples(1.0))
    return fade(_norm(filt(x, lp(7000)), -3), .001, 1.0)


def clappers(seed):
    """Hyoshigi: two hard wooden blocks, struck twice (the night-watch call before a story)."""
    rng = np.random.default_rng(seed)
    n = samples(1.6)
    x = np.zeros(n)
    for st in (0, .55, .75):
        add_at(x, inst.woodblock(1, rng, f=rng.uniform(1100, 1250), decay=.03), samples(st))
    ir = reverb_ir(1.2, seed=seed, damp=2500)
    from scipy.signal import fftconvolve
    y = x + fftconvolve(x, ir)[:n] * .3
    return fade(_norm(y, -3), .0005, .2)


def station_chime(seed):
    """Monorail station chime: three soft tine notes descending A5-F#5-D5, then a sustained D."""
    rng = np.random.default_rng(seed)
    n = samples(3.6)
    x = np.zeros(n)
    for st, m in [(0, 81), (.45, 78), (.9, 74)]:
        add_at(x, inst.epiano(float(mtof(m)), .4, .7, rng)[:n], samples(st))
        add_at(x, inst.celesta(float(mtof(m + 12)), .4, .25, rng)[:n], samples(st))
    ir = reverb_ir(1.8, seed=seed, damp=3000)
    from scipy.signal import fftconvolve
    y = x + fftconvolve(x, ir)[:n] * .35
    return fade(_norm(y, -3), .001, .4)


def announce(seed):
    """Calm announcement: an attention tone, then a few synthesised wordless 'syllables' on a gentle contour."""
    rng = np.random.default_rng(seed)
    n = samples(3.4)
    x = np.zeros(n)
    add_at(x, inst.epiano(float(mtof(74)), .3, .5, rng)[:n], 0)
    add_at(x, inst.epiano(float(mtof(81)), .5, .5, rng)[:n], samples(.3))
    st = 1.1
    for k, (m, d) in enumerate([(57, .16), (59, .12), (57, .2), (55, .14), (57, .1), (54, .3)]):
        v = inst.voice(float(mtof(m)), d, .55, rng, vowel='aoeu'[k % 4], attack=.03, release=.06, vib=0)
        add_at(x, filt(v, chain(bp(1200, .5), lp(3400))), samples(st))
        st += d + .05
    return fade(_norm(x, -3), .001, .3)


def owl(seed):
    """Tawny-owl-like hoot: 'hoo ... hu-hu-hoooo' as a breathy sine with formant and pitch glides."""
    rng = np.random.default_rng(seed)
    n = samples(3.2)
    x = np.zeros(n)
    f0 = rng.uniform(380, 440)
    for st, d, gl in [(0, .5, .05), (1.2, .12, 0), (1.4, .12, 0), (1.62, .9, .12)]:
        m = samples(d)
        tt = _t(m)
        f = f0 * (1 + gl * np.sin(np.pi * tt / d)) * (1 - .04 * tt / d)
        h = np.sin(np.cumsum(TAU * f / SR)) + .15 * np.sin(2 * np.cumsum(TAU * f / SR))
        env = np.sin(np.pi * tt / d) ** .6 * (1 + .3 * np.sin(TAU * 18 * tt))
        add_at(x, h * env, samples(st))
    x += filt(rng.normal(size=n), bp(f0, 4)) * .05 * (np.abs(x) > .05)
    ir = reverb_ir(2.0, seed=seed, damp=1500, predelay=.03)
    from scipy.signal import fftconvolve
    y = x * .6 + fftconvolve(x, ir)[:n] * .6
    return fade(_norm(filt(y, lp(3000)), -3), .01, .4)


def dice(seed):
    rng = np.random.default_rng(seed)
    n = samples(1.3)
    x = np.zeros(n)
    t = 0.0
    for k in range(rng.integers(6, 11)):
        for die in range(2):
            add_at(x, inst.woodblock(rng.uniform(.3, 1) * np.exp(-t * 2), rng, f=rng.uniform(1800, 2600), decay=.008),
                   samples(t + die * rng.uniform(.005, .03)))
        t += rng.uniform(.04, .14) * (1 + k * .15)
    return fade(_norm(filt(x, lp(8000)), -3), .0005, .1)


def kettle(seed):
    """Cider kettle simmering: bubbles + a soft breathy steam (no whistle: no long piercing tone)."""
    rng = np.random.default_rng(seed)
    n = samples(4.0)
    t = _t(n)
    steam = filt(rng.normal(size=n), chain(bp(1800, .8), lp(5000))) * np.sin(np.pi * t / 4) ** 2 * .5
    bub = np.zeros(n)
    tt = 0.0
    while tt < 3.9:
        d = rng.uniform(.01, .03); m = samples(d); f = rng.uniform(500, 1500)
        b = np.sin(np.cumsum(TAU * f * (1 + 1.5 * _t(m) / d) / SR)) * np.exp(-_t(m) / (d / 3))
        add_at(bub, b * rng.uniform(.1, .5), samples(tt))
        tt += rng.exponential(.03)
    return fade(_norm(steam + bub, -3), .3, .8)


def skate(seed):
    """Skate blades: a long carving scrape with a sharp stop."""
    rng = np.random.default_rng(seed)
    n = samples(2.5)
    t = _t(n)
    carve = filt(rng.normal(size=n), chain(bp(rng.uniform(2200, 3200), 1.5), lp(7000)))
    e = np.sin(np.pi * np.minimum(1, t / 1.6)) ** 2 * (1 + .4 * np.sin(TAU * 1.3 * t))
    stop = filt(rng.normal(size=n), chain(bp(4000, .7), lp(8000))) * np.exp(-((t - 1.9) / .08) ** 2) * 1.5
    return fade(_norm((carve * e + stop) * .9, -3), .05, .2)


def sizzle(L, seed):
    """Food stall griddle: dense fat crackle over a hiss (periodic)."""
    rng = np.random.default_rng(seed)
    out = crackle(L, seed, rate=300, roar=0) * .6
    hiss = pnoise(L, seed + 5, band(2500, 7000, 2), 2) * .12 * (1 + .3 * slow_lfo(L, seed + 6, (3, 7)))[:, None]
    return pfilter(out + hiss, lp(8000))


def taiko_loop(L, bpm=72, seed=5):
    """Distant taiko pattern over the loop (beats at 72 bpm), heavy room."""
    rng = np.random.default_rng(seed)
    out = np.zeros(L)
    beat = 60 / bpm
    nb = int(round(L / SR / beat))
    pat = [1, 0, 0, .5, 1, 0, .4, .4, 1, 0, 0, .5, 1, .6, .8, 1]
    for i in range(nb * 2):
        v = pat[i % len(pat)]
        if v:
            add_at(out, inst.taiko(v, rng, f=58 + 6 * (i % 2)), int(i * beat / 2 * SR))
        if i % 4 == 3:
            add_at(out, inst.woodblock(.25, rng, f=700, decay=.02), int((i + .5) * beat / 2 * SR))
    return circ_conv(out, reverb_ir(2.5, seed=seed, damp=1200)) * .5 + out * .5


def ice_chimes(seed):
    """Ice chimes / glass: a little falling cluster in D major pentatonic, very high and soft."""
    rng = np.random.default_rng(seed)
    n = samples(4.0)
    x = np.zeros(n)
    notes = [86, 88, 90, 93, 95, 98]
    st = 0.0
    for k in range(rng.integers(4, 8)):
        m = notes[int(rng.integers(0, len(notes)))]
        add_at(x, inst.glock(float(mtof(m)), .1, rng.uniform(.2, .5), rng, decay=1.2)[:n], samples(st))
        st += rng.uniform(.08, .35)
    ir = reverb_ir(2.5, seed=seed, damp=4000)
    from scipy.signal import fftconvolve
    y = x * .6 + fftconvolve(x, ir)[:n] * .5
    return fade(_norm(filt(y, lp(8500)), -3), .001, .6)


def creak(seed):
    """Timber / rope creak: a slowly varying stick-slip buzz through wooden resonances."""
    rng = np.random.default_rng(seed)
    d = rng.uniform(.6, 1.3)
    n = samples(d)
    t = _t(n)
    rate = rng.uniform(25, 60) * (1 + .5 * np.sin(np.pi * t / d))
    ph = np.cumsum(rate / SR)
    pulses = (np.diff(np.floor(ph), prepend=0) > 0).astype(float)
    x = filt(pulses, chain(bp(rng.uniform(350, 700), 4), lp(3000))) + filt(pulses, bp(rng.uniform(1100, 1600), 6)) * .5
    x *= np.sin(np.pi * t / d) ** .7
    return fade(_norm(x, -3), .02, .1)
