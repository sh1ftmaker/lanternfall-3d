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
