"""Measure near-coplanar overlapping surface pairs (z-fighting candidates) in the triangles pack.py emits.

  python web_export/pack.py NPZ OUT --dump-tris tris.npz          # dequantised emitted triangles + labels
  uv run --no-project --with numpy --with pillow python web_export/zfight_measure.py tris.npz OUT_PREFIX [--cell 0.15]

Method: opaque triangles are grouped by unsigned plane orientation (horizontal floors/ceilings in one group, the rest
in 3-degree azimuth x elevation bins). Each group is rasterised onto a fine grid in its own plane frame (cell centres,
jittered off the 3 m bake grid); every sample stores its depth along the group normal. In each cell the samples are
sorted by depth and every consecutive pair whose depth gap is under 8 cm, whose normals agree within 5 degrees and that
is not a seam duplicate of one object is a conflict. Conflict area = cells x cell^2, reported per part, per material
pair and per gap bucket (<5 mm, <2 cm, <8 cm). "Exposed + outward" pairs are the ones that can actually
be seen: the upper surface faces away from the lower one (its normal points out of the stack, so it is not the inside
of a solid sitting on the other) and, for floors, no opaque layer lies within 1.5 m above it. Writes OUT_PREFIX.json, OUT_PREFIX.txt and a top-down OUT_PREFIX.png.
"""
import sys, os, json, math
import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, HERE)
import park_common as pc

src, pre = sys.argv[1], sys.argv[2]
CELL = float(sys.argv[sys.argv.index("--cell") + 1]) if "--cell" in sys.argv else 0.15
WCELL = 0.08                     # walls / sloped surfaces: finer, plaques and signs are small
R_MAX = 330.0                    # region measured (the bake grid-cuts faces only inside this radius)
BUCKETS = [(0.005, "<5mm"), (0.02, "<2cm"), (0.08, "<8cm")]
COS_PAR = math.cos(math.radians(5.0))

d = np.load(src)
P = d["P"].astype(np.float64); mat = d["mat"]; oid = d["oid"]; part = d["part"]; glass = d["glass"]
names = list(d["names"]); parts = list(d["parts"])
sel = ~glass & (np.hypot(P[:, :, 0], P[:, :, 1]).min(1) < R_MAX)
cr = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]); ln = np.linalg.norm(cr, axis=1); sel &= ln > 1e-9
N = cr / np.maximum(ln, 1e-12)[:, None]
idx = np.nonzero(sel)[0]
print("opaque triangles in region:", len(idx))

# ---- orientation groups
nz = N[idx, 2]
floor = np.abs(nz) > 0.985                                         # within ~10 deg of horizontal
STEP = math.radians(3.0)
Nf = N[idx] * np.where(np.arctan2(N[idx, 1], N[idx, 0]) < 0, -1.0, 1.0)[:, None]  # unsigned: azimuth in [0, pi)
az = np.arctan2(Nf[:, 1], Nf[:, 0]); el = np.arcsin(np.clip(Nf[:, 2], -1, 1))
nb_az = int(round(math.pi / STEP))
baz = np.round(az / STEP).astype(np.int64) % nb_az
bel = np.round(el / STEP).astype(np.int64)
grp = np.where(floor, -1, baz * 1000 + (bel + 500))

def frame(g):
    if g == -1: return np.array([0, 0, 1.0]), np.array([1.0, 0, 0]), np.array([0, 1.0, 0])
    a = (g // 1000) * STEP; e = (g % 1000 - 500) * STEP
    R = np.array([math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)])
    U = np.cross([0, 0, 1.0], R); U /= np.linalg.norm(U); V = np.cross(R, U)
    return R, U, V

def raster(tris, R, U, V, cell, jit=(0.0371, 0.0613)):
    """tris: global triangle ids. Returns (tri id, cell u, cell v, depth) for cell centres inside each triangle."""
    out = []
    Q = P[tris]; u = Q @ U; v = Q @ V; w = Q @ R
    u0 = np.floor((u.min(1) - jit[0]) / cell).astype(np.int64); u1 = np.floor((u.max(1) - jit[0]) / cell).astype(np.int64)
    v0 = np.floor((v.min(1) - jit[1]) / cell).astype(np.int64); v1 = np.floor((v.max(1) - jit[1]) / cell).astype(np.int64)
    nu = u1 - u0 + 1; nv = v1 - v0 + 1; n = nu * nv
    ok = n < 2_000_000
    order = np.nonzero(ok)[0]
    cs = np.cumsum(n[order]); starts = np.concatenate([[0], cs[:-1]])
    B = 6_000_000
    i0 = 0
    while i0 < len(order):
        i1 = np.searchsorted(cs, cs[i0 - 1] + B if i0 > 0 else B, side="right"); i1 = max(i1, i0 + 1)
        o = order[i0:i1]; cnt = n[o]
        t = np.repeat(np.arange(len(o)), cnt)
        k = np.arange(cnt.sum()) - np.repeat(starts[i0:i1] - starts[i0], cnt)
        tt = o[t]
        cu = u0[tt] + k % nu[tt]; cv = v0[tt] + k // nu[tt]
        px = (cu + 0.5) * cell + jit[0]; py = (cv + 0.5) * cell + jit[1]
        a = np.stack([u[tt, 0], v[tt, 0]], 1); b = np.stack([u[tt, 1], v[tt, 1]], 1); c = np.stack([u[tt, 2], v[tt, 2]], 1)
        den = (b[:, 1] - c[:, 1]) * (a[:, 0] - c[:, 0]) + (c[:, 0] - b[:, 0]) * (a[:, 1] - c[:, 1])
        den = np.where(np.abs(den) < 1e-14, 1e-14, den)
        l1 = ((b[:, 1] - c[:, 1]) * (px - c[:, 0]) + (c[:, 0] - b[:, 0]) * (py - c[:, 1])) / den
        l2 = ((c[:, 1] - a[:, 1]) * (px - c[:, 0]) + (a[:, 0] - c[:, 0]) * (py - c[:, 1])) / den
        l3 = 1 - l1 - l2
        ins = (l1 >= 0) & (l2 >= 0) & (l3 >= 0)
        dep = l1 * w[tt, 0] + l2 * w[tt, 1] + l3 * w[tt, 2]
        out.append((tris[tt[ins]], cu[ins], cv[ins], dep[ins]))
        i0 = i1
    if not out: return [np.zeros(0, np.int64)] * 3 + [np.zeros(0)]
    return [np.concatenate(x) for x in zip(*out)]

pairs = []        # (lower tri, upper tri, gap, cell area, group is floor, exposed)
for g in np.unique(grp):
    tris = idx[grp == g]
    if g != -1 and len(tris) < 2: continue
    R, U, V = frame(g); cell = CELL if g == -1 else WCELL
    t, cu, cv, dep = raster(tris, R, U, V, cell)
    if len(t) < 2: continue
    key = (cu + (1 << 20)) * (1 << 21) + (cv + (1 << 20))
    o = np.lexsort((dep, key)); t, key, dep = t[o], key[o], dep[o]
    same = key[1:] == key[:-1]
    gap = dep[1:] - dep[:-1]
    lo, hi = t[:-1], t[1:]
    seam = (gap < 1e-5) & (oid[lo] == oid[hi])
    par = np.abs((N[lo] * N[hi]).sum(1)) > COS_PAR
    m = same & ~seam & par & (gap < BUCKETS[-1][0])
    exposed = np.ones(len(m), bool)
    if g == -1:
        # exposed: the next sample above the upper one (same cell) is > 1.5 m higher, or there is none
        nxt_same = np.concatenate([same[1:], [False]])
        nxt_gap = np.concatenate([gap[1:], [np.inf]])
        exposed = ~nxt_same | (nxt_gap > 1.5)
    k = np.nonzero(m)[0]
    outward = (N[hi] @ R) > 0.5
    pc_ = (cu[o][k] + 0.5) * cell * U[:, None] + (cv[o][k] + 0.5) * cell * V[:, None] + dep[k] * R[:, None]   # sample position
    pairs.append((lo[k], hi[k], gap[k], np.full(len(k), cell * cell), np.full(len(k), g == -1), exposed[k] & outward[k], pc_[0].astype(np.float32), pc_[1].astype(np.float32)))
lo, hi, gap, ca, isf, expo, sx, sy = [np.concatenate(x) for x in zip(*pairs)]
print("conflict samples:", len(lo))

def bucket_areas(msk):
    return {lab: round(float(ca[msk & (gap < th)].sum()), 2) for th, lab in BUCKETS}

rep = dict(cell=CELL, wall_cell=WCELL, total=dict(floor=bucket_areas(isf), floor_exposed=bucket_areas(isf & expo), other=bucket_areas(~isf), other_outward=bucket_areas(~isf & expo)))
rep["per_part"] = {}
for pi, pn in enumerate(parts):
    mm = part[hi] == pi
    rep["per_part"][str(pn)] = dict(floor=bucket_areas(mm & isf), floor_exposed=bucket_areas(mm & isf & expo), other=bucket_areas(mm & ~isf), other_outward=bucket_areas(mm & ~isf & expo))
# per material pair (lower | upper), sorted by <2cm area
mp = mat[lo].astype(np.int64) * 100000 + mat[hi]
um, inv = np.unique(mp, return_inverse=True)
rows = []
for j, k in enumerate(um):
    msk = inv == j
    a = [float(ca[msk & (gap < th)].sum()) for th, _ in BUCKETS]
    e = [float(ca[msk & expo & (gap < th)].sum()) for th, _ in BUCKETS]
    rows.append(dict(lower=str(names[k // 100000]), upper=str(names[k % 100000]), floor=bool(isf[msk].mean() > 0.5),
                     a5=round(a[0], 2), a2=round(a[1], 2), a8=round(a[2], 2), e5=round(e[0], 2), e2=round(e[1], 2), e8=round(e[2], 2),
                     med_gap_mm=round(float(np.median(gap[msk])) * 1000, 1),
                     at=[round(float(sx[msk][len(sx[msk]) // 2]), 1), round(float(sy[msk][len(sy[msk]) // 2]), 1)]))
rows.sort(key=lambda r: -r["a8"])
rep["material_pairs"] = rows[:400]
json.dump(rep, open(pre + ".json", "w"), indent=1)

with open(pre + ".txt", "w") as f:
    def pr(*s): print(*s); print(*s, file=f)
    pr("conflict area m^2 (cell %.2f m floors, %.2f m others); gap buckets are cumulative" % (CELL, WCELL))
    pr("%-12s | %26s | %26s | %26s | %26s" % ("part", "floor all <5mm/<2cm/<8cm", "floor exposed+outward", "walls+other all", "walls+other outward"))
    for pn, v in list(rep["per_part"].items()) + [("TOTAL", rep["total"])]:
        fm = lambda b: "%8.1f %8.1f %8.1f" % tuple(b[l] for _, l in BUCKETS)
        pr("%-12s | %s | %s | %s | %s" % (pn, fm(v["floor"]), fm(v["floor_exposed"]), fm(v["other"]), fm(v["other_outward"])))
    pr("\ntop material pairs (lower -> upper): area <5mm <2cm <8cm, median gap")
    for r in rows[:40]:
        pr("  %-5s %-28s -> %-28s %8.2f %8.2f %8.2f  %6.1f mm" % ("floor" if r["floor"] else "wall", r["lower"], r["upper"], r["a5"], r["a2"], r["a8"], r["med_gap_mm"]))
    pr("\ntop EXPOSED+OUTWARD floor pairs: area <5mm <2cm <8cm")
    for r in sorted([r for r in rows if r["floor"]], key=lambda r: -(r["e2"] * 10 + r["e8"]))[:40]:
        pr("  %-28s -> %-28s %8.2f %8.2f %8.2f  %6.1f mm  at %s" % (r["lower"], r["upper"], r["e5"], r["e2"], r["e8"], r["med_gap_mm"], r["at"]))
    pr("\ntop OUTWARD wall/other pairs by <2cm area")
    for r in sorted([r for r in rows if not r["floor"]], key=lambda r: -r["e2"])[:30]:
        pr("  %-28s -> %-28s %8.2f %8.2f %8.2f  %6.1f mm  at %s" % (r["lower"], r["upper"], r["e5"], r["e2"], r["e8"], r["med_gap_mm"], r["at"]))

# ---- top-down debug image, 0.5 m / px
try:
    from PIL import Image, ImageDraw
    X0, X1, Y0, Y1, S = -275.0, 345.0, -225.0, 225.0, 0.5
    W, H = int((X1 - X0) / S), int((Y1 - Y0) / S)
    img = np.zeros((H, W, 3), np.float32)
    # base: max height of opaque floors, grey
    fl = idx[floor]; c = P[fl].mean(1)
    ix = np.clip(((c[:, 0] - X0) / S).astype(int), 0, W - 1); iy = np.clip(((Y1 - c[:, 1]) / S).astype(int), 0, H - 1)
    base = np.zeros((H, W)); np.maximum.at(base, (iy, ix), 0.25 + np.clip(c[:, 2], 0, 30) / 60)
    img[:] = base[:, :, None] * 0.6
    def splat(msk, col, full):
        jx = ((sx[msk] - X0) / S).astype(int); jy = ((Y1 - sy[msk]) / S).astype(int)
        cnt = np.zeros((H, W)); ok = (jx >= 0) & (jx < W) & (jy >= 0) & (jy < H)
        np.add.at(cnt, (jy[ok], jx[ok]), ca[msk][ok])
        a = np.clip(cnt / (full * S * S), 0, 1)[:, :, None]
        img[:] = img * (1 - a) + np.array(col, np.float32) * a
    splat(isf & ~expo & (gap < 0.08), (0.35, 0.15, 0.45), 1.0)     # hidden under-layers: dim purple
    splat(isf & expo & (gap < 0.08), (0.9, 0.85, 0.2), 1.0)
    splat(isf & expo & (gap < 0.02), (1.0, 0.5, 0.0), 0.5)
    splat(~isf & expo & (gap < 0.02), (0.2, 0.6, 1.0), 0.3)
    splat(expo & isf & (gap < 0.005), (1.0, 0.0, 0.1), 0.5)
    splat(~isf & expo & (gap < 0.005), (0.0, 1.0, 1.0), 0.3)
    im = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
    dr = ImageDraw.Draw(im)
    for k, v in pc.LANDS.items():
        x, y = v["center"]; dr.text(((x - X0) / S - 30, (Y1 - y) / S), k, fill=(255, 255, 255))
    dr.text((8, 8), "visible floor pairs: red <5mm orange <2cm yellow <8cm | hidden floor stacks <8cm: purple | visible wall pairs: cyan <5mm blue <2cm", fill=(255, 255, 255))
    im.save(pre + ".png")
except ImportError:
    print("pillow not available: no image")
