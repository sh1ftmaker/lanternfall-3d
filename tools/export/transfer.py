"""Draft lighting for web_export/build.py --draft: no Cycles. Takes the geometry dump of a changed part
(bake.py --draft: joined + grid-cut triangles, no light) and fills its light / albedo / emission from the part's last
real bake, so geometry and navigation can be checked in the viewer within a minute or two.

  python web_export/transfer.py NEW_GEOM.npz PREVIOUS_BAKE.npz OUT.npz      (PREVIOUS may be missing)

- Triangles that are still where they were (same three corners within 0.1 mm) take the old orientation (bake.py turns
  faces to their open side) and their old per-corner values exactly.
- Other triangles keep their built winding, take light from the nearest old corner with a similar normal (within 3 m),
  albedo / emission from the nearest old corner of the same material (within 3 m) or else the material's flat colour.
- Nothing near: the median light of old faces facing the same way (up / down / sideways), material colours.
"""
import sys, json
import numpy as np
from scipy.spatial import cKDTree

def load(p):
    d = np.load(p); return {k: d[k] for k in d.files}

def face_normals(co, tri):
    p = co[tri]; n = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    return n / np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]

def transfer(new, old):
    co = new["co"].astype(np.float64); tri = new["tri"].copy(); T = len(tri)
    mats = json.loads(str(new["meta"]))["mats"]; mname = np.array([m["name"] for m in mats] or ["none"])
    mi = np.clip(new["mi"], 0, len(mname) - 1)
    n = face_normals(co, tri)
    light = np.zeros((T, 3, 3), np.float32); lightnm = np.zeros_like(light); alb = np.zeros_like(light); emit = np.zeros_like(light)
    base = np.array([m["base"] for m in mats] or [[.5, .5, .5]], np.float32)
    ecol = np.array([np.array(m["emit"]) * m["estr"] for m in mats] or [[0, 0, 0]], np.float32)
    alb[:] = base[mi][:, None, :]; emit[:] = ecol[mi][:, None, :]
    stats = dict(tris=T, exact=0, near=0, fallback=0, flipped=0)
    if old is None:
        light[:] = lightnm[:] = 0.05; stats["fallback"] = T
        return pack_out(new, tri, light, lightnm, alb, emit), stats
    oco = old["co"].astype(np.float64); otri = old["tri"]; OT = len(otri)
    omats = json.loads(str(old["meta"]))["mats"]; oname = np.array([m["name"] for m in omats] or ["none"])
    omi = np.clip(old["mi"], 0, len(oname) - 1)
    ol = old["light"].astype(np.float32).reshape(OT, 3, 3); olnm = old["lightnm"].astype(np.float32).reshape(OT, 3, 3)
    oa = old["alb"].astype(np.float32).reshape(OT, 3, 3); oe = old["emit"].astype(np.float32).reshape(OT, 3, 3)
    on = face_normals(oco, otri)
    # ---- exact: same three corner positions (bitwise) and same material; coincident twins (both sides of a thin
    # panel) are matched in creation order, k-th twin to k-th twin
    allnames = {nm: i for i, nm in enumerate(sorted(set(mname) | set(oname)))}
    def keys(cc, tt, mm):
        P = np.ascontiguousarray(cc.astype(np.float32)[tt]).view(np.uint32).astype(np.int64)      # (n,3,3)
        k = np.stack([np.sort(P[:, :, i], 1) for i in range(3)], 1).reshape(len(tt), 9)  # per-axis sorted: set signature
        return np.concatenate([k, mm[:, None].astype(np.int64)], 1)
    kn = keys(co, tri, np.array([allnames[x] for x in mname])[mi]); ko = keys(oco, otri, np.array([allnames[x] for x in oname])[omi])
    K = np.concatenate([kn, ko]); _, gid = np.unique(K, axis=0, return_inverse=True); gid = gid.ravel()
    def rank(g):
        o = np.argsort(g, kind="stable"); r = np.empty(len(g), np.int64)
        gs = g[o]; start = np.r_[0, np.nonzero(gs[1:] != gs[:-1])[0] + 1]
        cnt = np.diff(np.r_[start, len(gs)]); r[o] = np.arange(len(gs)) - np.repeat(start, cnt)
        return r
    gn, go = gid[:T], gid[T:]
    ckey_o = go * (OT + 1) + rank(go); ckey_n = gn * (OT + 1) + rank(gn)
    so = np.argsort(ckey_o); pos = np.searchsorted(ckey_o[so], ckey_n)
    pos = np.minimum(pos, OT - 1); hit = ckey_o[so][pos] == ckey_n
    jj = np.where(hit, so[pos], 0)
    P = co[tri]; OP = oco[otri[jj]]                                   # (T,3,3)
    dist = np.linalg.norm(P[:, :, None, :] - OP[:, None, :, :], axis=3)   # (T,3,3): new corner k vs old corner m
    m = dist.argmin(2); hit &= (dist.min(2) < 1e-6).all(1) & (np.sort(m, 1) == [0, 1, 2]).all(1)
    h = np.nonzero(hit)[0]
    # adopt the old winding: reorder the new corners to follow the old face's corner order
    inv = np.argsort(m[h], 1)                                          # old corner c <- new corner inv[c]
    tri[h] = np.take_along_axis(tri[h], inv, 1)
    stats["flipped"] = int(((n[h] * on[jj[h]]).sum(1) < 0).sum())
    light[h] = ol[jj[h]]; lightnm[h] = olnm[jj[h]]; alb[h] = oa[jj[h]]; emit[h] = oe[jj[h]]
    stats["exact"] = len(h)
    # ---- near: light from the nearest old corner with a similar normal; albedo / emission from the same material
    r = np.nonzero(~hit)[0]
    if len(r):
        ocorner = oco[otri].reshape(-1, 3); ocn = np.repeat(on, 3, 0); ocmat = np.repeat(oname[omi], 3)
        kd = cKDTree(ocorner)
        q = co[tri[r]].reshape(-1, 3); qn = np.repeat(n[r], 3, 0); qmat = np.repeat(mname[mi[r]], 3)
        dd, jj2 = kd.query(q, k=16, distance_upper_bound=3.0)
        ok = np.isfinite(dd); jc = np.where(ok, jj2, 0)
        agree = np.abs((ocn[jc] * qn[:, None, :]).sum(2))                  # winding unknown: |n . n_old|
        score = np.where(ok, dd + 2.0 * (1 - agree), np.inf)
        b = score.argmin(1); found = np.isfinite(score[np.arange(len(q)), b])
        src = jc[np.arange(len(q)), b]
        L = ol.reshape(-1, 3); LN = olnm.reshape(-1, 3)
        lr = light[r].reshape(-1, 3); lnr = lightnm[r].reshape(-1, 3)
        lr[found] = L[src[found]]; lnr[found] = LN[src[found]]
        same = ok & (ocmat[jc] == qmat[:, None])
        bs = np.where(same, dd, np.inf).argmin(1); fs = np.isfinite(np.where(same, dd, np.inf)[np.arange(len(q)), bs])
        ss = jc[np.arange(len(q)), bs]
        ar = alb[r].reshape(-1, 3); er = emit[r].reshape(-1, 3)
        ar[fs] = oa.reshape(-1, 3)[ss[fs]]; er[fs] = oe.reshape(-1, 3)[ss[fs]]
        # nothing near: median light of old faces facing the same way
        cls_o = np.where(on[:, 2] > 0.7, 0, np.where(on[:, 2] < -0.7, 1, 2)); cls_q = np.where(np.abs(qn[:, 2]) > 0.7, 0, 2)
        for c in (0, 2):
            sel = ~found & (cls_q == c)
            if sel.any():
                pool = cls_o == c
                lr[sel] = np.median(ol[pool].reshape(-1, 3), 0) if pool.any() else 0.05
                lnr[sel] = np.median(olnm[pool].reshape(-1, 3), 0) if pool.any() else 0.05
        light[r] = lr.reshape(-1, 3, 3); lightnm[r] = lnr.reshape(-1, 3, 3); alb[r] = ar.reshape(-1, 3, 3); emit[r] = er.reshape(-1, 3, 3)
        fc = (~found).reshape(-1, 3).any(1)
        stats["near"] = int((~fc).sum()); stats["fallback"] = int(fc.sum())
    return pack_out(new, tri, light, lightnm, alb, emit), stats

def pack_out(new, tri, light, lightnm, alb, emit):
    co = new["co"]; p = co[tri].astype(np.float64)
    nr = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]); nr = (nr / np.maximum(np.linalg.norm(nr, axis=1), 1e-12)[:, None]).astype(np.float32)
    out = dict(new); out.update(tri=tri.astype(new["tri"].dtype), nr=nr, light=light.reshape(-1, 3).astype(np.float16),
                                lightnm=lightnm.reshape(-1, 3).astype(np.float16), alb=alb.reshape(-1, 3).astype(np.float16),
                                emit=emit.reshape(-1, 3).astype(np.float32))
    return out

if __name__ == "__main__":
    import os
    new = load(sys.argv[1]); old = load(sys.argv[2]) if os.path.exists(sys.argv[2]) else None
    out, st = transfer(new, old)
    np.savez(sys.argv[3], **out)
    print("[transfer] %s: %d tris, %d exact, %d nearby light, %d fallback, %d turned to the old side" % (
        os.path.basename(sys.argv[3]), st["tris"], st["exact"], st["near"], st["fallback"], st["flipped"]))
