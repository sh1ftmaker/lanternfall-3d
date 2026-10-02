"""Render, normalise, encode every Lanternfall sound and write data/audio/audio.json.

usage:  python build.py [--only name1,name2] [--src DIR]
  --src   folder with the downloaded CC0 recordings (fetch/fs_get.py writes fs<id>.mp3 there)
Needs numpy, scipy, soundfile and ffmpeg (AAC encoder). Deterministic (seeded)."""
import argparse, json, os, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(REPO, 'data', 'audio')
META = os.path.join(HERE, 'render_meta.json')
sys.path.insert(0, '/home/zalo/Work/nocturne-lands/Blender-Park')   # park_common (geometry only, no bpy)

from lib.dsp import SR, pfilter, chain, lp, hp, peak, shelf, slow_lfo, pnoise, pink, band
from lib import io as aio
import music, sfx

ap = argparse.ArgumentParser()
ap.add_argument('--only', default='')
ap.add_argument('--src', default=os.environ.get('AUDIO_SRC', '/tmp/claude-1000/-home-zalo/253e908b-4e3c-4d12-a43e-a8b3b88482f6/scratchpad/agents/sound-music/src'))
ap.add_argument('--tmp', default=os.environ.get('AUDIO_TMP', '/tmp'))
ap.add_argument('--json-only', action='store_true')
args = ap.parse_args()
ONLY = set(filter(None, args.only.split(',')))

TARGET = {'music': -20.0, 'bed': -24.0, 'layer': -26.0, 'emit': -24.0}
KBPS = {'music': 72, 'bed': 80, 'layer': 56, 'emit': 56, 'oneshot': 48}


def secs(s):
    return int(round(s * SR))


# ------------------------------------------------------------------ recordings -> periodic loops
_cache = {}


def rec(fid, L, start=None, mono=False, hpf=None, lpf=None, xfade=1.5, gain_db=0.0, search=None):
    key = (fid, mono)
    if key not in _cache:
        _cache[key] = aio.load(os.path.join(args.src, f'fs{fid}.mp3'), mono=mono)
    x = _cache[key]
    sos = []
    if hpf: sos.append(hp(hpf))
    if lpf: sos += [lp(lpf), lp(lpf * 1.2)]
    if start is None and search:
        a, b = secs(search[0]), min(x.shape[0], secs(search[1]))
        start = (a + aio.best_window(x[a:b], L + secs(xfade))) / SR
    y, st = aio.make_loop(x, L, start=None if start is None else secs(start), xfade=xfade)
    if sos:
        y = pfilter(y, chain(*sos))
    y = y / 10 ** (aio.lufs(y, True) / 20) * 10 ** ((-24 + gain_db) / 20)     # component at -24 LUFS + gain
    return y


def lvl(x, db):
    """Set a synthetic component to -24 LUFS + db."""
    return x / 10 ** (aio.lufs(x, True) / 20) * 10 ** ((-24 + db) / 20)


def st(x):
    return x if x.ndim == 2 else np.stack([x, x], 1)


# ------------------------------------------------------------------ beds (stereo, 16-20 s, layered lengths)
def width(x, target=0.35):
    """Mono-compatibility: narrow a stereo bed (scale its side signal) until L/R correlation >= target."""
    if x.ndim == 1:
        return x
    for k in range(12):
        c = np.corrcoef(x[:, 0], x[:, 1])[0, 1]
        if c >= target:
            break
        m, sd = (x[:, 0] + x[:, 1]) / 2, (x[:, 0] - x[:, 1]) / 2 * .85
        x = np.stack([m + sd, m - sd], 1)
    return x


def bed_gate():
    """Arrival: a light crowd walking the gravel/stone avenue (452458) over a festival murmur, soft air."""
    L = secs(18)
    return width(rec(452458, L, lpf=6500, hpf=90, search=(30, 85)) + rec(848976, L, lpf=4000, hpf=100, gain_db=-7) +
                 lvl(sfx.wind(L, 11, lo=60, hi=500, gust=.4), -14))


def bed_lake():
    """The hush: small waves on the quay (352356), synthetic lapping and bubbles, a faint breeze. No voices."""
    L = secs(17)
    return width(rec(352356, L, lpf=5000, hpf=60) + lvl(sfx.lapping(L, 21), -7) + lvl(sfx.wind(L, 22, 50, 400, .5), -11))


def bed_guild():
    """Courtyard evening crowd (741283) + torches crackling (483692)."""
    L = secs(16)
    return width(rec(741283, L, lpf=5500, hpf=90) + rec(483692, L, lpf=7000, gain_db=-8))


def bed_frost():
    """Wind over snow with a faint whistle; the crowd heard muffled (low-passed) behind it."""
    L = secs(19)
    w = sfx.wind(L, 41, lo=80, hi=1200, gust=.8, whistle=.15)
    return width(lvl(w, 0) + rec(461060, L, lpf=1500, hpf=120, gain_db=-8))


def bed_meridian():
    """Plaza crowd (848976) and a low electric hum under the neon."""
    L = secs(16)
    return width(rec(848976, L, lpf=6500, hpf=100) + lvl(sfx.hum(L, 51), -17))


def bed_wanderers():
    """A big cavernous convention-hall murmur (451600)."""
    L = secs(18)
    return width(rec(451600, L, lpf=6000, hpf=70))


def bed_brine():
    """Water slapping hulls and piles with small creaks (843246, Venice at night), plus a hull creak layer (31574)."""
    L = secs(17)
    return width(rec(843246, L, lpf=6000, hpf=50) + rec(31574, L, lpf=4000, hpf=120, gain_db=-7))


def bed_lantern():
    """Night-market chatter (834339, close and cheerful) with chimes tuned to the park's pentatonic."""
    L = secs(16)
    return width(rec(834339, L, lpf=5000, hpf=100, gain_db=-1) + lvl(sfx.chimes(L, 91, rate=.35), -15))


def bed_rosewick():
    """Gardens: a fountain (618285), crickets (522299) and guests strolling on gravel (352552), all soft."""
    L = secs(18)
    return width(rec(618285, L, lpf=6500, hpf=80, gain_db=-4) + rec(522299, L, lpf=7000, hpf=200, gain_db=-7) +
                 rec(352552, L, lpf=5000, hpf=120, gain_db=-8))


def bed_gap():
    """Green gaps and woods: crickets (522299), a breeze in leaves, wind."""
    L = secs(19)
    return width(rec(522299, L, lpf=7000, hpf=150, search=(100, 220)) + lvl(sfx.leaves(L, 112), -11) +
                 lvl(sfx.wind(L, 113, 50, 500, .6), -9))


def bed_sky():
    """From the sky: wind and a distant low-passed blend of the whole park."""
    L = secs(20)
    w = sfx.wind(L, 121, lo=40, hi=700, gust=.7, whistle=.08)
    return width(lvl(w, 0) + rec(461060, L, lpf=900, hpf=100, gain_db=-9) + rec(848976, L, lpf=600, hpf=80, gain_db=-12))


def crowd(fid, secs_, **kw):
    return lambda: width(rec(fid, secs(secs_), **kw))


# ------------------------------------------------------------------ layers and looped emitters (mono unless noted)
def mono(x):
    return x.mean(1) if x.ndim == 2 else x


ITEMS = {}


def item(name, cat, loop=True):
    def deco(fn):
        ITEMS[name] = dict(fn=fn, cat=cat, loop=loop)
        return fn
    return deco


for nm, fn in [('gate', bed_gate), ('lake', bed_lake), ('guildhollow', bed_guild), ('frostmere', bed_frost),
               ('meridian', bed_meridian), ('wanderers', bed_wanderers), ('brinewatch', bed_brine),
               ('lantern-row', bed_lantern), ('rosewick', bed_rosewick), ('gap', bed_gap), ('sky', bed_sky)]:
    ITEMS['bed_' + nm] = dict(fn=fn, cat='bed', loop=True)
for nm, fn in [('sparse', crowd(461060, 15, lpf=6000, hpf=100)), ('murmur', crowd(741283, 17, lpf=6000, hpf=90, search=(30, 70))),
               ('dense', crowd(546676, 13, lpf=6500, hpf=100))]:
    ITEMS['crowd_' + nm] = dict(fn=fn, cat='bed', loop=True)

for nm, fn in music.LOOPS.items():
    ITEMS[nm] = dict(fn=fn, cat='music', loop=True)
ITEMS['frost_drum']['cat'] = 'emit'


@item('torch_loop', 'emit')
def _():
    return mono(rec(483692, secs(9), lpf=7000, search=(200, 400)))


@item('fountain_loop', 'emit')
def _():
    return mono(rec(618285, secs(11), lpf=7000, hpf=100))


@item('neon_hum', 'emit')
def _():
    return mono(sfx.hum(secs(8), 52))


@item('train_loop', 'emit')
def _():
    return sfx.train_loop(secs(6), 61)


@item('creak_loop', 'emit')
def _():
    return mono(rec(31574, secs(13), lpf=4000, hpf=120))


@item('sizzle_loop', 'emit')
def _():
    return mono(sfx.sizzle(secs(7), 71))


@item('taiko_loop', 'emit')
def _():
    return sfx.taiko_loop(secs(26.6666667), 72, 73)   # 32 beats @72 = 26.67 s, same grid as the market music


@item('chimes_loop', 'emit')
def _():
    return mono(sfx.chimes(secs(13), 74, rate=.8, width=0))


ONESHOT_LEVEL = {}   # peak dBFS baked into the file (relative levels); default -3


def oneshot(name, fn, n, level=-3.0):
    for i in range(n):
        key = f'{name}_{i + 1}'
        ITEMS[key] = dict(fn=(lambda f=fn, i=i: f(i)), cat='oneshot', loop=False, level=level, group=name)


def rec_events(fid, picks=None, n=5, hpf=60, lpf=9000, max_len=1.5, thresh=-30, fade_out=.04, min_dur=.08, max_dur=99):
    """One-shots cut from a recording of separate hits: events with a typical level, `n` of them spread out."""
    from lib.dsp import filt, fade
    key = (fid, True)
    if key not in _cache:
        _cache[key] = aio.load(os.path.join(args.src, f'fs{fid}.mp3'), mono=True)
    ev = aio.events(_cache[key], thresh, max_len=max_len)
    if picks is None:
        pk = np.array([20 * np.log10(np.max(np.abs(e)) + 1e-9) for e in ev])
        ok = [i for i in range(len(ev)) if abs(pk[i] - np.median(pk)) < 6 and min_dur * SR < ev[i].size < max_dur * SR]
        picks = [ok[int(round(k))] for k in np.linspace(0, len(ok) - 1, min(n, len(ok)))]
    out = []
    for i in picks:
        e = filt(ev[i], chain(hp(hpf), lp(lpf)))
        out.append(fade(e, .002, fade_out))
    return out


def rec_oneshots(name, fid, level, **kw):
    cache = {}
    def get(i):
        if 'v' not in cache:
            cache['v'] = rec_events(fid, **kw)
        return cache['v'][i]
    k = len(kw.get('picks') or []) or kw.get('n', 5)
    oneshot(name, get, k, level)


rec_oneshots('footstep_stone', 521590, -6, n=5)
rec_oneshots('footstep_grass', 521587, -8, n=5)
rec_oneshots('footstep_snow', 613849, -6, n=5)
rec_oneshots('footstep_wood', 543685, -6, n=5, picks=[6, 7, 8, 9, 10])
oneshot('footstep_gravel', lambda i: sfx.footstep('gravel', 340 + i), 5, -7)
oneshot('firework_launch', lambda i: sfx.firework_launch(400 + i), 3, -4)
oneshot('firework_burst', lambda i: sfx.firework_burst(410 + i, big=i < 3), 5, -1)
oneshot('splash', lambda i: sfx.splash(420 + i, 1 + .3 * i), 4, -6)
oneshot('lantern_release', lambda i: sfx.lantern_release(430 + i), 3, -6)
oneshot('ui_click', lambda i: sfx.ui_click(i), 2, -10)
oneshot('oar', lambda i: sfx.oar(440 + i), 3, -6)
oneshot('spire_bell', lambda i: sfx.spire_bell(450 + i), 1, -1)
oneshot('anvil', lambda i: sfx.anvil(460 + i) if i else rec_events(270588, picks=[0], fade_out=.3)[0], 4, -4)
rec_oneshots('nightingale', 521035, -8, n=6, thresh=-24, max_len=4.0, fade_out=.3, hpf=900, lpf=9500, min_dur=1.2,
             max_dur=3.6)
oneshot('strength_bell', lambda i: sfx.strength_bell(470 + i), 2, -3)
oneshot('fanfare', lambda i: music.guild_fanfare()[0], 1, -2)
oneshot('ship_bell', lambda i: sfx.ship_bell(480 + i), 1, -3)
oneshot('shrine_bell', lambda i: sfx.shrine_bell(490 + i), 1, -3)
oneshot('clappers', lambda i: sfx.clappers(500 + i), 2, -3)
oneshot('station_chime', lambda i: sfx.station_chime(510 + i), 1, -3)
oneshot('announce', lambda i: sfx.announce(520 + i), 1, -5)
oneshot('owl', lambda i: sfx.owl(530 + i) if i else rec_events(465697, picks=[0], max_len=3, hpf=200, lpf=4000, fade_out=.3)[0], 3, -4)
oneshot('dice', lambda i: sfx.dice(540 + i) if i else rec_events(629982, picks=[0], fade_out=.1)[0], 3, -6)
oneshot('kettle', lambda i: sfx.kettle(550 + i), 2, -6)
rec_oneshots('skate', 593623, -6, picks=[0, 1, 2, 3], max_len=1.5, fade_out=.1, lpf=8000)
oneshot('ice_chimes', lambda i: sfx.ice_chimes(570 + i), 3, -4)
oneshot('creak', lambda i: sfx.creak(580 + i), 4, -6)
for d in range(12):
    ITEMS[f'door_{d + 1:02d}'] = dict(fn=(lambda d=d: music.door_phrase(d)[0]), cat='oneshot', loop=False, level=-3,
                                      group='door')

SUBDIR = {'music': 'music', 'bed': 'beds', 'layer': 'beds', 'emit': 'fx', 'oneshot': 'oneshots'}


def render_all():
    meta = json.load(open(META)) if os.path.exists(META) else {}
    for name, it in ITEMS.items():
        if ONLY and name not in ONLY and it.get('group') not in ONLY:
            continue
        t0 = time.time()
        res = it['fn']()
        cat = it['cat']
        if isinstance(res, tuple):          # music: (loop, Piece) -> keep the score for the piano roll / checks
            res, P = res
            os.makedirs(os.path.join(HERE, 'scores'), exist_ok=True)
            json.dump(dict(name=name, bpm=P.bpm, beats=P.beats, seconds=P.L / SR,
                           notes=[[t, round(b, 4), round(d, 4), int(m), round(float(v), 3)] for t, b, d, m, v in P.notes]),
                      open(os.path.join(HERE, 'scores', name + '.json'), 'w'))
        x = np.asarray(res, float)
        if cat == 'music':
            x = x if x.ndim == 1 else x.mean(1)
        if it['loop']:
            x = x - x.mean(0)                              # no DC
            x = x / 10 ** (aio.lufs(x, True) / 20) * 10 ** (TARGET[cat] / 20)
            x = aio.limit_periodic(x, -1.5)
        else:
            x = x - np.mean(x[: secs(.002)], 0) if x.shape[0] > 100 else x
            x = x / (np.max(np.abs(x)) + 1e-12) * 10 ** (it.get('level', -3) / 20)
            if it.get('group', '').startswith('footstep'):   # steps: equal loudness across surfaces, peak <= -3 dBFS
                x = x / 10 ** (aio.lufs(x) / 20) * 10 ** (-27 / 20)
                x = x * min(1, 10 ** (-3 / 20) / (np.max(np.abs(x)) + 1e-12))
        rel = f"{SUBDIR[cat]}/{name}.m4a"
        loop = aio.encode(x, os.path.join(OUT, rel), KBPS[cat], loop=it['loop'], tmp_dir=args.tmp)
        meta[name] = dict(file=rel, cat=cat, loop=loop, seconds=round(x.shape[0] / SR, 3),
                          channels=1 if x.ndim == 1 else 2, lufs=round(aio.lufs(x, it['loop']), 2),
                          true_peak=round(aio.true_peak_db(x), 2), bytes=os.path.getsize(os.path.join(OUT, rel)),
                          group=it.get('group'))
        print(f"{name:24s} {cat:8s} {meta[name]['seconds']:6.2f}s ch{meta[name]['channels']} "
              f"{meta[name]['lufs']:6.1f} LUFS tp {meta[name]['true_peak']:5.1f} {meta[name]['bytes'] / 1024:6.1f} KB "
              f"({time.time() - t0:.1f}s)", flush=True)
        json.dump(meta, open(META, 'w'), indent=1, sort_keys=True)
    return meta


if __name__ == '__main__':
    meta = json.load(open(META)) if args.json_only and os.path.exists(META) else render_all()
    import scene
    scene.write_json(meta, os.path.join(OUT, 'audio.json'))
