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
ap.add_argument('--src', default=os.environ.get('AUDIO_SRC', '/tmp/claude-1000/-home-zalo/253e908b-4e3c-4d12-a43e-a8b3b88482f6/scratchpad/agents/sound-fix/src'))   # sound-music/src + the wind recordings
ap.add_argument('--tmp', default=os.environ.get('AUDIO_TMP', '/tmp'))
ap.add_argument('--json-only', action='store_true')
args = ap.parse_args()
ONLY = set(filter(None, args.only.split(',')))

TARGET = {'music': -20.0, 'bed': -24.0, 'layer': -26.0, 'emit': -24.0}
KBPS = {'music': 64, 'bed': 64, 'layer': 56, 'emit': 56, 'oneshot': 48}


def secs(s):
    return int(round(s * SR))


# ------------------------------------------------------------------ recordings -> periodic loops
_cache = {}
USED = []          # Freesound ids used by the item being rendered (provenance -> render_meta -> CREDITS.md)


def rec(fid, L, start=None, mono=False, hpf=None, lpf=None, xfade=1.5, gain_db=0.0, search=None, calm=False):
    key = (fid, mono)
    USED.append(fid)
    if key not in _cache:
        _cache[key] = aio.load(os.path.join(args.src, f'fs{fid}.mp3'), mono=mono)
    x = _cache[key]
    sos = []
    if hpf: sos.append(hp(hpf))
    if lpf: sos += [lp(lpf), lp(lpf * 1.2)]
    if start is None and search:
        a, b = secs(search[0]), min(x.shape[0], secs(search[1]))
        start = (a + (aio.calm_window if calm else aio.best_window)(x[a:b], L + secs(xfade))) / SR
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


# ------------------------------------------------------------------ wind from recordings
_wind = {}


def wind_rec(fid, L, gain_db=0.0, **kw):
    """Recorded wind (Freesound `fid`) as a stereo periodic loop of L samples at -24 LUFS + gain_db; see
    lib.io.wind_loop for the rumble filter, the gust tamer and the loop choice."""
    USED.append(fid)
    y = aio.wind_loop(os.path.join(args.src, f'fs{fid}.mp3'), L, **kw)
    return y / 10 ** (aio.lufs(y, True) / 20) * 10 ** ((-24 + gain_db) / 20)


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
    """Arrival: an evening crowd outdoors (741283, a different stretch than Guildhollow's) over a large festival
    walla (848976), a little night air in the trees (37873)."""
    L = secs(18)
    return width(rec(741283, L, lpf=6500, hpf=90, search=(0, 30)) + rec(848976, L, lpf=4000, hpf=100, gain_db=-6) +
                 wind_rec(37873, L, hpf=200, lpf=5000, search=(12, 66), gain_db=-14))


def bed_lake():
    """The hush: small waves on the quay (352356), synthetic lapping and bubbles, a faint breeze. No voices."""
    L = secs(17)
    return width(rec(352356, L, lpf=5000, hpf=60) + lvl(sfx.lapping(L, 21), -7) +
                 wind_rec(435206, L, hpf=200, lpf=5000, search=(125, 235), gain_db=-12))


def bed_guild():
    """Courtyard evening crowd (741283) + torches crackling (483692)."""
    L = secs(16)
    return width(rec(741283, L, lpf=5500, hpf=90, search=(35, 70)) + rec(483692, L, lpf=7000, hpf=150, gain_db=-8))


def bed_frost():
    """Cold winter wind in conifers (575245); the crowd heard muffled (low-passed) behind it."""
    L = secs(24)
    return width(wind_rec(575245, L, hpf=200, lpf=7000, tame=.5) + rec(461060, L, lpf=1500, hpf=120, gain_db=-8))


def bed_meridian():
    """Plaza crowd (848976) and a low electric hum under the neon. The stretch is the one with the fewest stand-out
    events (the old one had a beep 29 dB over the crowd, heard every 16 s all over the land)."""
    L = secs(16)
    return width(rec(848976, L, lpf=6500, hpf=100, search=(0, 100), calm=True) + lvl(sfx.hum(L, 51), -17))


def bed_wanderers():
    """A big cavernous convention-hall murmur (451600)."""
    L = secs(18)
    return width(rec(451600, L, lpf=6000, hpf=70))


def bed_brine():
    """Water slapping hulls and piles with small creaks (843246, Venice at night), plus a hull creak layer (31574)."""
    L = secs(17)
    return width(rec(843246, L, lpf=6000, hpf=110) + rec(31574, L, lpf=4000, hpf=120, gain_db=-7))   # hull slaps: thuds, not rumble


def bed_lantern():
    """A bustling night market walked through (752436) with chimes tuned to the park's pentatonic."""
    L = secs(16)
    return width(rec(752436, L, lpf=5500, hpf=100) + lvl(sfx.chimes(L, 91, rate=.35), -15))


def bed_rosewick():
    """Gardens: a fountain (618285), a breeze in the leaves and a soft distant murmur (546676, low-passed).
    (The crickets are a few placed emitters now, crickets_loop: in every bed they never let up.)"""
    L = secs(18)
    return width(rec(618285, L, lpf=6500, hpf=80, gain_db=-4) + lvl(sfx.leaves(L, 114), -13) +
                 rec(546676, L, lpf=2500, hpf=120, gain_db=-11))


def bed_gap():
    """Green gaps and woods: wind in the trees at night (37873) over a breeze through oak leaves (435206).
    No crickets: this bed is heard a little everywhere."""
    L = secs(28)
    return width(wind_rec(37873, L, hpf=200, lpf=7000, search=(12, 66), tame=.25) +
                 wind_rec(435206, L, hpf=200, lpf=8000, search=(125, 235), tame=.25, gain_db=-5))


def bed_sky():
    """From the sky: open-air wind (a gale in pines, 86345, high-passed so only the air is left) and a distant
    low-passed blend of the whole park."""
    L = secs(30)
    return width(wind_rec(86345, L, hpf=250, lpf=6000, tame=.6) + rec(461060, L, lpf=900, hpf=120, gain_db=-9) +
                 rec(848976, L, lpf=600, hpf=120, gain_db=-12))


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
for nm, fn in [('sparse', crowd(461060, 15, lpf=6000, hpf=100)), ('murmur', crowd(848976, 17, lpf=6000, hpf=90, search=(100, 200), calm=True)),
               ('dense', crowd(546676, 13, lpf=6500, hpf=100))]:
    ITEMS['crowd_' + nm] = dict(fn=fn, cat='bed', loop=True)

for nm, fn in music.LOOPS.items():
    ITEMS[nm] = dict(fn=fn, cat='music', loop=True)
ITEMS['frost_drum']['cat'] = 'emit'
ITEMS['frost_drum']['hpf'] = 60          # drum loops that play continuously: keep the body, lose the sub


@item('torch_loop', 'emit')
def _():
    return mono(rec(483692, secs(9), lpf=7000, hpf=150, search=(200, 400)))   # the recording has rumble under the fire


@item('crickets_loop', 'emit')
def _():
    """Crickets at night (522299), for a few placed spots only."""
    return mono(rec(522299, secs(13), lpf=7000, hpf=250, search=(100, 220)))


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
    return mono(rec(500143, secs(13), lpf=5000, hpf=120, search=(2, 33)))


@item('sizzle_loop', 'emit')
def _():
    return mono(rec(783813, secs(9), lpf=7000, hpf=200))


@item('taiko_loop', 'emit')
def _():
    return sfx.taiko_loop(secs(13.3333333), 72, 73)   # 16 beats @72 = 13.33 s, same grid as the market music


ITEMS['taiko_loop']['hpf'] = 60


@item('chimes_loop', 'emit')
def _():
    return mono(sfx.chimes(secs(13), 74, rate=.8, width=0))


@item('ghost_hush', 'emit')
def _():
    return sfx.ghost_hush(secs(14), 75)


ONESHOT_LEVEL = {}   # peak dBFS baked into the file (relative levels); default -3
ONESHOT_HPF = {'firework_burst': 55, 'firework_launch': 70, 'strength_bell': 70, 'splash': 80, 'footstep_gravel': 60}


def oneshot(name, fn, n, level=-3.0):
    for i in range(n):
        key = f'{name}_{i + 1}'
        ITEMS[key] = dict(fn=(lambda f=fn, i=i: f(i)), cat='oneshot', loop=False, level=level, group=name)


def rec_events(fid, picks=None, n=5, hpf=60, lpf=9000, max_len=1.5, thresh=-30, fade_out=.04, min_dur=.08, max_dur=99):
    """One-shots cut from a recording of separate hits: events with a typical level, `n` of them spread out."""
    from lib.dsp import filt, fade
    key = (fid, True)
    USED.append(fid)
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
        USED.append(fid)
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
oneshot('firework_burst', lambda i: sfx.firework_burst(410 + i, big=i < 3), 5, -3)
oneshot('splash', lambda i: sfx.splash(420 + i, 1 + .3 * i), 4, -6)
oneshot('lantern_release', lambda i: sfx.lantern_release(430 + i), 3, -6)
oneshot('ui_click', lambda i: sfx.ui_click(i), 2, -10)
oneshot('oar', lambda i: sfx.oar(440 + i), 3, -6)
oneshot('spire_bell', lambda i: sfx.spire_bell(450 + i), 1, -3)
oneshot('anvil', lambda i: sfx.anvil(460 + i) if i else rec_events(270588, picks=[0], fade_out=.3)[0], 4, -4)
rec_oneshots('nightingale', 521035, -8, n=6, thresh=-24, max_len=4.0, fade_out=.3, hpf=900, lpf=9500, min_dur=1.2,
             max_dur=3.6)
oneshot('strength_bell', lambda i: sfx.strength_bell(470 + i), 2, -3)
oneshot('fanfare', lambda i: music.guild_fanfare()[0], 1, -3)
oneshot('lamplighter', lambda i: sfx.lamplighter(590 + i), 3, -6)
oneshot('ship_bell', lambda i: sfx.ship_bell(480 + i), 1, -3)
oneshot('shrine_bell', lambda i: sfx.shrine_bell(490 + i), 1, -3)
oneshot('clappers', lambda i: sfx.clappers(500 + i), 2, -3)
oneshot('station_chime', lambda i: sfx.station_chime(510 + i), 1, -3)
oneshot('announce', lambda i: sfx.announce(520 + i), 1, -5)
def _owl(i):
    if i == 0:
        return rec_events(465697, picks=[0], max_len=3, hpf=200, lpf=4000, fade_out=.3)[0]
    # tawny owl (745208): band-limit to the hoot (250-1200 Hz) to lose the phone's noise floor, then cut the hoots
    from lib.dsp import filt, fade
    USED.append(745208)
    x = aio.load(os.path.join(args.src, 'fs745208.mp3'), mono=True)
    ev = aio.events(filt(x, chain(hp(250), lp(1200), lp(1400))), -16, max_len=4, tail_db=-25, min_gap=.3)
    return fade(ev[i - 1], .03, .3)


oneshot('owl', _owl, 3, -4)
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
        USED.clear()
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
            if it.get('hpf'):                              # sub-bass a phone cannot play and the compressor pumps on
                x = pfilter(x, chain(hp(it['hpf']), hp(it['hpf'])))
            x = x / 10 ** (aio.lufs(x, True) / 20) * 10 ** (TARGET[cat] / 20)
            x = aio.limit_periodic(x, -3.0)            # AAC overshoots by up to ~2 dB on peaky material
            m_ = x if x.ndim == 1 else x.mean(1)
            src_wrap = float(abs(m_[0] - m_[-1]) / (np.percentile(np.abs(np.diff(m_)), 99) + 1e-12))
        else:
            src_wrap = None
            x = x - np.mean(x[: secs(.002)], 0) if x.shape[0] > 100 else x
            # one-shots: no DC or sub-sonic content (several synthetic ones had most of their energy below 60 Hz:
            # offsets from their envelopes, booms down to 25 Hz), 4th-order high-pass at ONESHOT_HPF (default 40 Hz)
            from lib.dsp import filt, fade
            f0 = ONESHOT_HPF.get(it.get('group'), 40)
            x = fade(filt(np.concatenate([x, np.zeros_like(x[:secs(.08)])]), chain(hp(f0), hp(f0))), 0, .06)
            x = x / (np.max(np.abs(x)) + 1e-12) * 10 ** (it.get('level', -3) / 20)
            if it.get('group', '').startswith('footstep'):   # steps: equal loudness across surfaces, peak <= -3 dBFS
                x = x / 10 ** (aio.lufs(x) / 20) * 10 ** (-27 / 20)
                x = x * min(1, 10 ** (-3 / 20) / (np.max(np.abs(x)) + 1e-12))
        rel = f"{SUBDIR[cat]}/{name}.m4a"
        loop = aio.encode(x, os.path.join(OUT, rel), KBPS[cat], loop=it['loop'], tmp_dir=args.tmp)
        meta[name] = dict(file=rel, cat=cat, loop=loop, seconds=round(x.shape[0] / SR, 3),
                          channels=1 if x.ndim == 1 else 2, lufs=round(aio.lufs(x, it['loop']), 2),
                          true_peak=round(aio.true_peak_db(x), 2), bytes=os.path.getsize(os.path.join(OUT, rel)),
                          group=it.get('group'), sources=sorted(set(USED)),
                          src_wrap=None if src_wrap is None else round(src_wrap, 3),
                          doc=(it['fn'].__doc__ or '').strip().split('\n\n')[0] if it['fn'].__doc__ else None)
        print(f"{name:24s} {cat:8s} {meta[name]['seconds']:6.2f}s ch{meta[name]['channels']} "
              f"{meta[name]['lufs']:6.1f} LUFS tp {meta[name]['true_peak']:5.1f} {meta[name]['bytes'] / 1024:6.1f} KB "
              f"({time.time() - t0:.1f}s)", flush=True)
        json.dump(meta, open(META, 'w'), indent=1, sort_keys=True)
    return meta


if __name__ == '__main__':
    meta = json.load(open(META)) if args.json_only and os.path.exists(META) else render_all()
    import scene
    scene.write_json(meta, os.path.join(OUT, 'audio.json'))
