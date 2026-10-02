"""Coarse path network for the crowd: promenade rings, the Lamplighters' Walk, and one paved spoke per land and gap
(cheapest walk from the Ring Promenade to the Shore Promenade, preferring paved cells)."""
import math
import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import dijkstra
import common as C
import park_common as pc

COST = {"paved": 1.0, "wood": 1.0, "floor": 1.0, "stairs": 1.3, "bridge": 1.0, "pier": 1.0, "gravel": 1.15, "ice": 2.0,
        "snow": 1.3, "lawn": 3.5, "bed": 25.0, "water": 60.0, "none": 0}

def rdp(pts, eps):
    pts = np.asarray(pts)
    if len(pts) < 3: return pts
    a, b = pts[0], pts[-1]; ab = b - a; L = np.hypot(*ab) or 1e-9
    d = np.abs(ab[0] * (pts[:, 1] - a[1]) - ab[1] * (pts[:, 0] - a[0])) / L
    k = int(np.argmax(d))
    if d[k] > eps: return np.vstack([rdp(pts[:k + 1], eps)[:-1], rdp(pts[k:], eps)])
    return np.vstack([a, b])

def width_at(nav, ground, classes, x, y, tx, ty, hard, wmax=12.0):
    """Width of the hard-surfaced band across (tx, ty) at (x, y)."""
    nx, ny = -ty, tx; w = 0.0
    for sg in (1, -1):
        d = 0.0
        while d < wmax / 2:
            px, py = x + nx * sg * (d + 0.25), y + ny * sg * (d + 0.25)
            i, j = C.nav_ij(nav, px, py)
            if not (0 <= i < nav["w"] and 0 <= j < nav["h"]) or ground[j, i] not in hard: break
            d += 0.25
        w += d
    return w

def ring(nav, ground, classes, rfun, name, n=180, width=None):
    pts = []; ws = []; hard = {classes.index(k) for k in ("paved", "wood", "floor", "stairs", "bridge", "pier")}
    for k in range(n):
        phi = 2 * math.pi * k / n; r = rfun(phi)
        x, y = r * math.cos(phi), r * math.sin(phi)
        pts.append((x, y))
    pts = np.array(pts)
    for k in range(n):
        t = pts[(k + 1) % n] - pts[k - 1]; t /= np.hypot(*t)
        ws.append(width_at(nav, ground, classes, pts[k, 0], pts[k, 1], t[0], t[1], hard))
    walk = np.mean(~np.isnan(C.nav_height(nav, pts[:, 0], pts[:, 1])))
    return dict(name=name, closed=True, w=round(float(width if width else np.median(ws)), 1), walk=round(float(walk), 2), pts=[[round(float(a), 1), round(float(b), 1)] for a, b in pts])

def build(nav, ground, classes, log=print):
    out = []
    shore_mid = lambda p: 0.5 * (pc.lake_radius(p) + pc.shore_radius(p)) + 0.6
    out.append(ring(nav, ground, classes, shore_mid, "Shore Promenade", 240))
    out.append(ring(nav, ground, classes, lambda p: pc.rail_radius(p), "Ring Promenade", 240, width=2 * pc.PROM_HALF))
    # cost grid on the nav cells (0.5 m); edges between walkable neighbours less than 0.35 m apart in height
    H, W = nav["h"], nav["w"]; cs = nav["cell"]
    cost = np.zeros((H, W))
    for name, c in COST.items():
        if c: cost[ground == classes.index(name)] = c
    z = np.nan_to_num(nav["zA"], nan=-99)
    idx = np.arange(H * W).reshape(H, W)
    rows, cols, vals = [], [], []
    for dj, di, L in ((0, 1, 1.0), (1, 0, 1.0), (1, 1, 1.414), (1, -1, 1.414)):
        sa = (slice(0, H - dj), slice(max(0, -di), W - max(0, di))); sb = (slice(dj, H), slice(max(0, di), W - max(0, -di)))
        ca, cb = cost[sa].ravel(), cost[sb].ravel()
        ok = (ca > 0) & (cb > 0) & (np.abs(z[sa] - z[sb]).ravel() < 0.35)
        rows.append(idx[sa].ravel()[ok]); cols.append(idx[sb].ravel()[ok]); vals.append((0.5 * (ca + cb) * L * cs)[ok])
    G = sparse.coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(H * W, H * W)).tocsr()
    G = G + G.T
    def node(x, y):
        best = None
        for r in np.arange(0, 6, 0.5):
            for a in np.linspace(0, 2 * math.pi, 16, endpoint=False):
                px, py = x + r * math.cos(a), y + r * math.sin(a)
                i = int((px - nav["x0"]) / cs); j = int((py - nav["y0"]) / cs)
                if 0 <= i < W and 0 <= j < H and cost[j, i] > 0 and cost[j, i] <= 1.3: return j * W + i
            if best: break
        return None
    spokes = [(l, pc.LANDS[l]["phi"], pc.LANDS[l]["name"] + " main lane") for l in pc.LAND_IDS]
    spokes += [(None, gp["mid"], "Gap path %s-%s" % (gp["a"], gp["b"])) for gp in pc.gaps() if abs(math.remainder(gp["mid"], 2 * math.pi)) > 0.1]
    hard = {classes.index(k) for k in ("paved", "wood", "floor", "stairs", "bridge", "pier")}
    for land, phi, name in spokes:
        r0 = pc.shore_radius(phi) + 1.0; r1 = pc.rail_radius(phi) + (pc.PROM_HALF if land else 0)
        if land: r1 = pc.outer_radius(phi) - 8.0
        a = node(r0 * math.cos(phi), r0 * math.sin(phi)); b = None
        for back in (0, 6, 12, 18, 24):
            b = node((r1 - back) * math.cos(phi), (r1 - back) * math.sin(phi))
            if b is not None: break
        if a is None or b is None: log("  path: no end node for", name); continue
        dist, pred = dijkstra(G, indices=a, return_predecessors=True)
        if not np.isfinite(dist[b]): log("  path: unreachable", name); continue
        seq = [b]
        while seq[-1] != a: seq.append(pred[seq[-1]])
        P = np.array([[nav["x0"] + (k % W + 0.5) * cs, nav["y0"] + (k // W + 0.5) * cs] for k in seq[::-1]])
        ws = []
        for k in range(4, len(P) - 4, 4):
            t = P[k + 4] - P[k - 4]; t = t / (np.hypot(*t) or 1)
            ws.append(width_at(nav, ground, classes, P[k, 0], P[k, 1], t[0], t[1], hard))
        P = rdp(P, 0.8)
        out.append(dict(name=name, land=land or "transit", closed=False, w=round(float(np.clip(np.median(ws) if ws else 2, 1.5, 12)), 1),
                        pts=[[round(float(x), 1), round(float(y), 1)] for x, y in P]))
    # the Lamplighters' Walk (East Gate -> Shore Promenade), along y = 0
    x1 = pc.shore_radius(0.0) + 1.0
    xs = np.arange(338.0, x1, -1.0)
    ws = [width_at(nav, ground, classes, x, 0.0, 1.0, 0.0, hard, wmax=20) for x in xs]
    out.append(dict(name="The Lamplighters' Walk", land="transit", closed=False, w=round(float(np.median(ws)), 1),
                    pts=[[338.0, 0.0], [round(float(x1), 1), 0.0]]))
    log("paths: %d polylines: %s" % (len(out), [(p["name"], p["w"], len(p["pts"])) for p in out]))
    return out
