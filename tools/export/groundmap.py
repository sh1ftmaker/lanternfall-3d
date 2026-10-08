"""Ground maps, stage 2 (numpy, run by pack.py): NPZ_DIR/ground_raw.npz (web_export/ground.py) -> OUT/ground.bin.

Per texel two bytes, R = contact occlusion (Cycles AO, 1 m rays), G = lamp-shadow detail: the share of lamp light that
arrives (v = shadowed / unshadowed), deepened against a 1.5 m blur of itself, c = clamp(v / (0.95 vb), 0, 1). The
vertex bake already holds shadows as large as its ground vertices are apart; c only adds what is smaller (bench legs,
lamp posts, railings) and is 1 where lamps hardly reach (there v is noise). Tiles where both stay near 1 are left out
(the viewer reads 1 for them). The viewer (fx/light/ground.js) gates the maps to up-facing pixels at the walk-grid
height, so bench seats and balconies above the ground are left alone.

ground.bin = gzip of two planes, R then G, each the kept tiles (manifest.ground.tiles order) of tile x tile bytes, rows
along Blender +y; values in steps of 4/255, 255 = 1 (no effect). ground_lo.bin: the same at half resolution.
"""
import os, json, gzip, math
import numpy as np

QSTEP = 4

def build(src, out, log=print, keep_tol=0.04):
    f = os.path.join(src, "ground_raw.npz")
    if not os.path.exists(f): return None
    from scipy import ndimage
    d = np.load(f); meta = json.loads(str(d["meta"])); K = meta["tile"]; TX, TY = meta["tx"], meta["ty"]
    tiles = d["tiles"]; n = len(tiles)
    G = lambda name, fill: _assemble(d[name].astype(np.float32), tiles, K, TX, TY, fill)
    ao = G("ao", 1.0); sh = G("sh", 0.0); un = G("un", 0.0); fz = G("fz", np.nan)
    valid = ~np.isnan(fz)
    v = np.where(un > 1e-4, sh / np.maximum(un, 1e-6), 1.0).clip(0, 1)
    v = ndimage.uniform_filter(v, 3)                                     # the last of the light-sampling noise
    tex = meta["texel"]
    sig = 1.5 / tex / 2.0
    w = ndimage.gaussian_filter(valid.astype(np.float32), sig)
    vb = ndimage.gaussian_filter(np.where(valid, v, 0), sig) / np.maximum(w, 1e-3)
    c = np.clip(v / np.maximum(0.95 * vb, 1e-3), 0, 1)
    lit = np.clip((un - 0.01) / 0.03, 0, 1)                             # where lamps hardly reach, v is noise: c -> 1
    c = 1 - (1 - c) * lit
    ao = ndimage.uniform_filter(np.where(valid, ao, 1.0), 3)             # the skill's 3 x 3 blur
    ao = np.where(valid, ao, 1.0); c = np.where(valid, c, 1.0)
    # snap what is within a few % of 1 to 1: invisible, and it is most of the ground (the file shrinks by half or more)
    ao = np.where(ao > 0.97, 1.0, ao); c = np.where(c > 0.95, 1.0, c)
    keep = []; blobs = []
    for k, (ty, tx) in enumerate(tiles):
        A = ao[ty * K:(ty + 1) * K, tx * K:(tx + 1) * K]; C = c[ty * K:(ty + 1) * K, tx * K:(tx + 1) * K]
        if (A < 1 - keep_tol).mean() < 0.002 and (C < 1 - keep_tol).mean() < 0.002: continue
        keep.append(int(ty * TX + tx))
        blobs.append(np.stack([A, C], 0))
    def enc(tl):          # steps of 4/255 (1 stays 1), planar: every tile's R, then every tile's G (gzips 25 % smaller)
        q = np.round(np.stack(tl, 1) * 255.0)
        q = np.where(q >= 254.5, 255, np.minimum(np.round(q / QSTEP) * QSTEP, 252)).astype(np.uint8)
        return q.tobytes()
    raw = enc(blobs) if blobs else b""; gz = gzip.compress(raw, 9, mtime=0)
    open(os.path.join(out, "ground.bin"), "wb").write(gz)
    # phones: the same tiles at half resolution (2 x 2 means)
    Kh = K // 2
    lo = enc([b.reshape(2, Kh, 2, Kh, 2).mean((2, 4)) for b in blobs]) if blobs else b""
    gzl = gzip.compress(lo, 9, mtime=0); open(os.path.join(out, "ground_lo.bin"), "wb").write(gzl)
    # three.js: x = Blender x, z = -Blender y
    g = dict(file="ground.bin", bytes=len(gz), raw=len(raw), texel=tex, tile=K, x0=meta["x0"], y0=meta["y0"], tx=TX, ty=TY,
             tiles=keep, lo=dict(file="ground_lo.bin", bytes=len(gzl), raw=len(lo), tile=Kh), axes="tile (tx, ty) covers Blender x0 + tx*tile*texel .., y0 + ty*tile*texel ..; three.js z = -Blender y")
    log("ground maps: %d of %d tiles kept (%.0f m texels %.1f cm), %.1f MB raw -> %.2f MB gz; GPU RG8 %.1f MB; half res %.2f MB gz, %.1f MB GPU" % (
        len(keep), n, K * tex, tex * 100, len(raw) / 1e6, len(gz) / 1e6, len(raw) / 1e6, len(gzl) / 1e6, len(lo) / 1e6))
    return g

def _assemble(arr, tiles, K, TX, TY, fill):
    out = np.full((TY * K, TX * K), fill, np.float32)
    for k, (ty, tx) in enumerate(tiles): out[ty * K:(ty + 1) * K, tx * K:(tx + 1) * K] = arr[k]
    return out

if __name__ == "__main__":
    import sys
    print(build(sys.argv[1], sys.argv[2]))
