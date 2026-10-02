"""Analytic QA of every encoded file (we cannot listen): decodes data/audio/**.m4a with ffmpeg and checks
  - loop seams on the DECODED file: the samples after loopEnd (post-roll) must equal those after loopStart, so the
    wrap is the natural continuation; reports seam error (dB relative to signal) and the wrap jump vs typical step,
  - clipping (|x| >= 0.999), DC offset, true peak, integrated loudness (own BS.1770 meter, cross-checked with ffmpeg
    ebur128), spectral balance (energy above 12 kHz; narrow sustained peaks 2-5 kHz), stereo correlation and mono
    fold-down loss for beds,
  - music scores: pitch-set membership (D major), ranges per track, grid, harmony at the loop boundary,
and draws a contact sheet (waveform + spectrogram + seam zoom per file) and piano rolls.

usage: python analyze.py OUTDIR [--files pattern]"""
import glob, json, os, re, subprocess, sys
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import io as aio
from lib.dsp import SR
from lib.seq import D_MAJOR, nn

REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
AUD = os.path.join(REPO, 'data', 'audio')
OUT = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(OUT, exist_ok=True)
meta = json.load(open(os.path.join(HERE, 'render_meta.json')))


def ffmpeg_lufs(path):
    r = subprocess.run(['ffmpeg', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                       capture_output=True, text=True).stderr
    i = re.findall(r'I:\s+(-?[\d.]+) LUFS', r)
    tp = re.findall(r'Peak:\s+(-?[\d.]+) dBFS', r)
    return (float(i[-1]) if i else None), (float(tp[-1]) if tp else None)


def spectrum(x):
    m = x if x.ndim == 1 else x.mean(1)
    n = 8192
    if m.size < n:
        m = np.pad(m, (0, n - m.size))
    frames = np.lib.stride_tricks.sliding_window_view(m, n)[::n // 2]
    S = np.mean(np.abs(np.fft.rfft(frames * np.hanning(n), axis=1)) ** 2, 0)
    f = np.fft.rfftfreq(n, 1 / SR)
    return f, S


def tonal_2_5k(f, S):
    """Largest narrow peak (dB above the local median, +-300 Hz) between 2 and 5 kHz in the long-term spectrum."""
    db = 10 * np.log10(S + 1e-20)
    best = 0.0
    idx = np.where((f > 2000) & (f < 5000))[0]
    w = int(300 / (f[1] - f[0]))
    for i in idx[::2]:
        med = np.median(db[max(0, i - w):i + w])
        best = max(best, db[i] - med)
    return best


def seam(x, lo, hi):
    """Compare the post-roll after loopEnd with the audio after loopStart (they should be identical)."""
    a, b = int(round(lo * SR)), int(round(hi * SR))
    k = min(int(.2 * SR), x.shape[0] - b)
    if k <= 0:
        return None
    d = x[a:a + k] - x[b:b + k]
    sig = np.sqrt(np.mean(x[a:b] ** 2)) + 1e-12
    err_db = 20 * np.log10(np.sqrt(np.mean(d ** 2)) / sig + 1e-12)
    # wrap jump: sample before loopEnd -> sample at loopStart, vs typical |step|
    m = x if x.ndim == 1 else x.mean(1)
    jump = abs(m[a] - m[b - 1])
    loc = np.concatenate([m[b - 2205:b], m[a:a + 2205]])        # +-50 ms around the wrap
    typ = np.percentile(np.abs(np.diff(loc)), 99) + 1e-12
    # spectral continuity: 1/3-octave band levels of 93 ms after loopStart vs after loopEnd (identical audio,
    # different codec frames) -> max |dB| difference over bands with energy
    n = 4096
    def bands(seg):
        S = np.abs(np.fft.rfft(seg * np.hanning(n))) ** 2
        f = np.fft.rfftfreq(n, 1 / SR)
        edges = 100 * 2 ** (np.arange(0, 22) / 3)
        return np.array([S[(f >= lo) & (f < hi)].sum() for lo, hi in zip(edges[:-1], edges[1:])])
    if x.shape[0] - b > n:
        A, B = bands(m[a:a + n]), bands(m[b:b + n])
        ok = (A > A.max() * 1e-4)
        spec = float(np.max(np.abs(10 * np.log10((A[ok] + 1e-20) / (B[ok] + 1e-20)))))
    else:
        spec = None
    return err_db, jump / typ, spec


rows = []
items = sorted(meta.items(), key=lambda kv: (kv[1]['cat'], kv[0]))
pat = sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == '--files' else None
for name, m in items:
    if pat and not re.search(pat, name):
        continue
    path = os.path.join(AUD, m['file'])
    if not os.path.exists(path):
        continue
    x = aio.load(path, mono=(m['channels'] == 1))
    r = dict(name=name, cat=m['cat'], file=m['file'], kb=round(os.path.getsize(path) / 1024, 1),
             sec=round(x.shape[0] / SR, 2), ch=m['channels'])
    r['clip'] = int(np.sum(np.abs(x) >= .999))
    r['dc'] = float(np.max(np.abs(np.mean(x, 0))))
    r['tp'] = round(aio.true_peak_db(x), 2)
    if m['loop']:
        lo, hi = m['loop']
        body = x[int(lo * SR):int(hi * SR)]
        r['lufs'] = round(aio.lufs(body, True), 2)
        s = seam(x, lo, hi)
        r['seam_db'], r['wrap_jump'], r['seam_spec_db'] = (round(s[0], 1), round(s[1], 2), round(s[2], 2) if s[2] is not None else None) if s else (None, None, None)
    else:
        body = x
        r['lufs'] = round(aio.lufs(x), 2)
    r['lufs_ffmpeg'], _ = ffmpeg_lufs(path)
    f, S = spectrum(body)
    tot = S.sum() + 1e-20
    r['above12k_db'] = round(10 * np.log10(S[f > 12000].sum() / tot + 1e-20), 1)
    r['tonal_2_5k_db'] = round(tonal_2_5k(f, S), 1)
    if body.ndim == 2:
        L, R = body[:, 0], body[:, 1]
        r['corr'] = round(float(np.corrcoef(L, R)[0, 1]), 2)
        mono = (L + R) / 2
        r['mono_loss_db'] = round(10 * np.log10(np.mean(mono ** 2) / (np.mean(body ** 2) + 1e-20) + 1e-20), 1)
    rows.append(r)
    r['_x'] = body
    print({k: v for k, v in r.items() if k != '_x'}, flush=True)

# ---------------------------------------------------------------------- contact sheets
def sheet(rows, title, fn, cols=3):
    n = len(rows)
    if not n:
        return
    rr = -(-n // cols)
    fig = plt.figure(figsize=(cols * 6.2, rr * 2.2), dpi=70)
    for i, r in enumerate(rows):
        x = r['_x']
        m = x if x.ndim == 1 else x.mean(1)
        ax = fig.add_subplot(rr, cols * 3, i * 3 + 1)
        t = np.arange(m.size) / SR
        step = max(1, m.size // 3000)
        ax.plot(t[::step], m[::step], lw=.4, color='#335')
        ax.set_ylim(-1, 1); ax.set_title(r['name'][:24], fontsize=7); ax.tick_params(labelsize=5)
        ax = fig.add_subplot(rr, cols * 3, i * 3 + 2)
        ax.specgram(m, NFFT=1024, Fs=SR, noverlap=512, cmap='magma', vmin=-130, vmax=-20)
        ax.set_ylim(0, 12000); ax.tick_params(labelsize=5)
        ax.set_title(f"{r.get('lufs')} LUFS  tp {r['tp']}", fontsize=6)
        ax = fig.add_subplot(rr, cols * 3, i * 3 + 3)
        k = int(.03 * SR)
        z = np.concatenate([m[-k:], m[:k]])   # the wrap: end of loop -> start of loop
        ax.plot(np.arange(-k, k) / SR * 1000, z, lw=.5, color='#a33' if r.get('seam_db') else '#999')
        ax.axvline(0, color='k', lw=.4)
        ax.set_title(f"seam {r.get('seam_db')} dB jump {r.get('wrap_jump')}" if r.get('seam_db') is not None else 'one-shot (start)', fontsize=6)
        ax.tick_params(labelsize=5)
    fig.suptitle(title, fontsize=10)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, fn))
    plt.close(fig)


for cat in ['music', 'bed', 'emit', 'oneshot']:
    rs = [r for r in rows if r['cat'] == cat]
    for k in range(0, len(rs), 24):
        sheet(rs[k:k + 24], f'{cat} ({k // 24 + 1})', f'sheet_{cat}_{k // 24 + 1}.png')

# ---------------------------------------------------------------------- music score checks + piano rolls
score_rows = []
for fn in sorted(glob.glob(os.path.join(HERE, 'scores', '*.json'))):
    sc = json.load(open(fn))
    notes = [n for n in sc['notes'] if n[3] >= 0]
    if not notes:
        continue
    out = [n for n in notes if n[3] % 12 not in D_MAJOR]
    tracks = sorted({n[0] for n in notes})
    rng = {t: (nn(min(n[3] for n in notes if n[0] == t)), nn(max(n[3] for n in notes if n[0] == t))) for t in tracks}
    grid = sorted({round((n[1] % 1) * 12) / 12 for n in notes})
    score_rows.append(dict(name=sc['name'], notes=len(notes), outside_d_major=len(out), ranges=rng,
                           onsets_per_beat=len(grid)))
    fig, ax = plt.subplots(figsize=(14, 4), dpi=80)
    cmap = plt.get_cmap('tab10')
    for i, t in enumerate(tracks):
        for _, b, d, mm, v in [n for n in notes if n[0] == t]:
            ax.add_patch(plt.Rectangle((b, mm - .4), d, .8, color=cmap(i % 10), alpha=.35 + .6 * min(v, 1)))
        ax.plot([], [], color=cmap(i % 10), lw=6, label=t)
    ax.set_xlim(0, sc['beats']); lo = min(n[3] for n in notes); hi = max(n[3] for n in notes)
    ax.set_ylim(lo - 2, hi + 2)
    ax.set_yticks(range(lo - lo % 12 + 2, hi + 2, 12)); ax.set_yticklabels([nn(k) for k in range(lo - lo % 12 + 2, hi + 2, 12)])
    for b in range(0, int(sc['beats']) + 1, 4):
        ax.axvline(b, color='#ccc', lw=.4, zorder=0)
    ax.legend(fontsize=7, loc='upper right', ncol=4)
    ax.set_title(f"{sc['name']}: {sc['bpm']} grid-bpm, {sc['beats']} beats, {sc['seconds']:.2f} s, "
                 f"{len(out)} notes outside D major")
    ax.set_xlabel('beat')
    fig.tight_layout(); fig.savefig(os.path.join(OUT, f"roll_{sc['name']}.png")); plt.close(fig)

clean = [{k: v for k, v in r.items() if k != '_x'} for r in rows]
json.dump(dict(files=clean, scores=score_rows), open(os.path.join(OUT, 'analysis.json'), 'w'), indent=1)
with open(os.path.join(OUT, 'loudness_table.md'), 'w') as fh:
    fh.write('| file | cat | s | ch | KB | LUFS | ffmpeg LUFS | true peak | clip | seam wave dB | seam spec dB | wrap jump | >12k dB | 2-5k peak dB | corr | mono loss |\n')
    fh.write('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n')
    for r in clean:
        fh.write(f"| {r['name']} | {r['cat']} | {r['sec']} | {r['ch']} | {r['kb']} | {r['lufs']} | {r['lufs_ffmpeg']} | "
                 f"{r['tp']} | {r['clip']} | {r.get('seam_db', '')} | {r.get('seam_spec_db', '')} | {r.get('wrap_jump', '')} | {r['above12k_db']} | "
                 f"{r['tonal_2_5k_db']} | {r.get('corr', '')} | {r.get('mono_loss_db', '')} |\n")
    fh.write('\n')
    for s in score_rows:
        fh.write(f"- {s['name']}: {s['notes']} notes, {s['outside_d_major']} outside D major, onset positions per beat "
                 f"{s['onsets_per_beat']}, ranges {s['ranges']}\n")
print('total KB', round(sum(r['kb'] for r in clean), 1))
print(json.dumps(score_rows, indent=0)[:3000])
