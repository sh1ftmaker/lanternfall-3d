"""Loading, loudness, looping and encoding helpers."""
import json, os, subprocess
import numpy as np
import soundfile as sf
from scipy import signal
from .dsp import SR, filt, hp, shelf, chain


def load(path, mono=False, start=None, dur=None):
    """Decode any file with ffmpeg to float32 at SR (stereo unless mono)."""
    cmd = ['ffmpeg', '-v', 'error']
    if start is not None:
        cmd += ['-ss', str(start)]
    cmd += ['-i', path]
    if dur is not None:
        cmd += ['-t', str(dur)]
    cmd += ['-f', 'f32le', '-ac', '1' if mono else '2', '-ar', str(SR), '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).astype(np.float64)
    return x if mono else x.reshape(-1, 2)


# ------------------------------------------------------------------ BS.1770-4 loudness (integrated, gated)
def _kweight():
    return chain(shelf(1681.97, 3.999843853973347, True, 1.0), hp(38.13547087602444, .5003270373238773))


def lufs(x, periodic=False):
    x = x if x.ndim == 2 else x[:, None]
    if periodic:
        x = np.concatenate([x, x])   # the meter needs > 400 ms blocks across the seam too
    y = filt(x, _kweight())
    blk, hop = int(.4 * SR), int(.1 * SR)
    if y.shape[0] < blk:
        y = np.concatenate([y, np.zeros((blk - y.shape[0], y.shape[1]))])
    ms = np.array([np.mean(y[i:i + blk] ** 2, 0).sum() for i in range(0, y.shape[0] - blk + 1, hop)])
    l = -0.691 + 10 * np.log10(ms + 1e-20)
    g = ms[l > -70]
    if g.size == 0:
        return -70.0
    rel = -0.691 + 10 * np.log10(g.mean()) - 10
    g2 = ms[(l > -70) & (l > rel)]
    return float(-0.691 + 10 * np.log10(g2.mean()))


def true_peak_db(x):
    x = x if x.ndim == 2 else x[:, None]
    up = signal.resample_poly(x, 4, 1, axis=0)
    return float(20 * np.log10(np.max(np.abs(up)) + 1e-12))


def limit_periodic(x, ceiling_db=-1.5):
    """Smooth peak limiter for a periodic loop: gain envelope from a circular max-filter + smoothing."""
    c = 10 ** (ceiling_db / 20)
    a = np.abs(x) if x.ndim == 1 else np.max(np.abs(x), 1)
    if a.max() <= c:
        return x
    need = np.minimum(1, c / np.maximum(a, 1e-9))
    w = int(.005 * SR)
    L = need.size
    ext = np.concatenate([need[-w:], need, need[:w]])
    from scipy.ndimage import minimum_filter1d, uniform_filter1d
    g = minimum_filter1d(ext, 2 * w + 1)
    g = uniform_filter1d(g, 2 * w + 1)[w:w + L]
    g = np.minimum(g, need)
    return x * (g if x.ndim == 1 else g[:, None])


# ------------------------------------------------------------------ loops from recordings
def best_window(x, L, hop=None, avoid_db=8.0):
    """Start index of the length-L window with the steadiest short-term level (no loud one-off events)."""
    m = x if x.ndim == 1 else x.mean(1)
    b = int(.1 * SR)
    e = 10 * np.log10(np.convolve(m ** 2, np.ones(b) / b, 'valid')[::b] + 1e-12)
    nb = L // b
    best, bc = 0, 1e9
    med = np.median(e)
    for i in range(0, max(1, e.size - nb - 12), 2):
        seg = e[i:i + nb + 10]
        cost = np.std(seg) + 3 * np.sum(seg > med + avoid_db) / nb
        if cost < bc:
            best, bc = i, cost
    return best * b


def calm_window(x, L, thresh=10.0):
    """Start index of the length-L window with the fewest stand-out events: 100 ms frames, third-octave bands above
    200 Hz; a frame counts when a band carrying > 3 % of the energy is `thresh` dB over that band's median IN THE
    WINDOW (an event is heard against the loop's own texture). A beep, a shout or a laugh in a loop is heard again
    every lap; broadband steadiness (best_window) misses them."""
    from scipy import signal as sg
    m = x if x.ndim == 1 else x.mean(1)
    hop = int(.1 * SR)
    F, T, S = sg.spectrogram(m, SR, nperseg=2048, noverlap=2048 - hop)
    edges = 200 * 2 ** (np.arange(0, 16) / 3)
    B = np.array([S[(F >= a) & (F < b)].sum(0) for a, b in zip(edges[:-1], edges[1:])]) + 1e-20
    Ld, share = 10 * np.log10(B), B / B.sum(0, keepdims=True)
    nb = L // hop
    best, bc = 0, 1e18
    for i in range(0, max(1, Ld.shape[1] - nb), 5):
        w = Ld[:, i:i + nb]
        ex = np.where(share[:, i:i + nb] > .03, w - np.median(w, 1, keepdims=True), 0)
        c = np.sum(np.maximum(0, ex.max(0) - thresh) ** 4)          # the loudest stand-out matters most
        if c < bc:
            best, bc = i, c
    return min(best * hop, max(0, m.size - L))


def make_loop(x, L, start=None, xfade=1.5):
    """Periodic loop of L samples from a recording: x[start:start+L], with the following `xfade` seconds
    equal-power crossfaded over the head, so the wrap continues the recording exactly."""
    C = int(xfade * SR)
    if start is None:
        start = best_window(x, L + C)
    seg = x[start:start + L + C]
    out = seg[:L].copy()
    t = np.linspace(0, np.pi / 2, C)
    fi, fo = np.sin(t), np.cos(t)
    if x.ndim == 2:
        fi, fo = fi[:, None], fo[:, None]
    out[:C] = seg[:C] * fi + seg[L:L + C] * fo
    return out, start


_wind = {}


def wind_loop(path, L, hpf=180, lpf=7000, search=None, tame=0.5, xfade=2.0):
    """A wind recording as a stereo periodic loop of L samples (level not set).
    The rumble goes first (4th-order high-pass at `hpf`: below ~180 Hz small speakers distort and the master
    compressor pumps), then the slow level swings are compressed (`tame`: 0 keeps the gusts, 0.5 halves their size
    in dB, measured on a 1.5 s envelope), so a gust swells instead of jumping. The steadiest stretch inside `search`
    (seconds) is looped with an equal-power crossfade. A mono recording gets its right channel from a different
    stretch, which gives a natural, uncorrelated width."""
    from scipy.ndimage import uniform_filter1d
    from .dsp import lp
    key = (path, hpf, lpf, tame)
    if key not in _wind:
        x = load(path)
        mono_src = np.corrcoef(x[:, 0], x[:, 1])[0, 1] > 0.98
        x = filt(x, chain(hp(hpf), hp(hpf), lp(lpf), lp(lpf * 1.2)))
        if tame:
            env = np.sqrt(uniform_filter1d(x.mean(1) ** 2, int(1.5 * SR), mode='nearest') + 1e-12)
            g = uniform_filter1d((env / np.median(env)) ** (-tame), SR // 2, mode='nearest')
            x = x * g[:, None]
        _wind[key] = (x, mono_src)
    x, mono_src = _wind[key]
    C = int(xfade * SR)
    a, b = (0, x.shape[0]) if search is None else (int(search[0] * SR), min(x.shape[0], int(search[1] * SR)))
    seg = x[a:b]
    s0 = best_window(seg, L + C)
    if not mono_src:
        return make_loop(seg, L, start=s0, xfade=xfade)[0]
    lft, _ = make_loop(seg[:, 0], L, start=s0, xfade=xfade)
    # the right ear: the steadiest stretch that does not overlap the left one
    rest = np.concatenate([seg[:s0, 0], seg[s0 + L + C:, 0]]) if seg.shape[0] > 2 * (L + C) else np.roll(seg[:, 0], L // 2)
    rgt, _ = make_loop(rest, L, start=best_window(rest, L + C), xfade=xfade)
    return np.stack([lft, rgt], 1)


# ------------------------------------------------------------------ writing / encoding
PAD = 0.5   # seconds of pre/post-roll around every loop (copies of the loop's own tail/head)


def encode(x, out_path, kbps, loop=True, tmp_dir='/tmp'):
    """Write m4a (AAC-LC). Loops get PAD seconds of the loop's tail before and head after, and the returned
    loop points [PAD, PAD + len] are in seconds of the decoded file."""
    if loop:
        p = int(PAD * SR)
        y = np.concatenate([x[-p:], x, x[:p]])
    else:
        y = x
    y = y.astype(np.float32)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    wav = os.path.join(tmp_dir, os.path.basename(out_path) + '.wav')
    sf.write(wav, y, SR, subtype='FLOAT')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav, '-c:a', 'aac', '-b:a', f'{kbps}k', '-ar', str(SR),
                    '-movflags', '+faststart', out_path], check=True)
    os.remove(wav)
    if loop:
        return [PAD, round(PAD + x.shape[0] / SR, 6)]
    return None


def events(x, thresh_db=-30.0, min_gap=.12, pre=.01, max_len=1.5, tail_db=-45.0):
    """Split a recording of separate hits (footsteps, splashes...) into events by energy onsets.
    Returns a list of mono arrays (pre-roll `pre` s, cut where the level falls `tail_db` below the event peak)."""
    m = x if x.ndim == 1 else x.mean(1)
    h = int(.005 * SR)
    env = np.sqrt(np.convolve(m ** 2, np.ones(h) / h, 'same'))
    db = 20 * np.log10(env + 1e-9)
    top = db.max()
    on = db > top + thresh_db
    out, i = [], 0
    while i < m.size:
        if on[i]:
            s = max(0, i - int(pre * SR))
            pk = db[i:i + int(.1 * SR)].max()
            j = i + int(.03 * SR)
            lim = min(m.size, i + int(max_len * SR))
            while j < lim and db[j] > pk + tail_db:
                j += 1
            # stop early if a new strong onset begins
            seg = m[s:j].copy()
            out.append(seg)
            i = j + int(min_gap * SR)
        else:
            i += 1
    return out
