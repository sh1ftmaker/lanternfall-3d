"""Ground maps, stage 1 (Blender + Cycles): contact occlusion and lamp-shadow visibility on a top-down grid over the
walkable ground (the skill's bake-runtime.md "Ground maps"). Per-vertex light cannot hold the dark rim where a bench
meets the paving or the thin shadow of a lamp post (ground vertices are metres apart); these maps can.

  blender -b -P web_export/ground.py -- --npz NPZ_DIR --scene-blend scene.blend [--texel 0.125] [--samples 64]

Covers only 16 m tiles (128 texels of 12.5 cm) that hold walk-grid cells (NPZ_DIR/nav_debug.npy, written by pack.py),
and in them only texels within 1 m of a walkable cell. Per texel, on a small quad 5 cm above the floor (the floor found
by a ray straight down from the walk-grid height against the baked geometry):
  ao  Cycles AO, rays of 1 m (contact occlusion: benches, kerbs, posts, walls);
  v   lamp light arriving with shadows / without (DIFFUSE DIRECT twice, the second with every light's shadow off),
      the lamps shaped exactly as bake.py shapes them (lampshape.py).
Writes NPZ_DIR/ground_raw.npz (float16 ao, v; tile list; floor height); web_export/groundmap.py (run by pack.py) turns it
into data/ground.bin.
"""
import sys, os, math, time, json, argparse
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
import numpy as np
from mathutils.bvhtree import BVHTree
import park_common as pc, lampshape

ap = argparse.ArgumentParser()
ap.add_argument("--npz", required=True); ap.add_argument("--scene-blend", required=True)
ap.add_argument("--texel", type=float, default=0.125); ap.add_argument("--tile", type=int, default=128)
ap.add_argument("--samples", type=int, default=64); ap.add_argument("--batch", type=int, default=48)
ap.add_argument("--shadow-samples", type=int, default=384, help="the two lamp bakes (many lights: noisy at the AO count)")
ap.add_argument("--lsoft", type=float, default=0.45); ap.add_argument("--lcap", type=float, default=0.25)
ap.add_argument("--max-tiles", type=int, default=0, help="(testing) only the first N tiles")
a = ap.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
T0 = time.time()
def log(*s): print("[ground %5.0fs]" % (time.time() - T0), *s, flush=True)

# ───────────── walk grid -> tiles and texels ─────────────
NX0, NY0, NCS = -275.0, -225.0, 0.5                     # pack.py build_nav() grid (Blender x, y)
hA = np.load(os.path.join(a.npz, "nav_debug.npy"))[0].astype(np.int64)
NH, NW = hA.shape
walk = hA > 0
navz = np.where(walk, (hA - 1) / 100.0 - 2.0, np.nan)
TS = a.tile * a.texel                                   # tile size (m)
TX = int(math.ceil(NW * NCS / TS)); TY = int(math.ceil(NH * NCS / TS))
n = int(round(TS / NCS))
wpad = np.zeros((TY * n, TX * n), bool); wpad[:NH, :NW] = walk
tiles = np.argwhere(wpad.reshape(TY, n, TX, n).any((1, 3)))          # (ty, tx)
if a.max_tiles: tiles = tiles[:a.max_tiles]
log("walk grid %dx%d, %d walkable cells; %d tiles of %.0f m (%dx%d grid)" % (NW, NH, walk.sum(), len(tiles), TS, TX, TY))

# nearest walkable cell height for every cell within 1 m (2 cells) of walkable ground, by dilation
def dilate_height(z, iters=2):
    z = z.copy()
    for _ in range(iters):
        P = np.pad(z, 1, constant_values=np.nan); acc = np.zeros_like(z); cnt = np.zeros_like(z)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                s = P[1 + dy:NH + 1 + dy, 1 + dx:NW + 1 + dx]; ok = ~np.isnan(s); acc[ok] += s[ok]; cnt += ok
        z = np.where(np.isnan(z) & (cnt > 0), acc / np.maximum(cnt, 1), z)
    return z
navz2 = dilate_height(navz)

# ───────────── floor height: a ray down from the walk height against the baked geometry ─────────────
t = time.time()
V = []; F = []; off = 0
for f in sorted(os.listdir(a.npz)):
    if not (f.startswith("part__") and f.endswith(".npz")): continue
    d = np.load(os.path.join(a.npz, f)); co = d["co"]; tri = d["tri"]; nr = d["nr"]
    keep = nr[:, 2] > 0.5                              # floors only: a ray down meets the floor, not a lantern string
    V.append(co); F.append(tri[keep] + off); off += len(co)
V = np.concatenate(V); F = np.concatenate(F)
bvh = BVHTree.FromPolygons(V.tolist(), F.tolist(), all_triangles=True)
del V, F
log("floor BVH %.0fs" % (time.time() - t))

K = a.tile
ti, tj = np.meshgrid(np.arange(K), np.arange(K))               # texel (i along x, j along y) inside a tile
def tile_texels(ty, tx):
    x = tx * TS + (ti + 0.5) * a.texel + NX0; y = ty * TS + (tj + 0.5) * a.texel + NY0
    ci = np.clip(((x - NX0) / NCS).astype(np.int64), 0, NW - 1); cj = np.clip(((y - NY0) / NCS).astype(np.int64), 0, NH - 1)
    z0 = navz2[cj, ci]
    return x, y, z0

from mathutils import Vector
DOWN = Vector((0, 0, -1))
FL = {}; t = time.time(); nt = 0
for k, (ty, tx) in enumerate(tiles):
    x, y, z0 = tile_texels(ty, tx)
    fz = np.full((K, K), np.nan, np.float32)
    for j, i in zip(*np.nonzero(~np.isnan(z0))):
        h = bvh.ray_cast(Vector((x[j, i], y[j, i], z0[j, i] + 0.6)), DOWN, 1.3)
        fz[j, i] = h[0].z if h[0] is not None else z0[j, i]
        nt += 1
    FL[k] = fz
log("floor heights: %d texels, %.0fs" % (nt, time.time() - t))
del bvh

# ───────────── Cycles ─────────────
bpy.ops.wm.open_mainfile(filepath=a.scene_blend); scene = bpy.context.scene
pc.setup_world(scene); pc.setup_render(scene, (64, 64), a.samples, bloom=False)
scene.cycles.use_denoising = False; scene.cycles.use_adaptive_sampling = False
scene.render.bake.margin = 0; scene.render.bake.use_clear = True
log(lampshape.shape_lights(scene, a.lsoft, a.lcap))
for o in list(scene.objects):                       # what the web does not draw does not shade the ground either
    if o.name.startswith(("core_finale_lanterns", "core_moon")): o.hide_render = True
LIGHTS = [o for o in scene.objects if o.type == 'LIGHT' and o.name != "Moonlight"]
moon = bpy.data.objects.get("Moonlight")
mat = bpy.data.materials.new("ground_probe"); mat.use_nodes = True
nt_ = mat.node_tree; bsdf = next(nd for nd in nt_.nodes if nd.type == 'BSDF_PRINCIPLED')
bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1); bsdf.inputs["Roughness"].default_value = 1.0
tex = nt_.nodes.new("ShaderNodeTexImage"); nt_.nodes.active = tex
vl = bpy.context.view_layer

def bake_batch(items):
    """items: [(k, x, y, fz)] -> per k (ao, v) arrays (K, K)"""
    nb = len(items); cols = int(math.ceil(math.sqrt(nb))); rows = int(math.ceil(nb / cols))
    IW, IH = cols * K, rows * K
    verts = []; faces = []; uvs = []
    h = a.texel * 0.5
    for s, (k, x, y, fz) in enumerate(items):
        sx, sy = (s % cols) * K, (s // cols) * K
        jj, ii = np.nonzero(~np.isnan(fz))
        cx, cy, cz = x[jj, ii], y[jj, ii], fz[jj, ii] + 0.05
        b = sum(len(v) for v in verts)
        q = np.stack([np.stack([cx - h, cy - h, cz], 1), np.stack([cx + h, cy - h, cz], 1), np.stack([cx + h, cy + h, cz], 1), np.stack([cx - h, cy + h, cz], 1)], 1)
        verts.append(q.reshape(-1, 3)); faces.append(b + np.arange(len(cx) * 4).reshape(-1, 4))
        u0 = (sx + ii) / IW; v0 = (sy + jj) / IH; du = 1.0 / IW; dv = 1.0 / IH
        uvs.append(np.stack([np.stack([u0, v0], 1), np.stack([u0 + du, v0], 1), np.stack([u0 + du, v0 + dv], 1), np.stack([u0, v0 + dv], 1)], 1).reshape(-1, 2))
    V = np.concatenate(verts); Fc = np.concatenate(faces); UV = np.concatenate(uvs)
    me = bpy.data.meshes.new("ground_probe")
    me.vertices.add(len(V)); me.vertices.foreach_set("co", V.astype(np.float32).ravel())
    me.loops.add(Fc.size); me.loops.foreach_set("vertex_index", Fc.astype(np.int32).ravel())
    me.polygons.add(len(Fc)); me.polygons.foreach_set("loop_start", (np.arange(len(Fc)) * 4).astype(np.int32)); me.polygons.foreach_set("loop_total", np.full(len(Fc), 4, np.int32))
    me.update(); uvl = me.uv_layers.new(name="UV"); uvl.data.foreach_set("uv", UV.astype(np.float32).ravel())
    me.materials.append(mat)
    ob = bpy.data.objects.new("ground_probe", me); scene.collection.objects.link(ob)
    img = bpy.data.images.new("gp", IW, IH, float_buffer=True); tex.image = img
    for o in vl.objects:
        try: o.select_set(False)
        except Exception: pass
    ob.select_set(True); vl.objects.active = ob
    def run(kind, pf=None, samples=None):
        scene.cycles.samples = samples or a.samples
        kw = dict(type=kind, target='IMAGE_TEXTURES')
        if pf: kw["pass_filter"] = pf
        bpy.ops.object.bake(**kw)
        px = np.empty(IW * IH * 4, np.float32); img.pixels.foreach_get(px)
        return px.reshape(IH, IW, 4)[..., :3].mean(-1)
    scene.world.light_settings.distance = 1.0
    ao = run('AO')
    # lamp light with and without shadows: no sky, no moon
    wstr = scene.world.node_tree.nodes["Background"].inputs["Strength"]; w0 = wstr.default_value; wstr.default_value = 0.0
    if moon: moon.hide_render = True
    sh = run('DIFFUSE', {'DIRECT'}, a.shadow_samples)
    for o in LIGHTS: o.data.use_shadow = False
    un = run('DIFFUSE', {'DIRECT'}, a.shadow_samples)
    for o in LIGHTS: o.data.use_shadow = True
    wstr.default_value = w0
    if moon: moon.hide_render = False
    bpy.data.objects.remove(ob, do_unlink=True); bpy.data.meshes.remove(me); bpy.data.images.remove(img)
    out = {}
    for s, (k, x, y, fz) in enumerate(items):
        sx, sy = (s % cols) * K, (s // cols) * K
        A = ao[sy:sy + K, sx:sx + K]; S = sh[sy:sy + K, sx:sx + K]; U = un[sy:sy + K, sx:sx + K]
        out[k] = (A, S, U)
    return out

AO = np.ones((len(tiles), K, K), np.float16); SH = np.zeros((len(tiles), K, K), np.float16); UN = np.zeros((len(tiles), K, K), np.float16)
FZ = np.full((len(tiles), K, K), np.nan, np.float16)
todo = [k for k in range(len(tiles)) if (~np.isnan(FL[k])).any()]
t = time.time()
for b0 in range(0, len(todo), a.batch):
    items = []
    for k in todo[b0:b0 + a.batch]:
        ty, tx = tiles[k]; x, y, _ = tile_texels(ty, tx); items.append((k, x, y, FL[k]))
    res = bake_batch(items)
    for k, (A, S, U) in res.items():
        m = ~np.isnan(FL[k]); AO[k][m] = A[m]; SH[k][m] = S[m]; UN[k][m] = U[m]; FZ[k] = FL[k]
    log("  baked tiles %d-%d of %d (%.0fs)" % (b0, b0 + len(items), len(todo), time.time() - t))
np.savez_compressed(os.path.join(a.npz, "ground_raw.npz"), tiles=tiles, ao=AO, sh=SH, un=UN, fz=FZ,
                    meta=json.dumps(dict(texel=a.texel, tile=K, x0=NX0, y0=NY0, tx=TX, ty=TY, lsoft=a.lsoft, lcap=a.lcap, samples=a.samples)))
log("wrote ground_raw.npz: %d tiles; done" % len(tiles))
