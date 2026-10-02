"""Weather sounds for fx/weather/audio.js, all synthesised here (no recordings): rain on paving, rain on the lake, rain
drumming on a roof heard from under it, wind, and three thunder rolls. Periodic loops (FFT noise, circular impulse
trains and convolution), so they loop without a seam; encoded like the other beds (AAC, 0.5 s pre/post-roll, loop
points [0.5, 0.5 + length]).

usage:  python tools/audio/weather.py            (numpy + scipy; ffmpeg on PATH; soundfile not needed)
writes  data/audio/weather/*.m4a and prints the loop points (copied into fx/weather/audio.js)"""
import os, subprocess, sys
import numpy as np
from scipy.io import wavfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib.dsp import SR, pnoise, band, pink, slow_lfo, pfilter, circ_conv, chain, lp, hp, bp, peak, filt, add_at
import sfx

OUT = os.path.abspath(os.path.join(HERE, '..', '..', 'data', 'audio', 'weather'))
PAD = 0.5


def rms_norm(x, db):
    return x / (np.sqrt(np.mean(x ** 2)) + 1e-12) * 10 ** (db / 20)


def peak_norm(x, db):
    return x / (np.max(np.abs(x)) + 1e-12) * 10 ** (db / 20)


def encode(x, name, kbps, loop=True):
    p = int(PAD * SR)
    y = np.concatenate([x[-p:], x, x[:p]]) if loop else x
    os.makedirs(OUT, exist_ok=True)
    wav = os.path.join('/tmp', name + '.wav')
    wavfile.write(wav, SR, np.clip(y, -1, 1).astype(np.float32))
    out = os.path.join(OUT, name + '.m4a')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav, '-c:a', 'aac', '-b:a', f'{kbps}k', '-ar', str(SR), '-movflags', '+faststart', out], check=True)
    os.remove(wav)
    print(f'{name}: {x.shape[0] / SR:.2f} s, {os.path.getsize(out) // 1024} KB' + (f', loop [{PAD}, {PAD + x.shape[0] / SR:.6f}]' if loop else ''))


def drops(L, seed, rate, kernel, amp_sigma=0.8, ch=2, spread=0.8):
    """`rate` drops per second at random times, log-normal loudness, random pan, each one `kernel(rng)` (mono)."""
    rng = np.random.default_rng(seed)
    out = np.zeros((L, ch))
    n = int(rate * L / SR)
    for _ in range(n):
        k = kernel(rng)
        a = np.exp(rng.normal(0, amp_sigma)) * 0.2
        pan = rng.uniform(-spread, spread); th = (pan + 1) * np.pi / 4
        add_at(out, np.stack([k * np.cos(th), k * np.sin(th)], 1) * a, int(rng.integers(0, L)))
    return out


def tick(rng, f0=(2500, 7000), dur=(0.002, 0.006)):
    """a raindrop on a hard surface: a few ms of resonant noise"""
    n = int(rng.uniform(*dur) * SR) + 8
    x = rng.normal(size=n) * np.exp(-np.arange(n) / (n / 4))
    return filt(x, bp(rng.uniform(*f0), 1.5))


def plip(rng):
    """a drop on water: a short damped sine whose pitch rises (the bubble it traps), Minnaert ~1-4 kHz"""
    d = rng.uniform(0.012, 0.03); n = int(d * SR)
    t = np.arange(n) / SR
    f = rng.uniform(900, 3200) * (1 + rng.uniform(0.3, 1.2) * t / d)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t / (d / 3)) * np.minimum(1, t / 0.0008)


def thud(rng):
    n = int(rng.uniform(0.01, 0.03) * SR)
    x = rng.normal(size=n) * np.exp(-np.arange(n) / (n / 5))
    return filt(x, lp(rng.uniform(300, 900), 0.9))


def rain_open(L):
    hiss = pnoise(L, 1, pink(500, 11000, 2), 2) * 0.5 + pnoise(L, 2, band(2500, 9000, 2), 2) * 0.35
    hiss *= (1 + 0.18 * slow_lfo(L, 3, (1, 2, 3)))[:, None]
    pat = drops(L, 4, 900, lambda r: tick(r)) + drops(L, 5, 160, lambda r: tick(r, (900, 2600), (0.004, 0.012)), 0.6)
    x = hiss * 0.55 + pat * 1.4
    x = pfilter(x, chain(hp(120), peak(4000, -2, 0.7)))
    return rms_norm(x, -29.6)                  # about -24 LUFS, like the other beds


def rain_lake(L):
    hiss = pnoise(L, 11, pink(300, 7000, 2), 2) * 0.5
    hiss *= (1 + 0.15 * slow_lfo(L, 12, (1, 2, 5)))[:, None]
    pl = drops(L, 13, 70, plip, 0.7) + drops(L, 14, 500, lambda r: tick(r, (1800, 5000), (0.002, 0.005)), 0.9) * 0.5
    x = hiss * 0.6 + pl * 1.2
    x = pfilter(x, chain(hp(90), lp(9000)))
    return rms_norm(x, -29)


def rain_roof(L):
    drum = drops(L, 21, 700, thud, 0.6, spread=0.5) + drops(L, 22, 400, lambda r: tick(r, (700, 1800), (0.004, 0.01)), 0.6, spread=0.5) * 0.6
    wash = pnoise(L, 23, pink(80, 1500, 2), 2) * 0.35
    rng = np.random.default_rng(24); dr = np.zeros((L, 2))          # a gutter dripping close by
    t = 0.0
    while t < L / SR - 0.05:
        k = plip(rng) * 0.8; th = (rng.uniform(-0.6, 0.6) + 1) * np.pi / 4
        add_at(dr, np.stack([k * np.cos(th), k * np.sin(th)], 1), int(t * SR)); t += rng.uniform(0.35, 0.9)
    x = pfilter(drum + wash, chain(hp(50), lp(2200, 0.6))) + dr * 0.25
    return rms_norm(x, -26)


def wind(L):
    x = sfx.wind(L, 31, lo=50, hi=800, gust=0.85, whistle=0.06)
    return rms_norm(x, -26.3)


def thunder(seed, dur=8.0):
    """a roll: a few overlapping low noise bursts with ragged envelopes, then a long rumbling tail"""
    rng = np.random.default_rng(seed); n = int(dur * SR); t = np.arange(n) / SR
    env = np.zeros(n)
    for _ in range(rng.integers(4, 8)):
        t0 = rng.uniform(0.0, 1.6) ** 1.5; a = rng.uniform(0.4, 1.0); tau = rng.uniform(0.25, 1.4)
        env += a * np.where(t > t0, np.exp(-(t - t0) / tau) * (1 - np.exp(-(t - t0) / 0.03)), 0)
    env += 0.35 * np.exp(-t / 2.6) * (1 - np.exp(-t / 0.4))
    jag = np.abs(filt(rng.normal(size=n), lp(14, 0.7))); jag = 0.55 + jag / jag.max()
    body = filt(rng.normal(size=n), chain(lp(320, 0.7), lp(480, 0.7), hp(28)))
    crack = filt(rng.normal(size=n), chain(hp(600), lp(3500))) * np.exp(-t / 0.12) * (t > 0.02) * rng.uniform(0.0, 0.35)
    x = body * env * jag + crack
    x *= np.minimum(1, (dur - t) / 1.5)                                   # fade to silence
    st = np.stack([x, np.roll(filt(x, lp(260)), int(0.011 * SR))], 1)    # a little width
    return peak_norm(st, -3)


if __name__ == '__main__':
    encode(rain_open(int(16 * SR)), 'rain_open', 64)
    encode(rain_lake(int(16 * SR)), 'rain_lake', 56)
    encode(rain_roof(int(14 * SR)), 'rain_roof', 48)
    encode(wind(int(18 * SR)), 'wind', 48)
    for i, s in enumerate((41, 42, 43)):
        encode(thunder(s), f'thunder_{i + 1}', 48, loop=False)
