"""Per-vertex auxiliary data for the lit prototype: albedo (RGB) + material class, aligned to data/*.bin.

  uv run --no-project --with numpy python tools/gen_aux.py NPZ_DIR data data/lit

Replays the vertex welding / chunking / ordering of web_export/pack.py (snapshot of 2026-10-01 09:18, the version that
wrote the current data/*.bin) and checks every mesh's vertex/index count against data/manifest.json; a mesh that does
not match is written with nv = 0 so the viewer leaves it on the baked material. When pack.py changes (hidden-surface
removal etc.) this replay goes stale: the real fix is for pack.py itself to emit these bytes.
Output: data/lit/aux_<part>.bin = gzip of, per opaque mesh in manifest order, 4 planes of nv bytes (zigzag deltas):
  albedo R, G, B (sqrt-encoded u8), class (u8, see CLASSES).
"""
import sys, os, json, gzip, math, re
import numpy as np

NPZ, DATA, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
CELL = 64.0
CLASSES = [  # (class id, regex on material name without the part prefix); first match wins, emissive is decided first
    (5, r"roof|shingle|slate|tile_edge|^tile$"),
    (4, r"grass|lawn|turf|hedge|leaf|topiary|boxwood|conifer|snow|soil|earth|gravel|sand|shrub|flower|blossom|pine|maple|palm|bark|trunk|moss"),
    (1, r"pave|paving|cobble|flagstone|plaza|quay|road|tactile|wharf|prom|kerb|asphalt|floor|ring|walk"),
    (2, r"wood|plank|boardwalk|deck|timber|bench|barrel|crate|board|siding|bamboo|pile|mast|chest|tabletop|counter|cork"),
    (3, r"stone|brick|wall|marble|stucco|plaster|concrete|coping|balustrade|facade|rock|pylon|panel|cap|base"),
    (6, r"iron|brass|gold|chrome|steel|copper|bronze|metal|wire|rail|pipe|truss|silver|grate"),
]
NAMES = {0: "plain", 1: "paving", 2: "wood", 3: "masonry", 4: "organic", 5: "roof", 6: "metal", 7: "emissive"}

def mat_class(m, part):
    if m["estr"] > 0 and max(m["emit"]) > 0: return 7
    n = m["name"]; n = n[len(part) + 1:] if n.startswith(part.replace("-", "_") + "_") else n.split("_", 1)[-1]
    for c, rx in CLASSES:
        if re.search(rx, n): return c
    return 0

def to_three(p): return np.stack([p[..., 0], p[..., 2], -p[..., 1]], -1)

def morton(q):
    def spread(v):
        v = v.astype(np.uint64) & 0x3FF
        v = (v | (v << 16)) & 0x30000FF; v = (v | (v << 8)) & 0x300F00F
        v = (v | (v << 4)) & 0x30C30C3; v = (v | (v << 2)) & 0x9249249
        return v
    return spread(q[:, 0]) | (spread(q[:, 1]) << 1) | (spread(q[:, 2]) << 2)

def corner_angles(co, t):
    p = co[t]; a = []
    for i in range(3):
        u = p[:, (i + 1) % 3] - p[:, i]; v = p[:, (i + 2) % 3] - p[:, i]
        cs = (u * v).sum(1) / np.maximum(np.linalg.norm(u, axis=1) * np.linalg.norm(v, axis=1), 1e-12)
        a.append(np.arccos(np.clip(cs, -1, 1)))
    return np.stack(a, 1).ravel()

def weld(co, tri, key_extra, colors, weights):
    key = tri.ravel().astype(np.int64) * (int(key_extra.max()) + 1) + key_extra
    uniq, inv = np.unique(key, return_inverse=True)
    acc = np.zeros((len(uniq), colors.shape[1])); np.add.at(acc, inv, colors * weights[:, None])
    ws = np.bincount(inv, weights=weights, minlength=len(uniq))
    gcol = acc / np.maximum(ws, 1e-12)[:, None]
    vidx = uniq // (int(key_extra.max()) + 1)
    first = np.full(len(uniq), -1, np.int64); first[inv[::-1]] = np.arange(len(inv))[::-1]
    return vidx, gcol, inv.reshape(-1, 3), first

def process_opaque(d, part):
    """Same as pack.py process() for the opaque kind; returns pos (three), tri, cls(detail), alb (V,3), mclass (V,)."""
    meta = json.loads(str(d["meta"])); mats = meta["mats"]
    co = d["co"].astype(np.float64); tri = d["tri"].astype(np.int64); mi = d["mi"]; oid = d["oid"]
    T = len(tri)
    light = d["light"].astype(np.float32).reshape(T, 3, 3); alb = d["alb"].astype(np.float32).reshape(T, 3, 3)
    emit = d["emit"].astype(np.float32).reshape(T, 3, 3)
    p = co[tri]; cr = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]); area = 0.5 * np.linalg.norm(cr, axis=1)
    nrm = cr / np.maximum(np.linalg.norm(cr, axis=1), 1e-12)[:, None]
    ok = area > 1e-7
    ok &= np.hypot(p[:, :, 0], p[:, :, 1]).max(1) < 1650.0
    names = [m["name"] for m in mats]
    mi = np.clip(mi, 0, len(mats) - 1)
    for i, m in enumerate(mats):
        if m["name"] in ("core_lakebed",): ok &= mi != i
    linked = np.array([m["base_linked"] and not m["attr"] for m in mats])
    grp = oid.astype(np.int64) * len(mats) + mi
    ug, ginv = np.unique(grp, return_inverse=True)
    acc = np.zeros((len(ug), 3)); np.add.at(acc, ginv, alb.mean(1) * area[:, None])
    gw = np.bincount(ginv, weights=area, minlength=len(ug))
    galb = acc / np.maximum(gw, 1e-12)[:, None]
    alb = np.where(linked[mi][:, None, None], galb[ginv][:, None, :], alb)
    fine = np.array([m["fine"] for m in mats])[mi]
    emit = np.where(fine[:, None, None], emit.mean(1, keepdims=True), emit)
    light = np.minimum(light, 60.0)
    color = alb * light + emit
    glass = np.array([m["glass"] for m in mats])[mi]
    mcls = np.array([mat_class(m, part) for m in mats])[mi]
    mcls = np.where(emit.max(axis=(1, 2)) > 0.05, 7, mcls)
    nb = np.clip(np.round((nrm + 1.0) * 2.0), 0, 4).astype(np.int64)
    nkey = nb[:, 0] * 25 + nb[:, 1] * 5 + nb[:, 2]
    fkey = np.where(fine, 125 + np.arange(T), nkey)
    _, fkey = np.unique(fkey, return_inverse=True)
    sel = ok & ~glass
    t = tri[sel]; c = color[sel].reshape(-1, 3); fk = np.repeat(fkey[sel], 3)
    a = alb[sel].reshape(-1, 3)
    w = np.repeat(area[sel], 3)
    ang = corner_angles(co, t)
    vidx, g, nt, first = weld(co, t, fk, np.concatenate([c, a], 1), w * ang + 1e-9)
    pos = to_three(co[vidx])
    pt = co[t]; el = np.linalg.norm(pt - np.roll(pt, 1, axis=1), axis=2).max(1)
    bright = color[sel].max(axis=(1, 2)) > 1.2
    cls = np.where(bright, 0, np.where(el < 0.22, 2, np.where(el < 0.6, 1, 0)))
    vcls = np.repeat(mcls[sel], 3)[first]
    return pos, nt, cls, g[:, 3:6], vcls

def chunk_orders(pos, tri, cls, cell=CELL):
    """Replays pack.py chunk_and_encode + encode_mesh ordering; yields (vertex ids in final order, ni)."""
    cen = pos[tri].mean(1)
    r = np.hypot(cen[:, 0], cen[:, 2])
    cx = np.floor(cen[:, 0] / cell).astype(np.int64); cz = np.floor(cen[:, 2] / cell).astype(np.int64)
    far = r > 420.0
    ang = (np.floor((np.arctan2(cen[:, 2], cen[:, 0]) + math.pi) / (math.pi / 4)).astype(np.int64)) % 8
    key = np.where(far, 100000 + ang, (cx + 500) * 1000 + (cz + 500))
    uk, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)
    small = cnt < 1500
    if small.any() and (~small).any():
        cents = np.array([cen[inv == i].mean(0) for i in range(len(uk))])
        big = np.nonzero(~small)[0]
        for i in np.nonzero(small)[0]:
            j = big[np.argmin(((cents[big] - cents[i]) ** 2).sum(1))]
            if np.linalg.norm(cents[j] - cents[i]) < 140: inv[inv == i] = j
    for i in np.unique(inv):
        t = tri[inv == i]; cl = cls[inv == i]
        used, ti = np.unique(t.ravel(), return_inverse=True)
        ti = ti.reshape(-1, 3); p = pos[used]
        cen2 = p[ti].mean(1); lo = p.min(0); ext = np.maximum(p.max(0) - lo, 1e-6)
        mc = morton(np.clip(((cen2 - lo) / ext.max() * 1023).astype(np.int64), 0, 1023))
        order = np.lexsort((mc, cl))
        flat = ti[order].ravel()
        _, firstu = np.unique(flat, return_index=True)
        vorder = flat[np.sort(firstu)]
        yield used[vorder], len(flat)

def zz_planes(cols):
    out = []
    for c in range(cols.shape[1]):
        dlt = np.diff(cols[:, c].astype(np.int16), prepend=0).astype(np.int8).astype(np.int16)
        out.append((((dlt << 1) ^ (dlt >> 15)) & 0xFF).astype(np.uint8).tobytes())
    return b"".join(out)

man = json.load(open(os.path.join(DATA, "manifest.json")))
tot = 0; stats = np.zeros(8, np.int64); info = {}
for part in dict.fromkeys(p["id"] for p in man["parts"]):
    entries = [p for p in man["parts"] if p["id"] == part]
    if not entries: continue
    d = np.load(os.path.join(NPZ, "part__%s.npz" % part))
    pos, tri, cls, alb, vcls = process_opaque(d, part)
    orders = list(chunk_orders(pos, tri, cls))
    meshes = [m for e in entries for m in e["meshes"]]
    opaque = [m for m in meshes if m["kind"] == "opaque"]
    blobs = []; good = 0; nvs = []
    for k, m in enumerate(opaque):
        vids, ni = orders[k] if k < len(orders) else (None, -1)
        if vids is None or len(vids) != m["nv"] or ni != m["ni"]:
            nvs.append(0); continue
        a8 = np.clip(np.round(np.sqrt(np.clip(alb[vids], 0, 1)) * 255), 0, 255).astype(np.uint8)
        c8 = vcls[vids].astype(np.uint8)
        stats += np.bincount(c8, minlength=8)
        blobs.append(zz_planes(np.concatenate([a8, c8[:, None]], 1))); nvs.append(int(m["nv"])); good += 1
    gz = gzip.compress(b"".join(blobs), 9); tot += len(gz)
    open(os.path.join(OUT, "aux_%s.bin" % part), "wb").write(gz)
    info[part] = dict(file="aux_%s.bin" % part, bytes=len(gz), nv=nvs)
    print("[aux] %-12s %d/%d opaque meshes match, %.2f MB gz" % (part, good, len(opaque), len(gz) / 1e6), flush=True)
json.dump(dict(parts=info, classes=NAMES), open(os.path.join(OUT, "aux.json"), "w"))
print("[aux] total %.2f MB; vertex classes:" % (tot / 1e6), {NAMES[i]: int(stats[i]) for i in range(8)})
