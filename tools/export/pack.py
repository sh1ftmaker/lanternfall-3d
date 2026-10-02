"""Stage 2 of the three.js port: turn the baked npz dumps into compact web assets.

  uv run --no-project --with numpy --with scipy python web_export/pack.py NPZ_DIR OUT_DIR

Writes OUT_DIR/manifest.json + *.bin (gzip of delta-filtered quantised buffers) + nav.bin + extras.bin.
Blender (x, y, z up) -> three.js (x, y up, z) = (x, z, -y).
"""
import sys, os, json, gzip, math, time, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, HERE)
import park_common as pc

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
T0 = time.time()
def log(*s): print("[pack %5.0fs]" % (time.time() - T0), *s, flush=True)

RANGE = 32.0          # RGBM range: hdr = rgb * a * RANGE
CELL = 64.0           # chunk size (m)
STEP0 = 1.0 / 512.0   # finest position step

# Surface classes for the viewer's procedural detail (fx/surface.js): chosen from the Blender material name.
import re
CLASSES = [  # (class id, regex on the material name without the part prefix); first match wins; emissive is decided first
    (0, r"plaster|stucco|canvas|cloth|fabric|banner|sail|paper|awning|tent|rope|plush|paint|sign|poster|lacquer|ribbon|carpet|felt|facade|glass|panel|canopy|dome|asphalt|road|floor|skin|pastel|drape|navy|pylon|concrete|beam|trim|lakebed"),
    (5, r"roof|shingle|slate|tile|thatch"),
    (2, r"boardwalk|wharf|deck|plank|siding"),
    (1, r"pave|paving|cobble|flagstone|plaza|prom|kerb|curb|sett|terrace|court|rosestone"),
    (3, r"stone|brick|wall|marble|coping|balustrade|rock|masonry|ashlar|pillar|column|plinth|granite|quay"),
    (4, r"grass|lawn|turf|hedge|leaf|leaves|topiary|boxwood|conifer|snow|soil|earth|gravel|sand|shrub|flower|blossom|pine|maple|palm|bark|trunk|moss|terrain|ground|rose|petal|ivy|bush|foliage|reed|lily"),
    (2, r"wood|timber|bench|barrel|crate|board|bamboo|mast|chest|tabletop|counter|hull|fence|door|shutter|spar"),
    (6, r"iron|brass|gold|chrome|steel|copper|bronze|metal|wire|rail|pipe|truss|silver|grate|gilt"),
]
def mat_class(m, part):
    if m["estr"] > 0 and max(m["emit"]) > 0: return 7
    n = m["name"]; pre = part.replace("-", "_") + "_"
    n = n[len(pre):] if n.startswith(pre) else n.split("_", 1)[-1]
    for c, rx in CLASSES:
        if re.search(rx, n): return c
    return 0

MOON = np.array(pc.MOON_DIR, np.float64); MOON /= np.linalg.norm(MOON)
MOON_SAMPLES = []      # per-part estimates of the moon's irradiance colour (for the manifest)

def to_three(p):
    return np.stack([p[..., 0], p[..., 2], -p[..., 1]], -1)

def rgbm(c):
    c = np.clip(c, 0.0, RANGE)
    m = np.maximum(c.max(1), 1e-6) / RANGE
    a = np.clip(np.ceil(m * 255.0), 1, 255)
    rgb = np.clip(np.round(c / (a[:, None] / 255.0 * RANGE) * 255.0), 0, 255)
    return np.concatenate([rgb, a[:, None]], 1).astype(np.uint8)

def morton(q):  # q: (n,3) ints < 1024
    def spread(v):
        v = v.astype(np.uint64) & 0x3FF
        v = (v | (v << 16)) & 0x30000FF; v = (v | (v << 8)) & 0x300F00F
        v = (v | (v << 4)) & 0x30C30C3; v = (v | (v << 2)) & 0x9249249
        return v
    return spread(q[:, 0]) | (spread(q[:, 1]) << 1) | (spread(q[:, 2]) << 2)

def encode_mesh(pos, col, tri, cls=None, aux=None):
    """pos (n,3) float three-space, col (n,4) u8, tri (t,3) int, cls (t,) detail class 0/1/2. Returns (bytes, meta).
    Triangles are ordered base -> mid detail -> fine detail so the viewer can shorten the draw range with distance."""
    cen = pos[tri].mean(1); lo = pos.min(0); ext = np.maximum(pos.max(0) - lo, 1e-6)
    mc = morton(np.clip(((cen - lo) / ext.max() * 1023).astype(np.int64), 0, 1023))
    if cls is None: cls = np.zeros(len(tri), np.int64)
    order = np.lexsort((mc, cls))
    tri = tri[order]; n0 = int((cls == 0).sum()) * 3; n1 = int((cls <= 1).sum()) * 3
    flat = tri.ravel()
    _, first = np.unique(flat, return_index=True)
    vorder = flat[np.sort(first)]                       # vertices in order of first use
    remap = np.empty(len(pos), np.int64); remap[vorder] = np.arange(len(vorder))
    pos = pos[vorder]; col = col[vorder]; flat = remap[flat]
    if aux is not None: aux = aux[vorder]
    k = 0
    while (ext.max() / (STEP0 * 2 ** k)) > 65000: k += 1
    step = STEP0 * 2 ** k
    origin = np.floor(lo / step) * step
    q = np.clip(np.round((pos - origin) / step), 0, 65535).astype(np.int64)
    d = np.diff(q, axis=0, prepend=0)                   # deltas wrapped to int16, zigzag -> u16
    d = ((d + 32768) % 65536) - 32768
    zz = ((d << 1) ^ (d >> 63)) & 0xFFFF
    planes = []
    for c in range(3):
        planes.append((zz[:, c] & 0xFF).astype(np.uint8)); planes.append((zz[:, c] >> 8).astype(np.uint8))
    cd = np.diff(col.astype(np.int16), axis=0, prepend=0).astype(np.int8)
    czz = ((cd.astype(np.int16) << 1) ^ (cd.astype(np.int16) >> 15)).astype(np.uint8)
    for c in range(4): planes.append(czz[:, c])
    if aux is not None:                                 # albedo rgb (sqrt-encoded) + surface class, same coding as the colours
        ad = np.diff(aux.astype(np.int16), axis=0, prepend=0).astype(np.int8)
        azz = ((ad.astype(np.int16) << 1) ^ (ad.astype(np.int16) >> 15)).astype(np.uint8)
        for c in range(4): planes.append(azz[:, c])
    # indices: code = next - idx  (0 => a new vertex)
    nxt = np.maximum.accumulate(flat); prev_max = np.concatenate([[-1], nxt[:-1]])
    code = (prev_max + 1 - flat).astype(np.uint32)
    for b in range(4): planes.append(((code >> (8 * b)) & 0xFF).astype(np.uint8))
    blob = b"".join(p.tobytes() for p in planes)
    bb = [float(v) for v in (origin + q.min(0) * step)] + [float(v) for v in (origin + q.max(0) * step)]
    return blob, dict(nv=int(len(pos)), ni=int(len(flat)), n0=n0, n1=n1, aux=int(aux is not None), origin=[float(v) for v in origin], step=float(step), bbox=bb)

def weld(co, tri, key_extra, colors, weights):
    """Group corners by (vertex, key_extra); average colours per group. Returns new pos idx, per-group colour, tri."""
    nv = co.shape[0]
    key = tri.ravel().astype(np.int64) * (int(key_extra.max()) + 1) + key_extra
    uniq, inv = np.unique(key, return_inverse=True)
    w = weights
    acc = np.zeros((len(uniq), colors.shape[1])); np.add.at(acc, inv, colors * w[:, None])
    ws = np.bincount(inv, weights=w, minlength=len(uniq))
    gcol = acc / np.maximum(ws, 1e-12)[:, None]
    vidx = uniq // (int(key_extra.max()) + 1)
    return vidx, gcol, inv.reshape(-1, 3)

def process(d, part, glass_ok=True):
    """Bake arrays -> per-kind welded meshes. Returns a list of dicts (Blender-space positions, HDR colours for opaque
    meshes / final u8 colours for glass, triangles, detail class and per-triangle labels used by hsr.py)."""
    meta = json.loads(str(d["meta"])); mats = meta["mats"]
    co = d["co"].astype(np.float64); tri = d["tri"].astype(np.int64); mi = d["mi"]; oid = d["oid"]
    T = len(tri)
    light = d["light"].astype(np.float32).reshape(T, 3, 3); alb = d["alb"].astype(np.float32).reshape(T, 3, 3)
    emit = d["emit"].astype(np.float32).reshape(T, 3, 3)
    p = co[tri]; cr = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]); area = 0.5 * np.linalg.norm(cr, axis=1)
    nrm = cr / np.maximum(np.linalg.norm(cr, axis=1), 1e-12)[:, None]
    ok = area > 1e-7
    ok &= np.hypot(p[:, :, 0], p[:, :, 1]).max(1) < 1650.0          # drop the far moon sphere (the sky shader draws the moon)
    names = [m["name"] for m in mats]
    mi = np.clip(mi, 0, len(mats) - 1)
    for i, m in enumerate(mats):
        if m["name"] in ("core_lakebed",): ok &= mi != i
    # --- albedo: average procedural base colours per (object, material)
    linked = np.array([m["base_linked"] and not m["attr"] for m in mats])
    grp = oid.astype(np.int64) * len(mats) + mi
    ug, ginv = np.unique(grp, return_inverse=True)
    acc = np.zeros((len(ug), 3)); np.add.at(acc, ginv, alb.mean(1) * area[:, None])
    gw = np.bincount(ginv, weights=area, minlength=len(ug))
    galb = acc / np.maximum(gw, 1e-12)[:, None]
    use_avg = linked[mi]
    alb = np.where(use_avg[:, None, None], galb[ginv][:, None, :], alb)
    # --- emission: mosaic for fine patterns
    fine = np.array([m["fine"] for m in mats])[mi]
    emit = np.where(fine[:, None, None], emit.mean(1, keepdims=True), emit)
    light = np.minimum(light, 60.0)
    # moonlight is added per pixel in the viewer (with its shadow map), so the baked colour uses the no-moon bake
    if "lightnm" in d.files:
        lightnm = np.minimum(d["lightnm"].astype(np.float32).reshape(T, 3, 3), 60.0)
        ndl = nrm @ MOON; lit = (ndl > 0.35) & ok & (light.mean(axis=(1, 2)) < 0.4)
        if lit.sum() > 500:
            dm = (light - lightnm).mean(1)[lit] / ndl[lit, None]
            MOON_SAMPLES.append((np.percentile(dm, 85, axis=0), int(lit.sum())))
    else:
        lightnm = light
    color = alb * lightnm + emit                                 # (T,3,3) linear HDR, without the moon
    glass = np.array([m["glass"] for m in mats])[mi] & glass_ok
    alpha = np.array([m["alpha"] for m in mats])[mi]
    if glass.any():
        ecol = np.array([np.array(m["emit"]) * min(m["estr"], 1.5) for m in mats])[mi]
        gcol = np.clip(ecol[:, None, :] + emit * 0.0 + 0.5 * alb * light + np.array([0.012, 0.016, 0.026]), 0, 1)
        color = np.where(glass[:, None, None], gcol, color)
    # per-triangle labels for hidden-surface removal / diagnostics
    memis = np.array([m["estr"] > 0 and max(m["emit"]) > 0 for m in mats])[mi] | (emit.max(axis=(1, 2)) > 0.05)
    out = []
    # smoothing-group key: normal bucket, or unique per face for mosaic faces
    nb = np.clip(np.round((nrm + 1.0) * 2.0), 0, 4).astype(np.int64)
    nkey = nb[:, 0] * 25 + nb[:, 1] * 5 + nb[:, 2]
    fkey = np.where(fine, 125 + np.arange(T), nkey)
    _, fkey = np.unique(fkey, return_inverse=True)
    mcls_mat = np.array([mat_class(m, part) for m in mats], np.int64)
    for kind, sel in (("opaque", ok & ~glass), ("glass", ok & glass)):
        if not sel.any(): continue
        t = tri[sel]; c = color[sel].reshape(-1, 3); fk = np.repeat(fkey[sel], 3)
        if kind == "opaque":                             # surface class is part of the vertex identity (flat per triangle)
            tcl = np.where(memis[sel] | (color[sel].max(axis=(1, 2)) > 1.2), 7, mcls_mat[mi[sel]])
            fk = fk * 8 + np.repeat(tcl, 3); _, fk = np.unique(fk, return_inverse=True)
            c = np.concatenate([c, alb[sel].reshape(-1, 3), lightnm[sel].reshape(-1, 3), emit[sel].reshape(-1, 3)], 1)
        if kind == "glass":
            aq = np.clip(np.round(alpha[sel] * 20), 2, 20).astype(np.int64)     # opacity bucket in the key
            fk = fk * 32 + np.repeat(aq, 3)
            _, fk = np.unique(fk, return_inverse=True)
        w = np.repeat(area[sel], 3)
        ang = corner_angles(co, t)
        vidx, gcol, nt = weld(co, t, fk, c, w * ang + 1e-9)
        pt = co[t]; el = np.linalg.norm(pt - np.roll(pt, 1, axis=1), axis=2).max(1)
        bright = color[sel].max(axis=(1, 2)) > 1.2
        cls = np.where(bright | (kind == "glass"), 0, np.where(el < 0.22, 2, np.where(el < 0.6, 1, 0)))
        r = dict(kind=kind, pos=co[vidx], tri=nt, cls=cls, mat=mi[sel].astype(np.int32), names=names, oid=oid[sel].astype(np.int64),
                 emis=memis[sel] | bright, part=part)
        if kind == "glass":
            # per-vertex opacity: recover from first corner using it
            first = np.zeros(len(vidx), np.int64); first[nt.ravel()] = np.arange(nt.size)
            op = np.repeat(alpha[sel], 3)[first]
            r["col"] = np.concatenate([np.clip(np.round(np.sqrt(np.clip(gcol, 0, 1)) * 255), 0, 255), np.clip(np.round(op * 255), 0, 255)[:, None]], 1).astype(np.uint8)
        else:
            # vertex colour = albedo * smoothed baked light + emission (mosaic faces keep their own light)
            Ls = smooth_light(gcol[:, 6:9], nt[~fine[sel]]) if (~fine[sel]).any() else gcol[:, 6:9]
            r["hdr"] = gcol[:, 3:6] * Ls + gcol[:, 9:12]
            first = np.zeros(len(vidx), np.int64); first[nt.ravel()] = np.arange(nt.size)
            r["aux"] = np.concatenate([gcol[:, 3:6], np.repeat(tcl, 3)[first][:, None].astype(np.float64)], 1)   # albedo rgb, class
        out.append(r)
    return out

def finish(r):
    """dict from process() (after hsr) -> (kind, three-space pos, u8 colour, tri, cls)."""
    col = r["col"] if r["kind"] == "glass" else rgbm(r["hdr"])
    aux = None
    if r["kind"] != "glass" and "aux" in r:
        a = r["aux"]
        aux = np.concatenate([np.clip(np.round(np.sqrt(np.clip(a[:, :3], 0, 1)) * 255), 0, 255), np.clip(np.round(a[:, 3:4]), 0, 7)], 1).astype(np.uint8)
    return r["kind"], to_three(r["pos"]), col, r["tri"], r["cls"], aux

def smooth_light(L, tri, iters=4, lam=0.6):
    """Laplacian smoothing of per-vertex baked light over mesh edges. The bake samples light at single points, so a
    vertex that happens to sit in the thin shadow of a lantern string or a post darkens whole triangles (dark blotches
    on lamp-lit floors). Welded vertices are already split at hard edges and class changes, so this stays on a surface."""
    e = np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]]); e = np.unique(np.sort(e, 1), axis=0)
    deg = np.bincount(e.ravel(), minlength=len(L)).astype(np.float64)
    for _ in range(iters):
        acc = np.zeros_like(L); np.add.at(acc, e[:, 0], L[e[:, 1]]); np.add.at(acc, e[:, 1], L[e[:, 0]])
        L = np.where(deg[:, None] > 0, (1 - lam) * L + lam * acc / np.maximum(deg, 1)[:, None], L)
    return L

def corner_angles(co, t):
    p = co[t]; a = []
    for i in range(3):
        u = p[:, (i + 1) % 3] - p[:, i]; v = p[:, (i + 2) % 3] - p[:, i]
        cs = (u * v).sum(1) / np.maximum(np.linalg.norm(u, axis=1) * np.linalg.norm(v, axis=1), 1e-12)
        a.append(np.arccos(np.clip(cs, -1, 1)))
    return np.stack(a, 1).ravel()

DUMP = []     # (P blender (t,3,3) f32, labels) of every emitted triangle, when --dump-tris is given
def chunk_and_encode(kind, pos, col, tri, cls, cell=CELL, lab=None, aux=None):
    cen = pos[tri].mean(1)
    r = np.hypot(cen[:, 0], cen[:, 2])
    cx = np.floor(cen[:, 0] / cell).astype(np.int64); cz = np.floor(cen[:, 2] / cell).astype(np.int64)
    far = r > 420.0
    ang = (np.floor((np.arctan2(cen[:, 2], cen[:, 0]) + math.pi) / (math.pi / 4)).astype(np.int64)) % 8
    key = np.where(far, 100000 + ang, (cx + 500) * 1000 + (cz + 500))
    # merge tiny cells into the biggest neighbour-less bucket of the same part
    uk, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)
    small = cnt < 1500
    if small.any() and (~small).any():
        cents = np.array([cen[inv == i].mean(0) for i in range(len(uk))])
        big = np.nonzero(~small)[0]
        for i in np.nonzero(small)[0]:
            j = big[np.argmin(((cents[big] - cents[i]) ** 2).sum(1))]
            if np.linalg.norm(cents[j] - cents[i]) < 140: inv[inv == i] = j
    res = []
    for i in np.unique(inv):
        t = tri[inv == i]
        used, ti = np.unique(t.ravel(), return_inverse=True)
        blob, m = encode_mesh(pos[used], col[used], ti.reshape(-1, 3), cls[inv == i], None if aux is None else aux[used])
        m["kind"] = kind; res.append((blob, m))
        if lab is not None:
            o = np.array(m["origin"]); s = m["step"]
            dq = o + np.round((pos[used] - o) / s) * s                     # what the viewer reconstructs
            P = dq[ti.reshape(-1, 3)]; P = np.stack([P[..., 0], -P[..., 2], P[..., 1]], -1).astype(np.float32)
            DUMP.append((P, {k: v[inv == i] for k, v in lab.items()}))
    return res

manifest = dict(range=RANGE, parts=[], lake=[[float(x), float(y)] for x, y in pc.LAKE], shore=[[float(x), float(y)] for x, y in pc.SHORE],
                water_z=pc.Z_WATER, rail=dict(a=pc.RAIL_A, b=pc.RAIL_B, top=pc.RAIL_TOP, length=pc.RAIL_LENGTH),
                lands=[dict(id=k, name=v["name"], hex=v["hex"], theme=v["theme"], center=[float(v["center"][0]), float(v["center"][1])], phi=float(v["phi"])) for k, v in pc.LANDS.items()])
def opt(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default
DUMP_PATH = opt("--dump-tris")
world_tris = []
tot_t = tot_v = tot_b = 0
ORDER = ["core", "transit"] + pc.LAND_IDS
if opt("--parts"): ORDER = [p for p in ORDER if p in opt("--parts").split(",")]     # iterate on a subset
PARTS = {}
import par                     # (build.py) parts are processed / encoded in forked worker processes, results in order
def _process(part):
    f = os.path.join(SRC, "part__%s.npz" % part)
    if not os.path.exists(f): return None, []
    n = len(MOON_SAMPLES); r = process(np.load(f), part)
    return r, MOON_SAMPLES[n:]
# (build.py) --keep p,q: take these parts exactly as the last pack into OUT left them (its .bin files, manifest
# entries, nav triangles and moon samples, recorded under --state DIR) instead of processing them again
STATE = opt("--state"); KEEP = [p for p in (opt("--keep") or "").split(",") if p in ORDER]
if KEEP and not STATE: sys.exit("--keep needs --state")
MOONP = {}
todo = [p for p in ORDER if p not in KEEP]
for part, (r, ms) in zip(todo, par.pmap(_process, [(p,) for p in todo])):
    if r is None: log("missing", part); continue
    PARTS[part] = r; MOONP[part] = ms
    log("processed", part, sum(len(r["tri"]) for r in PARTS[part]), "tris")
KEPT = {}
for part in KEEP:
    rec = json.load(open(os.path.join(STATE, part + ".json"))); t = np.load(os.path.join(STATE, part + "_tris.npz"))
    for f in rec["files"]: assert os.path.getsize(os.path.join(OUT, f["file"])) == f["bytes"], "kept file changed: " + f["file"]
    KEPT[part] = (rec, [(t["P%d" % i], t["N%d" % i]) for i in range(len(t.files) // 2)])
    MOONP[part] = [(np.array(c), n) for c, n in rec["moon"]]
    log("kept", part, "as packed before")
for part in ORDER: MOON_SAMPLES.extend(MOONP.get(part, []))
if "--no-hsr" not in sys.argv:
    import hsr
    hsr.run(PARTS, log)
MATNAMES = {}
def write_same(path, data):
    """(build.py) leave a file that already holds exactly these bytes alone (browsers keep unchanged files cached)"""
    if os.path.exists(path) and os.path.getsize(path) == len(data) and open(path, "rb").read() == data: return
    open(path, "wb").write(data)
def _encode(pi, part):
    meshes = []; wt = []
    for r in PARTS[part]:
        kind, pos, col, tri, cls, aux = finish(r)
        if kind == "opaque": 
            P = r["pos"][tri]; N = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
            wt.append((P.astype(np.float32), (N / np.maximum(np.linalg.norm(N, axis=1), 1e-12)[:, None]).astype(np.float32)))
        lab = None
        if DUMP_PATH:
            mids = np.array([MATNAMES.setdefault(n, len(MATNAMES)) for n in r["names"]])
            lab = dict(mat=mids[r["mat"]].astype(np.int32), oid=(pi * 100000 + r["oid"]).astype(np.int32), emis=r["emis"],
                       part=np.full(len(tri), pi, np.int8), glass=np.full(len(tri), kind == "glass"))
        meshes += chunk_and_encode(kind, pos, col, tri, cls, lab=lab, aux=aux)
    # split into files of at most ~11 MB compressed
    files = []; cur = []; cur_raw = 0
    for blob, m in meshes:
        if cur and cur_raw + len(blob) > 40_000_000: files.append(cur); cur = []; cur_raw = 0
        cur.append((blob, m)); cur_raw += len(blob)
    if cur: files.append(cur)
    out = []
    for fi, group in enumerate(files):
        raw = b"".join(b for b, _ in group)
        out.append((fi, len(files), [m for _, m in group], len(raw), gzip.compress(raw, 9, mtime=0)))
    return out, wt
enc = [_encode(pi, part) for pi, part in enumerate(PARTS)] if DUMP_PATH else par.pmap(_encode, list(enumerate(PARTS)))
ENC = dict(zip(list(PARTS), enc))
if STATE: os.makedirs(STATE, exist_ok=True)
for part in [p for p in ORDER if p in ENC or p in KEPT]:
    if part in KEPT:
        rec, wt = KEPT[part]; world_tris += wt
        for f in rec["files"]:
            manifest["parts"].append(f); nt = sum(m["ni"] for m in f["meshes"]) // 3; nv = sum(m["nv"] for m in f["meshes"])
            tot_t += nt; tot_v += nv; tot_b += f["bytes"]
        continue
    out, wt = ENC[part]
    world_tris += wt; files = []
    for fi, nfiles, group, raw_len, gz in out:
        name = "%s%s.bin" % (part, "" if nfiles == 1 else "_%d" % fi)
        write_same(os.path.join(OUT, name), gz)
        nt = sum(m["ni"] for m in group) // 3; nv = sum(m["nv"] for m in group)
        tot_t += nt; tot_v += nv; tot_b += len(gz)
        manifest["parts"].append(dict(id=part, file=name, bytes=len(gz), raw=raw_len, meshes=group)); files.append(manifest["parts"][-1])
        log("%-12s %-16s %3d meshes %8d tris %8d verts  raw %5.1f MB -> gz %5.1f MB" % (part, name, len(group), nt, nv, raw_len / 1e6, len(gz) / 1e6))
    if STATE:
        json.dump(dict(files=files, moon=[[[float(x) for x in c], int(n)] for c, n in MOONP.get(part, [])], hsr="--no-hsr" not in sys.argv),
                  open(os.path.join(STATE, part + ".json"), "w"))
        np.savez(os.path.join(STATE, part + "_tris.npz"), **{k: v for i, (P, N) in enumerate(wt) for k, v in (("P%d" % i, P), ("N%d" % i, N))})
    PARTS[part] = None
if DUMP_PATH:
    np.savez(DUMP_PATH, P=np.concatenate([p for p, _ in DUMP]), names=np.array(list(MATNAMES)), parts=np.array(list(PARTS)),
             **{k: np.concatenate([l[k] for _, l in DUMP]) for k in DUMP[0][1]})
    log("dumped %d emitted triangles to %s" % (sum(len(p) for p, _ in DUMP), DUMP_PATH))
log("TOTAL %d tris, %d verts, %.1f MB compressed" % (tot_t, tot_v, tot_b / 1e6))

# ───────────── trains (movable prototypes) ─────────────
def nearest_s(loc, chord):
    best = (1e9, 0.0)
    for i in range(int(pc.RAIL_LENGTH / 0.05)):
        s = i * 0.05
        if chord:
            xb, yb, _, _ = pc.rail_at(s - 3.0); xf, yf, _, _ = pc.rail_at(s + 3.0); x, y = (xb + xf) / 2, (yb + yf) / 2
        else:
            x, y, _, _ = pc.rail_at(s)
        dd = (x - loc[0]) ** 2 + (y - loc[1]) ** 2
        if dd < best[0]: best = (dd, s)
    return best[1]

extras = []; ex_meta = dict(trains=[], train_meshes={}, forest=[])
def add_extra(arr):
    b = np.ascontiguousarray(arr).tobytes(); off = sum(len(x) for x in extras); extras.append(b)
    pad = (-len(b)) % 4
    if pad: extras.append(b"\0" * pad)
    return [off, len(b)]

train_blobs = []; 
for f in sorted(glob.glob(os.path.join(SRC, "train__*.npz"))):
    d = np.load(f); meta = json.loads(str(d["meta"])); mname = os.path.basename(f)[7:-4]
    ms = []
    for kind, pos, col, tri, cls, aux in map(finish, process(d, "train", glass_ok=False)):
        blob, m = encode_mesh(pos, col, tri, None, aux); m["kind"] = kind; train_blobs.append(blob); ms.append(m)
    ex_meta["train_meshes"][mname] = ms
    for ins in meta["extra"]["instances"]:
        chord = "_car" in ins["name"]
        s = nearest_s(ins["loc"], chord)
        if chord:
            xb, yb, _, _ = pc.rail_at(s - 3.0); xf, yf, _, _ = pc.rail_at(s + 3.0); ang = math.atan2(yf - yb, xf - xb)
        else:
            _, _, tx, ty = pc.rail_at(s); ang = math.atan2(ty, tx)
        dr = (ins["rz"] - ang + math.pi) % (2 * math.pi) - math.pi
        ex_meta["trains"].append(dict(name=ins["name"], mesh=mname, s=s, chord=chord, flip=abs(dr) > 1.5, z=ins["loc"][2]))
if train_blobs:
    raw = b"".join(train_blobs); gz = gzip.compress(raw, 9, mtime=0); write_same(os.path.join(OUT, "trains.bin"), gz)
    ex_meta["train_file"] = dict(file="trains.bin", bytes=len(gz), raw=len(raw))
    log("trains: %d instances, %d prototype meshes, %.2f MB" % (len(ex_meta["trains"]), len(ex_meta["train_meshes"]), len(gz) / 1e6))

# ───────────── lanterns + forest (float32 blobs) ─────────────
f = os.path.join(SRC, "lanterns.npz")
if os.path.exists(f):
    d = np.load(f); Pb = d["pos"].astype(np.float32); Cb = d["col"].astype(np.float32); Sb = d["strength"].astype(np.float32); Zb = d["size"].astype(np.float32)
    for k in (6, 5, 4, 3, 2):       # the bake groups verts by ring; merge rings of the same lantern
        if len(Pb) % k == 0:
            G = Pb.reshape(-1, k, 3)
            if (np.linalg.norm(G - G.mean(1, keepdims=True), axis=2).max() < 0.5) and np.allclose(Sb.reshape(-1, k), Sb.reshape(-1, k)[:, :1]):
                ext = (G.max(1) - G.min(1)).max(1) + Zb.reshape(-1, k).max(1) * 0.5
                Pb = G.mean(1); Cb = Cb.reshape(-1, k, 3)[:, 0]; Sb = Sb.reshape(-1, k)[:, 0]; Zb = ext; break
    P = to_three(Pb)
    arr = np.concatenate([P, Cb, Sb[:, None], Zb[:, None]], 1).astype(np.float32)
    ex_meta["lanterns"] = dict(count=int(len(P)), stride=8, span=add_extra(arr))
    log("lanterns:", len(P))
f = os.path.join(SRC, "forest.npz")
if os.path.exists(f):
    d = np.load(f); keys = sorted({k.split("__")[0] for k in d.files})
    for k in keys:
        g = lambda n: d[k + "__" + n]
        sv = to_three(g("sv").astype(np.float32)); st = g("st").astype(np.uint32); smi = g("smi"); mc = g("mcols")
        # un-index per material colour: colour per vertex via triangle material (duplicate verts)
        vp = sv[st].reshape(-1, 3); vc = np.repeat(mc[np.clip(smi, 0, len(mc) - 1)], 3, 0)
        P = g("P").astype(np.float32); inst = np.concatenate([to_three(P), g("rz")[:, None], g("sc")[:, None]], 1).astype(np.float32)
        ex_meta["forest"].append(dict(name=k, nv=int(len(vp)), count=int(len(inst)), pos=add_extra(vp.astype(np.float32)), col=add_extra(vc.astype(np.float32)), inst=add_extra(inst)))
    log("forest:", [(e["name"], e["count"], e["nv"] // 3) for e in ex_meta["forest"]])
raw = b"".join(extras); gz = gzip.compress(raw, 9, mtime=0); write_same(os.path.join(OUT, "extras.bin"), gz)
ex_meta["file"] = dict(file="extras.bin", bytes=len(gz), raw=len(raw)); manifest["extras"] = ex_meta

# ───────────── walk-mode navigation grid ─────────────
def fill_nav_holes(hA, A, occ, inpark, NB, passes=2):
    """(crowd-geo) Walk-grid cells with no floor sample at all, inside ground walkable on (nearly) all sides at one
    height, and with nothing in the column from 0.15 m to 1.95 m above that floor: seams between two pavings (the grass
    verge between the Shore Promenade's kerb and the lands, a downward-facing strip), 0.5 m cracks the sampling missed.
    They get the mean height of their walkable neighbours. Posts, bollards, rails and anything else standing there keep
    the cell blocked, and a cell needs 6 of its 8 neighbours walkable within 0.2 m of each other."""
    Hh, Ww = hA.shape; total = 0
    for _ in range(passes):
        P = np.pad(hA.astype(np.int64), 1); K = np.pad(A, 1, constant_values=9999)
        nbh = np.stack([P[1 + dy:Hh + 1 + dy, 1 + dx:Ww + 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx], -1)
        nbk = np.stack([K[1 + dy:Hh + 1 + dy, 1 + dx:Ww + 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx], -1)
        valid = nbh > 0
        hi = np.where(valid, nbh, 0).max(-1); lo = np.where(valid, nbh, 1 << 30).min(-1)
        cand = (hA == 0) & inpark & (valid.sum(-1) >= 6) & (hi - lo <= 20)
        J, I = np.nonzero(cand)
        if not len(J): break
        kk = np.where(nbk[J, I] < 9999, nbk[J, I], 0).max(-1)
        ok = np.ones(len(J), bool)
        for d in range(1, 14):
            ok &= occ[J, I, np.clip(kk + d, 0, NB - 1)] == 0
        J, I, kk = J[ok], I[ok], kk[ok]
        if not len(J): break
        v = valid[J, I]
        hA[J, I] = np.round(np.where(v, nbh[J, I], 0).sum(-1) / v.sum(-1)).astype(hA.dtype); A[J, I] = kk
        total += len(J)
    return hA, total


def build_nav():
    from scipy import ndimage
    X0, X1, Y0, Y1, CS = -275.0, 345.0, -225.0, 225.0, 0.5
    Z0, ZB, NB = -1.5, 0.15, 120
    W = int((X1 - X0) / CS); H = int((Y1 - Y0) / CS)
    anyv = np.zeros((H * W, NB), np.uint8); flo = np.zeros((H * W, NB), np.uint8)
    rng = np.random.default_rng(7)
    for P, N in world_tris:
        zmin = P[:, :, 2].min(1); zmax = P[:, :, 2].max(1)
        inside = (P[:, :, 0].max(1) > X0) & (P[:, :, 0].min(1) < X1) & (P[:, :, 1].max(1) > Y0) & (P[:, :, 1].min(1) < Y1) & (zmax > Z0) & (zmin < Z0 + NB * ZB)
        P = P[inside]; N = N[inside]
        area = 0.5 * np.linalg.norm(np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]), axis=1)
        n = np.minimum(np.ceil(area / 0.012).astype(np.int64) + 4, 4000)
        for s in range(0, len(P), 200000):
            Pb = P[s:s + 200000]; nb = n[s:s + 200000]; nz = N[s:s + 200000, 2]; zc = Pb.mean(1)[:, 2]
            # floors face up (bake.py orients faces to their open side), so slab undersides below ground are not floors;
            # ground-level slabs whose winding ended up facing down (Brinewatch's cobbles) still count
            # (crowd-geo) from -0.03 m (was 0.02): the terrain's grass at z 0, where the bake turned it face-down under the
            # edges of pavings (the verge at the shore kerb, the gate forecourt's corners), left floorless seams in the grid
            up = (nz > 0.72) | ((nz < -0.72) & (zc > -0.03) & (zc < 0.35))
            idx = np.repeat(np.arange(len(Pb)), nb)
            u = rng.random(len(idx), dtype=np.float32); v = rng.random(len(idx), dtype=np.float32)
            fl = u + v > 1; u = np.where(fl, 1 - u, u); v = np.where(fl, 1 - v, v)
            pts = Pb[idx, 0] + (Pb[idx, 1] - Pb[idx, 0]) * u[:, None] + (Pb[idx, 2] - Pb[idx, 0]) * v[:, None]
            ix = np.floor((pts[:, 0] - X0) / CS).astype(np.int64); iy = np.floor((pts[:, 1] - Y0) / CS).astype(np.int64)
            zf = (pts[:, 2] - Z0) / ZB; iz = np.floor(zf).astype(np.int64)
            okp = (ix >= 0) & (ix < W) & (iy >= 0) & (iy < H) & (iz >= 0) & (iz < NB)
            c = (iy * W + ix)[okp]; iz = iz[okp]; sub = (np.clip((zf[okp] - iz) * 254, 0, 254) + 1).astype(np.uint8)
            anyv[c, iz] = 1
            fu = up[idx][okp]
            np.maximum.at(flo, (c[fu], iz[fu]), sub[fu])
    log("nav: sampled; any=%d floor=%d voxels" % (int(anyv.sum()), int((flo > 0).sum())))
    blocked = np.zeros_like(anyv)
    for j in range(3, 13):
        blocked[:, :NB - j] |= anyv[:, j:]
    stand = (flo > 0) & (blocked == 0)
    gx = X0 + (np.arange(W) + 0.5) * CS; gy = Y0 + (np.arange(H) + 0.5) * CS
    GX, GY = np.meshgrid(gx, gy)
    inpark = ((GX / (pc.PARK_A - 1.5)) ** 2 + (GY / (pc.PARK_B - 1.5)) ** 2 < 1.0) | ((GX > 240) & (GX < 338) & (np.abs(GY) < 34))
    stand &= inpark.reshape(-1)[:, None]
    top = stand.copy(); top[:, :-1] &= ~stand[:, 1:]                 # top of each standable run
    vol = top.reshape(H, W, NB)
    dil = vol.copy(); dil[:, :, 1:] |= vol[:, :, :-1]; dil[:, :, :-1] |= vol[:, :, 1:]
    lab, nlab = ndimage.label(dil, structure=np.ones((3, 3, 3), np.uint8))
    # seed: paved East Gate plaza
    sx, sy = int((300 - X0) / CS), int((0 - Y0) / CS)
    seeds = lab[sy - 6:sy + 6, sx - 6:sx + 6, :]; seeds = seeds[seeds > 0]
    main = np.bincount(seeds).argmax()
    reach = (lab == main) & vol
    log("nav: %d components, main reaches %d cells" % (nlab, int(reach.any(2).sum())))
    kidx = np.arange(NB)[None, None, :]
    A = np.where(reach, kidx, 9999).min(2)
    B = np.where(reach & (kidx >= (A[:, :, None] + 13)), kidx, 9999).min(2)
    sub = flo.reshape(H, W, NB)
    def height(K):
        has = K < 9999; Kc = np.where(has, K, 0)
        s = np.take_along_axis(sub, Kc[:, :, None], 2)[:, :, 0].astype(np.float32)
        z = Z0 + (Kc + (s - 1) / 254.0) * ZB
        return np.where(has, np.round((z + 2.0) * 100).astype(np.int64) + 1, 0).astype(np.uint16)
    hA, hB = height(A), height(B)
    hA, nfill = fill_nav_holes(hA, A, anyv.reshape(H, W, NB), inpark, NB)
    log("nav: filled %d floorless seam cells" % nfill)
    planes = []
    for h in (hA, hB):
        dlt = np.diff(h.astype(np.int32), axis=1, prepend=0).astype(np.int32) & 0xFFFF
        planes.append((dlt & 0xFF).astype(np.uint8).tobytes()); planes.append((dlt >> 8).astype(np.uint8).tobytes())
    gz = gzip.compress(b"".join(planes), 9, mtime=0); write_same(os.path.join(OUT, "nav.bin"), gz)
    manifest["nav"] = dict(file="nav.bin", bytes=len(gz), w=W, h=H, x0=X0, y0=Y0, cell=CS, levels=2)
    log("nav: %dx%d grid, levelA cells %d, levelB cells %d, %.2f MB" % (W, H, int((hA > 0).sum()), int((hB > 0).sum()), len(gz) / 1e6))
    return hA, hB

if "--no-nav" not in sys.argv:
    hA, hB = build_nav()
    np.save(opt("--nav-debug", os.path.join(SRC, "nav_debug.npy")), np.stack([hA, hB]))
# moonlight for the viewer: direction (three.js axes) and the diffuse light it adds to a surface facing it
if MOON_SAMPLES:
    wsum = sum(n for _, n in MOON_SAMPLES); mcol = sum(c * n for c, n in MOON_SAMPLES) / wsum
else:
    mcol = np.array([0.62, 0.74, 1.0]) * 0.55 / math.pi
manifest["moon"] = dict(dir=[float(MOON[0]), float(MOON[2]), float(-MOON[1])], col=[float(v) for v in mcol], baked=not MOON_SAMPLES)
log("moon light colour", [round(float(v), 4) for v in mcol], "(analytic %s)" % [round(v * 0.55 / math.pi, 4) for v in (0.62, 0.74, 1.0)])
# format = what the viewer must understand (app.js DATA_FORMAT); build = content id used to cache-bust the data files
import hashlib
_h = hashlib.sha1()
for _p in manifest["parts"]: _h.update(open(os.path.join(OUT, _p["file"]), "rb").read())
manifest["format"] = 2; manifest["build"] = _h.hexdigest()[:10]
json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), separators=(",", ":"))
log("manifest written; total download %.1f MB" % (sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)) / 1e6))
