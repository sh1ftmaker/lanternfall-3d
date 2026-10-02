"""Small DSP toolkit for Lanternfall's sound content (numpy + scipy only).

Everything that loops is rendered as a PERIODIC signal of exactly L samples: note tails and reverb wrap around
(`fold`), noise is made periodic in the frequency domain, IIR filters run over three copies and keep the middle.
A periodic signal has no loop seam by construction; the encoder adds pre/post-roll copies (see build.py).
"""
import numpy as np
from scipy import signal

SR = 44100
TAU = 2 * np.pi


def secs(n):
    return n / SR


def samples(s):
    return int(round(s * SR))


def mtof(m):
    return 440.0 * 2 ** ((np.asarray(m, float) - 69) / 12)


# ----------------------------------------------------------------- periodic helpers
def fold(buf, L):
    """Wrap a long buffer onto a loop of L samples (sum of all laps). Works for mono (n,) or (n, ch)."""
    n = buf.shape[0]
    laps = -(-n // L)
    pad = laps * L - n
    if pad:
        buf = np.concatenate([buf, np.zeros((pad,) + buf.shape[1:])])
    return buf.reshape((laps, L) + buf.shape[1:]).sum(0)


def add_at(buf, x, start):
    """Add x into buf at sample `start`, wrapping around (circular)."""
    L = buf.shape[0]
    start %= L
    n = x.shape[0]
    i = 0
    while i < n:
        s = (start + i) % L
        k = min(n - i, L - s)
        buf[s:s + k] += x[i:i + k]
        i += k


def pnoise(L, seed, shape=None, ch=1):
    """Periodic noise of length L. `shape(f)` = amplitude weight per frequency (Hz). Unit RMS per channel."""
    rng = np.random.default_rng(seed)
    f = np.fft.rfftfreq(L, 1 / SR)
    out = []
    for c in range(ch):
        spec = rng.normal(size=f.shape) + 1j * rng.normal(size=f.shape)
        if shape is not None:
            spec *= shape(f)
        spec[0] = 0
        x = np.fft.irfft(spec, L)
        out.append(x / (np.sqrt(np.mean(x ** 2)) + 1e-12))
    return out[0] if ch == 1 else np.stack(out, 1)


def band(lo, hi, slope=2.0):
    """Smooth band-pass weight for pnoise: flat lo..hi with soft skirts (power slope)."""
    def w(f):
        f = np.maximum(f, 1.0)
        a = 1 / (1 + (lo / f) ** (2 * slope)) if lo > 0 else 1.0
        b = 1 / (1 + (f / hi) ** (2 * slope)) if hi else 1.0
        return np.sqrt(a * b)
    return w


def pink(lo=20, hi=None, slope=2.0):
    bw = band(lo, hi, slope)
    return lambda f: bw(f) / np.sqrt(np.maximum(f, 1.0))


def slow_lfo(L, seed, cycles=(1, 2, 3, 5), depth=1.0):
    """Smooth periodic random modulation in [-depth, depth] made of integer-cycle sinusoids."""
    rng = np.random.default_rng(seed)
    t = np.arange(L) / L
    x = sum(rng.uniform(.5, 1) / c ** .5 * np.sin(TAU * c * t + rng.uniform(0, TAU)) for c in cycles)
    return depth * x / (np.max(np.abs(x)) + 1e-12)


def pfilter(x, sos):
    """Filter a periodic signal (IIR) circularly: run over 3 laps, keep the middle one."""
    L = x.shape[0]
    y = signal.sosfilt(sos, np.concatenate([x, x, x]), axis=0)
    return y[L:2 * L]


def circ_conv(x, ir):
    """Circular convolution of a periodic signal x (n,) or (n,ch) with an IR (m,) or (m,ch)."""
    L = x.shape[0]
    irf = fold(ir, L) if ir.shape[0] > L else np.concatenate([ir, np.zeros((L - ir.shape[0],) + ir.shape[1:])])
    X = np.fft.rfft(x, axis=0)
    H = np.fft.rfft(irf, axis=0)
    if x.ndim == 1 and irf.ndim == 2:
        X = X[:, None]
    return np.fft.irfft(X * H, L, axis=0)


# ----------------------------------------------------------------- filters (RBJ biquads as sos)
def _biq(b, a):
    b = np.asarray(b, float) / a[0]
    a = np.asarray(a, float) / a[0]
    return np.concatenate([b, a])[None, :]


def lp(fc, q=0.707):
    w = TAU * fc / SR; al = np.sin(w) / (2 * q); c = np.cos(w)
    return _biq([(1 - c) / 2, 1 - c, (1 - c) / 2], [1 + al, -2 * c, 1 - al])


def hp(fc, q=0.707):
    w = TAU * fc / SR; al = np.sin(w) / (2 * q); c = np.cos(w)
    return _biq([(1 + c) / 2, -(1 + c), (1 + c) / 2], [1 + al, -2 * c, 1 - al])


def bp(fc, q=1.0):
    w = TAU * fc / SR; al = np.sin(w) / (2 * q); c = np.cos(w)
    return _biq([al, 0, -al], [1 + al, -2 * c, 1 - al])


def peak(fc, gain_db, q=1.0):
    A = 10 ** (gain_db / 40); w = TAU * fc / SR; al = np.sin(w) / (2 * q); c = np.cos(w)
    return _biq([1 + al * A, -2 * c, 1 - al * A], [1 + al / A, -2 * c, 1 - al / A])


def shelf(fc, gain_db, high=True, s=1.0):
    A = 10 ** (gain_db / 40); w = TAU * fc / SR; c = np.cos(w)
    al = np.sin(w) / 2 * np.sqrt((A + 1 / A) * (1 / s - 1) + 2)
    if high:
        b = [A * ((A + 1) + (A - 1) * c + 2 * np.sqrt(A) * al), -2 * A * ((A - 1) + (A + 1) * c),
             A * ((A + 1) + (A - 1) * c - 2 * np.sqrt(A) * al)]
        a = [(A + 1) - (A - 1) * c + 2 * np.sqrt(A) * al, 2 * ((A - 1) - (A + 1) * c),
             (A + 1) - (A - 1) * c - 2 * np.sqrt(A) * al]
    else:
        b = [A * ((A + 1) - (A - 1) * c + 2 * np.sqrt(A) * al), 2 * A * ((A - 1) - (A + 1) * c),
             A * ((A + 1) - (A - 1) * c - 2 * np.sqrt(A) * al)]
        a = [(A + 1) + (A - 1) * c + 2 * np.sqrt(A) * al, -2 * ((A - 1) + (A + 1) * c),
             (A + 1) + (A - 1) * c - 2 * np.sqrt(A) * al]
    return _biq(b, a)


def chain(*sos):
    return np.concatenate(sos, 0)


def filt(x, sos):
    return signal.sosfilt(sos, x, axis=0)


# ----------------------------------------------------------------- envelopes
def env_adsr(n, a, d, s, r, hold=None):
    """ADSR in seconds; `hold` = time the gate is held (default: n - r). Returns n samples."""
    t = np.arange(n) / SR
    hold = (n / SR - r) if hold is None else hold
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    lvl = np.interp(hold, t, e) if hold < t[-1] else e[-1]
    e = np.where(t < hold, e, lvl * np.exp(-(t - hold) / max(r / 4, 1e-4)))
    return e


def fade(x, fin=0.003, fout=0.01):
    n = x.shape[0]
    a = min(samples(fin), n // 2); b = min(samples(fout), n // 2)
    w = np.ones(n)
    if a: w[:a] = np.sin(np.linspace(0, np.pi / 2, a)) ** 2
    if b: w[n - b:] = np.cos(np.linspace(0, np.pi / 2, b)) ** 2
    return x * (w if x.ndim == 1 else w[:, None])


# ----------------------------------------------------------------- reverb
def reverb_ir(t60=2.0, length=None, seed=1, ch=1, damp=3000.0, predelay=0.01, early=0.0):
    """Synthetic diffuse IR: decaying noise whose high frequencies die faster (damp = Hz where t60 halves)."""
    length = length or t60 * 1.2
    n = samples(length)
    rng = np.random.default_rng(seed)
    t = np.arange(n) / SR
    edges = [0, 250, 700, 1500, 3000, 6000, 12000, SR / 2]
    out = np.zeros((n, ch))
    for i in range(len(edges) - 1):
        fc = np.sqrt(max(edges[i], 60) * edges[i + 1])
        t60b = t60 / (1 + (fc / damp) ** 1.2)
        sos = chain(hp(max(edges[i], 20)), lp(min(edges[i + 1], SR / 2 * .95))) if i else lp(edges[1])
        for c in range(ch):
            nz = filt(rng.normal(size=n), sos)
            out[:, c] += nz * np.exp(-6.9 * t / t60b)
    pd = samples(predelay)
    out = np.concatenate([np.zeros((pd, ch)), out])[:n]
    out *= np.minimum(1, t / 0.004)[:, None]
    if early:
        for k in range(8):
            d = samples(predelay * .3 + rng.uniform(.003, .04))
            if d < n:
                out[d, :] += early * rng.uniform(.3, 1) * rng.choice([-1, 1], size=ch) * np.sqrt(SR / 1000) / 10
    out /= np.sqrt(np.sum(out ** 2, 0, keepdims=True)) + 1e-12
    return out[:, 0] if ch == 1 else out


def wet(x, ir, mix):
    """dry/wet with an IR; periodic (circular) when x is a loop."""
    return (1 - mix) * x + mix * circ_conv(x, ir) * 1.0


# ----------------------------------------------------------------- measurement helpers
def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(np.square(x))) + 1e-12)


def peak_db(x):
    return 20 * np.log10(np.max(np.abs(x)) + 1e-12)


def soft_clip(x, drive=1.0):
    return np.tanh(x * drive) / np.tanh(drive)
