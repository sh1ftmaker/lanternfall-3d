"""Lamp shape for the Cycles bakes (bake.py, ground.py): the skill's look.md item 2.

- a soft near field: Light Falloff "Smooth" = soft^2, so a lamp's light falls as 1 / (d^2 + soft^2) instead of 1 / d^2 and
  walls and posts right beside a lamp do not burn out;
- capped upward light: point lamps and lanterns send only `cap` of their light upward (a lantern has a roof), so
  facades are not lit to the eaves. Washes, up-lights, signs and spots keep their shape (UPLIGHT, by name).
"""
import re
UPLIGHT = re.compile(r"wash|uplight|_up_|flood|beacon|glow|key|spire_gal|dome|tower|pegasus|topiary|exedra|fountain|"
                     r"crown|capsule|torii|pagoda|hall_roof|sign|_S$|_spot")

def lamp_shape(li, name, soft, cap):
    """(soft radius, upward share) the bake gives this light"""
    if li.type not in ('POINT', 'SPOT'): return 0.0, 1.0
    up = cap if (li.type == 'POINT' and not UPLIGHT.search(name)) else 1.0
    return soft, up

def shape_lights(scene, soft_r, cap):
    n = [0, 0]
    for o in scene.objects:
        if o.type != 'LIGHT': continue
        soft, up = lamp_shape(o.data, o.name, soft_r, cap)
        if soft <= 0 and up >= 1: continue
        li = o.data; li.use_nodes = True; nt = li.node_tree; nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputLight"); em = nt.nodes.new("ShaderNodeEmission"); nt.links.new(em.outputs[0], out.inputs[0])
        fo = nt.nodes.new("ShaderNodeLightFalloff"); fo.inputs["Strength"].default_value = 1.0; fo.inputs["Smooth"].default_value = soft * soft
        if up < 1:
            # Geometry Normal in a light shader = direction of the emitted ray: full strength downward, `up` upward,
            # blended across the horizon (z -0.2 .. 0.2)
            geo = nt.nodes.new("ShaderNodeNewGeometry"); sep = nt.nodes.new("ShaderNodeSeparateXYZ"); nt.links.new(geo.outputs["Normal"], sep.inputs[0])
            mr = nt.nodes.new("ShaderNodeMapRange"); mr.inputs["From Min"].default_value = -0.2; mr.inputs["From Max"].default_value = 0.2
            mr.inputs["To Min"].default_value = 1.0; mr.inputs["To Max"].default_value = up; nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
            mul = nt.nodes.new("ShaderNodeMath"); mul.operation = 'MULTIPLY'
            nt.links.new(fo.outputs["Quadratic"], mul.inputs[0]); nt.links.new(mr.outputs[0], mul.inputs[1]); nt.links.new(mul.outputs[0], em.inputs["Strength"])
            n[1] += 1
        else:
            nt.links.new(fo.outputs["Quadratic"], em.inputs["Strength"])
        n[0] += 1
    return "lamp shape: %d lights with a %.2f m soft near field, %d of them capped to %.0f %% upward" % (n[0], soft_r, n[1], cap * 100)
