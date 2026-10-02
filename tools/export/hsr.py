"""Hidden-surface removal for stacked near-coplanar layers (z-fighting fix at the data level), used by pack.py.

The Blender park stacks surfaces millimetres to centimetres apart (terrain 0.00, land ground 0.06, paving 0.116-0.124,
decals a few mm above, plaques/posters ~1 cm off facades). Cycles does not mind; a depth buffer does. For every opaque
triangle T this finds the opaque, near-parallel triangles O that overlap it in projection and lie just in front of it,
and drops T when the union of those O covers T completely (exact test: no boundary edge of the union crosses T's
interior, and T's centroid is inside the union). Triangles only partly covered are cut along the union boundary and the
covered pieces dropped (`clip`); neighbours sharing a cut edge are split at the same points so no T-junctions appear.
Covered surfaces whose back side could still be seen (a floor over a walkable space, a thin sign) are only removed when
the two layers are nearly touching; ground below z = 0.6 m outside the lake counts as closed from below.
Glass/transparent materials and water surfaces never occlude; emissive triangles are never removed.
Colours of surviving vertices are untouched; new vertices interpolate the colours of the triangle they were cut from.
"""
import math
import numpy as np
import par

FLOOR_COS = 0.985              # |nz| above this: horizontal group (frame = z)
PAR_COS = math.cos(math.radians(6.0))
BAND_FLOOR = 0.20              # max gap to a covering layer, floors / ceilings
BAND_WALL = 0.05               # walls, roofs and everything else
BAND_BACK = 0.60               # a layer this close behind T closes T's back side
BAND_TOUCH = 0.012             # "nearly touching": cull even if T's back side may be visible
EPS = 0.0015                   # occluder must be at least this far in front (else: coplanar rule)
CLIP_GAP = float(__import__("os").environ.get("CLIP_GAP", 0.08))               # partially covered triangles are clipped when the covering gap is below this
CLIP_MIN_AREA = 0.004
CLIP_BUDGET = int(__import__("os").environ.get("CLIP_BUDGET", 20))              # give up clipping a triangle whose uncovered part needs more vertices than this          # ... and the covered part is at least this big (m^2)
MARGIN = 0.06                 # removed lower layers stop this far inside an open rim (decal edge without side face)
SHRINK = 0.002                 # boundary edges closer than this to T's edges do not count as crossing
R_MAX = 335.0
CLIP_MIN_TRI = float(__import__("os").environ.get("CLIP_MIN_TRI", 0.1))   # ... on triangles at least this big (m^2): small detail meshes (iron lattices, foliage) are not worth it
CLIP_CONTRAST = 0.2            # ... and the layers differ in colour by more than this (max |log ratio| over rgb)
PROMOTE = True                 # promote fine decals to the LOD class of the layer they cover
NO_OCCLUDE = ("water", "pool", "jet", "fountain", "foam", "spray", "mist", "smoke", "steam")

def _frame(g, step):
    if g == -1: return np.array([0, 0, 1.0]), np.array([1.0, 0, 0]), np.array([0, 1.0, 0])
    a = (g // 1000) * step; e = (g % 1000 - 500) * step
    R = np.array([math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)])
    U = np.cross([0, 0, 1.0], R); U /= np.linalg.norm(U); V = np.cross(R, U)
    return R, U, V

def _clip_halfplane(poly, cnt, a, b):
    """Sutherland-Hodgman, vectorised. poly (B,K,2), cnt (B,), keep the left side of directed line a->b (B,2)."""
    B, K, _ = poly.shape
    out = np.zeros((B, 2 * K, 2)); oc = np.zeros(B, np.int64)
    d = b - a
    side = d[:, None, 0] * (poly[:, :, 1] - a[:, None, 1]) - d[:, None, 1] * (poly[:, :, 0] - a[:, None, 0])
    rows = np.arange(B)
    for k in range(K):
        valid = k < cnt
        kn = np.where(k + 1 < cnt, k + 1, 0)
        p = poly[:, k]; q = poly[rows, kn]
        sp = side[:, k]; sq = side[rows, kn]
        ins_p = sp >= 0; ins_q = sq >= 0
        # emit p if inside
        m = valid & ins_p
        out[rows[m], oc[m]] = p[m]; oc[m] += 1
        # emit intersection if crossing
        m = valid & (ins_p != ins_q)
        t = sp[m] / np.where(np.abs(sp[m] - sq[m]) < 1e-300, 1e-300, sp[m] - sq[m])
        out[rows[m], oc[m]] = p[m] + (q[m] - p[m]) * t[:, None]; oc[m] += 1
    return out[:, :max(int(oc.max(initial=0)), 1)], oc

def _poly_area(poly, cnt):
    K = poly.shape[1]; a = np.zeros(len(poly))
    for k in range(K):
        kn = np.where(k + 1 < cnt, k + 1, 0); valid = k < cnt
        p = poly[:, k]; q = poly[np.arange(len(poly)), kn]
        a += np.where(valid, p[:, 0] * q[:, 1] - q[:, 0] * p[:, 1], 0)
    return 0.5 * a

def _plane(u, v, w):
    """coefficients of w = A u + B v + C for each triangle (n,3) arrays."""
    du1 = u[:, 1] - u[:, 0]; dv1 = v[:, 1] - v[:, 0]; dw1 = w[:, 1] - w[:, 0]
    du2 = u[:, 2] - u[:, 0]; dv2 = v[:, 2] - v[:, 0]; dw2 = w[:, 2] - w[:, 0]
    det = du1 * dv2 - du2 * dv1; det = np.where(np.abs(det) < 1e-14, 1e-14, det)
    A = (dw1 * dv2 - dw2 * dv1) / det; Bc = (du1 * dw2 - du2 * dw1) / det
    return A, Bc, w[:, 0] - A * u[:, 0] - Bc * v[:, 0]

def _join(kt, it, ko, io):
    """all (it, io) pairs with equal keys."""
    ot = np.argsort(kt, kind="stable"); kt, it = kt[ot], it[ot]
    oo = np.argsort(ko, kind="stable"); ko, io = ko[oo], io[oo]
    lo = np.searchsorted(ko, kt, "left"); hi = np.searchsorted(ko, kt, "right")
    n = hi - lo; tot = int(n.sum())
    if tot == 0: return np.zeros(0, np.int64), np.zeros(0, np.int64)
    rep = np.repeat(np.arange(len(kt)), n)
    off = np.arange(tot) - np.repeat(np.cumsum(n) - n, n)
    return it[rep], io[lo[rep] + off]

def _cells(u, v, w, cell, dcell, pad_w, cap):
    """hash entries (key, tri) for the 2D bbox cells x depth buckets of each triangle (index into u)."""
    u0 = np.floor(u.min(1) / cell).astype(np.int64); u1 = np.floor(u.max(1) / cell).astype(np.int64)
    v0 = np.floor(v.min(1) / cell).astype(np.int64); v1 = np.floor(v.max(1) / cell).astype(np.int64)
    w0 = np.floor((w.min(1) - pad_w) / dcell).astype(np.int64); w1 = np.floor((w.max(1) + pad_w) / dcell).astype(np.int64)
    nu = u1 - u0 + 1; nv = v1 - v0 + 1; nw = w1 - w0 + 1; n = nu * nv * nw
    ok = n <= cap
    i = np.nonzero(ok)[0]; n = n[i]
    rep = np.repeat(i, n); k = np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)
    a = k % nu[rep]; k //= nu[rep]; b = k % nv[rep]; c = k // nv[rep]
    key = ((u0[rep] + a + 40000) * 80000 + (v0[rep] + b + 40000)) * 4096 + ((w0[rep] + c) & 4095)
    return key, rep

class Stack:
    """All opaque triangles of all parts, flattened."""
    def __init__(self, PARTS):
        P, rid, loc, emis, occ, oarea, cls_, prt, ocen, tcol = [], [], [], [], [], [], [], [], [], []
        self.refs = []; self.pnames = []
        for pn, rs in PARTS.items():
            self.pnames.append(pn)
            for r in rs:
                if r["kind"] != "opaque": continue
                k = len(self.refs); self.refs.append(r)
                p = r["pos"][r["tri"]]; P.append(p)
                rid.append(np.full(len(p), k, np.int32)); loc.append(np.arange(len(p)))
                tcol.append(r["hdr"][r["tri"]].mean(1))
                emis.append(r["emis"]); cls_.append(r["cls"]); prt.append(np.full(len(p), len(self.pnames), np.int32))
                bad = np.array([any(s in n.lower() for s in NO_OCCLUDE) for n in r["names"]])
                occ.append(~bad[r["mat"]])
                cr = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]); a = 0.5 * np.linalg.norm(cr, axis=1)
                ob = np.bincount(r["oid"], weights=a); oarea.append(ob[r["oid"]])
                oc = np.stack([np.bincount(r["oid"], weights=a * p[:, :, j].mean(1), minlength=len(ob)) for j in range(3)], 1) / np.maximum(ob, 1e-12)[:, None]
                ocen.append(oc[r["oid"]])
        self.P = np.concatenate(P); self.rid = np.concatenate(rid); self.loc = np.concatenate(loc)
        self.tcol = np.concatenate(tcol)            # mean baked HDR colour per triangle
        self.objc = np.concatenate(ocen)            # area-weighted centroid of each triangle's source object
        self.cls = np.concatenate(cls_).astype(np.int64); self.part = np.concatenate(prt)
        c = self.P.mean(1)      # pack.py chunks by 64 m cells of the three.js (x, -y) centroid
        self.chunk = (np.floor(c[:, 0] / 64.0).astype(np.int64) + 500) * 1000 + np.floor(-c[:, 1] / 64.0).astype(np.int64) + 500
        self.emis = np.concatenate(emis); self.occ = np.concatenate(occ); self.objarea = np.concatenate(oarea)
        cr = np.cross(self.P[:, 1] - self.P[:, 0], self.P[:, 2] - self.P[:, 0]); ln = np.linalg.norm(cr, axis=1)
        self.N = cr / np.maximum(ln, 1e-12)[:, None]; self.area = 0.5 * ln
        # global vertex ids by position (edge adjacency across welded / unwelded copies)
        q = np.round(self.P.reshape(-1, 3) * 1e4).astype(np.int64)
        _, vid = np.unique(q, axis=0, return_inverse=True)
        self.vid = vid.reshape(-1, 3)
        # edge -> incident triangles (to tell a decal's open rim from an edge closed by a side face)
        NV = int(self.vid.max()) + 1; self.NV = NV
        e0 = np.minimum(self.vid, np.roll(self.vid, -1, 1)); e1 = np.maximum(self.vid, np.roll(self.vid, -1, 1))
        ek = (e0 * NV + e1).ravel(); o = np.argsort(ek, kind="stable")
        self.ek_sorted = ek[o]; self.ek_tri = (o // 3).astype(np.int64)
        # priority for (nearly) coplanar duplicates: the layer Cycles actually lit is the visible one (the hidden twin
        # bakes dark in its shadow); ties go to the smaller object (a decal on top)
        lum = self.tcol @ np.array([0.2126, 0.7152, 0.0722])
        self.prio = np.round(np.log(lum + 1e-3), 1) * 1e6 - self.objarea * 1e-3 + 1e-12 * np.arange(len(self.P))

def inside_poly(pts, poly, grow=0.0):
    """even-odd point in polygon; a star-shaped polygon around the origin is first grown radially by `grow` metres."""
    r = np.linalg.norm(poly, axis=1, keepdims=True); poly = poly * (r + grow) / np.maximum(r, 1e-9)
    x, y = pts[:, 0], pts[:, 1]; res = np.zeros(len(pts), bool)
    for i in range(len(poly)):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % len(poly)]
        c = ((y0 > y) != (y1 > y))
        xi = x0 + (y - y0) * (x1 - x0) / ((y1 - y0) if y1 != y0 else 1e-12)
        res ^= c & (x < xi)
    return res

STATS = {} if __import__("os").environ.get("HSR_STATS") else None

def run(PARTS, log, clip=True):
    import park_common as pc, os
    S = Stack(PARTS)
    T = len(S.P)
    log("hsr: %d opaque triangles" % T)
    cen = S.P.mean(1)
    inreg = (np.hypot(cen[:, 0], cen[:, 1]) < R_MAX) & (S.area > 1e-7)
    # over the lake (docks, bridges, boats) nothing counts as closed ground below
    lake = inside_poly(cen[:, :2], np.array(pc.LAKE), grow=1.5)
    nz = S.N[:, 2]
    floor = np.abs(nz) > FLOOR_COS
    STEP = math.radians(3.0)
    Nf = S.N * np.where(np.arctan2(S.N[:, 1], S.N[:, 0]) < 0, -1.0, 1.0)[:, None]
    az = np.arctan2(Nf[:, 1], Nf[:, 0]); el = np.arcsin(np.clip(Nf[:, 2], -1, 1))
    nb_az = int(round(math.pi / STEP))
    baz = np.round(az / STEP).astype(np.int64) % nb_az; bel = np.round(el / STEP).astype(np.int64)
    grp = np.where(floor, -1, baz * 1000 + (bel + 500))
    grp = np.where(inreg, grp, -999)
    # ---- candidate pairs per orientation group
    groups, ginv = np.unique(grp, return_inverse=True)
    members = np.split(np.argsort(ginv, kind="stable"), np.cumsum(np.bincount(ginv))[:-1])
    gindex = {int(g): m for g, m in zip(groups, members)}
    # (build.py) groups are independent and the pairs of a group come out sorted by T: big groups are split into
    # T ranges, the pieces run in parallel and are concatenated in order (same pairs, same order as one serial pass)
    tasks = []
    for g in groups:
        g = int(g)
        if g == -999: continue
        n = len(gindex[g]); k = max(1, n // 40000)
        tasks += [(g, lo, hi) for lo, hi in par.ranges(n, k)]
    tasks.sort(key=lambda t: -(t[2] - t[1]))                  # biggest first for the pool, put back in order below
    def group_pairs(g, lo, hi):
        PT, PO, DMIN, DMAX, OAR = [], [], [], [], []
        tris = gindex[g][lo:hi]
        if g == -1:
            occs = gindex[g]; band = BAND_BACK; cell = 1.5
        else:
            a, e = g // 1000, g % 1000 - 500
            nbrs = [((a + da) % nb_az) * 1000 + (e + de + 500) for da in (-1, 0, 1) for de in (-1, 0, 1)]
            # azimuth wrap flips the unsigned normal: (a=0) and (a=nb_az-1) are neighbours with mirrored elevation
            if a in (0, nb_az - 1):
                aa = nb_az - 1 if a == 0 else 0
                nbrs += [aa * 1000 + (-e + de + 500) for de in (-1, 0, 1)]
            occs = np.concatenate([gindex[n] for n in set(nbrs) if n in gindex])
            band = BAND_BACK; cell = 0.75
        R, U, V = _frame(g, STEP)
        Q = S.P;
        def proj(ix):
            q = Q[ix]; return q @ U, q @ V, q @ R
        ut, vt, wt = proj(tris); uo, vo, wo = proj(occs)
        kt, it = _cells(ut, vt, wt, cell, band, band, 400)
        ko, io = _cells(uo, vo, wo, cell, band, 0.0, 400)
        a_, b_ = _join(kt, it, ko, io)
        # cheap prefilter: 2D bbox overlap and depth ranges within the band
        m = (ut.min(1)[a_] < uo.max(1)[b_]) & (uo.min(1)[b_] < ut.max(1)[a_]) & (vt.min(1)[a_] < vo.max(1)[b_]) & (vo.min(1)[b_] < vt.max(1)[a_])
        m &= (wo.min(1)[b_] < wt.max(1)[a_] + band) & (wo.max(1)[b_] > wt.min(1)[a_] - band)
        pt = tris[a_[m]]; po = occs[b_[m]]
        m = (pt != po) & S.occ[po]
        pt, po = pt[m], po[m]
        key = np.unique(pt.astype(np.int64) * T + po)
        pt = key // T; po = key % T
        par = np.abs((S.N[pt] * S.N[po]).sum(1)) > PAR_COS
        pt, po = pt[par], po[par]
        # exact overlap polygon + depth gaps at its vertices, in chunks
        for s in range(0, len(pt), 400000):
            a = pt[s:s + 400000]; b = po[s:s + 400000]
            qa = S.P[a]; qb = S.P[b]
            ua, va, wa = qa @ U, qa @ V, qa @ R; ub, vb, wb = qb @ U, qb @ V, qb @ R
            poly = np.zeros((len(a), 3, 2)); poly[:, :, 0] = ua; poly[:, :, 1] = va
            cnt = np.full(len(a), 3)
            # orient O counter-clockwise
            ccw = ((ub[:, 1] - ub[:, 0]) * (vb[:, 2] - vb[:, 0]) - (ub[:, 2] - ub[:, 0]) * (vb[:, 1] - vb[:, 0])) > 0
            ob = np.stack([ub, vb], -1)
            ob = np.where(ccw[:, None, None], ob, ob[:, ::-1])
            for k in range(3):
                poly, cnt = _clip_halfplane(poly, cnt, ob[:, k], ob[:, (k + 1) % 3])
            ar = np.abs(_poly_area(poly, cnt))
            keep = ar > 1e-6
            if not keep.any(): continue
            poly, cnt, a, b, ar = poly[keep], cnt[keep], a[keep], b[keep], ar[keep]
            Aa, Ba, Ca = _plane(ua[keep], va[keep], wa[keep]); Ab, Bb, Cb = _plane(ub[keep], vb[keep], wb[keep])
            dz = (Ab - Aa)[:, None] * poly[:, :, 0] + (Bb - Ba)[:, None] * poly[:, :, 1] + (Cb - Ca)[:, None]
            valid = np.arange(poly.shape[1])[None, :] < cnt[:, None]
            dmin = np.where(valid, dz, np.inf).min(1); dmax = np.where(valid, dz, -np.inf).max(1)
            ok = (dmax > -BAND_BACK) & (dmin < BAND_BACK)
            PT.append(a[ok]); PO.append(b[ok]); DMIN.append(dmin[ok]); DMAX.append(dmax[ok]); OAR.append(ar[ok])
        z = lambda L, t: np.concatenate(L) if L else np.zeros(0, t)
        return z(PT, np.int64), z(PO, np.int64), z(DMIN, float), z(DMAX, float), z(OAR, float)
    res = dict(zip(tasks, par.pmap(group_pairs, tasks)))
    res = [res[t] for t in sorted(tasks, key=lambda t: (int(np.searchsorted(groups, t[0])), t[1]))]
    PT, PO, DMIN, DMAX, OAR = ([r[i] for r in res] for i in range(5))
    log("hsr: %d orientation groups in %d tasks" % (len(groups), len(tasks)))
    pt = np.concatenate(PT); po = np.concatenate(PO); dmin = np.concatenate(DMIN); dmax = np.concatenate(DMAX); oar = np.concatenate(OAR)
    log("hsr: %d overlapping near-parallel pairs" % len(pt))
    # frame used for each T (sign of "front")
    Rg = np.zeros((T, 3)); Rg[:, 2] = 1.0
    nf = ~floor
    Rg[nf] = np.stack([np.cos(bel[nf] * STEP) * np.cos(baz[nf] * STEP), np.cos(bel[nf] * STEP) * np.sin(baz[nf] * STEP), np.sin(bel[nf] * STEP)], 1)
    # NOTE: depth gaps above were measured along the frame of T's group, so "+" = along Rg[T]
    # ---- LOD safety: the viewer stops drawing detail classes 1/2 with distance (per 64 m chunk), and a covered
    # lower layer is the far-distance stand-in for a fine decal. A decal that covers a coarser layer within the
    # z-fighting range is promoted to that layer's class (drawn as far as the layer was), then it may occlude.
    near_gap = np.where(dmin > -EPS, dmax, -dmin)
    close_pair = (np.minimum(np.abs(dmin), np.abs(dmax)) < CLIP_GAP) & (np.sign(dmin) == np.sign(dmax)) | (np.maximum(np.abs(dmin), np.abs(dmax)) <= EPS)
    close_pair &= near_gap < CLIP_GAP
    cls = S.cls.copy()
    if PROMOTE:
        m = close_pair & (cls[po] > cls[pt]) & (oar > 0.002) & ~S.emis[pt]
        newc = cls.copy(); np.minimum.at(newc, po[m], cls[pt[m]])
        prom = newc < cls
        log("hsr: promoted %d decal triangles (%.0f m^2) to a coarser LOD class" % (prom.sum(), S.area[prom].sum()))
        cls = newc
    lod_ok = (cls[po] == 0) | ((cls[po] <= cls[pt]) & (S.part[po] == S.part[pt]) & (S.chunk[po] == S.chunk[pt]))
    flat = np.maximum(np.abs(dmin), np.abs(dmax)) <= EPS
    # coplanar duplicates: the smaller object wins, and only if it faces the same way (else T's side would show O's back)
    coplanar = flat & (S.prio[po] > S.prio[pt]) & ((S.N[pt] * S.N[po]).sum(1) > 0)
    # contact faces: two solids touching (a box standing on a roof): opposite, coplanar faces, each pointing into the
    # other object. Both are inside the merged solid and go wherever they overlap.
    contact = flat & ((S.N[pt] * S.N[po]).sum(1) < -PAR_COS)
    contact &= ((S.objc[po] - S.P[pt, 0]) * S.N[pt]).sum(1) > 0.01
    contact &= ((S.objc[pt] - S.P[po, 0]) * S.N[po]).sum(1) > 0.01
    coplanar |= contact
    log("hsr: %d coplanar pairs, %d contact pairs" % (flat.sum(), contact.sum()))

    VH = {}
    def skirt_hit(q):
        """does some steep (side) triangle pass within 3 mm of each point q (n,3)?"""
        if not VH:
            v = np.nonzero((np.abs(S.N[:, 2]) < 0.7) & inreg)[0]
            P = S.P[v]; C = 0.5
            x0 = np.floor(P[:, :, 0].min(1) / C).astype(np.int64); x1 = np.floor(P[:, :, 0].max(1) / C).astype(np.int64)
            y0 = np.floor(P[:, :, 1].min(1) / C).astype(np.int64); y1 = np.floor(P[:, :, 1].max(1) / C).astype(np.int64)
            nx = x1 - x0 + 1; ny = y1 - y0 + 1; n = nx * ny; ok = n <= 64
            v, x0, y0, nx, n = v[ok], x0[ok], y0[ok], nx[ok], n[ok]
            rep = np.repeat(np.arange(len(v)), n); k = np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)
            key = (x0[rep] + k % nx[rep] + 4000) * 8000 + (y0[rep] + k // nx[rep] + 4000)
            o = np.argsort(key, kind="stable"); VH.update(key=key[o], tri=v[rep[o]], C=C)
        C = VH["C"]
        key = (np.floor(q[:, 0] / C).astype(np.int64) + 4000) * 8000 + (np.floor(q[:, 1] / C).astype(np.int64) + 4000)
        lo = np.searchsorted(VH["key"], key, "left"); hi = np.searchsorted(VH["key"], key, "right")
        n = hi - lo; rep = np.repeat(np.arange(len(q)), n); k = np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)
        X = VH["tri"][lo[rep] + k]; Q = q[rep]
        P = S.P[X]; Nx = S.N[X]
        ok = np.abs(((Q - P[:, 0]) * Nx).sum(1)) < 0.003
        # barycentric inside (with 3 mm slack) in X's plane
        e1 = P[:, 1] - P[:, 0]; e2 = P[:, 2] - P[:, 0]; w = Q - P[:, 0]
        d11 = (e1 * e1).sum(1); d12 = (e1 * e2).sum(1); d22 = (e2 * e2).sum(1); w1 = (w * e1).sum(1); w2 = (w * e2).sum(1)
        den = np.maximum(d11 * d22 - d12 * d12, 1e-18)
        b1 = (d22 * w1 - d12 * w2) / den; b2 = (d11 * w2 - d12 * w1) / den
        tol = 0.003 / np.sqrt(np.maximum(np.minimum(d11, d22), 1e-12))
        ok &= (b1 >= -tol) & (b2 >= -tol) & (b1 + b2 <= 1 + tol)
        res = np.zeros(len(q), bool); res[rep[ok]] = True
        return res

    def open_edges(ta, eo, ei):
        """boundary edge (edge ei of occluder eo) is 'open' unless another triangle on that edge (a side face) reaches
        most of the way down to T's plane: then nothing can be seen through the gap between the layers there."""
        if len(ta) == 0: return np.zeros(0, bool)
        va = S.vid[eo, ei]; vb = S.vid[eo, (ei + 1) % 3]
        key = np.minimum(va, vb) * S.NV + np.maximum(va, vb)
        lo = np.searchsorted(S.ek_sorted, key, "left"); hi = np.searchsorted(S.ek_sorted, key, "right")
        mid = 0.5 * (S.P[eo, ei] + S.P[eo, (ei + 1) % 3])
        hT = ((mid - S.P[ta, 0]) * S.N[ta]).sum(1)                  # edge height over T's plane
        u = -np.sign(hT)[:, None] * S.N[ta]                         # direction from the edge towards T
        closed = np.zeros(len(ta), bool)
        for j in range(6):
            k = lo + j; ok = k < hi
            if not ok.any(): break
            X = S.ek_tri[np.where(ok, k, 0)]
            ok &= X != eo
            third = S.P[X].sum(1) - S.P[eo, ei] - S.P[eo, (ei + 1) % 3]   # X's vertex off the shared edge (if shared exactly)
            h = ((third - mid) * u).sum(1)
            side = np.abs((S.N[X] * S.N[ta]).sum(1)) < 0.7
            closed |= ok & side & (h >= 0.7 * np.abs(hT) - 1e-4)
            # the same surface simply continues past this edge (not a rim): no margin needed
            cont = (np.abs((S.N[X] * S.N[eo]).sum(1)) > PAR_COS) & (np.abs(((third - mid) * S.N[eo]).sum(1)) < 0.01)
            closed |= ok & cont
        closed |= np.abs(hT) < 0.003                               # rim lies on T: no gap to look through
        # side faces are often not welded to the rim (the bake grid-cuts big faces separately): look for any
        # steep face passing through points 30% and 70% of the way from the rim down to T
        q = ~closed & floor[ta]
        if q.any():
            idx = np.nonzero(q)[0]
            hit = np.ones(len(idx), bool)
            for f in (0.3, 0.7):
                hit &= skirt_hit(mid[idx] + u[idx] * (f * np.abs(hT[idx]))[:, None])
            closed[idx[hit]] = True
        if os.environ.get("HSR_OPEN_DEBUG"):
            opn = ~closed; log("hsr:   open rims %d of %d boundary edges" % (opn.sum(), len(opn)))
            rng = np.random.default_rng(1)
            for j in rng.choice(np.nonzero(opn)[0], min(12, opn.sum()), replace=False):
                rO = S.refs[S.rid[eo[j]]]; rT = S.refs[S.rid[ta[j]]]
                log("hsr:     O %-24s T %-24s hT %.3f inc %d mid %s" % (rO["names"][rO["mat"][S.loc[eo[j]]]], rT["names"][rT["mat"][S.loc[ta[j]]]], hT[j], hi[j] - lo[j], np.round(mid[j], 2)))
        return ~closed

    def covered(sel, margin=True):
        """T fully covered by the union of their O (pairs in sel). Returns (bool[T], crossing boundary edges)."""
        a = pt[sel]; b = po[sel]
        if len(a) == 0: return np.zeros(T, bool), (a, b, b, np.zeros(0, bool))
        vb = S.vid[b]
        e0 = np.minimum(vb, np.roll(vb, -1, 1)); e1 = np.maximum(vb, np.roll(vb, -1, 1))
        NV = int(S.vid.max()) + 1
        ek = (e0 * NV + e1)
        ta = np.repeat(a, 3); ekf = ek.ravel(); eo = np.repeat(b, 3); ei = np.tile(np.arange(3), len(b))
        o = np.lexsort((ekf, ta)); ta, ekf, eo, ei = ta[o], ekf[o], eo[o], ei[o]
        same_prev = np.r_[False, (ta[1:] == ta[:-1]) & (ekf[1:] == ekf[:-1])]
        same_next = np.r_[same_prev[1:], False]
        bnd = ~same_prev & ~same_next                       # union boundary: edge used once among this T's occluders
        ta, eo, ei = ta[bnd], eo[bnd], ei[bnd]
        opn = open_edges(ta, eo, ei) if margin else np.zeros(len(ta), bool)
        cross = np.zeros(len(ta), bool)
        for s in range(0, len(ta), 1000000):
            t_ = ta[s:s + 1000000]; o_ = eo[s:s + 1000000]; i_ = ei[s:s + 1000000]
            sh = np.where(opn[s:s + 1000000], -MARGIN, SHRINK)   # open rims must stay MARGIN away from T
            tp = S.P[t_]; n = S.N[t_]
            ax = tp[:, 1] - tp[:, 0]; ax /= np.maximum(np.linalg.norm(ax, axis=1), 1e-12)[:, None]
            ay = np.cross(n, ax)
            def to2(p):
                d = p - tp[:, 0]; return np.stack([(d * ax).sum(1), (d * ay).sum(1)], 1)
            A = [to2(tp[:, k]) for k in range(3)]
            p0 = to2(S.P[o_, i_]); p1 = to2(S.P[o_, (i_ + 1) % 3])
            orient = np.sign((A[1][:, 0] - A[0][:, 0]) * (A[2][:, 1] - A[0][:, 1]) - (A[2][:, 0] - A[0][:, 0]) * (A[1][:, 1] - A[0][:, 1]))
            tin = np.zeros(len(t_)); tout = np.ones(len(t_)); empty = np.zeros(len(t_), bool)
            dseg = p1 - p0
            for k in range(3):                                   # Cyrus-Beck against T shrunk by SHRINK / grown by MARGIN
                ea = A[k]; eb = A[(k + 1) % 3]; ed = eb - ea
                ln = np.maximum(np.linalg.norm(ed, axis=1), 1e-12)
                nin = np.stack([-ed[:, 1], ed[:, 0]], 1) * (orient / ln)[:, None]
                f0 = ((p0 - ea) * nin).sum(1) - sh; fd = (dseg * nin).sum(1)
                par = np.abs(fd) < 1e-12
                empty |= par & (f0 <= 0)
                t = -f0 / np.where(par, 1, fd)
                tin = np.where(~par & (fd > 0), np.maximum(tin, t), tin)
                tout = np.where(~par & (fd < 0), np.minimum(tout, t), tout)
            cross[s:s + 1000000] = ~empty & (tin < tout - 1e-9)
        crossing_T = np.zeros(T, bool); crossing_T[ta[cross]] = True
        c = S.P[a].mean(1); n = S.N[a]; ob = S.P[b]
        ax = ob[:, 1] - ob[:, 0]; ax /= np.maximum(np.linalg.norm(ax, axis=1), 1e-12)[:, None]; ay = np.cross(n, ax)
        def to2(p): d = p - ob[:, 0]; return np.stack([(d * ax).sum(-1), (d * ay).sum(-1)], -1)
        o0, o1, o2, cc = to2(ob[:, 0]), to2(ob[:, 1]), to2(ob[:, 2]), to2(c)
        def side(p, q, r): return (q[:, 0] - p[:, 0]) * (r[:, 1] - p[:, 1]) - (r[:, 0] - p[:, 0]) * (q[:, 1] - p[:, 1])
        s0, s1, s2 = side(o0, o1, cc), side(o1, o2, cc), side(o2, o0, cc)
        inside = ((s0 >= 0) & (s1 >= 0) & (s2 >= 0)) | ((s0 <= 0) & (s1 <= 0) & (s2 <= 0))
        cin = np.zeros(T, bool); cin[a[inside]] = True
        return cin & ~crossing_T, (ta[cross], eo[cross], ei[cross], opn[cross])

    # (build.py) covered() decides each T from T's own pairs only, so it runs in parallel over T ranges (balanced by
    # pair count); the per-range results are concatenated in order and equal one serial call
    cum = np.cumsum(np.bincount(pt, minlength=T))
    def covered_many(specs):
        """[covered(sel, margin) for sel, margin in specs], computed in parallel."""
        skirt_hit(np.zeros((0, 3)))                           # build the steep-triangle hash before forking
        b = np.searchsorted(cum, np.linspace(0, cum[-1], 2 * par.workers() + 1)[1:-1], "right")
        b = np.unique(np.r_[0, b, T])
        tasks = [(i, int(lo), int(hi)) for i in range(len(specs)) for lo, hi in zip(b[:-1], b[1:])]
        def one(i, lo, hi):
            sel, margin = specs[i]
            full, cr = covered(sel & (pt >= lo) & (pt < hi), margin)
            return np.nonzero(full)[0], cr
        res = par.pmap(one, tasks); out = []
        for i in range(len(specs)):
            rs = [r for t, r in zip(tasks, res) if t[0] == i]
            full = np.zeros(T, bool)
            for f, _ in rs: full[f] = True
            out.append((full, tuple(np.concatenate([cr[k] for _, cr in rs]) for k in range(4))))
        return out

    zmax = S.P[:, :, 2].max(1)
    hiT = np.where(floor, BAND_FLOOR, BAND_WALL)[pt]
    def front(hi): return lod_ok & (dmin > EPS) & (dmax <= hi)
    def back(hi): return lod_ok & (dmax < -EPS) & (dmin >= -hi)
    cop = lod_ok & coplanar
    (cov_f, _), (cov_b, _), (close_f, _), (close_b, _), (touch_f, _), (touch_b, _) = covered_many([
        (front(hiT) | cop, True), (back(hiT) | cop, True), (front(BAND_BACK), False), (back(BAND_BACK), False),
        (front(BAND_TOUCH) | cop, True), (back(BAND_TOUCH) | cop, True)])
    ground = floor & (zmax < 0.6) & ~lake          # earth below: back side never seen
    keepme = S.emis | ~inreg
    # "nearly touching" may only replace T's back-side view: the occluder must lie on the side T faces (bake.py
    # orients every face towards its open side), so T's visible side now shows the occluder's own front.
    faces_f = (S.N * Rg).sum(1) > 0
    touch_f &= faces_f; touch_b &= ~faces_f
    cull = ((cov_f & (close_b | ground)) | (cov_b & close_f) | touch_f | touch_b) & ~keepme
    log("hsr: covered front %d back %d | closed %d/%d | touching %d/%d | ground %d -> cull %d (%.1f%%, %.0f m^2)" % (
        cov_f.sum(), cov_b.sum(), close_f.sum(), close_b.sum(), touch_f.sum(), touch_b.sum(), ground.sum(), cull.sum(),
        100.0 * cull.mean(), S.area[cull].sum()))

    import os
    if os.environ.get("HSR_DEBUG"):
        x, y, z = map(float, os.environ["HSR_DEBUG"].split(","))
        c = S.P.mean(1); near = np.nonzero((np.abs(c[:, 0] - x) < 2) & (np.abs(c[:, 1] - y) < 2) & (np.abs(c[:, 2] - z) < 0.3))[0]
        for t in near[:12]:
            r = S.refs[S.rid[t]]
            print("T", t, r["names"][r["mat"][S.loc[t]]], "cls", S.cls[t], "emis", S.emis[t], "floor", floor[t], "ground", ground[t], "area %.3f" % S.area[t],
                  "covf", cov_f[t], "covb", cov_b[t], "closef", close_f[t], "closeb", close_b[t], "cull", cull[t])
            for j in np.nonzero(pt == t)[0][:10]:
                q = po[j]; rq = S.refs[S.rid[q]]
                print("    O", q, rq["names"][rq["mat"][S.loc[q]]], "cls", S.cls[q], "dz %.4f..%.4f ovl %.3f lod_ok %d occ %d" % (dmin[j], dmax[j], oar[j], lod_ok[j], S.occ[q]))
    # ---- clip partially covered triangles along the boundary of the covering union
    pieces = {}                                    # T -> list of kept convex polygons (2D, T frame)
    if clip:
        done = cull | keepme
        def groups_of(sel, want, margin=True):
            """crossing boundary edges and occluders of the T in `want`, grouped per T."""
            sel = sel & want[pt]                              # (only the T in want are read: same result, less work)
            full, (ta, eo, ei, op) = covered_many([(sel, margin)])[0]
            m = want[ta]; ta, eo, ei, op = ta[m], eo[m], ei[m], op[m]
            o = np.argsort(ta, kind="stable"); ta, eo, ei, op = ta[o], eo[o], ei[o], op[o]
            ps, pb = pt[sel], po[sel]; m = want[ps]; ps, pb = ps[m], pb[m]
            o = np.argsort(ps, kind="stable"); ps, pb = ps[o], pb[o]
            def get(t):
                i0, i1 = np.searchsorted(ta, t), np.searchsorted(ta, t, "right")
                j0, j1 = np.searchsorted(ps, t), np.searchsorted(ps, t, "right")
                return eo[i0:i1], ei[i0:i1], pb[j0:j1], op[i0:i1]
            return full, get
        # (covering pairs, closing pairs or None when T's back is ground / irrelevant)
        cfgs = [("front", lambda: front(hiT) | cop, lambda: back(BAND_BACK), ground),
                ("back", lambda: back(hiT) | cop, lambda: front(BAND_BACK), np.zeros(T, bool)),
                ("touch+", lambda: front(BAND_TOUCH) | cop, None, faces_f),
                ("touch-", lambda: back(BAND_TOUCH) | cop, None, ~faces_f)]
        nO = (S.N[po] * Rg[pt]).sum(1); same = (S.N[po] * S.N[pt]).sum(1) > 0
        out_f = np.where(flat, same, nO > 0.5); out_b = np.where(flat, same, nO < -0.5)
        for name, covfn, closefn, noclose in cfgs:
            # clip only where the overlap is visible: against surviving occluders whose front faces away from T
            # (an occluder facing T is the inside of a solid resting on T: nothing between them can be seen)
            sel = covfn() & ~cull[po] & ~contact & (out_f if name[-1] != "-" and name != "back" else out_b)
            # a partial cut is only worth its extra triangles where the two layers look different
            contrast = np.zeros(T, bool); cm = sel & (np.abs(np.log((S.tcol[pt] + 0.01) / (S.tcol[po] + 0.01))).max(1) > CLIP_CONTRAST)
            contrast[pt[cm]] = True
            ovl = np.bincount(pt[sel], weights=oar[sel], minlength=T)
            gp = np.where(flat, 0.0, dmin if name[-1] != "-" and name != "back" else -dmax)
            mingap = np.full(T, np.inf); np.minimum.at(mingap, pt[sel], gp[sel])
            want = ~done & (ovl > CLIP_MIN_AREA)
            if closefn is None: want &= noclose                # touch passes: only T facing the occluder
            if not want.any(): continue
            _, getF = groups_of(sel, want)
            getB = groups_of(closefn(), want & ~noclose, False)[1] if closefn is not None else None
            ids = np.nonzero(want)[0]
            nclip = nfull = 0; ntri = []
            def clip_range(lo, hi):                           # (build.py) each t is cut on its own: run in parallel
                res = []
                for t in ids[lo:hi]:
                    eoF, eiF, oF, opF = getF(t)
                    if getB is not None and not noclose[t]:
                        eoB, eiB, oB, _ = getB(t)
                        if len(oB) == 0: continue
                    else:
                        eoB = eiB = oB = None
                    kept = _clip_one(S, t, eoF, eiF, oF, CLIP_BUDGET, eoB, eiB, oB, opF)
                    if kept is None: continue                   # nothing removable, or too complex
                    res.append((t, kept, oF[0] if len(oF) else -1))
                return res
            for t, kept, o0 in [x for r in par.pmap(clip_range, par.ranges(len(ids), 4 * par.workers())) for x in r]:
                if len(kept) and (mingap[t] >= CLIP_GAP or not contrast[t] or S.area[t] < CLIP_MIN_TRI):
                    continue                                    # partial cuts only where a fight would show
                done[t] = True
                if len(kept) == 0: cull[t] = True; nfull += 1
                else:
                    pieces[t] = kept; nclip += 1; ntri.append(sum(len(p) - 2 for p in kept))
                    if STATS is not None:
                        rT = S.refs[S.rid[t]]; rO = S.refs[S.rid[o0]]
                        k_ = (name, rT["names"][rT["mat"][S.loc[t]]], rO["names"][rO["mat"][S.loc[o0]]])
                        STATS[k_] = STATS.get(k_, 0) + ntri[-1]
            log("hsr: clip %-6s: %6d candidates, %5d culled, %5d clipped into %d tris" % (name, len(ids), nfull, nclip, sum(ntri)))
        pieces = {t: v for t, v in pieces.items() if not cull[t]}
        if STATS:
            for k_, v in sorted(STATS.items(), key=lambda x: -x[1])[:25]: log("hsr:   clip tris %-6s %-28s under %-28s %6d" % (k_ + (v,)))
    _apply(S, cull, pieces, cls, log)
    return dict(cull=int(cull.sum()), clipped=len(pieces))

def _frame2(S, t):
    p = S.P[t]; ax = p[1] - p[0]; ax = ax / np.linalg.norm(ax); ay = np.cross(S.N[t], ax)
    return p[0], ax, ay

def _split(poly, n, c, tol=1e-9):
    s = [n[0] * x + n[1] * y - c for x, y in poly]
    if min(s) >= -tol or max(s) <= tol: return None
    A, B = [], []
    m = len(poly)
    for i in range(m):
        p, q = poly[i], poly[(i + 1) % m]; sp, sq = s[i], s[(i + 1) % m]
        if sp <= tol: A.append(p)
        if sp >= -tol: B.append(p)
        if (sp < -tol and sq > tol) or (sp > tol and sq < -tol):
            u = sp / (sp - sq); x = (p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u)
            A.append(x); B.append(x)
    return A, B

def _seg_hits(pg, p0, p1, tol=1e-9):
    """does segment p0-p1 pass through the interior of convex CCW polygon pg (by more than a point)?"""
    tin, tout = 0.0, 1.0
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    m = len(pg)
    for i in range(m):
        a = pg[i]; b = pg[(i + 1) % m]
        ex, ey = b[0] - a[0], b[1] - a[1]; L = math.hypot(ex, ey)
        if L < 1e-12: continue
        nx, ny = -ey / L, ex / L                         # inward for CCW
        f0 = (p0[0] - a[0]) * nx + (p0[1] - a[1]) * ny - tol; fd = dx * nx + dy * ny
        if abs(fd) < 1e-15:
            if f0 <= 0: return False
            continue
        t = -f0 / fd
        if fd > 0: tin = max(tin, t)
        else: tout = min(tout, t)
        if tin >= tout - 1e-12: return False
    return tin < tout - 1e-12

def _pt_seg(px, py, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]; L2 = dx * dx + dy * dy
    u = 0.0 if L2 < 1e-24 else max(0.0, min(1.0, ((px - a[0]) * dx + (py - a[1]) * dy) / L2))
    return math.hypot(px - a[0] - u * dx, py - a[1] - u * dy)

def _poly_seg_dist(pg, a, b):
    """distance between a convex CCW polygon and segment a-b (0 if they meet)."""
    if _seg_hits(pg, a, b, tol=-1e-9): return 0.0
    d = min(_pt_seg(x, y, a, b) for x, y in pg)
    m = len(pg)
    for q in (a, b):
        for i in range(m):
            d = min(d, _pt_seg(q[0], q[1], pg[i], pg[(i + 1) % m]))
    return d

def _clip_one(S, t, eo, ei, occ, budget, eoB=None, eiB=None, occB=None, opn=None):
    """Cut triangle t by the boundary edges that cross it of the covering union (and of the closing union behind it,
    when given); each piece is split only by the lines of segments that actually pass through it. Open rims (no side
    face) are cut MARGIN further inside the union, so the lower layer still runs under the rim. Pieces covered in front
    (deeper than MARGIN behind every open rim, and closed behind) are dropped. Returns the remaining convex pieces (2D,
    t's frame, CCW), [] if all of t goes, None if nothing does or the result needs more than `budget` ring vertices."""
    o, ax, ay = _frame2(S, t)
    def to2(q): d = q - o; return (float(d @ ax), float(d @ ay))
    poly = [to2(S.P[t, k]) for k in range(3)]
    segs = {}; rims = []
    for E, I, OP in ((eo, ei, opn), (eoB, eiB, None)):
        if E is None: continue
        for j, (e, i) in enumerate(zip(E, I)):
            p0 = to2(S.P[e, i]); p1 = to2(S.P[e, (i + 1) % 3])
            ln = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
            if ln < 1e-9: continue
            if OP is not None and OP[j]:
                # shift the cut MARGIN towards the occluder's interior (side of its third vertex), extend the ends
                q = to2(S.P[e, (i + 2) % 3]); dx, dy = (p1[0] - p0[0]) / ln, (p1[1] - p0[1]) / ln
                nx, ny = -dy, dx
                if (q[0] - p0[0]) * nx + (q[1] - p0[1]) * ny < 0: nx, ny = -nx, -ny
                rims.append((p0, p1))
                p0 = (p0[0] + MARGIN * (nx - dx), p0[1] + MARGIN * (ny - dy)); p1 = (p1[0] + MARGIN * (nx + dx), p1[1] + MARGIN * (ny + dy))
            k = tuple(sorted([(round(p0[0], 7), round(p0[1], 7)), (round(p1[0], 7), round(p1[1], 7))]))
            segs[k] = (p0, p1)
    pcs = [poly]
    for p0, p1 in segs.values():
        d = (p1[0] - p0[0], p1[1] - p0[1]); ln = math.hypot(*d)
        n = (-d[1] / ln, d[0] / ln); c = n[0] * p0[0] + n[1] * p0[1]
        nxt = []
        for pg in pcs:
            r = _split(pg, n, c) if _seg_hits(pg, p0, p1) else None
            if r is None: nxt.append(pg)
            else: nxt += [x for x in r if len(x) >= 3]
        pcs = nxt
        if len(pcs) > 4 * budget: return None
    def inside_any(O, cx, cy):
        for (a0, a1), (b0, b1), (c0, c1) in O:
            s0 = (b0 - a0) * (cy - a1) - (cx - a0) * (b1 - a1)
            s1 = (c0 - b0) * (cy - b1) - (cx - b0) * (c1 - b1)
            s2 = (a0 - c0) * (cy - c1) - (cx - c0) * (a1 - c1)
            if (s0 >= -1e-9 and s1 >= -1e-9 and s2 >= -1e-9) or (s0 <= 1e-9 and s1 <= 1e-9 and s2 <= 1e-9): return True
        return False
    OF = [[to2(S.P[b, k]) for k in range(3)] for b in occ]
    OB = [[to2(S.P[b, k]) for k in range(3)] for b in occB] if occB is not None else None
    kept = []
    for pg in pcs:
        cx = sum(x for x, _ in pg) / len(pg); cy = sum(y for _, y in pg) / len(pg)
        drop = inside_any(OF, cx, cy) and (OB is None or inside_any(OB, cx, cy))
        if drop and rims:
            drop = all(_poly_seg_dist(pg, a, b) >= MARGIN * 0.98 for a, b in rims)
        if not drop: kept.append(pg)
    if len(kept) == len(pcs): return None
    if len(kept) and sum(len(p) for p in kept) > budget: return None
    return kept

def _apply(S, cull, pieces, cls, log):
    """Drop culled triangles, replace clipped ones by their pieces and split neighbours at the new edge points so the
    mesh stays free of T-junctions. New vertices interpolate the parent triangle's colours."""
    # edge points: global edge (vidA < vidB) -> sorted params along A->B
    EP = {}
    def onedge(pt2, A2):
        res = []
        for k in range(3):
            a = A2[k]; b = A2[(k + 1) % 3]; d = (b[0] - a[0], b[1] - a[1]); L2 = d[0] * d[0] + d[1] * d[1]
            u = ((pt2[0] - a[0]) * d[0] + (pt2[1] - a[1]) * d[1]) / L2
            dist = abs((pt2[0] - a[0]) * d[1] - (pt2[1] - a[1]) * d[0]) / math.sqrt(L2)
            if dist < 1e-6 and 1e-7 < u < 1 - 1e-7: res.append((k, u))
        return res
    corners = {}
    for t, kept in pieces.items():
        o, ax, ay = _frame2(S, t)
        A2 = [(float((S.P[t, k] - o) @ ax), float((S.P[t, k] - o) @ ay)) for k in range(3)]
        corners[t] = A2
        for pg in kept:
            for q in pg:
                for k, u in onedge(q, A2):
                    va, vb = S.vid[t, k], S.vid[t, (k + 1) % 3]
                    EP.setdefault((min(va, vb), max(va, vb)), []).append(u if va < vb else 1 - u)
    for k in EP:                                           # merge points closer than ~10 microns
        v = sorted(EP[k]); m = [v[0]]
        for x in v[1:]:
            if x - m[-1] > 1e-6: m.append(x)
        EP[k] = m
    # every triangle touching a split edge must be re-triangulated
    e0 = np.minimum(S.vid, np.roll(S.vid, -1, 1)); e1 = np.maximum(S.vid, np.roll(S.vid, -1, 1))
    NV = int(S.vid.max()) + 1
    ek = e0 * NV + e1
    keys = np.array([a * NV + b for a, b in EP], np.int64) if EP else np.zeros(0, np.int64)
    touch = np.isin(ek, keys).any(1) & ~cull
    redo = set(np.nonzero(touch)[0].tolist()) | set(pieces)
    log("hsr: %d clipped triangles, %d edge split points, %d triangles re-triangulated" % (len(pieces), sum(len(v) for v in EP.values()), len(redo)))
    new = {}                                               # ref -> lists
    for t in sorted(redo):
        k_ref = int(S.rid[t]); r = S.refs[k_ref]; loc = int(S.loc[t])
        o, ax, ay = _frame2(S, t)
        A2 = corners.get(t) or [(float((S.P[t, k] - o) @ ax), float((S.P[t, k] - o) @ ay)) for k in range(3)]
        polys = pieces.get(t, [A2])
        vt = r["tri"][loc]
        P3 = S.P[t]
        # per-edge split params (in this triangle's k -> k+1 direction)
        eparams = []
        for k in range(3):
            va, vb = S.vid[t, k], S.vid[t, (k + 1) % 3]
            ps = EP.get((min(va, vb), max(va, vb)), [])
            eparams.append(sorted(u if va < vb else 1 - u for u in ps))
        den = (A2[1][1] - A2[2][1]) * (A2[0][0] - A2[2][0]) + (A2[2][0] - A2[1][0]) * (A2[0][1] - A2[2][1])
        def bary(q):
            l1 = ((A2[1][1] - A2[2][1]) * (q[0] - A2[2][0]) + (A2[2][0] - A2[1][0]) * (q[1] - A2[2][1])) / den
            l2 = ((A2[2][1] - A2[0][1]) * (q[0] - A2[2][0]) + (A2[0][0] - A2[2][0]) * (q[1] - A2[2][1])) / den
            return (l1, l2, 1 - l1 - l2)
        out = new.setdefault(k_ref, dict(pos=[], col=[], tri=[], src=[]))
        if "_hx" not in r: r["_hx"] = np.concatenate([r["hdr"], r["aux"]], 1) if "aux" in r else r["hdr"]   # colour (+ albedo, class)
        hdr = r["_hx"]; base = len(r["pos"])
        def vert(q, edge=None):
            """vertex index for 2D point q (snapped to a corner / an edge point when it lies there)."""
            for k in range(3):
                if abs(q[0] - A2[k][0]) < 1e-7 and abs(q[1] - A2[k][1]) < 1e-7: return int(vt[k])
            if edge is not None:
                k, u = edge; X = P3[k] + (P3[(k + 1) % 3] - P3[k]) * u
                l = [0.0, 0.0, 0.0]; l[k] = 1 - u; l[(k + 1) % 3] = u
            else:
                l = bary(q); X = P3[0] * l[0] + P3[1] * l[1] + P3[2] * l[2]
            out["pos"].append(X); out["col"].append(hdr[vt[0]] * l[0] + hdr[vt[1]] * l[1] + hdr[vt[2]] * l[2])
            return base + sum(len(x["pos"]) for x in [out]) - 1
        allv = [q for pg in polys for q in pg] if len(polys) > 1 else []
        for pg in polys:
            # walk the polygon, inserting edge points on segments that lie along an original edge, and vertices of
            # sibling pieces that lie on a segment (pieces are cut by segment-restricted lines)
            ring = []
            m = len(pg)
            info = [onedge(q, A2) for q in pg]
            for i in range(m):
                q = pg[i]; qn = pg[(i + 1) % m]
                ek_ = None
                if info[i]:
                    ek_ = info[i][0]
                    # snap to the merged edge point
                    k, u = ek_; cand = eparams[k]
                    if cand:
                        j = min(range(len(cand)), key=lambda j: abs(cand[j] - u))
                        if abs(cand[j] - u) < 1e-5: ek_ = (k, cand[j])
                ring.append((q, vert(q, ek_)))
                # which original edge does segment q->qn lie on?
                kq = {k for k, _ in info[i]} | {k for k in range(3) if abs(q[0] - A2[k][0]) < 1e-7 and abs(q[1] - A2[k][1]) < 1e-7 for k in (k, (k - 1) % 3)}
                kn = {k for k, _ in info[(i + 1) % m]} | {k for k in range(3) if abs(qn[0] - A2[k][0]) < 1e-7 and abs(qn[1] - A2[k][1]) < 1e-7 for k in (k, (k - 1) % 3)}
                ins = []                                   # (param along q->qn, 2D point, edge info)
                for k in kq & kn:
                    a = A2[k]; b = A2[(k + 1) % 3]; d = (b[0] - a[0], b[1] - a[1]); L2 = d[0] * d[0] + d[1] * d[1]
                    u0 = ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]) / L2; u1 = ((qn[0] - a[0]) * d[0] + (qn[1] - a[1]) * d[1]) / L2
                    lo_, hi_ = min(u0, u1), max(u0, u1)
                    for u in eparams[k]:
                        if lo_ + 1e-6 < u < hi_ - 1e-6: ins.append(((u - u0) / (u1 - u0), (a[0] + d[0] * u, a[1] + d[1] * u), (k, u)))
                    break
                sx, sy = qn[0] - q[0], qn[1] - q[1]; sl2 = sx * sx + sy * sy
                if allv and sl2 > 1e-18:
                    sl = math.sqrt(sl2)
                    for w in allv:
                        f = ((w[0] - q[0]) * sx + (w[1] - q[1]) * sy) / sl2
                        if 1e-7 < f < 1 - 1e-7 and abs((w[0] - q[0]) * sy - (w[1] - q[1]) * sx) / sl < 1e-7:
                            if all(abs(f - g) * sl > 1e-6 for g, _, _ in ins): ins.append((f, w, None))
                for f, w, e in sorted(ins, key=lambda x: x[0]):
                    ring.append((w, vert(w, e)))
            # triangulate the convex ring (collinear points allowed)
            n = len(ring)
            def colin(i):
                a, b, c = ring[(i - 1) % n][0], ring[i][0], ring[(i + 1) % n][0]
                cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
                return abs(cr) <= 1e-7 * math.hypot(b[0] - a[0], b[1] - a[1]) * math.hypot(c[0] - b[0], c[1] - b[1]) + 1e-14
            cl = [colin(i) for i in range(n)]
            if n == 3:
                out["tri"].append([ring[0][1], ring[1][1], ring[2][1]]); out["src"].append(t); continue
            apex = None
            for i in range(n):
                if not cl[i] and not cl[(i - 1) % n] and not cl[(i + 1) % n]: apex = i; break
            if apex is not None:
                for j in range(1, n - 1):
                    out["tri"].append([ring[apex][1], ring[(apex + j) % n][1], ring[(apex + j + 1) % n][1]]); out["src"].append(t)
            else:
                cx = sum(q[0] for q, _ in ring) / n; cy = sum(q[1] for q, _ in ring) / n
                ci = vert((cx, cy))
                for j in range(n):
                    out["tri"].append([ci, ring[j][1], ring[(j + 1) % n][1]]); out["src"].append(t)
    # write back
    drop = cull.copy(); drop[list(redo)] = True
    added = 0
    for k, r in enumerate(S.refs):
        m = S.rid == k
        keep = ~drop[m]
        f = {fld: r[fld] for fld in ("cls", "mat", "oid", "emis")}
        f["cls"] = cls[m]
        tri = r["tri"][keep]; fl = {fld: v[keep] for fld, v in f.items()}
        if k in new and new[k]["tri"]:
            nw = new[k]; src = np.array(nw["src"])
            loc = S.loc[src]
            npos = np.array(nw["pos"]).reshape(-1, 3); ncol = np.array(nw["col"]).reshape(len(npos), -1)
            # merge new vertices created more than once (shared by sibling pieces / both sides of a cut)
            key = np.concatenate([np.round(npos * 1e6), np.round(ncol * 1e6)], 1)
            _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
            base = len(r["pos"]); remap = np.arange(base + len(npos))
            remap[base:] = base + np.searchsorted(np.sort(first), first)[inv]
            keepv = np.sort(first)
            r["pos"] = np.concatenate([r["pos"], npos[keepv]])
            r["hdr"] = np.concatenate([r["hdr"], ncol[keepv][:, :3]])
            if "aux" in r: r["aux"] = np.concatenate([r["aux"], ncol[keepv][:, 3:]])
            tri = np.concatenate([tri, remap[np.array(nw["tri"], np.int64)]])
            for fld in fl: fl[fld] = np.concatenate([fl[fld], f[fld][loc]])
            added += len(nw["tri"])
        r["tri"] = tri; r.pop("_hx", None)
        for fld in fl: r[fld] = fl[fld]
    log("hsr: removed %d triangles, re-triangulated into %d" % (int(drop.sum()), added))
