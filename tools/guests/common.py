"""Shared loading for the guests data generator (tools/guests/).

Reads the baked dumps (read-only) and the viewer's walk grid. Blender frame: x east, y north, z up.
"""
import os, sys, json, gzip, re, math
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
NPZ = os.environ.get("GUESTS_NPZ", "/tmp/claude-1000/-home-zalo/253e908b-4e3c-4d12-a43e-a8b3b88482f6/scratchpad/web/npz")
PARK = os.environ.get("PARK_SRC", "/home/zalo/Work/nocturne-lands/Blender-Park")
sys.path.insert(0, PARK)
import park_common as pc  # noqa: E402

PARTS = ["core", "transit"] + pc.LAND_IDS
RANGE = 32.0

def load_manifest():
    return json.load(open(os.path.join(REPO, "data", "manifest.json")))

def load_nav():
    """Decode data/nav.bin exactly like app.js decodeNav(). Returns dict with w,h,x0,y0,cell and float heights
    zA, zB (nan = not walkable) plus raw codes A, B."""
    m = load_manifest()["nav"]
    raw = gzip.decompress(open(os.path.join(REPO, "data", m["file"]), "rb").read())
    W, H = m["w"], m["h"]; u8 = np.frombuffer(raw, np.uint8)
    out = []
    for l in range(2):
        lo = u8[l * 2 * W * H: l * 2 * W * H + W * H].astype(np.uint32)
        hi = u8[l * 2 * W * H + W * H: (l + 1) * 2 * W * H].astype(np.uint32)
        d = (lo | (hi << 8)).reshape(H, W)
        out.append((np.cumsum(d, axis=1) & 0xFFFF).astype(np.uint16))
    A, B = out
    zA = np.where(A > 0, (A.astype(np.float64) - 1) / 100 - 2, np.nan)
    zB = np.where(B > 0, (B.astype(np.float64) - 1) / 100 - 2, np.nan)
    return dict(w=W, h=H, x0=m["x0"], y0=m["y0"], cell=m["cell"], A=A, B=B, zA=zA, zB=zB)

def nav_ij(nav, x, y):
    i = np.floor((np.asarray(x) - nav["x0"]) / nav["cell"]).astype(np.int64)
    j = np.floor((np.asarray(y) - nav["y0"]) / nav["cell"]).astype(np.int64)
    return i, j

def nav_height(nav, x, y, zref=None, tol=0.6):
    """Walkable height at (x, y) nearest to zref (level A when zref is None); nan if none."""
    i, j = nav_ij(nav, x, y)
    ok = (i >= 0) & (j >= 0) & (i < nav["w"]) & (j < nav["h"])
    ic = np.clip(i, 0, nav["w"] - 1); jc = np.clip(j, 0, nav["h"] - 1)
    a = np.where(ok, nav["zA"][jc, ic], np.nan); b = np.where(ok, nav["zB"][jc, ic], np.nan)
    if zref is None: return a
    da = np.abs(a - zref); db = np.abs(b - zref)
    da = np.where(np.isnan(da), 1e9, da); db = np.where(np.isnan(db), 1e9, db)
    r = np.where(da <= db, a, b); d = np.minimum(da, db)
    return np.where(d <= tol, r, np.nan)

_cache = {}
def load_part(part, need=("co", "tri", "mi", "oid", "nr")):
    """Per-part arrays. Adds 'P' (T,3,3) float32 triangle corners, 'names', 'mats'."""
    key = part
    if key in _cache: return _cache[key]
    d = np.load(os.path.join(NPZ, "part__%s.npz" % part))
    meta = json.loads(str(d["meta"]))
    r = dict(part=part, names=meta["names"], mats=meta["mats"], _d=d)
    co = d["co"].astype(np.float32); tri = d["tri"].astype(np.int64)
    r["P"] = co[tri]; r["mi"] = np.clip(d["mi"], 0, len(meta["mats"]) - 1); r["oid"] = d["oid"]
    P = r["P"]; cr = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    a2 = np.linalg.norm(cr, axis=1); r["area"] = 0.5 * a2
    r["n"] = cr / np.maximum(a2, 1e-12)[:, None]
    _cache[key] = r
    return r

def corner(part_rec, key):
    """Per-corner array (T,3,3) float32 of 'light', 'lightnm', 'alb' or 'emit'."""
    d = part_rec["_d"]; T = len(part_rec["P"])
    return d[key].astype(np.float32).reshape(T, 3, 3)

_LADDER = None
def rgbm_ladder(c):
    """RGBM like rgbm(), but M is snapped up to a 64-step log ladder and rgb is quantized accordingly. Same decoding
    (hdr = rgb/255 * a/255 * RANGE); repeats bytes far more often, so the light grid compresses ~40% better."""
    global _LADDER
    if _LADDER is None: _LADDER = np.unique(np.clip(np.round(np.geomspace(1, 255, 64)), 1, 255))
    c = np.clip(c, 0.0, RANGE)
    a = np.clip(np.ceil(np.maximum(c.max(1), 1e-6) / RANGE * 255.0), 1, 255)
    a = _LADDER[np.searchsorted(_LADDER, a)]
    rgb = np.clip(np.round(c / (a[:, None] / 255.0 * RANGE) * 255.0 / 4) * 4, 0, 255)
    return np.concatenate([rgb, a[:, None]], 1).astype(np.uint8)

def strip(name, part):
    pre = part.replace("-", "_") + "_"
    return name[len(pre):] if name.startswith(pre) else name

def rgbm(c):
    c = np.clip(c, 0.0, RANGE)
    m = np.maximum(c.max(1), 1e-6) / RANGE
    a = np.clip(np.ceil(m * 255.0), 1, 255)
    rgb = np.clip(np.round(c / (a[:, None] / 255.0 * RANGE) * 255.0), 0, 255)
    return np.concatenate([rgb, a[:, None]], 1).astype(np.uint8)

def land_of(x, y):
    """'core' (lake, shore promenade, Spire), 'transit' (gaps, gate, ring outside lands) or a land id."""
    r = math.hypot(x, y); phi = math.atan2(y, x)
    if pc.point_in_poly(pc.SHORE, x, y) or r < 20: return "core"
    for lid in pc.LAND_IDS:
        a, b = pc.sector_phis(lid); p = phi
        while p < a: p += 2 * math.pi
        if p <= b: return lid
    return "transit"
