"""Build the real-time light list for Lanternfall 3D's per-pixel lighting mode.

  uv run --no-project --with numpy --with scipy python tools/gen_lights.py NPZ_DIR tools/lights_blender.json data/lit [--calib]

Sources:
  * Blender point / spot lights (tools/lights_blender.json, written by tools/dump_lights.py)
  * virtual point lights (VPLs) made by clustering the emissive triangles of every part (npz `emit`) on a 3D voxel grid
    (one per lantern / lamp head / window group / neon run segment)
Output data/lit/lights.bin = gzip(Float32 N x 16), three.js axes, one light = 4 RGBA texels:
  [p.xyz, range] [col.rgb, soft] [axis.xyz, a] [e0, e1, b, kind]
Light model (same in lit.js):  L(x, n) = col * ang * max(n.l, 0) * win(d / range) / (d^2 + soft^2)
  ang = (a + b * max(axis.w, 0)) * smoothstep(e0, e1, axis.w),  w = direction light -> x,  win(t) = clamp(1 - t^4)^2
Units: the baked `light` pass of bake.py (diffuse colour = albedo * light + emission).
"""
import sys, os, json, gzip, math
import numpy as np
from scipy.spatial import cKDTree

NPZ, LJ, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
CALIB = "--calib" in sys.argv
os.makedirs(OUT, exist_ok=True)
PARTS = ["core", "transit", "wanderers", "meridian", "frostmere", "guildhollow", "rosewick", "lantern-row", "brinewatch"]
EPS = 0.01            # range: where the brightest direction falls below this (baked-light units)
RMAX = 40.0
VOX = 1.6             # emissive clustering voxel (m)
K_LAMP = 1.0          # calibration scales (set from --calib)
K_EMIT = 1.0
LUM = np.array([0.2126, 0.7152, 0.0722])

def to_three(p): return np.stack([p[..., 0], p[..., 2], -p[..., 1]], -1)

lights = []   # dicts in Blender axes
for d in json.load(open(LJ)):
    if d["type"] not in ("POINT", "SPOT") or d["hidden"] or d["energy"] <= 0: continue
    col = np.array(d["color"]) * d["energy"] / (4 * math.pi ** 2) * K_LAMP
    L = dict(p=np.array(d["pos"]), col=col, soft=max(d["radius"], 0.1), axis=np.array(d["dir"]), a=1.0, b=0.0, e0=-3.0, e1=-2.0, kind=0)
    if d["type"] == "SPOT":
        half = d["spot_size"] / 2; c0 = math.cos(half)
        L.update(e0=c0, e1=c0 + max(d["spot_blend"], 0.02) * (1 - c0), kind=1)
    lights.append(L)
n_lamps = len(lights)

emit_stats = {}
for part in PARTS:
    f = os.path.join(NPZ, "part__%s.npz" % part)
    d = np.load(f)
    co = d["co"].astype(np.float64); tri = d["tri"].astype(np.int64); T = len(tri)
    e = d["emit"].astype(np.float32).reshape(T, 3, 3).mean(1)
    lum = e @ LUM
    sel = lum > 0.05
    p = co[tri[sel]]; cr = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]); A2 = np.linalg.norm(cr, axis=1)
    A = 0.5 * A2; n = cr / np.maximum(A2, 1e-12)[:, None]; cen = p.mean(1); e = e[sel]; lum = lum[sel]
    ok = (A > 1e-7) & (np.hypot(cen[:, 0], cen[:, 1]) < 1650)
    A, n, cen, e, lum = A[ok], n[ok], cen[ok], e[ok], lum[ok]
    key = np.floor(cen / VOX).astype(np.int64); key = (key[:, 0] + 4096) * 8192 * 8192 + (key[:, 1] + 4096) * 8192 + (key[:, 2] + 4096)
    uk, inv = np.unique(key, return_inverse=True); G = len(uk)
    w = lum * A
    S = np.zeros((G, 3)); np.add.at(S, inv, e * A[:, None])
    W = np.bincount(inv, weights=w, minlength=G)
    C = np.zeros((G, 3)); np.add.at(C, inv, cen * w[:, None]); C /= np.maximum(W, 1e-12)[:, None]
    V = np.zeros((G, 3)); np.add.at(V, inv, n * w[:, None])
    R2 = np.bincount(inv, weights=w * ((cen - C[inv]) ** 2).sum(1), minlength=G) / np.maximum(W, 1e-12)
    g = np.clip(np.linalg.norm(V, axis=1) / np.maximum(W, 1e-12), 0, 1)
    axis = V / np.maximum(np.linalg.norm(V, axis=1), 1e-12)[:, None]
    col = S / math.pi * K_EMIT
    keep = 0
    for i in range(G):
        imax = float(col[i] @ LUM) * ((1 - g[i]) / 4 + g[i])
        if imax / EPS < 2.0 ** 2: continue                  # reach under 2 m: negligible
        lights.append(dict(p=C[i], col=col[i], soft=max(math.sqrt(R2[i]), 0.12), axis=axis[i], a=(1 - g[i]) / 4, b=g[i], e0=-3.0, e1=-2.0, kind=2))
        keep += 1
    emit_stats[part] = (int(sel.sum()), G, keep)
    print("[lights] %-12s emissive tris %7d -> %6d voxels -> %6d VPLs" % (part, sel.sum(), G, keep), flush=True)

N = len(lights)
arr = np.zeros((N, 16), np.float32)
for i, L in enumerate(lights):
    imax = float(L["col"] @ LUM) * (L["a"] + L["b"])
    rng = min(RMAX, math.sqrt(max(imax, 1e-9) / EPS))
    arr[i, 0:3] = to_three(L["p"]); arr[i, 3] = rng
    arr[i, 4:7] = L["col"]; arr[i, 7] = L["soft"]
    arr[i, 8:11] = to_three(L["axis"]); arr[i, 11] = L["a"]
    arr[i, 12] = L["e0"]; arr[i, 13] = L["e1"]; arr[i, 14] = L["b"]; arr[i, 15] = L["kind"]
print("[lights] total %d (%d lamps/spots, %d VPLs); range median %.1f m, p90 %.1f m" % (N, n_lamps, N - n_lamps, np.median(arr[:, 3]), np.percentile(arr[:, 3], 90)))

def eval_lights(arr, P, Nn, k=96):
    """Analytic light (no shadows) at points P with normals Nn, three axes. Returns (n,3) and #lights in range."""
    tree = cKDTree(arr[:, :3])
    dd, ii = tree.query(P, k=min(k, len(arr)))
    Lp = arr[ii]                                            # (n,k,16)
    dv = Lp[:, :, :3] - P[:, None, :]; dist2 = (dv ** 2).sum(-1); dist = np.sqrt(dist2); l = dv / np.maximum(dist, 1e-6)[..., None]
    ndl = np.maximum((l * Nn[:, None, :]).sum(-1), 0)
    t = dist / Lp[:, :, 3]; win = np.clip(1 - t ** 4, 0, 1) ** 2
    c = -(l * Lp[:, :, 8:11]).sum(-1)
    x = np.clip((c - Lp[:, :, 12]) / (Lp[:, :, 13] - Lp[:, :, 12]), 0, 1); sm = x * x * (3 - 2 * x)
    ang = (Lp[:, :, 11] + Lp[:, :, 14] * np.maximum(c, 0)) * sm
    f = ang * ndl * win / (dist2 + Lp[:, :, 7] ** 2)
    kind = Lp[:, :, 15]
    out = {}
    for name, m in (("lamp", kind < 1.5), ("emit", kind > 1.5)):
        out[name] = ((f * m)[..., None] * Lp[:, :, 4:7]).sum(1)
    return out, (win > 0).sum(1)

if CALIB:
    rng_ = np.random.default_rng(1)
    rows = []
    for part in PARTS:
        d = np.load(os.path.join(NPZ, "part__%s.npz" % part))
        co = d["co"]; tri = d["tri"]; T = len(tri)
        meta = json.loads(str(d["meta"])); mats = meta["mats"]
        mi = np.clip(d["mi"], 0, len(mats) - 1)
        lit = d["light"].reshape(T, 3, 3).astype(np.float32); em = d["emit"].reshape(T, 3, 3)
        s = rng_.choice(T, size=min(T, 40000), replace=False)
        s = s[(em[s].max(axis=(1, 2)) < 0.01) & ~np.array([m["glass"] for m in mats])[mi[s]]]
        p = co[tri[s]].astype(np.float64); cr = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]); nn = cr / np.maximum(np.linalg.norm(cr, axis=1), 1e-12)[:, None]
        P = to_three(p.mean(1) + nn * 0.02); Nn = to_three(nn)
        out, cnt = eval_lights(arr, P, Nn)
        rows.append((part, lit[s].mean(1), out["lamp"], out["emit"], cnt, P))
        print("[calib] %-12s n=%6d  lights-in-range: median %d p90 %d max %d" % (part, len(s), np.median(cnt), np.percentile(cnt, 90), cnt.max()))
    Lb = np.concatenate([r[1] for r in rows]) @ LUM; La = np.concatenate([r[2] for r in rows]) @ LUM; Le = np.concatenate([r[3] for r in rows]) @ LUM
    # robust scale: fit baked ~ kL*La + kE*Le + c on points where the analytic light is substantial (upper envelope = unshadowed)
    m = (La + Le) > 0.02
    X = np.stack([La[m], Le[m], np.ones(m.sum())], 1)
    coef, *_ = np.linalg.lstsq(X, Lb[m], rcond=None)
    print("[calib] lstsq baked ~ %.3f*lamps + %.3f*emitters + %.3f   (n=%d)" % (*coef, m.sum()))
    for nm, sel in (("lamp-dominated", m & (La > 3 * Le)), ("emit-dominated", m & (Le > 3 * La))):
        r = Lb[sel] / np.maximum(La[sel] + Le[sel], 1e-6)
        print("[calib] %s: n=%d  baked/analytic  p25 %.2f  median %.2f  p75 %.2f  p90 %.2f" % (nm, sel.sum(), *np.percentile(r, [25, 50, 75, 90])))
    an = La + Le
    print("[calib] analytic>2x baked (leak/shadow) fraction: %.1f%%   analytic<0.5x baked: %.1f%%" % (100 * np.mean(an[m] > 2 * Lb[m]), 100 * np.mean(an[m] < 0.5 * Lb[m])))
    print("[calib] baked light median %.3f, analytic median %.3f" % (np.median(Lb), np.median(an)))

raw = arr.tobytes(); gz = gzip.compress(raw, 9)
open(os.path.join(OUT, "lights.bin"), "wb").write(gz)
json.dump(dict(count=N, lamps=n_lamps, stride=16, eps=EPS, emit=emit_stats), open(os.path.join(OUT, "lights.json"), "w"))
print("[lights] wrote lights.bin %d lights, %.0f KB gz (raw %.0f KB)" % (N, len(gz) / 1e3, len(raw) / 1e3))
