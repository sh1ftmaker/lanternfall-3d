"""Ground-light grid for the guests: data/guestlight.bin (+ preview PNG in the scratch dir).

For every 1 m cell: area-weighted average of the baked moon-less irradiance (`lightnm`, before albedo) of the
up-facing ground triangles at the walk-grid height of that spot; holes are filled from neighbours and the result is
blurred lightly. Optional side term: see figure_light() in this file.
"""
import os, sys, gzip, json
import numpy as np
from scipy import ndimage
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

CELL = 1.0

def sample_ground(nav, parts=C.PARTS, dens=0.03, log=print):
    """Accumulate lightnm of up-facing triangles that lie at the level-A walk height. Returns (sum (H,W,3), wsum (H,W))
    on the nav grid (0.5 m), plus the same for level B."""
    H, W = nav["h"], nav["w"]
    acc = np.zeros((2, H * W, 3)); wsum = np.zeros((2, H * W))
    rng = np.random.default_rng(3)
    for part in parts:
        r = C.load_part(part); P = r["P"]; nz = r["n"][:, 2]; zc = P[:, :, 2].mean(1)
        up = nz > 0.7          # down-facing slabs (Brinewatch cobbles) carry a constant placeholder light: skip them
        x0, y0 = nav["x0"], nav["y0"]
        inside = up & (P[:, :, 0].max(1) > x0) & (P[:, :, 0].min(1) < x0 + W * 0.5) & (P[:, :, 1].max(1) > y0) & (P[:, :, 1].min(1) < y0 + H * 0.5) & (zc < 40)
        idx_t = np.nonzero(inside)[0]
        L = C.corner(r, "lightnm")[idx_t]; L = np.minimum(L, 60.0)
        Pt = P[idx_t]; area = r["area"][idx_t]
        n = np.minimum(np.ceil(area / dens).astype(np.int64) + 1, 3000)
        for s in range(0, len(Pt), 100000):
            Pb = Pt[s:s + 100000]; Lb = L[s:s + 100000]; nb = n[s:s + 100000]; ab = area[s:s + 100000]
            idx = np.repeat(np.arange(len(Pb)), nb)
            u = rng.random(len(idx)); v = rng.random(len(idx)); fl = u + v > 1; u = np.where(fl, 1 - u, u); v = np.where(fl, 1 - v, v)
            w0 = 1 - u - v
            pts = Pb[idx, 0] * w0[:, None] + Pb[idx, 1] * u[:, None] + Pb[idx, 2] * v[:, None]
            lv = Lb[idx, 0] * w0[:, None] + Lb[idx, 1] * u[:, None] + Lb[idx, 2] * v[:, None]
            wt = (ab / nb)[idx]
            ix = np.floor((pts[:, 0] - x0) / 0.5).astype(np.int64); iy = np.floor((pts[:, 1] - y0) / 0.5).astype(np.int64)
            ok = (ix >= 0) & (iy >= 0) & (ix < W) & (iy < H)
            ix, iy, pts, lv, wt = ix[ok], iy[ok], pts[ok], lv[ok], wt[ok]
            for lev, key in ((0, "zA"), (1, "zB")):
                zl = nav[key][iy, ix]
                m = ~np.isnan(zl) & (pts[:, 2] > zl - 0.07) & (pts[:, 2] < zl + 0.07)
                c = iy[m] * W + ix[m]
                for k in range(3): acc[lev, :, k] += np.bincount(c, weights=lv[m, k] * wt[m], minlength=H * W)
                wsum[lev] += np.bincount(c, weights=wt[m], minlength=H * W)
        log("light: sampled", part, len(idx_t), "ground tris")
    return acc.reshape(2, H, W, 3), wsum.reshape(2, H, W)

def fill(val, w, have, sig=(0.8, 1.5, 3, 6, 12, 24, 48)):
    """Normalized-convolution fill of empty cells (have=False) from neighbours, at growing radii."""
    out = val.copy(); known = have.copy()
    for s in sig:
        if known.all(): break
        ww = ndimage.gaussian_filter(known.astype(np.float64), s, mode="nearest")
        vv = np.stack([ndimage.gaussian_filter(np.where(known, out[..., k], 0), s, mode="nearest") for k in range(3)], -1)
        new = (~known) & (ww > 0.02)
        out[new] = vv[new] / ww[new, None]; known |= new
    return out

def build(nav, log=print):
    acc, ws = sample_ground(nav, log=log)
    H, W = nav["h"], nav["w"]
    res = {}
    for lev in (0, 1):
        # 0.5 m -> 1 m
        a = acc[lev].reshape(H // 2, 2, W // 2, 2, 3).sum((1, 3)); w = ws[lev].reshape(H // 2, 2, W // 2, 2).sum((1, 3))
        walk = (~np.isnan(nav["zA" if lev == 0 else "zB"])).reshape(H // 2, 2, W // 2, 2).any((1, 3))
        have = w > 0.05
        val = np.where(have[..., None], a / np.maximum(w, 1e-9)[..., None], 0)
        val = fill(val, w, have)
        # light blur over everything (guests should not flicker between cells)
        val = np.stack([ndimage.gaussian_filter(val[..., k], 0.6, mode="nearest") for k in range(3)], -1)
        res[lev] = dict(val=val, have=have, walk=walk)
        log("light level %d: walk cells %d, sampled %d, walk-without-sample %d" % (lev, walk.sum(), (have & walk).sum(), (walk & ~have).sum()))
    return res

if __name__ == "__main__":
    nav = C.load_nav()
    res = build(nav)
    np.save(os.environ.get("GUESTS_SCRATCH", "/tmp") + "/light_raw.npy", np.stack([res[0]["val"], res[1]["val"]]))
