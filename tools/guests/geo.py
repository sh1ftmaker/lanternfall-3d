"""Spatial queries over the baked triangles of every part (Blender frame)."""
import numpy as np
import common as C

class Geo:
    def __init__(self, parts=C.PARTS, tile=4.0, log=print):
        Ps, Ns, part_ix, oid, mi, area = [], [], [], [], [], []
        self.parts = list(parts); self.names = []; self.mats = []
        for k, p in enumerate(self.parts):
            r = C.load_part(p)
            P = r["P"]; c = np.hypot(P[:, :, 0], P[:, :, 1]).max(1) < 700
            mat_names = np.array([m["name"] for m in r["mats"]])
            c &= mat_names[r["mi"]] != "core_lakebed"
            Ps.append(P[c]); Ns.append(r["n"][c].astype(np.float32)); part_ix.append(np.full(c.sum(), k, np.int8))
            oid.append(r["oid"][c]); mi.append(r["mi"][c]); area.append(r["area"][c].astype(np.float32))
            self.names.append(r["names"]); self.mats.append([m["name"] for m in r["mats"]])
            r["keep"] = np.nonzero(c)[0]
        self.P = np.concatenate(Ps); self.n = np.concatenate(Ns); self.part = np.concatenate(part_ix)
        self.oid = np.concatenate(oid); self.mi = np.concatenate(mi); self.area = np.concatenate(area)
        self.tile = tile
        lo = self.P.min(1); hi = self.P.max(1)
        self.lo, self.hi = lo, hi
        tx0 = np.floor(lo[:, 0] / tile).astype(np.int64); tx1 = np.floor(hi[:, 0] / tile).astype(np.int64)
        ty0 = np.floor(lo[:, 1] / tile).astype(np.int64); ty1 = np.floor(hi[:, 1] / tile).astype(np.int64)
        nx = tx1 - tx0 + 1; ny = ty1 - ty0 + 1; cnt = nx * ny
        big = cnt > 400                                # the far-away berm etc: clamp
        cnt = np.where(big, 1, cnt)
        tid = np.repeat(np.arange(len(self.P)), cnt)
        off = np.arange(len(tid)) - np.repeat(np.cumsum(cnt) - cnt, cnt)
        nxr = np.repeat(nx, cnt)
        kx = np.repeat(tx0, cnt) + off % nxr; ky = np.repeat(ty0, cnt) + off // nxr
        key = (kx + 1000) * 4000 + (ky + 1000)
        o = np.argsort(key, kind="stable"); self.tkey = key[o]; self.ttri = tid[o]
        log("geo: %d triangles indexed" % len(self.P))
        self.zc = self.P[:, :, 2].mean(1)
        self.fullnames = np.array(["%s|%s" % (self.parts[p], "") for p in range(len(self.parts))])

    def tris_in(self, x0, x1, y0, y1, z0=-50, z1=200):
        t = self.tile; ids = []
        for kx in range(int(np.floor(x0 / t)), int(np.floor(x1 / t)) + 1):
            for ky in range(int(np.floor(y0 / t)), int(np.floor(y1 / t)) + 1):
                key = (kx + 1000) * 4000 + (ky + 1000)
                a = np.searchsorted(self.tkey, key); b = np.searchsorted(self.tkey, key, side="right")
                ids.append(self.ttri[a:b])
        if not ids: return np.zeros(0, np.int64)
        ids = np.unique(np.concatenate(ids))
        lo, hi = self.lo[ids], self.hi[ids]
        ok = (hi[:, 0] >= x0) & (lo[:, 0] <= x1) & (hi[:, 1] >= y0) & (lo[:, 1] <= y1) & (hi[:, 2] >= z0) & (lo[:, 2] <= z1)
        return ids[ok]

    def points(self, ids, step=0.05):
        """Sample points on triangles (deterministic-ish). Returns pts (N,3), tri index (N)."""
        if len(ids) == 0: return np.zeros((0, 3), np.float32), np.zeros(0, np.int64)
        P = self.P[ids]; a = self.area[ids]
        n = np.minimum(np.ceil(a / (step * step) * 2.0).astype(np.int64) + 3, 20000)
        idx = np.repeat(np.arange(len(ids)), n)
        rng = np.random.default_rng(len(ids))
        u = rng.random(len(idx), dtype=np.float32); v = rng.random(len(idx), dtype=np.float32)
        fl = u + v > 1; u = np.where(fl, 1 - u, u); v = np.where(fl, 1 - v, v)
        pts = P[idx, 0] + (P[idx, 1] - P[idx, 0]) * u[:, None] + (P[idx, 2] - P[idx, 0]) * v[:, None]
        # corners too, so thin boxes keep their extremes
        pts = np.concatenate([pts, P.reshape(-1, 3)]); idx = np.concatenate([idx, np.repeat(np.arange(len(ids)), 3)])
        return pts, ids[idx]

    def name(self, t):
        return self.names[self.part[t]][self.oid[t]]

    def mat(self, t):
        return self.mats[self.part[t]][self.mi[t]]

    def local_box(self, cx, cy, ux, uy, half_u, half_v, z0, z1, step=0.05):
        """Points of all geometry inside an oriented box around (cx, cy): u along (ux, uy), v = left normal.
        Returns local coordinates (N,3) = (u, v, z) and tri ids."""
        r = np.hypot(half_u, half_v) + 0.1
        ids = self.tris_in(cx - r, cx + r, cy - r, cy + r, z0, z1)
        pts, tid = self.points(ids, step)
        dx = pts[:, 0] - cx; dy = pts[:, 1] - cy
        u = dx * ux + dy * uy; v = -dx * uy + dy * ux
        ok = (np.abs(u) <= half_u) & (np.abs(v) <= half_v) & (pts[:, 2] >= z0) & (pts[:, 2] <= z1)
        return np.stack([u[ok], v[ok], pts[ok, 2]], 1), tid[ok]

class Vox:
    """Coarse occupancy of all geometry (0.5 m voxels) for line-of-sight tests."""
    def __init__(self, geo, nav, cs=0.5, z0=-2.0, nz=90, log=print):
        self.cs, self.x0, self.y0, self.z0 = cs, nav["x0"], nav["y0"], z0
        self.W = int(nav["w"] * nav["cell"] / cs); self.H = int(nav["h"] * nav["cell"] / cs); self.NZ = nz
        occ = np.zeros((self.H, self.W, nz), bool)
        glassy = np.zeros(len(geo.P), bool)
        for k in range(len(geo.parts)):
            g = np.array([bool(m.get("glass")) for m in C.load_part(geo.parts[k])["mats"]])
            sel = geo.part == k; glassy[sel] = g[geo.mi[sel]]
        ids = np.nonzero(~glassy)[0]
        for s in range(0, len(ids), 300000):
            pts, _ = geo.points(ids[s:s + 300000], 0.3)
            i = np.floor((pts[:, 0] - self.x0) / cs).astype(np.int64); j = np.floor((pts[:, 1] - self.y0) / cs).astype(np.int64)
            k = np.floor((pts[:, 2] - z0) / cs).astype(np.int64)
            ok = (i >= 0) & (j >= 0) & (k >= 0) & (i < self.W) & (j < self.H) & (k < nz)
            occ[j[ok], i[ok], k[ok]] = True
        self.occ = occ
        log("vox: %d occupied voxels" % occ.sum())

    def clear(self, a, b, skip_end=1.0, skip_start=0.4):
        """True if the segment a->b (3D) crosses no occupied voxel, ignoring the first/last metres."""
        a = np.asarray(a, float); b = np.asarray(b, float); d = b - a; L = np.linalg.norm(d)
        if L < skip_end + skip_start: return True
        t = np.arange(skip_start, L - skip_end, self.cs * 0.5) / L
        p = a[None] + d[None] * t[:, None]
        i = np.floor((p[:, 0] - self.x0) / self.cs).astype(np.int64); j = np.floor((p[:, 1] - self.y0) / self.cs).astype(np.int64)
        k = np.floor((p[:, 2] - self.z0) / self.cs).astype(np.int64)
        ok = (i >= 0) & (j >= 0) & (k >= 0) & (i < self.W) & (j < self.H) & (k < self.NZ)
        return not self.occ[j[ok], i[ok], k[ok]].any()

def objects(geo):
    """Per (part, object name): dict(c centroid (area weighted), lo, hi, area, ids)."""
    key = geo.part.astype(np.int64) * 100000 + geo.oid
    o = np.argsort(key, kind="stable"); ks = key[o]
    cut = np.nonzero(np.diff(ks))[0] + 1; starts = np.r_[0, cut]; ends = np.r_[cut, len(ks)]
    c = geo.P.mean(1); out = {}
    for a, b in zip(starts, ends):
        ids = o[a:b]; p = int(geo.part[ids[0]]); nm = geo.names[p][geo.oid[ids[0]]]
        w = geo.area[ids].astype(np.float64) + 1e-9
        out[nm] = dict(part=geo.parts[p], c=(c[ids] * w[:, None]).sum(0) / w.sum(), lo=geo.lo[ids].min(0), hi=geo.hi[ids].max(0), area=float(w.sum()), ids=ids)
    return out
