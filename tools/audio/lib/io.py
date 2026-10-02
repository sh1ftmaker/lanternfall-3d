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
