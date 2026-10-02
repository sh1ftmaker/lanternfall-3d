"""Synthesised instruments. Each returns a mono float array for one note: f(freq_hz, dur_s, vel, rng, **kw).
The array runs past `dur` by the instrument's natural release; the sequencer folds tails around the loop.
All are additive / Karplus-Strong / filtered noise, band-limited below ~0.45 SR and mostly below 9 kHz."""
import numpy as np
from scipy import signal
from .dsp import SR, TAU, samples, filt, lp, hp, bp, peak, chain, env_adsr

NYQ_SAFE = 9000.0  # keep partials of musical sources below this (no harsh top end on point sources)


def _t(n):
    return np.arange(n) / SR


def _phase(f, n, rng, vib_rate=0.0, vib_cents=0.0, vib_delay=0.3, drift_cents=0.0, bend=None):
    """Running phase (radians) of the fundamental with delayed vibrato, slow random drift and an optional
    onset pitch bend `bend=(cents, seconds)` that glides to pitch."""
    t = _t(n)
    cents = np.zeros(n)
    if vib_cents:
        ramp = np.clip((t - vib_delay) / 0.4, 0, 1)
        cents += vib_cents * ramp * np.sin(TAU * vib_rate * t + rng.uniform(0, TAU))
    if drift_cents:
        cents += drift_cents * np.sin(TAU * rng.uniform(.2, .6) * t + rng.uniform(0, TAU))
    if bend:
        c0, tb = bend
        cents += c0 * np.exp(-t / max(tb, 1e-3))
    finst = f * 2 ** (cents / 1200)
    return np.cumsum(TAU * finst / SR)


def additive(f, n, partials, ph, amp_env=None, top=NYQ_SAFE):
    """partials: list of (ratio, amp, decay_s|None). Inharmonic ratios ok. ph = fundamental phase array."""
    t = _t(n)
    out = np.zeros(n)
    for r, a, d in partials:
        if f * r > top or a == 0:
            continue
        w = a * np.sin(ph * r + r * 1.7)
        if d:
            w = w * np.exp(-t / d)
        out += w
    if amp_env is not None:
        out *= amp_env
    return out


# ---------------------------------------------------------------- struck / plucked
def celesta(f, dur, vel, rng, decay=1.6):
    n = samples(min(dur + decay * 2.2, 6))
    ph = _phase(f, n, rng)
    p = [(1, 1.0, decay), (2, .10, decay * .3), (3, .04, decay * .2), (4, .12, decay * .15), (5.4, .03, .08)]
    x = additive(f, n, p, ph)
    att = np.minimum(1, _t(n) / 0.002)
    return x * att * vel * 0.5


def glock(f, dur, vel, rng, decay=1.8):
    n = samples(min(dur + decay * 2.5, 7))
    ph = _phase(f, n, rng)
    p = [(1, 1.0, decay), (2.76, .22, decay * .3), (5.40, .10, decay * .12), (8.93, .04, decay * .06)]
    return additive(f, n, p, ph) * np.minimum(1, _t(n) / .0015) * vel * .45


def musicbox(f, dur, vel, rng):
    n = samples(2.2)
    ph = _phase(f, n, rng)
    p = [(1, 1.0, .9), (3.0, .18, .25), (5.9, .06, .08), (2.0, .08, .4)]
    return additive(f, n, p, ph) * np.minimum(1, _t(n) / .001) * vel * .45


def bell(f, dur, vel, rng, decay=4.0, kind='church'):
    """Modal bell. kind: church (minor-third tierce), temple (soft, long hum), ship (bright, short), handbell."""
    sets = {
        'church': [(.5, .5, 1.6), (1, 1, 1.0), (1.2, .45, .55), (1.5, .3, .45), (2.0, .35, .35), (2.5, .12, .2),
                   (3.0, .1, .16), (4.06, .05, .1)],
        'temple': [(.5, .25, 1.4), (1, 1, 1.0), (1.18, .25, .5), (2.0, .3, .32), (2.73, .14, .22), (3.4, .05, .12)],
        'ship': [(1, 1, 1.0), (2.32, .5, .5), (4.25, .28, .25), (6.63, .14, .12), (9.38, .05, .06)],
        'hand': [(1, 1, 1.0), (2.0, .2, .4), (3.0, .5, .3), (4.17, .1, .15), (5.43, .08, .1)],
    }
    n = samples(decay * 2.2 + .1)
    ph = _phase(f, n, rng)
    p = [(r, a, decay * d) for r, a, d in sets[kind]]
    # tiny beating between doublet partials (real bells are not perfectly round)
    p += [(r * 1.0016, a * .5, decay * d) for r, a, d in sets[kind][:3]]
    x = additive(f, n, p, ph, top=11000)
    strike = filt(rng.normal(size=samples(.012)) * np.exp(-_t(samples(.012)) / .003), bp(f * 3, 1.5)) * .2
    x[:strike.size] += strike
    return x * np.minimum(1, _t(n) / .001) * vel * .35


def ks_pluck(f, dur, vel, rng, bright=0.5, decay=2.0, pick=0.18, body=None, stop=None):
    """Karplus-Strong string. bright 0..1 (excitation lowpass), decay = seconds to -60 dB at this pitch,
    pick = pluck position (comb), body = list of (fc, gain_db, q) resonances, stop = damp after dur (s)."""
    rate = SR * 2                                  # 2x oversampled for tuning accuracy
    D = rate / f                                   # loop delay in samples
    N = int(np.floor(D - 0.6)); fa = D - 0.5 - N   # two-tap average adds 0.5; allpass supplies fa in [0.1, 1.1)
    c = (1 - fa) / (1 + fa)                        # first-order allpass coefficient (low-freq delay = fa)
    total = min(dur + (stop if stop is not None else decay * 1.2), 8)
    n2 = int(total * rate)
    g = 10 ** (-3 / (decay * f))                   # per-period loss to reach -60 dB in `decay` s
    exc = rng.uniform(-1, 1, N + 2)
    sos = lp(800 + 9000 * bright ** 1.5)           # biquad designed for SR; at 2x rate fc doubles: fine as tone control
    exc = signal.sosfilt(sos, exc)
    if pick:
        k = max(1, int(pick * N)); exc = exc - np.concatenate([np.zeros(k), exc[:-k]])
    x = np.zeros(n2); x[:exc.size] = exc
    # loop: y = x + g * avg(z) * allpass(z) * z^-N * y  ->  y * (1 + c z^-1 - g/2 (1 + z^-1)(c + z^-1) z^-N) = x (1 + c z^-1)
    a = np.zeros(N + 3); a[0] = 1; a[1] += c
    a[N] -= g / 2 * c; a[N + 1] -= g / 2 * (1 + c); a[N + 2] -= g / 2
    y = signal.lfilter([1.0, c], a, x)
    if stop is not None:
        t2 = np.arange(n2) / rate
        y *= np.where(t2 < dur, 1, np.exp(-(t2 - dur) / max(stop / 5, 1e-3)))
    y = signal.resample_poly(y, 1, 2)
    y = filt(y, chain(hp(f * .5), lp(min(NYQ_SAFE, f * 12 + 1500))))
    if body:
        y = filt(y, chain(*[peak(fc, gdb, q) for fc, gdb, q in body]))
    y *= np.minimum(1, _t(y.size) / .0015)
    return y / (np.max(np.abs(y)) + 1e-9) * vel * .55


def lute(f, dur, vel, rng):
    return ks_pluck(f, dur, vel, rng, bright=.45, decay=1.8, pick=.2,
                    body=[(220, 4, 1.2), (480, 3, 1.5), (2600, -4, .7)], stop=.35)


def harp(f, dur, vel, rng):
    return ks_pluck(f, dur, vel, rng, bright=.35, decay=3.2, pick=.3, body=[(300, 3, 1), (1800, -3, .8)])


def koto(f, dur, vel, rng):
    y = ks_pluck(f, dur, vel, rng, bright=.7, decay=2.4, pick=.12, body=[(350, 3, 1.2), (1400, 3, 2), (3500, -5, .7)])
    return y


def shamisen(f, dur, vel, rng):
    # bright, buzzy (sawari): short decay plus a touch of soft-clipped buzz
    y = ks_pluck(f, dur, vel, rng, bright=.85, decay=1.0, pick=.08, body=[(600, 4, 2), (2200, 3, 2)], stop=.25)
    y = np.tanh(y * 2.2) / 2.2 * 1.6
    return filt(y, lp(6500))


def guitarish(f, dur, vel, rng):
    return ks_pluck(f, dur, vel, rng, bright=.5, decay=2.5, pick=.22, body=[(110, 4, 1.3), (250, 3, 1.4)], stop=.3)


# ---------------------------------------------------------------- sustained (bowed, blown, reeds, organ, voice)
def _sus_env(n, dur, a, r, s_dip=0.0):
    t = _t(n)
    e = np.minimum(1, t / max(a, 1e-3)) ** 1.5
    e = e * np.where(t < dur, 1, np.exp(-(t - dur) / max(r / 4, 1e-3)))
    if s_dip:
        e *= 1 - s_dip * np.exp(-((t - dur * .5) / (dur * .5 + 1e-3)) ** 2)
    return e


def _harm(f, kmax, slope=1.0, top=NYQ_SAFE, formants=()):
    ks = np.arange(1, kmax + 1)
    ks = ks[ks * f < top]
    amp = 1 / ks ** slope
    for fc, gdb, bw in formants:
        amp = amp * 10 ** (gdb / 20 * np.exp(-((ks * f - fc) / bw) ** 2))
    return ks, amp


def bowed(f, dur, vel, rng, attack=.18, release=.35, vib=12, kind='violin'):
    """Bowed string: band-limited saw with body resonances, delayed vibrato, bow noise."""
    n = samples(dur + release + .05)
    ph = _phase(f, n, rng, vib_rate=rng.uniform(5.0, 5.8), vib_cents=vib, vib_delay=.25, drift_cents=3)
    body = {'violin': [(450, 5, 200), (2900, 4, 900), (1200, -3, 300)],
            'viola': [(380, 5, 180), (2200, 3, 800)],
            'cello': [(220, 6, 120), (600, 3, 300), (2000, 2, 700)],
            'fiddle': [(500, 6, 220), (3000, 6, 900)]}[kind]
    ks, amp = _harm(f, 40, slope=1.0, top=7500, formants=body)
    t = _t(n)
    x = np.zeros(n)
    bright = 0.6 + 0.4 * vel
    for k, a in zip(ks, amp):
        x += a * np.exp(-(k - 1) * (1 - bright) * .15) * np.sin(ph * k + k * .9)
    env = _sus_env(n, dur, attack, release)
    noise = filt(rng.normal(size=n), chain(bp(f * 4, .7), lp(5000))) * .02 * (env ** .5)
    return (x / (np.sum(amp) * .35) * env + noise) * vel * .45


def section(f, dur, vel, rng, voices=3, kind='violin', **kw):
    """String section: a few detuned bowed voices with staggered attacks."""
    out = None
    for v in range(voices):
        det = 2 ** (rng.uniform(-7, 7) / 1200)
        x = bowed(f * det, dur, vel, rng, kind=kind, **kw)
        d = samples(rng.uniform(0, .025))
        x = np.concatenate([np.zeros(d), x])
        out = x if out is None else (np.pad(out, (0, max(0, x.size - out.size))) +
                                     np.pad(x, (0, max(0, out.size - x.size))))
    return out / np.sqrt(voices)


def flute(f, dur, vel, rng, kind='recorder', attack=None, release=.12):
    """Recorder / flute / shakuhachi: few harmonics + breath noise around the harmonics + chiff."""
    cfg = {'recorder': dict(h=[1, .35, .12, .06, .03], breath=.06, vib=8, bend=(-15, .03), a=.03),
           'flute': dict(h=[1, .5, .2, .1, .05, .02], breath=.05, vib=14, bend=(-10, .04), a=.06),
           'shakuhachi': dict(h=[1, .25, .14, .05], breath=.22, vib=22, bend=(-80, .12), a=.12),
           'pan': dict(h=[1, .15, .05], breath=.12, vib=6, bend=(-20, .05), a=.05)}[kind]
    a = attack or cfg['a']
    n = samples(dur + release + .05)
    ph = _phase(f, n, rng, vib_rate=rng.uniform(4.5, 5.5), vib_cents=cfg['vib'], vib_delay=.35, drift_cents=2,
                bend=cfg['bend'])
    x = sum(h * np.sin(ph * (k + 1)) for k, h in enumerate(cfg['h']) if f * (k + 1) < NYQ_SAFE)
    env = _sus_env(n, dur, a, release)
    br = rng.normal(size=n)
    breath = filt(br, bp(f, 6)) * 1.5 + filt(br, chain(hp(1200), lp(6000))) * .25
    chiff = filt(rng.normal(size=n), bp(f * 3, 2)) * np.exp(-_t(n) / .02) * .5
    y = x * env + cfg['breath'] * breath * (env ** .7) + chiff * min(1, vel) * .3
    return y * vel * .4


def reed(f, dur, vel, rng, kind='concertina', attack=.03, release=.08):
    """Free reed (concertina / accordion), band-organ pipe rank, hurdy-gurdy melody string."""
    cfg = {'concertina': dict(slope=.85, form=[(1100, 5, 500), (2500, 3, 700)], det=5, buzz=0),
           'accordion': dict(slope=.75, form=[(900, 4, 400), (2200, 4, 800)], det=9, buzz=0),
           'bandorgan': dict(slope=1.1, form=[(700, 3, 500)], det=3, buzz=0),
           'hurdy': dict(slope=.7, form=[(800, 6, 300), (1800, 6, 500), (3000, 2, 800)], det=2, buzz=.25),
           'drone': dict(slope=.9, form=[(500, 4, 300), (1500, 3, 500)], det=4, buzz=.15)}[kind]
    n = samples(dur + release + .03)
    out = np.zeros(n)
    for d in (-cfg['det'], cfg['det']):
        ph = _phase(f * 2 ** (d / 2 / 1200), n, rng, drift_cents=1.5,
                    vib_rate=6.0 if kind == 'hurdy' else 0, vib_cents=6 if kind == 'hurdy' else 0)
        ks, amp = _harm(f, 30, cfg['slope'], top=7000, formants=cfg['form'])
        out += sum(a * np.sin(ph * k + k) for k, a in zip(ks, amp)) / np.sum(amp)
    env = _sus_env(n, dur, attack, release)
    if cfg['buzz']:   # wheel-on-string rasp: slight amplitude flutter + band noise
        t = _t(n)
        out *= 1 + cfg['buzz'] * .3 * np.sin(TAU * 31 * t)
        out += filt(rng.normal(size=n), bp(f * 6, 3)) * cfg['buzz'] * .08
    return out * env * vel * .5


def organ(f, dur, vel, rng, stops=((1, 1.0), (2, .45), (3, .18), (4, .15), (.5, .35)), attack=.05,
          release=.25, trem=0.0):
    n = samples(dur + release + .03)
    ph = _phase(f, n, rng, drift_cents=1)
    x = sum(a * np.sin(ph * r) for r, a in stops if f * r < NYQ_SAFE) / sum(a for _, a in stops)
    env = _sus_env(n, dur, attack, release)
    if trem:
        x *= 1 + trem * np.sin(TAU * 5.5 * _t(n))
    return x * env * vel * .5


def glassharp(f, dur, vel, rng, attack=.25, release=1.2):
    """Glass harmonica: near-sine with a soft 2nd/3rd partial, slow swell, gentle shimmer."""
    n = samples(dur + release + .05)
    ph = _phase(f, n, rng, vib_rate=rng.uniform(3, 4), vib_cents=4, vib_delay=0, drift_cents=1)
    x = np.sin(ph) + .12 * np.sin(2 * ph + .3) + .05 * np.sin(3 * ph + 1.1) + .03 * np.sin(4.02 * ph)
    env = _sus_env(n, dur, attack, release) * (1 + .08 * np.sin(TAU * 4.3 * _t(n)))
    return x * env * vel * .45


VOWELS = {  # formant (Hz, gain dB, bandwidth Hz)
    'a': [(730, 0, 90), (1090, -5, 110), (2440, -14, 170), (3400, -20, 250)],
    'o': [(570, 0, 80), (840, -6, 100), (2410, -18, 170), (3400, -24, 250)],
    'u': [(440, 0, 70), (1020, -10, 110), (2240, -24, 170)],
    'e': [(530, 0, 80), (1840, -8, 120), (2480, -12, 170), (3400, -20, 250)],
}


def voice(f, dur, vel, rng, vowel='a', attack=.25, release=.6, vib=18):
    """One 'aah' voice by formant-weighted additive synthesis (spectral envelope sampled at the harmonics)."""
    n = samples(dur + release + .05)
    ph = _phase(f, n, rng, vib_rate=rng.uniform(4.8, 5.6), vib_cents=vib, vib_delay=.4, drift_cents=4)
    ks = np.arange(1, 60); ks = ks[ks * f < 6000]
    fk = ks * f
    amp = np.zeros(ks.size)
    for fc, gdb, bw in VOWELS[vowel]:
        amp += 10 ** (gdb / 20) / (1 + ((fk - fc) / bw) ** 2)
    amp *= 1 / ks ** .3
    x = sum(a * np.sin(ph * k + k * 2.1) for k, a in zip(ks, amp)) / (np.sum(amp) * .5)
    env = _sus_env(n, dur, attack, release)
    breath = filt(rng.normal(size=n), chain(bp(900, .8), lp(4000))) * .015
    return (x + breath) * env * vel * .4


def choir(f, dur, vel, rng, voices=4, vowel='a', **kw):
    out = None
    for v in range(voices):
        x = voice(f * 2 ** (rng.uniform(-9, 9) / 1200), dur, vel, rng, vowel=vowel, **kw)
        out = x if out is None else out[:min(out.size, x.size)] + x[:min(out.size, x.size)]
    return out / np.sqrt(voices)


# ---------------------------------------------------------------- electronic
def saw_stack(f, dur, vel, rng, voices=5, detune=12, cutoff=2500.0, attack=.02, release=.2, cut_env=None,
              slope=1.0, top=8000.0):
    """Detuned band-limited saws ('supersaw'), spectrally low-passed per harmonic (cutoff may follow cut_env)."""
    n = samples(dur + release + .02)
    t = _t(n)
    fc = cutoff * (cut_env(t) if cut_env else 1.0)
    out = np.zeros(n)
    for v in range(voices):
        d = 0 if voices == 1 else detune * (2 * v / (voices - 1) - 1)
        ph = _phase(f * 2 ** (d / 1200), n, rng) + rng.uniform(0, TAU)
        kmax = int(min(top, 9000) / f)
        for k in range(1, max(kmax, 1) + 1):
            g = 1 / k ** slope / (1 + (k * f / fc) ** 4)
            if np.max(g) < 1e-3:
                break
            out += g * np.sin(ph * k)
    env = _sus_env(n, dur, attack, release)
    return out / voices ** .5 * env * vel * .35


def bass_synth(f, dur, vel, rng, cutoff=600.0, env_amt=4.0, decay=.18, release=.06):
    cut = lambda t: 1 + env_amt * np.exp(-t / decay)
    return saw_stack(f, dur, vel, rng, voices=2, detune=6, cutoff=cutoff, attack=.004, release=release,
                     cut_env=cut, top=5000) * 1.4


def epiano(f, dur, vel, rng):
    """FM electric piano (soft tine)."""
    n = samples(dur + 1.2)
    t = _t(n)
    ph = _phase(f, n, rng)
    idx = (1.2 + vel) * np.exp(-t / .35)
    x = np.sin(ph + idx * np.sin(ph * 1.0)) * np.exp(-t / 1.6)
    x += .15 * np.sin(14 * ph) * np.exp(-t / .03)  # tine
    env = np.where(t < dur, 1, np.exp(-(t - dur) / .08)) * np.minimum(1, t / .002)
    return filt(x * env, lp(6000)) * vel * .4


# ---------------------------------------------------------------- percussion
def kick(vel, rng, f0=55, f1=150, decay=.35):
    n = samples(decay * 1.5)
    t = _t(n)
    f = f0 + (f1 - f0) * np.exp(-t / .03)
    x = np.sin(np.cumsum(TAU * f / SR)) * np.exp(-t / (decay / 2.5))
    x += filt(rng.normal(size=n), bp(3000, 1)) * np.exp(-t / .004) * .15
    return x * vel * .8


def snare(vel, rng, tone=190, decay=.18, bright=5000):
    n = samples(decay * 2)
    t = _t(n)
    x = np.sin(TAU * tone * t) * np.exp(-t / .05) * .6
    x += filt(rng.normal(size=n), chain(hp(900), lp(bright))) * np.exp(-t / (decay / 2.5))
    return x * vel * .5


def hat(vel, rng, decay=.05, open_=False):
    n = samples(.45 if open_ else .12)
    t = _t(n)
    x = filt(rng.normal(size=n), chain(hp(7000), lp(11000)))
    return x * np.exp(-t / (0.18 if open_ else decay)) * vel * .25


def clap(vel, rng):
    n = samples(.3)
    t = _t(n)
    e = sum(np.exp(-np.maximum(t - d, 0) / .006) * (t >= d) for d in (0, .011, .022)) + np.exp(-t / .08) * .6
    return filt(rng.normal(size=n), chain(bp(1300, .9), lp(6000))) * e * vel * .35


def drum(vel, rng, f=90, decay=.5, slap=.3, skin=1.0, bend=1.5):
    """Hand / frame / tavern drum: pitched membrane with downward bend plus skin noise."""
    n = samples(decay * 2)
    t = _t(n)
    ff = f * (1 + (bend - 1) * np.exp(-t / .02))
    x = np.sin(np.cumsum(TAU * ff / SR)) * np.exp(-t / (decay / 3))
    x += .35 * np.sin(np.cumsum(TAU * ff * 1.59 / SR)) * np.exp(-t / (decay / 6))
    x += slap * filt(rng.normal(size=n), chain(bp(f * 9, .8), lp(5000))) * np.exp(-t / .015) * skin
    return x * vel * .6


def taiko(vel, rng, f=62, decay=1.2):
    n = samples(decay * 1.8)
    t = _t(n)
    ff = f * (1 + .25 * np.exp(-t / .05))
    x = np.sin(np.cumsum(TAU * ff / SR)) * np.exp(-t / (decay / 3))
    x += .4 * np.sin(np.cumsum(TAU * ff * 2.3 / SR)) * np.exp(-t / (decay / 7))
    x += filt(rng.normal(size=n), chain(bp(400, .8), lp(2500))) * np.exp(-t / .03) * .35
    return x * vel * .8


def woodblock(vel, rng, f=900, decay=.06):
    """Wooden clappers (hyoshigi) / woodblock: two inharmonic modes, very short."""
    n = samples(decay * 5)
    t = _t(n)
    x = (np.sin(TAU * f * t) + .6 * np.sin(TAU * f * 2.57 * t + 1) + .3 * np.sin(TAU * f * 4.1 * t)) * np.exp(-t / decay)
    x += filt(rng.normal(size=n), bp(f * 2, 2)) * np.exp(-t / .004) * .4
    return x * vel * .5


def tambourine(vel, rng):
    n = samples(.35)
    t = _t(n)
    jing = sum(np.sin(TAU * fr * t + rng.uniform(0, TAU)) for fr in rng.uniform(5000, 8500, 8)) / 8
    x = (jing * .6 + filt(rng.normal(size=n), chain(hp(5000), lp(10000)))) * np.exp(-t / .07)
    return x * vel * .2
