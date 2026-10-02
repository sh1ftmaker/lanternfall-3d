"""Music-in-the-background detector for field recordings: fraction of time with >= 2 sustained narrow spectral
lines (peaks >= 12 dB over the local median, 100-4000 Hz, lasting >= 0.7 s). Speech and noise score ~0; any
instrument, singing or a PA system scores high. usage: python tonecheck.py file|fs-id [...]"""
import sys, os, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import io as aio
from lib.dsp import SR
from scipy.ndimage import median_filter


PROM, DUR = 7.0, 0.5


def score(x, n=4096, hop=1024):
    m = x if x.ndim == 1 else x.mean(1)
    fr = np.lib.stride_tricks.sliding_window_view(m, n)[::hop] * np.hanning(n)
    S = 20 * np.log10(np.abs(np.fft.rfft(fr, axis=1)) + 1e-9)
    f = np.fft.rfftfreq(n, 1 / SR)
    band = (f > 100) & (f < 4000)
    S = S[:, band]
    pk = (S - median_filter(S, size=(1, 41))) > PROM
    pk = pk | np.roll(pk, 1, 1) | np.roll(pk, -1, 1)
    need = int(DUR * SR / hop)
    run = np.zeros_like(pk, dtype=int)
    for i in range(1, pk.shape[0]):
        run[i] = (run[i - 1] + 1) * pk[i]
    sustained = (run >= need).sum(1) // 3        # each line counted ~3 bins wide
    return float(np.mean(sustained >= 2)), float(np.mean(sustained >= 1))


if __name__ == '__main__':
    for a in sys.argv[1:]:
        p = a if os.path.exists(a) else os.path.join(os.environ.get('AUDIO_SRC', 'src'), f'fs{a}.mp3')
        x = aio.load(p, mono=True, dur=300)
        s2, s1 = score(x)
        print(f'{os.path.basename(p):40s} >=2 lines {s2:5.2f}   >=1 line {s1:5.2f}', flush=True)
