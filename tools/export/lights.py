"""The park's light list for the viewer (data/lights.json): every light the bake uses, in three.js axes.

  uv run --no-project --with numpy --with scipy python web_export/lights.py NPZ_DIR OUT_DIR     (pack.py calls build())

Two sources, both exactly what Cycles lit the park with:
- the Blender light objects (bake.py dumps them to NPZ_DIR/lights__<part>.json): street lamps, lanterns, braziers,
  facade washes. Each is matched to its visible glowing fitting: the emissive triangles within FIT_R of the light (a lamp
  globe, a lantern's glass, a flame). A light with no fitting near it is a helper (a wash, an uplight hidden in a bed)
  and gets kind "other" and no fitting position, so nothing draws a glare in mid-air for it.
- emissive meshes that are bright enough to act as lamps by themselves (windows, neon, festoon bulbs, flames without a
  light object): the emissive triangles of each part dump, grouped into connected pieces and then into CLUSTER m
  clusters, kept when their light at 1 m is at least MIN_I.

Brightness `i` is in the units of the baked light (the npz `light` arrays, which the viewer multiplies by albedo): a
surface at distance d facing the light receives  col * i * max(dot(n, l), 0) / max(d*d, rad*rad).  For a point or spot
light of W watts i = W / (4 pi^2) (Cycles: intensity W / 4pi, diffuse light = irradiance / pi); for an emissive piece of
area A and radiance L (emission strength x colour) i = L A / (4 pi) (its flux pi L A spread over the sphere). `up` is the
share of the light that the bake lets go upward (1 = all of it, see bake.py LANTERN_UP).
"""
import os, sys, json, glob, math, re
import numpy as np

FIT_R = 0.7          # m: emissive triangles this close to a light object are its fitting
CLUSTER = 1.0        # m: emissive pieces closer than this are one fitting
SPLIT = 4.0          # m: clusters larger than this (strips, rows of panes) are cut into SPLIT/2 m cells
MIN_I = dict(lamp=0.03, lantern=0.03, flame=0.03, window=0.5, neon=0.5, other=0.5)
                     # baked-light units at 1 m (0.5 = a 20 W lamp): fittings (lamp, lantern, flame) are kept down to a
                     # single festoon bulb because they are what a glare or a reflection is drawn for; glowing surfaces
                     # (windows, neon, signs) only when they light their surroundings like a lamp
EMIT_MIN = 0.3       # radiance below this is a glowing surface, not a light (rink ice, petals, ribbons)
KINDS = ["lamp", "lantern", "window", "neon", "flame", "other"]
PARTS = ["core", "transit", "guildhollow", "frostmere", "meridian", "wanderers", "brinewatch", "lantern-row", "rosewick"]
SKIP_MAT = re.compile(r"core_moon|finale")

def kind_of(name):
    n = name.lower()
    if re.search(r"flame|fire|coal|hearth|brazier|torch|candle|forge", n): return "flame"
    if re.search(r"window|win_|shoji|paper_wall|interior|lobby|skylight|hall_warm|gunport|stern_glow|facade|glasshouse|"
                 r"wall_glow|lift_car|store_glass", n): return "window"
    if re.search(r"lantern|lan_|fairy|festoon|string|paperlantern|_lamp_gold", n): return "lantern"
    if re.search(r"lamp|globe|bulb|beacon|headlight|lens|downlight|prom_light|street|lane|_light", n): return "lamp"
    if re.search(r"neon|letter|sign|led|stripe|glow|holo|inlay|ring|emb_|gyre|bollard|rail|screen|banner|poster|portal|"
                 r"slot|meter|board|target|crown|orb|rib|cap_|block_top|hurdle|kletters|tneon|kneon|hpc_|edge", n): return "neon"
    return "other"

def to_three(p): p = np.asarray(p, np.float64); return np.stack([p[..., 0], p[..., 2], -p[..., 1]], -1)

def _components(tri, nv):
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    n = len(tri)
    if n == 0: return 0, np.zeros(0, np.int64)
    M = coo_matrix((np.ones(3 * n), (np.repeat(np.arange(n), 3), tri.ravel())), shape=(n, nv)).tocsr()
    return connected_components(M @ M.T, directed=False)

def _merge(points, radius):
    """single-linkage clusters of points closer than radius"""
    from scipy.spatial import cKDTree
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    if len(points) == 0: return np.zeros(0, np.int64)
    pr = cKDTree(points).query_pairs(radius, output_type="ndarray")
    G = coo_matrix((np.ones(len(pr)), (pr[:, 0], pr[:, 1])), shape=(len(points),) * 2)
    return connected_components(G, directed=False)[1]

def emitters(npz):
    """emissive pieces of one part dump: centre, power-weighted colour, i, size, dominant material name"""
    d = np.load(npz); meta = json.loads(str(d["meta"])); mats = meta["mats"]
    tri = d["tri"]; co = d["co"].astype(np.float64); mi = np.clip(d["mi"], 0, len(mats) - 1)
    emit = d["emit"].astype(np.float32).reshape(-1, 3, 3).mean(1)
    skip = np.array([bool(SKIP_MAT.search(m["name"])) for m in mats])
    sel = np.nonzero((emit.max(1) > EMIT_MIN) & ~skip[mi])[0]
    P = co[tri[sel]]; A = 0.5 * np.linalg.norm(np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]), axis=1)
    _, lab = _components(tri[sel], len(co))
    return dict(cen=P.mean(1), A=A, rad=emit[sel], lab=lab, mat=np.array([mats[m]["name"] for m in mi[sel]]), P=P)

def _group(e, idx):
    """sum a set of emissive triangles (indices into e) into one emitter"""
    w = e["A"][idx][:, None] * e["rad"][idx]                      # L A per triangle per channel
    pw = w.sum(1)
    tot = w.sum(0); c = (e["cen"][idx] * pw[:, None]).sum(0) / max(pw.sum(), 1e-9)
    names, inv = np.unique(e["mat"][idx], return_inverse=True)
    mat = names[np.bincount(inv, weights=pw).argmax()]
    pts = e["P"][idx].reshape(-1, 3); size = float((pts.max(0) - pts.min(0)).max())
    return c, tot / (4 * math.pi), mat, size

def build(npz_dir, out_dir, light_jsons=None, log=print):
    lights = []
    for f in light_jsons or sorted(glob.glob(os.path.join(npz_dir, "lights__*.json"))):
        lights += json.load(open(f))
    lights = [l for l in lights if l["type"] in ("POINT", "SPOT", "AREA") and not l.get("hide")
              and not l["name"].startswith("transit_train_") and l["W"] > 0]      # trains move: their lamps are live
    rows = []; spots = {}; nfit = 0
    for part in PARTS:
        f = os.path.join(npz_dir, "part__%s.npz" % part)
        if not os.path.exists(f): continue
        e = emitters(f)
        used = np.zeros(len(e["A"]), bool)
        from scipy.spatial import cKDTree
        tree = cKDTree(e["cen"]) if len(e["cen"]) else None
        for l in [l for l in lights if l["part"] == part]:
            p = np.array(l["pos"]); col = np.array(l["col"], np.float64)
            i = l["W"] / (4 * math.pi ** 2) * col
            idx = np.array(tree.query_ball_point(p, FIT_R) if tree is not None else [], np.int64)
            fit = None; kind = kind_of(l["name"])
            if len(idx):
                # the whole connected pieces that reach into the radius (a globe, a flame, a pane), not half of them
                pieces = np.unique(e["lab"][idx]); idx = np.nonzero(np.isin(e["lab"], pieces) & ~used)[0]
                idx = idx[np.linalg.norm(e["cen"][idx] - p, axis=1) < FIT_R * 2.5]
            if len(idx):
                c, ie, mat, size = _group(e, idx); used[idx] = True; nfit += 1
                fit = c; i = i + ie
                k2 = kind_of(mat)
                if kind in ("lamp", "other") and k2 != "other": kind = k2 if k2 != "neon" else kind
                if kind == "other": kind = "lamp"
            else:
                kind = "other"; size = 0.0
            r = dict(p=p, i=i, rad=max(l.get("r", 0.1), l.get("soft", 0.0), 0.05), kind=kind, fit=fit, part=part, src=0, size=size,
                     name=l["name"], up=l.get("up", 1.0))
            if l["type"] == "SPOT":
                r["spot"] = (l["dir"], math.cos(l["size"] / 2), math.cos(l["size"] / 2 * (1 - l["blend"])))
            rows.append(r)
        # the rest of the emissive triangles: pieces -> clusters -> lamps when bright enough
        rest = np.nonzero(~used)[0]
        if len(rest):
            labs, inv = np.unique(e["lab"][rest], return_inverse=True)
            pw = e["A"][rest] * e["rad"][rest].max(1)
            pc_ = np.zeros((len(labs), 3)); np.add.at(pc_, inv, e["cen"][rest] * pw[:, None])
            pc_ /= np.maximum(np.bincount(inv, weights=pw), 1e-9)[:, None]
            cl = _merge(pc_, CLUSTER)[inv]
            for k in np.unique(cl):
                idx = rest[cl == k]
                c, ie, mat, size = _group(e, idx)
                groups = [idx]
                if size > SPLIT:          # a neon strip or a row of windows: one light per SPLIT/2 m cell, not one in the middle
                    vox = np.floor(e["cen"][idx] / (SPLIT * 0.5)).astype(np.int64)
                    _, vi = np.unique(vox, axis=0, return_inverse=True)
                    groups = [idx[vi.ravel() == g] for g in range(vi.max() + 1)]
                for idx in groups:
                    c, ie, mat, size = _group(e, idx)
                    if ie.max() < MIN_I[kind_of(mat)]: continue
                    rows.append(dict(p=c, i=ie, rad=max(0.05, min(size * 0.5, 1.5)), kind=kind_of(mat), fit=c, part=part, src=1, size=size, name=mat))
    # three.js axes, compact rows
    out = dict(format=1, axes="three.js (x, y up, z) = Blender (x, z, -y)",
               fields=["x", "y", "z", "r", "g", "b", "i", "rad", "kind", "fx", "fy", "fz", "part", "src", "size", "up"],
               kinds=KINDS, parts=PARTS, src=["light object", "emissive mesh"], rows=[], spots={}, names=[])
    for n, r in enumerate(rows):
        i = np.asarray(r["i"], np.float64); m = float(i.max()); col = i / max(m, 1e-9)
        p = to_three(r["p"]); f = to_three(r["fit"]) if r["fit"] is not None else None
        up = r.get("up", 1.0)
        out["rows"].append([round(float(v), 2) for v in p] + [round(float(v), 3) for v in col] + [float("%.3g" % m), round(float(r["rad"]), 2),
                           KINDS.index(r["kind"])] + ([round(float(v), 2) for v in f] if f is not None else [None, None, None]) +
                           [PARTS.index(r["part"]), r["src"], round(float(r["size"]), 2), up])
        out["names"].append(r["name"])
        if "spot" in r:
            dvec = to_three(r["spot"][0]); out["spots"][str(n)] = [round(float(v), 3) for v in dvec] + [round(r["spot"][1], 3), round(r["spot"][2], 3)]
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "lights.json")
    txt = json.dumps(out, separators=(",", ":"))
    open(path, "w").write(txt)
    from collections import Counter
    log("lights: %d (%d light objects, %d with a fitting; %d emissive) %s, %.0f kB" % (
        len(rows), sum(r["src"] == 0 for r in rows), nfit, sum(r["src"] == 1 for r in rows),
        dict(Counter(r["kind"] for r in rows)), len(txt) / 1e3))
    return out

if __name__ == "__main__":
    extra = sys.argv[3:] or None
    build(sys.argv[1], sys.argv[2], extra)
