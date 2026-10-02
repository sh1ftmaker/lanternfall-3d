"""Generate data/guests.json, data/guestlight.bin, data/guestground.bin for the park guests.

  uv run --no-project --with numpy --with scipy --with pillow python tools/guests/build.py [--only light,pois] [--debug DIR]

Reads the baked dumps ($GUESTS_NPZ, read-only) and data/nav.bin + data/manifest.json. See tools/guests/FORMAT.md.
"""
import os, sys, json, gzip, time, math
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

T0 = time.time()
def log(*a): print("[guests %5.1fs]" % (time.time() - T0), *a, flush=True)
def opt(k, d=None): return sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
OUT = os.path.join(C.REPO, "data")
DBG = opt("--debug")
if DBG: os.makedirs(DBG, exist_ok=True)

def rnd(v, k=2): return float(round(float(v), k))

def write_light(nav):
    import light as LT
    res = LT.build(nav, log=log)
    v = res[0]["val"]                                     # level A, (450, 620, 3) at 1 m
    H, W = v.shape[:2]
    from scipy import ndimage
    near = ndimage.binary_dilation(res[0]["walk"] | res[1]["walk"], iterations=2)     # keep 2 m around every walkable cell
    enc = C.rgbm_ladder(v.reshape(-1, 3)); enc[~near.reshape(-1)] = 0
    gz = gzip.compress(enc.tobytes(), 9)
    open(os.path.join(OUT, "guestlight.bin"), "wb").write(gz)
    log("guestlight.bin: %dx%d RGBM8, %d bytes" % (W, H, len(gz)))
    if DBG: np.save(os.path.join(DBG, "light.npy"), v)
    return dict(file="guestlight.bin", w=W, h=H, x0=nav["x0"], y0=nav["y0"], cell=1.0, range=C.RANGE, bytes=len(gz)), res

def poi_out(p):
    o = dict(type=p["type"], x=rnd(p["x"]), y=rnd(p["y"]), z=rnd(p["z"]), yaw=rnd(p["yaw"], 3), land=p["land"], cap=int(p["cap"]))
    for k in ("name",):
        if p.get(k): o[k] = p[k]
    for k in ("len", "ax", "ay", "qyaw", "qlen", "r"):
        if k in p and p[k] is not None: o[k] = rnd(p[k], 3 if k == "qyaw" else 2)
    if p.get("rail"): o["rail"] = 1
    if p.get("tag"): o["tag"] = p["tag"]
    return o

def main():
    nav = C.load_nav()
    out = dict(version=1, frame="blender", pois=[])
    old = os.path.join(OUT, "guests.json")
    only = (opt("--only") or "light,pois,ground").split(",")
    prev = json.load(open(old)) if os.path.exists(old) else {}
    if "light" in only: out["light"], _ = write_light(nav)
    elif "light" in prev: out["light"] = prev["light"]
    if "pois" in only:
        import geo as G, benches as Bn
        geo = G.Geo(log=log)
        pois = Bn.extract(geo, nav, log=log)
        try:
            import places as PL
            pois += PL.extract(geo, nav, log=log)
        except ImportError: pass
        out["pois"] = [poi_out(p) for p in pois]
        if DBG:
            import pickle; pickle.dump(pois, open(os.path.join(DBG, "pois.pkl"), "wb"))
    else: out["pois"] = prev.get("pois", [])
    if "ground" in only:
        try:
            import ground as GR
            out["ground"] = GR.write(nav, OUT, log=log)
            import paths as PA
            gr = np.frombuffer(gzip.decompress(open(os.path.join(OUT, "guestground.bin"), "rb").read()), np.uint8).reshape(nav["h"], nav["w"])
            out["paths"] = PA.build(nav, gr, GR.CLASSES, log=log)
        except ImportError: pass
    elif "ground" in prev: out["ground"] = prev["ground"]
    for k in ("paths",):
        if k in prev and k not in out: out[k] = prev[k]
    s = json.dumps(out, separators=(",", ":"))
    open(old, "w").write(s)
    from collections import Counter
    log("guests.json: %d bytes, %d pois: %s" % (len(s), len(out["pois"]), dict(Counter(p["type"] for p in out["pois"]))))

main()
