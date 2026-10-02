"""Scene cache + per-part fingerprints for web_export/build.py (Blender, headless, no GPU needed).

  blender -b -P web_export/scene.py -- --blend CACHE.blend --state STATE.json [--rebuild part,part] [--parts ...]

Opens CACHE.blend when it exists (the whole park as built by studio.load_part, before bake.py touches it), deletes and
rebuilds the parts named in --rebuild (and any part missing from the file), saves CACHE.blend again and writes STATE.json:
{"parts": {part: {"geo": fingerprint, "build_s": seconds}}, "shared_materials": [...]}. Without CACHE.blend every part is
built (the same as bake.py does). bake.py --scene-blend CACHE.blend then starts from this file instead of rebuilding.

The fingerprint hashes what the bake sees of a part: every object's evaluated mesh (all attributes), transforms and
visibility flags, its lights, and the node trees of its materials. Parts whose fingerprint did not change need no new
bake, even when their source files (or park_common.py) changed.
"""
import sys, os, time, json, hashlib, argparse
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, HERE)
import bpy
import numpy as np
import park_common as pc, studio

ap = argparse.ArgumentParser()
ap.add_argument("--blend", required=True); ap.add_argument("--state", required=True)
ap.add_argument("--rebuild", default=""); ap.add_argument("--parts", default=",".join(pc.ALL_PARTS))
ap.add_argument("--no-save", action="store_true")
a = ap.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
PARTS = [p for p in a.parts.split(",") if p]
T0 = time.time()
def log(*s): print("[scene %5.1fs]" % (time.time() - T0), *s, flush=True)

# ───────────── fingerprints ─────────────
def _h(hs, *xs):
    for x in xs:
        if isinstance(x, np.ndarray): hs.update(np.ascontiguousarray(x).tobytes())
        else: hs.update(repr(x).encode())

_SIMPLE = ('BOOLEAN', 'INT', 'FLOAT', 'STRING', 'ENUM')
def _rna(hs, st, skip=()):
    """hash the simple, writable RNA properties of a struct (node settings, light data)."""
    for p in st.bl_rna.properties:
        if p.identifier in skip or p.identifier in ("rna_type", "name", "label", "location", "width", "height", "select",
                                                     "dimensions", "show_options", "show_preview", "hide", "mute_label",
                                                     "session_uid", "name_full", "users", "use_fake_user", "use_extra_user",
                                                     "is_evaluated", "tag", "is_runtime_data", "is_missing", "is_embedded_data",
                                                     "is_library_indirect", "library", "id_type"):
            continue
        if p.type not in _SIMPLE: continue
        try: v = getattr(st, p.identifier)
        except Exception: continue
        if p.type == 'FLOAT' and getattr(p, "array_length", 0): v = tuple(round(float(x), 6) for x in v)
        elif p.type == 'FLOAT': v = round(float(v), 6)
        elif p.type in ('INT', 'BOOLEAN') and getattr(p, "array_length", 0): v = tuple(v)
        elif p.type == 'ENUM' and p.is_enum_flag: v = tuple(sorted(v))
        _h(hs, p.identifier, v)

def _socket_val(s):
    v = getattr(s, "default_value", None)
    if v is None: return None
    if isinstance(v, str): return v
    try: return tuple(round(float(x), 6) for x in v)
    except (TypeError, ValueError):
        if isinstance(v, float): return round(v, 6)
        if isinstance(v, bpy.types.ID): return v.name
        return v

def _tree(hs, nt, seen):
    if nt is None or nt.name in seen: return
    seen.add(nt.name); _h(hs, "tree", nt.bl_idname)
    for n in sorted(nt.nodes, key=lambda n: n.name):
        _h(hs, n.name, n.bl_idname); _rna(hs, n)
        for s in n.inputs: _h(hs, s.identifier, s.is_linked, _socket_val(s))
        if getattr(n, "color_ramp", None) is not None:
            cr = n.color_ramp; _h(hs, cr.interpolation, cr.color_mode, [(round(e.position, 6), tuple(round(c, 6) for c in e.color)) for e in cr.elements])
        if getattr(n, "mapping", None) is not None:
            try: _h(hs, [[(round(p.location[0], 6), round(p.location[1], 6)) for p in c.points] for c in n.mapping.curves])
            except Exception: pass
        if getattr(n, "node_tree", None) is not None: _tree(hs, n.node_tree, seen)
        if getattr(n, "image", None) is not None: _h(hs, n.image.name, n.image.filepath, tuple(n.image.size))
        if getattr(n, "object", None) is not None: _h(hs, "obj", n.object.name)
    for l in nt.links:
        _h(hs, l.from_node.name, l.from_socket.identifier, l.to_node.name, l.to_socket.identifier, l.is_muted)

def _faces_canonical(co, lv, lt):
    """Polygons as vertex-position rings, each started at its lowest vertex and the list sorted: independent of polygon
    and loop order (bmesh.ops.create_uvsphere, used for core's moon, orders its faces differently from run to run)."""
    if len(lt) == 0: return np.zeros(0)
    rank = np.empty(len(co), np.int64); rank[np.lexsort(co.T[::-1])] = np.arange(len(co))
    # equal positions get equal ranks
    srt = co[np.lexsort(co.T[::-1])]; same = np.r_[False, (srt[1:] == srt[:-1]).all(1)]
    grp = np.cumsum(~same) - 1; rank = grp[rank]
    out = []
    ls = np.r_[0, np.cumsum(lt)[:-1]]
    for k in np.unique(lt):
        sel = np.nonzero(lt == k)[0]
        idx = ls[sel][:, None] + np.arange(k)[None, :]
        r = rank[lv[idx]]
        st = r.argmin(1)
        rot = (st[:, None] + np.arange(k)[None, :]) % k
        r = np.take_along_axis(r, rot, 1)
        r = r[np.lexsort(r.T[::-1])]
        out.append(np.r_[k, r.ravel()])
    return np.concatenate(out)

def material_fp(m):
    hs = hashlib.sha1(); _h(hs, m.name, tuple(round(x, 6) for x in m.diffuse_color), m.use_backface_culling)
    try: _h(hs, m.surface_render_method)
    except Exception: pass
    _tree(hs, m.node_tree, set())
    return hs.hexdigest()

def part_fp(part, col):
    """sha1 over everything of this part that the bake can see."""
    dg = bpy.context.evaluated_depsgraph_get()
    hs = hashlib.sha1(); mats = {}
    for o in sorted(col.all_objects, key=lambda o: o.name):
        _h(hs, o.name, o.type, o.hide_render, o.visible_camera, o.visible_diffuse, o.visible_glossy, o.visible_shadow,
           o.visible_transmission, o.visible_volume_scatter, o.is_shadow_catcher, o.is_holdout,
           np.round(np.array(o.matrix_world, np.float64), 6), o.parent.name if o.parent else None)
        for s in o.material_slots:
            _h(hs, s.link, s.material.name if s.material else None)
            if s.material: mats[s.material.name] = s.material
        if o.type == 'LIGHT':
            _rna(hs, o.data)
            if o.data.node_tree: _tree(hs, o.data.node_tree, set())
        elif o.type == 'FONT':
            _h(hs, o.data.body, o.data.size, o.data.extrude, o.data.offset, o.data.align_x, o.data.font.name if o.data.font else None)
        if o.type in ('MESH', 'CURVE', 'FONT'):
            for md in o.modifiers:
                _h(hs, md.type); _rna(hs, md)
                if md.type == 'NODES' and md.node_group is not None:
                    _tree(hs, md.node_group, set())
                    for it in md.node_group.interface.items_tree:
                        if getattr(it, "item_type", "") != 'SOCKET' or it.in_out != 'INPUT': continue
                        try: v = md[it.identifier]
                        except Exception: continue
                        _h(hs, it.identifier, getattr(v, "name", None) or (tuple(v) if hasattr(v, "__len__") and not isinstance(v, str) else v))
            ev = o.evaluated_get(dg)
            try: me = ev.to_mesh()
            except RuntimeError: me = None
            if me is not None:
                nv, nl, npo = len(me.vertices), len(me.loops), len(me.polygons)
                co = np.empty(nv * 3, np.float32); me.vertices.foreach_get("co", co)
                lv = np.empty(nl, np.int32); me.loops.foreach_get("vertex_index", lv)
                lt = np.empty(npo, np.int32); me.polygons.foreach_get("loop_total", lt)
                _h(hs, nv, nl, npo, co, _faces_canonical(co.reshape(-1, 3), lv, lt))
                for at in sorted(me.attributes, key=lambda x: x.name):
                    if at.name.startswith(".") or at.name == "position": continue
                    _h(hs, at.name, at.domain, at.data_type)
                    n = len(at.data)
                    key, width = {'FLOAT_VECTOR': ("vector", 3), 'FLOAT2': ("vector", 2), 'INT32_2D': ("value", 2),
                                  'FLOAT_COLOR': ("color", 4), 'BYTE_COLOR': ("color", 4), 'QUATERNION': ("value", 4),
                                  'FLOAT4X4': ("value", 16)}.get(at.data_type, ("value", 1))
                    dt = {'INT': np.int32, 'INT8': np.int32, 'INT32_2D': np.int32, 'BOOLEAN': bool}.get(at.data_type, np.float32)
                    arr = np.empty(n * width, dt)
                    try: at.data.foreach_get(key, arr); _h(hs, arr)
                    except Exception as e: _h(hs, "unhashed"); log("  (could not hash attribute %s %s: %s)" % (at.name, at.data_type, e))
                ev.to_mesh_clear()
            if o.type == 'MESH' and o.data.materials:
                for m in o.data.materials:
                    if m is not None: mats[m.name] = m
    for nm in sorted(mats): _h(hs, material_fp(mats[nm]))
    return hs.hexdigest(), sorted(mats)

# ───────────── build / update ─────────────
rebuild = {p for p in a.rebuild.split(",") if p}
t = time.time()
if os.path.exists(a.blend):
    bpy.ops.wm.open_mainfile(filepath=a.blend)
    scene = bpy.context.scene
    have = {c.name[5:] for c in bpy.data.collections if c.name.startswith("PART_")}
    rebuild |= set(PARTS) - have
    log("opened %s (%.1fs); rebuilding %s" % (os.path.basename(a.blend), time.time() - t, sorted(rebuild) or "nothing"))
    for part in sorted(rebuild & have):
        col = bpy.data.collections["PART_" + part]
        for o in list(col.all_objects): bpy.data.objects.remove(o, do_unlink=True)
        for c in list(col.children_recursive): bpy.data.collections.remove(c)
        bpy.data.collections.remove(col)
    if rebuild & have:
        bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
else:
    scene = pc.reset_scene(); rebuild = set(PARTS)
    log("no cache: building every part")
built = {}
for part in [p for p in PARTS if p in rebuild]:          # park order, as bake.py builds them
    col, dt = studio.load_part(part, scene); built[part] = round(dt, 2)
    log("built %-12s %5.1fs" % (part, dt))
bpy.context.view_layer.update()
state = dict(parts={}, built=built)
owners = {}
t = time.time()
for part in PARTS:
    fp, mats = part_fp(part, bpy.data.collections["PART_" + part])
    state["parts"][part] = dict(geo=fp)
    for m in mats: owners.setdefault(m, []).append(part)
state["shared_materials"] = {m: ps for m, ps in owners.items() if len(ps) > 1}
log("fingerprints %.1fs" % (time.time() - t))
if state["shared_materials"]: log("materials used by more than one part:", state["shared_materials"])
if not a.no_save and (built or not os.path.exists(a.blend)):
    t = time.time(); tmp = a.blend + ".tmp.blend"
    bpy.ops.wm.save_as_mainfile(filepath=tmp, compress=False, copy=True)
    os.replace(tmp, a.blend); log("saved %s %.0f MB (%.1fs)" % (os.path.basename(a.blend), os.path.getsize(a.blend) / 1e6, time.time() - t))
json.dump(state, open(a.state, "w"), indent=1)
log("done")
