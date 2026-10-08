"""Stage 1 of the three.js port: bake Cycles lighting / albedo / emission into per-corner vertex colours
and dump raw arrays per part (npz) for web_export/pack.py.

  blender -b -P web_export/bake.py -- --out DIR [--parts core,frostmere] [--export frostmere] [--samples 64]
--parts = parts present in the scene (lighting context); --export = parts to bake + dump (default: same).
"""
import sys, os, math, time, json, argparse
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, HERE)
import bpy, bmesh
import numpy as np
from mathutils import Matrix
import park_common as pc, studio
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True); ap.add_argument("--parts", default=",".join(pc.ALL_PARTS))
ap.add_argument("--export", default=""); ap.add_argument("--samples", type=int, default=64)
ap.add_argument("--lmax", type=float, default=3.0); ap.add_argument("--lfine", type=float, default=0.7)
# light-driven sampling: faces near a light are split until every edge is <= lk x its distance to the light (never
# below lmin, at most lpasses halvings), so pools of lamp light get vertices where the light changes and plain walls far
# from lamps stay coarse. --lk 0 turns it off (the uniform lmax / lfine grid only).
ap.add_argument("--lk", type=float, default=0.5); ap.add_argument("--lmin", type=float, default=0.08)
ap.add_argument("--lpasses", type=int, default=6)
ap.add_argument("--lgrow", type=float, default=0.25, help="cap: at most this many more triangles per part from the light split")
# lamp shape (the skill's look.md item 2): a soft near-field so walls right beside a lamp do not burn out (Cycles Light
# Falloff "Smooth": the light falls as 1 / (d^2 + lsoft^2) instead of 1 / d^2), and lamps and lanterns send only lcap of
# their light upward (a lantern has a roof) so facades are not lit to the eaves. Washes and up-lights keep their shape.
ap.add_argument("--lsoft", type=float, default=0.45); ap.add_argument("--lcap", type=float, default=0.25)
# (build.py) start from web_export/scene.py's cached park instead of building it; the dumps are the same
ap.add_argument("--scene-blend", default="")
ap.add_argument("--no-trains", action="store_true"); ap.add_argument("--trains-only", action="store_true")
ap.add_argument("--draft", action="store_true", help="no Cycles: dump joined geometry only (light arrays empty)")
a = ap.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
PARTS = [p for p in a.parts.split(",") if p]; EXPORT = [p for p in a.export.split(",") if p] or PARTS
os.makedirs(a.out, exist_ok=True)
T0 = time.time()
def log(*s): print("[bake %6.0fs]" % (time.time() - T0), *s, flush=True)

cols = {}
if a.scene_blend:
    bpy.ops.wm.open_mainfile(filepath=a.scene_blend); scene = bpy.context.scene
    for part in PARTS: cols[part] = bpy.data.collections["PART_" + part]
    for c in [c for c in bpy.data.collections if c.name.startswith("PART_") and c.name[5:] not in PARTS]:
        for o in list(c.all_objects): bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.collections.remove(c)
    log("opened %s" % os.path.basename(a.scene_blend))
else:
    scene = pc.reset_scene()
for part in PARTS if not a.scene_blend else []:
    cols[part], dt = studio.load_part(part, scene)
pc.setup_world(scene); pc.setup_render(scene, (64, 64), a.samples, bloom=False)
scene.cycles.use_denoising = False; scene.cycles.use_adaptive_sampling = False
scene.render.bake.target = 'VERTEX_COLORS'
scene.world.light_settings.distance = 14.0
vl = bpy.context.view_layer

# ───────────── lamp shape: soft near field, capped upward light (web_export/lampshape.py) ─────────────
import lampshape
def lamp_shape(li, name): return lampshape.lamp_shape(li, name, a.lsoft, a.lcap)
if not a.draft and (a.lsoft > 0 or a.lcap < 1): log(lampshape.shape_lights(scene, a.lsoft, a.lcap))

# ───────────── material table ─────────────
def upstream_types(sock, seen=None):
    seen = seen if seen is not None else set(); out = set()
    for l in sock.links:
        n = l.from_node
        if n.name in seen: continue
        seen.add(n.name); out.add(n.type)
        for i in n.inputs: out |= upstream_types(i, seen)
    return out

PATTERN = {'TEX_WHITE_NOISE', 'TEX_VORONOI', 'TEX_WAVE', 'TEX_MAGIC', 'TEX_BRICK', 'TEX_CHECKER'}
def mat_info(m):
    d = dict(name=m.name, glass=False, alpha=1.0, metallic=0.0, fine=False, attr=False, base=[0.5, 0.5, 0.5],
             emit=[0, 0, 0], estr=0.0, base_linked=False, emit_linked=False, rough=0.5)
    if not m.node_tree: return d
    types = {n.type for n in m.node_tree.nodes}
    b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if b is None:
        if 'BSDF_TRANSPARENT' in types or 'BSDF_GLASS' in types:
            d["glass"] = True; d["alpha"] = 0.16
            e = next((n for n in m.node_tree.nodes if n.type == 'EMISSION'), None)
            if e is not None:
                d["emit"] = list(e.inputs["Color"].default_value)[:3]; d["estr"] = float(e.inputs["Strength"].default_value)
            g = next((n for n in m.node_tree.nodes if n.type == 'BSDF_GLOSSY'), None)
            if g is not None: d["base"] = list(g.inputs["Color"].default_value)[:3]
        return d
    def val(k):
        s = pc._sock(b, k); return s.default_value if s is not None else 0
    d["base"] = list(val("Base Color"))[:3]; d["metallic"] = float(val("Metallic")); d["rough"] = float(val("Roughness"))
    d["alpha"] = float(val("Alpha")); d["emit"] = list(val("Emission Color"))[:3]; d["estr"] = float(val("Emission Strength"))
    tr = float(val("Transmission Weight"))
    al = pc._sock(b, "Alpha")
    if d["alpha"] < 0.98 or tr > 0.5 or (al is not None and al.is_linked):
        d["glass"] = True
        if tr > 0.5 and d["alpha"] >= 0.98: d["alpha"] = 0.3
        if al is not None and al.is_linked: d["alpha"] = 0.5
    ec, es, bc = pc._sock(b, "Emission Color"), pc._sock(b, "Emission Strength"), pc._sock(b, "Base Color")
    ue = upstream_types(ec) | upstream_types(es); ub = upstream_types(bc)
    d["base_linked"] = bool(ub); d["emit_linked"] = bool(ue)
    d["fine"] = bool(ue & PATTERN)
    d["attr"] = bool((ue | ub) & {'ATTRIBUTE', 'VERTEX_COLOR', 'OBJECT_INFO'})
    return d

# ───────────── helpers ─────────────
def select_only(ob):
    for o in vl.objects:
        try: o.select_set(False)
        except Exception: pass
    ob.select_set(True); vl.objects.active = ob

def read_attr(me, name="bk"):
    at = me.color_attributes[name]; n = len(at.data)
    arr = np.empty(n * 4, np.float32); at.data.foreach_get("color", arr)
    return arr.reshape(-1, 4)[:, :3].copy()

def bake(ob, kind, pf=None, samples=None):
    select_only(ob)
    scene.cycles.samples = samples or a.samples
    t = time.time()
    kw = dict(type=kind, target='VERTEX_COLORS')
    if pf: kw["pass_filter"] = pf
    bpy.ops.object.bake(**kw)
    out = read_attr(ob.data)
    log("   bake %-8s %s  %.1fs  mean=%.4f" % (kind, sorted(pf) if pf else "", time.time() - t, float(out.mean())))
    return out

def ensure_attr(me):
    for c in list(me.color_attributes): me.color_attributes.remove(c)
    at = me.color_attributes.new("bk", 'FLOAT_COLOR', 'CORNER')
    me.color_attributes.active_color = at; me.color_attributes.render_color_index = 0

def tri_arrays(me):
    nl = len(me.loops); lv = np.empty(nl, np.int32); me.loops.foreach_get("vertex_index", lv)
    npoly = len(me.polygons); lt = np.empty(npoly, np.int32); me.polygons.foreach_get("loop_total", lt)
    ls = np.empty(npoly, np.int32); me.polygons.foreach_get("loop_start", ls)
    assert (lt == 3).all() and (ls == np.arange(npoly) * 3).all(), "mesh not a clean triangle list"
    nv = len(me.vertices); co = np.empty(nv * 3, np.float32); me.vertices.foreach_get("co", co)
    mi = np.empty(npoly, np.int32); me.polygons.foreach_get("material_index", mi)
    nr = np.empty(npoly * 3, np.float32); me.polygons.foreach_get("normal", nr)
    return co.reshape(-1, 3), lv.reshape(-1, 3), mi, nr.reshape(-1, 3)

def face_mean(c): return c.reshape(-1, 3, 3).mean(axis=(1, 2))

# metals -> diffuse for the bake so every surface receives baked light
METAL = {}
for m in bpy.data.materials:
    if m.node_tree:
        b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if b is not None:
            s = pc._sock(b, "Metallic")
            if s is not None and not s.is_linked and s.default_value > 0.01:
                METAL[m.name] = float(s.default_value); s.default_value = 0.0
MATINFO = {}
def info(m):
    if m.name not in MATINFO:
        MATINFO[m.name] = mat_info(m)
        if m.name in METAL: MATINFO[m.name]["metallic"] = METAL[m.name]
    return MATINFO[m.name]

def _cut_planes(bmx, L, zrange=(-6.0, 70.0)):
    """Slice every face of bmx with world-axis grid planes spaced L apart."""
    if not bmx.faces: return
    xs = [v.co.x for v in bmx.verts]; ys = [v.co.y for v in bmx.verts]; zs = [v.co.z for v in bmx.verts]
    for axis, lo, hi in ((0, min(xs), max(xs)), (1, min(ys), max(ys)), (2, max(min(zs), zrange[0]), min(max(zs), zrange[1]))):
        k0 = math.floor(lo / L) + 1; k1 = math.ceil(hi / L)
        no = [0, 0, 0]; no[axis] = 1
        for k in range(k0, k1):
            co = [0, 0, 0]; co[axis] = k * L + 0.013
            geom = bmx.verts[:] + bmx.edges[:] + bmx.faces[:]
            bmesh.ops.bisect_plane(bmx, geom=geom, dist=1e-5, plane_co=co, plane_no=no)

def grid_cut(me, Ls):
    """Cut large faces (and all faces of 'fine' pattern materials) on a world grid so baked vertex lighting has
    enough resolution, without sliver explosions. Large/fine faces are processed in their own bmesh."""
    L = a.lmax; Lf = a.lfine
    n = len(me.polygons)
    mi = np.empty(n, np.int32); me.polygons.foreach_get("material_index", mi)
    cen = np.empty(n * 3, np.float32); me.polygons.foreach_get("center", cen); cen = cen.reshape(-1, 3)
    area = np.empty(n, np.float32); me.polygons.foreach_get("area", area)
    lt = np.empty(n, np.int32); me.polygons.foreach_get("loop_total", lt); ls = np.empty(n, np.int32); me.polygons.foreach_get("loop_start", ls)
    lv = np.empty(len(me.loops), np.int32); me.loops.foreach_get("vertex_index", lv)
    co = np.empty(len(me.vertices) * 3, np.float32); me.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
    # bbox diagonal per polygon
    pid = np.repeat(np.arange(n), lt); pc_ = co[lv]
    mn = np.full((n, 3), 1e9, np.float32); mx = np.full((n, 3), -1e9, np.float32)
    np.minimum.at(mn, pid, pc_); np.maximum.at(mx, pid, pc_)
    diag = np.linalg.norm(mx - mn, axis=1)
    Larr = np.array(Ls, np.float32)[np.clip(mi, 0, len(Ls) - 1)]
    near = np.hypot(cen[:, 0], cen[:, 1]) < 330.0
    fine = (Larr < L) & (diag > Lf * 1.3)
    big = (~fine) & near & (diag > L * 1.4)
    cls = np.where(fine, 2, np.where(big, 1, 0))
    parts = []
    for c, step in ((1, L), (2, Lf)):
        if not (cls == c).any(): continue
        bmx = bmesh.new(); bmx.from_mesh(me); bmx.faces.ensure_lookup_table()
        bmesh.ops.delete(bmx, geom=[bmx.faces[i] for i in np.nonzero(cls != c)[0]], context='FACES')
        _cut_planes(bmx, step)
        bmesh.ops.triangulate(bmx, faces=bmx.faces[:])
        tmp = bpy.data.meshes.new("tmp_cut"); bmx.to_mesh(tmp); 
        log("   grid-cut class %d: %d faces -> %d tris" % (c, int((cls == c).sum()), len(bmx.faces))); bmx.free()
        parts.append(tmp)
    bm = bmesh.new(); bm.from_mesh(me); bm.faces.ensure_lookup_table()
    drop = np.nonzero(cls != 0)[0]
    if len(drop): bmesh.ops.delete(bm, geom=[bm.faces[i] for i in drop], context='FACES')
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    for tmp in parts:
        bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)
    bm.to_mesh(me); bm.free(); me.update()
    log("   after grid-cut: %d tris" % len(me.polygons))

def light_points(ob):
    """(position, reach) of everything that lights the bake like a lamp: every light object in the scene (all parts: a
    neighbour's lamp lights this part too) and the bright emissive faces of this part's mesh (lantern glass, flames,
    festoon bulbs, windows), summed into 0.5 m voxels. Reach = where the light falls under LREACH baked units."""
    LREACH = float(os.environ.get("LSPLIT_REACH", 0.03)); EMIN = float(os.environ.get("LSPLIT_EMIN", 0.15))
    P = []; R = []; S = []
    for o in scene.objects:
        if o.type != 'LIGHT' or o.hide_render or o.data.type not in ('POINT', 'SPOT', 'AREA'): continue
        i = o.data.energy / (4 * math.pi ** 2) * max(o.data.color)
        P.append(tuple(o.matrix_world.translation)); R.append(min(12.0, max(0.5, math.sqrt(i / LREACH))))
        S.append(max(getattr(o.data, "shadow_soft_size", 0.1), 0.1))
    me = ob.data; n = len(me.polygons)
    mi = np.empty(n, np.int32); me.polygons.foreach_get("material_index", mi)
    cen = np.empty(n * 3, np.float32); me.polygons.foreach_get("center", cen); cen = cen.reshape(-1, 3)
    area = np.empty(n, np.float32); me.polygons.foreach_get("area", area)
    L = np.array([(max(info(s.material)["emit"]) * info(s.material)["estr"]) if s.material and not info(s.material)["emit_linked"] else 0.0
                  for s in ob.material_slots] or [0.0], np.float32)
    rad = L[np.clip(mi, 0, len(L) - 1)]
    # only fittings (lamp glass, lanterns, flames) drive the split; windows, neon and signs light broad and soft, and
    # splitting walls and floors around every letter and inlay costs 40-110 % more triangles in Meridian for little
    import lights as _lights
    fit = np.array([bool(s.material) and _lights.kind_of(s.material.name) in ("lamp", "lantern", "flame") for s in ob.material_slots] or [False])
    sel = (rad > 0.3) & fit[np.clip(mi, 0, len(fit) - 1)]
    if sel.any():
        v = np.floor(cen[sel] / 0.5).astype(np.int64); w = rad[sel] * area[sel]
        _, inv = np.unique(v, axis=0, return_inverse=True); inv = inv.ravel()
        pw = np.bincount(inv, weights=w); c = np.zeros((len(pw), 3)); np.add.at(c, inv, cen[sel] * w[:, None])
        c /= np.maximum(pw, 1e-9)[:, None]; i = pw / (4 * math.pi)
        keep = i > EMIN
        P += [tuple(x) for x in c[keep]]; R += list(np.clip(np.sqrt(i[keep] / LREACH), 0.3, 12.0)); S += [float(os.environ.get("LSPLIT_ESRC", 0.4))] * int(keep.sum())
    return np.array(P, np.float64).reshape(-1, 3), np.array(R, np.float64), np.array(S, np.float64), rad > 0.3

def light_split(ob):
    """Split edges near lights until each is <= a.lk x the distance from its midpoint to the nearest light point within
    that light's reach (and >= a.lmin). Emissive and glass faces are not split for their own sake. Faces keep their
    attributes; 'elc' (each face's longest edge before this step) keeps the viewer's detail class of the face the pieces
    came from, so a split wall is not mistaken for small detail and dropped at distance."""
    from mathutils import kdtree
    me = ob.data
    n = len(me.polygons)
    lt = np.empty(n, np.int32); me.polygons.foreach_get("loop_total", lt)
    lv = np.empty(len(me.loops), np.int32); me.loops.foreach_get("vertex_index", lv)
    co = np.empty(len(me.vertices) * 3, np.float64); me.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
    ls = np.concatenate([[0], np.cumsum(lt)[:-1]])
    pts = co[lv]; nxt = np.arange(len(lv)) + 1; nxt[ls + lt - 1] = ls
    el = np.linalg.norm(pts[nxt] - pts, axis=1); elc = np.zeros(n, np.float32)
    np.maximum.at(elc, np.repeat(np.arange(n), lt), el)
    at = me.attributes.get("elc") or me.attributes.new("elc", 'FLOAT', 'FACE'); at.data.foreach_set("value", elc)
    if a.lk <= 0: return
    P, R, Ssrc, emis_face = light_points(ob)
    if not len(P): return
    kd = kdtree.KDTree(len(P))
    for k, p in enumerate(P): kd.insert(p, k)
    kd.balance()
    skip_mat = np.array([bool(s.material and (info(s.material)["glass"])) for s in ob.material_slots] or [False])
    t0 = time.time(); nt0 = n
    for ps in range(a.lpasses):
        me = ob.data; n = len(me.polygons)
        mi = np.empty(n, np.int32); me.polygons.foreach_get("material_index", mi)
        lt = np.empty(n, np.int32); me.polygons.foreach_get("loop_total", lt)
        le = np.empty(len(me.loops), np.int32); me.loops.foreach_get("edge_index", le)
        co = np.empty(len(me.vertices) * 3, np.float64); me.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
        ev = np.empty(len(me.edges) * 2, np.int32); me.edges.foreach_get("vertices", ev); ev = ev.reshape(-1, 2)
        # emissive / glass faces are not split for their own sake (a pane would shatter around its own light point)
        if ps == 0: emis = emis_face
        else:
            L = np.array([(max(info(s.material)["emit"]) * info(s.material)["estr"]) if s.material and not info(s.material)["emit_linked"] else 0.0
                          for s in ob.material_slots] or [0.0]); emis = L[np.clip(mi, 0, len(L) - 1)] > 0.3
        okf = ~emis & ~skip_mat[np.clip(mi, 0, len(skip_mat) - 1)]
        oke = np.zeros(len(ev), bool); oke[le[np.repeat(okf, lt)]] = True
        a0 = co[ev[:, 0]]; a1 = co[ev[:, 1]]; L_ = np.linalg.norm(a1 - a0, axis=1); mid = (a0 + a1) * 0.5
        cand = np.nonzero(oke & (L_ > 2 * a.lmin))[0]
        cut = []; ratio = []
        for e in cand:
            q, j, d = kd.find(mid[e])
            if d < R[j]:
                t = L_[e] / max(a.lmin, a.lk * max(d, Ssrc[j]))
                if t > 1: cut.append(int(e)); ratio.append(t)
        # the cap: an edge cut adds about two triangles; the worst-sampled edges (largest length / target) go first
        budget = int((a.lgrow * nt0 - (n - nt0)) / 2)
        if len(cut) > budget:
            o = np.argsort(-np.array(ratio))[:max(budget, 0)]; cut = [cut[k] for k in o]; capped = True
        else: capped = False
        if not cut: break
        bm = bmesh.new(); bm.from_mesh(me); bm.edges.ensure_lookup_table()
        res = bmesh.ops.subdivide_edges(bm, edges=[bm.edges[e] for e in cut], cuts=1, use_grid_fill=False)
        nf = [f for f in bm.faces if len(f.verts) > 3]
        if nf: bmesh.ops.triangulate(bm, faces=nf)
        bm.to_mesh(me); bm.free(); me.update()
        log("   light-split pass %d: %d edges cut -> %d tris%s" % (ps + 1, len(cut), len(me.polygons), " (capped)" if capped else ""))
        if capped: break
    log("   light-split: %d light points, %d -> %d tris (%.0f%%), %.1fs" % (len(P), nt0, len(ob.data.polygons),
        100.0 * (len(ob.data.polygons) / nt0 - 1), time.time() - t0))

def prepare_joined(part, objs):
    """fonts -> mesh, apply modifiers, tag object ids, join, world-space, triangulate + subdivide long edges."""
    dg = bpy.context.evaluated_depsgraph_get()
    col = cols[part]; meshes = []
    for o in objs:
        if o.type not in ('MESH', 'FONT', 'CURVE'): continue
        if o.type == 'FONT': o.data.resolution_u = 2
    dg = bpy.context.evaluated_depsgraph_get()
    oid = 0; names = []
    for o in objs:
        if o.type not in ('MESH', 'FONT', 'CURVE'): continue
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        if len(me.polygons) == 0: continue
        if o.type == 'MESH':
            o.modifiers.clear(); o.data = me; no = o
        else:
            no = bpy.data.objects.new(o.name + "_m", me); col.objects.link(no)
            no.parent = o.parent; no.matrix_world = o.matrix_world.copy()
            o.hide_render = True
        at = me.attributes.get("oid") or me.attributes.new("oid", 'INT', 'FACE')
        at.data.foreach_set("value", np.full(len(me.polygons), oid, np.int32))
        names.append(o.name); oid += 1; meshes.append(no)
    vl.update()
    for o in [o for o in objs if o.type in ('FONT', 'CURVE')]:
        bpy.data.objects.remove(o, do_unlink=True)
    log("  %s: joining %d objects" % (part, len(meshes)))
    with bpy.context.temp_override(active_object=meshes[0], selected_editable_objects=meshes, selected_objects=meshes, object=meshes[0]):
        bpy.ops.object.join()
    ob = meshes[0]; ob.name = "WEB_" + part
    me = ob.data
    M = ob.matrix_world.copy(); ob.parent = None; me.transform(M); ob.matrix_world = Matrix.Identity(4)
    if M.determinant() < 0: me.flip_normals()
    # per-slot max edge length
    slots = [s.material for s in ob.material_slots]
    Ls = [a.lfine if (m is not None and info(m)["fine"]) else a.lmax for m in slots] or [a.lmax]
    grid_cut(me, Ls)
    light_split(ob)
    ensure_attr(me)
    return ob, names

def orient(ob):
    """Make every face point to its more open side (AO from both sides), so the bake lights the visible side."""
    me = ob.data
    ao0 = face_mean(bake(ob, 'AO', samples=12))
    me.flip_normals(); me.update()
    ao1 = face_mean(bake(ob, 'AO', samples=12))
    keep_flipped = ao1 > ao0 + 0.08
    bm = bmesh.new(); bm.from_mesh(me); bm.faces.ensure_lookup_table()
    back = [bm.faces[i] for i in np.nonzero(~keep_flipped)[0]]
    bmesh.ops.reverse_faces(bm, faces=back)
    bm.to_mesh(me); bm.free(); me.update()
    log("   orient: flipped %d of %d faces" % (int(keep_flipped.sum()), len(keep_flipped)))

def bake_and_dump(ob, path, names=None, extra=None, do_orient=True):
    me = ob.data
    if a.draft:          # (build.py) geometry only, no Cycles; build.py carries the light over from the last bake
        z = np.zeros((len(me.loops), 3), np.float32)
        return dump(ob, path, z, z, z, z, names, extra)
    if do_orient: orient(ob)
    light = bake(ob, 'DIFFUSE', {'DIRECT', 'INDIRECT'})
    # the same again without the moon, so the viewer can add moonlight (and its shadows) per pixel
    moon = bpy.data.objects.get("Moonlight")
    if moon is not None:
        moon.hide_render = True
        lightnm = bake(ob, 'DIFFUSE', {'DIRECT', 'INDIRECT'})
        moon.hide_render = False
    else:
        lightnm = light
    alb = bake(ob, 'DIFFUSE', {'COLOR'}, samples=4)
    emit = bake(ob, 'EMIT', samples=4)
    dump(ob, path, light, lightnm, alb, emit, names, extra)

def dump(ob, path, light, lightnm, alb, emit, names=None, extra=None):
    me = ob.data
    co, tri, mi, nr = tri_arrays(me)
    oid = np.zeros(len(tri), np.int32)
    if me.attributes.get("oid") is not None: me.attributes["oid"].data.foreach_get("value", oid)
    elc = np.zeros(len(tri), np.float32)
    if me.attributes.get("elc") is not None: me.attributes["elc"].data.foreach_get("value", elc)
    mats = [info(s.material) if s.material else dict(name="none", glass=False, alpha=1, metallic=0, fine=False, attr=False,
            base=[.5, .5, .5], emit=[0, 0, 0], estr=0, base_linked=False, emit_linked=False, rough=.5) for s in ob.material_slots]
    np.savez(path, co=co, tri=tri, mi=mi, nr=nr, oid=oid, elc=elc, light=light.astype(np.float16), lightnm=lightnm.astype(np.float16), alb=alb.astype(np.float16),
             emit=emit.astype(np.float32), meta=json.dumps(dict(mats=mats, names=names or [], extra=extra or {})))
    log("  wrote %s: %d verts %d tris" % (os.path.basename(path), len(co), len(tri)))

# ───────────── specials (dumped before joins) ─────────────
if "core" in EXPORT:
    lo = bpy.data.objects.get("core_finale_lanterns")
    if lo is not None:
        me = lo.data; nv = len(me.vertices)
        co = np.empty(nv * 3, np.float32); me.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
        lc = np.empty(nv * 4, np.float32); me.attributes["lcol"].data.foreach_get("color", lc); lc = lc.reshape(-1, 4)
        ls = np.empty(nv, np.float32); me.attributes["lstr"].data.foreach_get("value", ls)
        # lanterns are identical copies: find verts-per-lantern as the smallest period of lstr
        per = next(k for k in range(4, 400) if nv % k == 0 and np.all(ls.reshape(-1, k) == ls.reshape(-1, k)[:, :1]) and np.all(np.abs(lc.reshape(-1, k, 4) - lc.reshape(-1, k, 4)[:, :1]).max() < 1e-6))
        P = co.reshape(-1, per, 3).mean(1); C = lc.reshape(-1, per, 4)[:, 0, :3]; S = ls.reshape(-1, per)[:, 0]
        size = (co.reshape(-1, per, 3).max(1) - co.reshape(-1, per, 3).min(1)).max(1)
        np.savez(os.path.join(a.out, "lanterns.npz"), pos=P, col=C, strength=S, size=size)
        log("lanterns: %d (verts per lantern %d)" % (len(P), per))
    forest = {}
    for o in list(cols["core"].all_objects):
        if o.name.startswith("core_forest_"):
            me = o.data; n = len(me.vertices)
            P = np.empty(n * 3, np.float32); me.vertices.foreach_get("co", P)
            rz = np.empty(n, np.float32); me.attributes["rz"].data.foreach_get("value", rz)
            sc = np.empty(n, np.float32); me.attributes["sc"].data.foreach_get("value", sc)
            src = None
            for md in o.modifiers:
                if md.type == 'NODES':
                    for nd in md.node_group.nodes:
                        if nd.type == 'OBJECT_INFO': src = nd.inputs["Object"].default_value
            sm = src.data; sm.calc_loop_triangles()
            sv = np.empty(len(sm.vertices) * 3, np.float32); sm.vertices.foreach_get("co", sv)
            st = np.empty(len(sm.loop_triangles) * 3, np.int32); sm.loop_triangles.foreach_get("vertices", st)
            smi = np.empty(len(sm.loop_triangles), np.int32); sm.loop_triangles.foreach_get("material_index", smi)
            mcols = [info(s.material)["base"] for s in src.material_slots]
            forest[o.name] = dict(P=P.reshape(-1, 3), rz=rz, sc=sc, sv=sv.reshape(-1, 3), st=st.reshape(-1, 3), smi=smi, mcols=np.array(mcols, np.float32))
            log("forest %s: %d instances of %s (%d tris)" % (o.name, n, src.name, len(st)))
    np.savez(os.path.join(a.out, "forest.npz"), **{k + "__" + kk: vv for k, d in forest.items() for kk, vv in d.items()})

# ───────────── light objects (pack.py -> lights.py -> data/lights.json) ─────────────
from mathutils import Vector
for part in EXPORT:
    if a.trains_only: break
    L = []
    for o in cols[part].all_objects:
        if o.type != 'LIGHT': continue
        li = o.data; M = o.matrix_world
        d = dict(name=o.name, part=part, type=li.type, pos=list(M.translation), W=li.energy, col=list(li.color),
                 r=getattr(li, "shadow_soft_size", 0.0), shadow=li.use_shadow, hide=o.hide_render)
        d["soft"], d["up"] = lamp_shape(li, o.name)
        if li.type == 'SPOT':
            d.update(dir=list((M.to_3x3() @ Vector((0, 0, -1))).normalized()), size=li.spot_size, blend=li.spot_blend)
        L.append(d)
    json.dump(L, open(os.path.join(a.out, "lights__%s.json" % part), "w"))

SKIP_PREFIX = ("core_forest_", "core_src_", "core_finale_lanterns", "core_water", "transit_train_")
for part in EXPORT:
    log("== %s ==" % part)
    objs = [o for o in cols[part].all_objects if not o.name.startswith(SKIP_PREFIX)]
    if part == "transit" and not a.no_trains and not a.draft:
        # train cars: bake one instance of each distinct mesh in place, export as movable prototypes
        cars = [o for o in cols[part].all_objects if o.name.startswith("transit_train_") and o.type == 'MESH']
        protos = {}; inst = []
        for o in cars:
            inst.append(dict(name=o.name, mesh=o.data.name, loc=list(o.location), rz=float(o.rotation_euler[2])))
        pref = sorted(cars, key=lambda o: (0 if "lanternrow" in o.name else 1, o.name))
        for o in pref:
            if o.data.name in protos: continue
            protos[o.data.name] = o
        for mname, o in protos.items():
            me = o.data
            bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.triangulate(bm, faces=bm.faces[:]); bm.to_mesh(me); bm.free(); me.update()
            ensure_attr(me)
            bake_and_dump(o, os.path.join(a.out, "train__%s.npz" % mname), extra=dict(instances=[i for i in inst if i["mesh"] == mname], rail_top=pc.RAIL_TOP), do_orient=False)
    if a.trains_only: continue
    ob, names = prepare_joined(part, objs)
    bake_and_dump(ob, os.path.join(a.out, "part__%s.npz" % part), names)
log("done")
