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

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True); ap.add_argument("--parts", default=",".join(pc.ALL_PARTS))
ap.add_argument("--export", default=""); ap.add_argument("--samples", type=int, default=64)
ap.add_argument("--lmax", type=float, default=3.0); ap.add_argument("--lfine", type=float, default=0.7)
a = ap.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
PARTS = [p for p in a.parts.split(",") if p]; EXPORT = [p for p in a.export.split(",") if p] or PARTS
os.makedirs(a.out, exist_ok=True)
T0 = time.time()
def log(*s): print("[bake %6.0fs]" % (time.time() - T0), *s, flush=True)

scene = pc.reset_scene()
cols = {}
for part in PARTS:
    cols[part], dt = studio.load_part(part, scene)
pc.setup_world(scene); pc.setup_render(scene, (64, 64), a.samples, bloom=False)
scene.cycles.use_denoising = False; scene.cycles.use_adaptive_sampling = False
scene.render.bake.target = 'VERTEX_COLORS'
scene.world.light_settings.distance = 14.0
vl = bpy.context.view_layer

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
    co, tri, mi, nr = tri_arrays(me)
    oid = np.zeros(len(tri), np.int32)
    if me.attributes.get("oid") is not None: me.attributes["oid"].data.foreach_get("value", oid)
    mats = [info(s.material) if s.material else dict(name="none", glass=False, alpha=1, metallic=0, fine=False, attr=False,
            base=[.5, .5, .5], emit=[0, 0, 0], estr=0, base_linked=False, emit_linked=False, rough=.5) for s in ob.material_slots]
    np.savez(path, co=co, tri=tri, mi=mi, nr=nr, oid=oid, light=light.astype(np.float16), lightnm=lightnm.astype(np.float16), alb=alb.astype(np.float16),
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

SKIP_PREFIX = ("core_forest_", "core_src_", "core_finale_lanterns", "core_water", "transit_train_")
for part in EXPORT:
    log("== %s ==" % part)
    objs = [o for o in cols[part].all_objects if not o.name.startswith(SKIP_PREFIX)]
    if part == "transit":
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
    ob, names = prepare_joined(part, objs)
    bake_and_dump(ob, os.path.join(a.out, "part__%s.npz" % part), names)
log("done")
