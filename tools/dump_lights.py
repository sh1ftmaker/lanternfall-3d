"""Dump every Blender point/spot/sun/area light of the park (world space, Blender axes) to JSON.

  blender -b -P tools/dump_lights.py -- --out lights_blender.json [--parts core,transit,...]
Builds the parts exactly as web_export/bake.py does (studio.load_part), no baking.
"""
import sys, os, json, math, argparse
BP = os.environ.get("BLENDER_PARK", "/home/zalo/Work/nocturne-lands/Blender-Park"); sys.path.insert(0, BP)
import bpy
import park_common as pc, studio
ap = argparse.ArgumentParser(); ap.add_argument("--out", required=True); ap.add_argument("--parts", default=",".join(pc.ALL_PARTS))
a = ap.parse_args(sys.argv[sys.argv.index("--") + 1:])
scene = pc.reset_scene()
cols = {}
for part in [p for p in a.parts.split(",") if p]:
    cols[part], dt = studio.load_part(part, scene); print("[lights] built", part, "%.1fs" % dt, flush=True)
pc.setup_world(scene)
bpy.context.view_layer.update()
out = []
for o in bpy.context.scene.objects:
    if o.type != 'LIGHT': continue
    li = o.data; M = o.matrix_world
    part = next((p for p, c in cols.items() if o.name in c.all_objects), "world")
    d = dict(name=o.name, part=part, type=li.type, pos=list(M.translation), color=list(li.color), energy=float(li.energy),
             radius=float(getattr(li, "shadow_soft_size", 0.0)), hidden=bool(o.hide_render))
    dirv = (M.to_3x3() @ __import__("mathutils").Vector((0, 0, -1))).normalized(); d["dir"] = list(dirv)
    if li.type == 'SPOT': d["spot_size"] = float(li.spot_size); d["spot_blend"] = float(li.spot_blend)
    if li.type == 'SUN': d["angle"] = float(li.angle)
    if li.type == 'AREA': d["size"] = float(li.size)
    out.append(d)
json.dump(out, open(a.out, "w"), indent=0)
from collections import Counter
print("[lights] wrote %d lights %s" % (len(out), dict(Counter(d["type"] for d in out))), flush=True)
