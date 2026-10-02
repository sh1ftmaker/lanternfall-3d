"""Benches, chairs and tiered seating -> bench POIs (seat centre at seat height, facing, cap, len)."""
import re, math
import numpy as np
from scipy import ndimage
import common as C

# what counts as seating, per part: object-name regex (prefix stripped) and material regex
NAME_RX = r"bench|bleacher|audience_chair"
NAME_NOT = r"(^|_)(src|SRC|proto)(_|$)|bench_src|SRC_|_led"
MAT_RX = {"core": r"^core_benchwood$", "meridian": r"^meridian_seat_violet$"}
CURVED = False   # no curved benches in the park at the moment (the split code below is kept for them)
# seats inside joined meshes: (object regex, material regex)
OBJMAT = {"guildhollow": [(r"gate_plaza|lakeside", r"stone_pale"), (r"training_yard", r"wood_light")]}

def candidates(geo):
    """Triangle ids grouped by (part, oid) for seating objects/materials."""
    groups = {}
    for k, part in enumerate(geo.parts):
        names = geo.names[k]; mats = geo.mats[k]
        on = np.array([bool(re.search(NAME_RX, C.strip(n, part))) and not re.search(NAME_NOT, n) for n in names])
        om = np.array([bool(re.search(MAT_RX.get(part, r"^$"), m)) for m in mats])
        idx = np.nonzero(geo.part == k)[0]
        hit = on[geo.oid[idx]] | om[geo.mi[idx]]
        for orx, mrx in OBJMAT.get(part, []):
            oo = np.array([bool(re.search(orx, n)) for n in names]); mm = np.array([bool(re.search(mrx, m)) for m in mats])
            hit |= oo[geo.oid[idx]] & mm[geo.mi[idx]]
        sel = idx[hit]
        for o in np.unique(geo.oid[sel]):
            ids = sel[geo.oid[sel] == o]
            # material-selected tris of a joined object are only the seat material; name-selected objects keep all
            groups[(part, names[o])] = ids
    return groups

def components(geo, ids, cell=0.1, grow=1):
    """Split a triangle set into spatially separate pieces (xy raster, dilated)."""
    pts, tid = geo.points(ids, 0.08)
    lo = pts[:, :2].min(0) - 0.5
    ij = np.floor((pts[:, :2] - lo) / cell).astype(np.int64)
    W, H = ij.max(0) + 2
    if W * H > 4e7: return [ids]
    occ = np.zeros((H, W), bool); occ[ij[:, 1], ij[:, 0]] = True
    occ = ndimage.binary_dilation(occ, iterations=grow)
    lab, n = ndimage.label(occ)
    pl = lab[ij[:, 1], ij[:, 0]]
    tl = np.zeros(len(geo.P), np.int64)          # scratch: label per tri (first sample wins)
    tl[tid[::-1]] = pl[::-1]
    out = []
    lt = tl[ids]
    for l in range(1, n + 1):
        s = ids[lt == l]
        if len(s): out.append(s)
    return out

def floor_near(geo, ids, pad=0.8):
    """Height of the floor around a piece: 20th percentile of up-facing geometry in a ring around its bbox
    (its own triangles excluded)."""
    P = geo.P[ids]; lo = P.reshape(-1, 3).min(0); hi = P.reshape(-1, 3).max(0)
    t = geo.tris_in(lo[0] - pad, hi[0] + pad, lo[1] - pad, hi[1] + pad, lo[2] - 2.0, hi[2])
    t = t[(geo.n[t, 2] > 0.7) & ~np.isin(t, ids)]
    pts, _ = geo.points(t, 0.1)
    inb = (pts[:, 0] > lo[0] - 0.15) & (pts[:, 0] < hi[0] + 0.15) & (pts[:, 1] > lo[1] - 0.15) & (pts[:, 1] < hi[1] + 0.15)
    ring = ~inb & (pts[:, 0] > lo[0] - pad) & (pts[:, 0] < hi[0] + pad) & (pts[:, 1] > lo[1] - pad) & (pts[:, 1] < hi[1] + pad) & (pts[:, 2] < hi[2] - 0.2)
    if ring.sum() < 10: return float(lo[2])
    return float(np.percentile(pts[ring, 2], 20))

def seat_of(geo, nav, ids, split=False, seat_pts=None):
    """Fit the seat surface of one seating piece. Returns dict or None."""
    P = geo.P[ids]; n = geo.n[ids]; a = geo.area[ids]; zc = P[:, :, 2].mean(1)
    g = floor_near(geo, ids)
    up = n[:, 2] > 0.85
    if not up.any(): return None
    # area histogram of up-facing faces by height (2 cm)
    lv = np.round(zc[up] / 0.02).astype(np.int64)
    hz = {}
    for l, ar in zip(lv, a[up]): hz[l] = hz.get(l, 0) + ar
    levels = sorted(hz)
    good = [l for l in levels if 0.08 <= l * 0.02 - g <= 2.4 and hz[l] > 0.04]
    if not good: return None
    best = max(hz[l] for l in good)
    lsel = min(l for l in good if hz[l] >= 0.35 * best)       # the lowest substantial level: the seat (backrest tops are small)
    zs = lsel * 0.02
    st = ids[up][np.abs(zc[up] - zs) < 0.03]
    pts = seat_pts if seat_pts is not None else geo.points(st, 0.04)[0]
    xy = pts[:, :2]; m = xy.mean(0)
    cov = np.cov((xy - m).T); w, v = np.linalg.eigh(cov)
    u = v[:, 1]; vn = np.array([-u[1], u[0]])
    pu = (xy - m) @ u; pv = (xy - m) @ vn
    L = float(np.percentile(pu, 99.5) - np.percentile(pu, 0.5)); D = float(np.percentile(pv, 99.5) - np.percentile(pv, 0.5))
    cu = float((np.percentile(pu, 99.5) + np.percentile(pu, 0.5)) / 2); cv = float((np.percentile(pv, 99.5) + np.percentile(pv, 0.5)) / 2)
    c = m + u * cu + vn * cv
    zs = float(pts[:, 2].max())
    fill = len(np.unique(np.floor(xy / 0.1).astype(np.int64) @ np.array([1, 100000]))) * 0.01 / max(1e-6, L * D)
    if fill < 0.5 and not CURVED: return None          # not a solid seat surface (an L of fence rails, rose clusters)
    if L > 2.6 and fill < 0.55 and not split:
        # a curved bench (Rosewick's exedra): cut it into ~2 m straight pieces
        from scipy.cluster.vq import kmeans2
        k = int(math.ceil(L / 2.0))
        _, lab = kmeans2(xy.astype(np.float64), k, seed=1, minit="++")
        out = []
        for q in range(k):
            sel_pts = pts[lab == q]
            if len(sel_pts) < 20: continue
            r = seat_of(geo, nav, ids, split=True, seat_pts=sel_pts)
            if r: out.append(r)
        return out
    own, _ = geo.points(ids, 0.04)
    dx = own[:, 0] - c[0]; dy = own[:, 1] - c[1]
    ownl = np.stack([dx * u[0] + dy * u[1], dx * vn[0] + dy * vn[1], own[:, 2]], 1)
    return dict(x=float(c[0]), y=float(c[1]), z=zs, u=u, v=vn, L=L, D=D, ground=g, own=ownl)

def facing(geo, nav, s):
    """Pick the open side: +1 => faces +v, -1 => faces -v, with diagnostics."""
    L, D, zs = s["L"], s["D"], s["z"]
    loc, tid = geo.local_box(s["x"], s["y"], s["u"][0], s["u"][1], L / 2 + 0.05, D / 2 + 0.9, zs - 1.2, zs + 1.4)
    uin = np.abs(loc[:, 0]) < L / 2 * 0.85
    res = {}
    for sg in (1, -1):
        v = loc[:, 1] * sg
        back = uin & (v > D / 2 - 0.15) & (v < D / 2 + 0.45) & (loc[:, 2] > zs + 0.12) & (loc[:, 2] < zs + 1.0)
        # backrest coverage: fraction of 10 cm u-bins with something there
        bins = np.unique(np.floor(loc[back, 0] / 0.1))
        cover = len(bins) / max(1, L * 0.85 / 0.1)
        # knee room in front: geometry between seat-0.3 and seat+1.0, 5..55 cm in front of the seat edge
        knee = uin & (v > D / 2 + 0.05) & (v < D / 2 + 0.55) & (loc[:, 2] > zs - 0.3) & (loc[:, 2] < zs + 1.0)
        kb = len(np.unique(np.floor(loc[knee, 0] / 0.1))) / max(1, L * 0.85 / 0.1)
        # feet support / walkable in front
        k = np.linspace(-L / 2 * 0.8, L / 2 * 0.8, max(2, int(L / 0.5) + 1))
        fx = s["x"] + s["u"][0] * k + s["v"][0] * sg * (D / 2 + 0.35)
        fy = s["y"] + s["u"][1] * k + s["v"][1] * sg * (D / 2 + 0.35)
        hz = C.nav_height(nav, fx, fy, zs - 0.45, 0.35)
        walk = float(np.mean(~np.isnan(hz)))
        sup = uin & (v > D / 2 + 0.1) & (v < D / 2 + 0.7) & (loc[:, 2] > zs - 0.62) & (loc[:, 2] < zs - 0.25)
        sb = len(np.unique(np.floor(loc[sup, 0] / 0.1))) / max(1, L * 0.85 / 0.1)
        ov = s["own"][:, 1] * sg; ou = np.abs(s["own"][:, 0]) < L / 2 * 0.85
        ob = ou & (ov > D / 2 - 0.15) & (ov < D / 2 + 0.45) & (s["own"][:, 2] > zs + 0.12) & (s["own"][:, 2] < zs + 1.0)
        own = len(np.unique(np.floor(s["own"][ob, 0] / 0.1))) / max(1, L * 0.85 / 0.1)
        # profile walking away from the seat edge: does the surface first step down by a seat height (front) or rise (back)?
        band = uin & (v > D / 2 + 0.02) & (v < D / 2 + 1.4)
        step = 0.0
        if band.any():
            vb = np.floor((v[band] - D / 2) / 0.1).astype(np.int64); zb = loc[band, 2]
            prof = np.full(15, -99.0); np.maximum.at(prof, vb, zb)
            for pz in prof:
                if pz == -99.0: continue
                if pz > zs + 0.15: break
                if zs - 0.75 <= pz <= zs - 0.3: step = 1.0; break
                if pz < zs - 0.75: break
        res_step = step
        res[sg] = dict(step=res_step, own=min(1.0, own), back=cover, knee=kb, walk=walk, support=min(1.0, sb), feet=hz)
    a, b = res[1]["own"], res[-1]["own"]
    if max(a, b) >= 0.5 and min(a, b) < 0.25: return (1 if b > a else -1), res
    high = s["z"] - s["ground"] > 0.8      # a bleacher tier: the feet rest on the tier in front
    def score(r): return -2.0 * r["back"] - 1.5 * r["knee"] + 1.0 * r["walk"] + (2.5 if high else 0.5) * r["support"] + (3.0 if high else 0.0) * r["step"]
    sg = 1 if score(res[1]) >= score(res[-1]) else -1
    return sg, res


def approach(nav, s, sg, step=0.55):
    """Seat slots along the bench and where a sitter stands before sitting. Returns (slots ok mask, ax, ay, az)."""
    L, D, zs = s["L"], s["D"], s["z"]
    n = max(1, int(round(L / step)))
    k = (np.arange(n) + 0.5) / n * L - L / 2
    fx = s["x"] + s["u"][0] * k + s["v"][0] * sg * (D / 2 + 0.35)
    fy = s["y"] + s["u"][1] * k + s["v"][1] * sg * (D / 2 + 0.35)
    ok = np.ones(n, bool)
    for dx, dy in ((0, 0), (0.25, 0), (-0.25, 0), (0, 0.25), (0, -0.25)):
        h = C.nav_height(nav, fx + dx, fy + dy, zs - 0.45, 0.4)
        ok &= ~np.isnan(h)
    return ok, fx, fy

def nearest_walk(nav, x, y, z, rmax=4.0):
    """Nearest walkable cell centre to (x, y) whose height is within 1 m of z. Returns (x, y, z) or None."""
    c = nav["cell"]; r = int(rmax / c)
    i0, j0 = C.nav_ij(nav, x, y)
    best = None
    for lev in ("zA", "zB"):
        Z = nav[lev][max(0, j0 - r):j0 + r + 1, max(0, i0 - r):i0 + r + 1]
        jj, ii = np.nonzero(~np.isnan(Z) & (np.abs(Z - z) < 1.0))
        if not len(jj): continue
        X = nav["x0"] + (ii + max(0, i0 - r) + 0.5) * c; Y = nav["y0"] + (jj + max(0, j0 - r) + 0.5) * c
        d = np.hypot(X - x, Y - y); m = np.argmin(d)
        if best is None or d[m] < best[3]: best = (float(X[m]), float(Y[m]), float(Z[jj[m], ii[m]]), float(d[m]))
    return best

def extract(geo, nav, log=print):
    pois = []; dropped = []
    for (part, name), ids in candidates(geo).items():
        for comp in components(geo, ids):
          ss = seat_of(geo, nav, comp)
          for s in (ss if isinstance(ss, list) else [ss]):
            if s is None: continue
            if s["L"] < 0.35 or s["D"] < 0.2: continue
            sg, res = facing(geo, nav, s)
            if s["z"] - s["ground"] > 0.8 and res[sg]["support"] < 0.5 and res[sg]["step"] < 1: continue      # high ledge with nothing to put the feet on
            ok, fx, fy = approach(nav, s, sg)
            yaw = math.atan2(s["v"][1] * sg, s["v"][0] * sg)
            if ok.any():
                k = np.nonzero(ok)[0]; ax, ay = float(fx[k].mean()), float(fy[k].mean())
                cap = int(ok.sum()) if s["L"] > 1.2 else 1
            else:
                nw = nearest_walk(nav, s["x"] + s["v"][0] * sg * (s["D"] / 2 + 0.35), s["y"] + s["v"][1] * sg * (s["D"] / 2 + 0.35), s["ground"], 3.0)
                if nw is None:
                    dropped.append((part, name, round(s["x"], 1), round(s["y"], 1), round(s["z"], 2))); continue
                ax, ay = nw[0], nw[1]; cap = max(1, int(round(s["L"] / 0.55))) if s["L"] > 1.2 else 1
            pois.append(dict(type="bench", x=s["x"], y=s["y"], z=s["z"], yaw=yaw, land=part, cap=cap, len=s["L"], ax=ax, ay=ay,
                             src=name, h=s["z"] - s["ground"], diag=res))
    log("benches: %d kept, %d dropped (no walkable front within 3 m)" % (len(pois), len(dropped)))
    for d in dropped: log("  dropped", d)
    return pois
