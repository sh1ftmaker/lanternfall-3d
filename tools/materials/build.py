"""Bake the park's tiling surface materials into one KTX2 texture array (fx/light/materials.js).

  uv run --no-project --with numpy python tools/materials/build.py SKILL_PROJECT_DIR OUT_DIR [--res 256 (512,256 for both)] [--only a,b]
         [--ktx PATH_TO_ktx] [--png]

The generators are the LanternTown skill's procedural PBR materials (SKILL_PROJECT_DIR/materials/<name>.py on its numpy
toolkit tk/tex.py; plain numpy, no Blender needed: the toolkit package's __init__ imports bpy helpers, so tk.tex is
loaded on its own). Each layer of the array holds one material tile, square in texels whatever its size in metres:

  R  albedo luminance ratio (luminance / layer mean, x AO^0.7), stored as sqrt(ratio / 4) so dark joints keep precision
  G  normal x, B normal y (tangent space, 0.5 = flat; U along the material's "along", V up)
  A  roughness

Colour is left to the park's vertex albedo (the theme colours); the texture only modulates it (the skill's
`albedo * tint / mean_albedo`, on luminance). OUT_DIR/mat<res>.ktx2 (UASTC + zstd, mipmapped, linear) per size,
OUT_DIR/mat.json with the layer order, tile sizes and stats. --png also writes OUT_DIR/png/ previews for review.
"""
import sys, os, json, time, types, importlib.util, subprocess, tempfile, shutil
import numpy as np

# the park's layers: name, tile (m) override or None (catalog tile)
LAYERS = [
    ("cobble_granite", None), ("sett_basalt", None), ("flagstone_york", None), ("gravel", None), ("soil", None),
    ("ashlar_limestone", None), ("rubble_fieldstone", None), ("brick_red", None), ("plaster_lime", None),
    ("roof_tile_clay", None), ("roof_slate", None), ("wood_shingle", None), ("wood_planks", None),
    ("wood_weathered", None), ("hedge", None), ("moss", None), ("bark", None), ("stone_smooth", None), ("slate", None),
]


def opt(a, k, d=None):
    return a[a.index(k) + 1] if k in a else d


def load_tex(proj):
    pkg = types.ModuleType("tk"); pkg.__path__ = [os.path.join(proj, "tk")]; sys.modules["tk"] = pkg
    spec = importlib.util.spec_from_file_location("tk.tex", os.path.join(proj, "tk", "tex.py"))
    tex = importlib.util.module_from_spec(spec); sys.modules["tk.tex"] = tex; spec.loader.exec_module(tex)
    return tex


def resample(a, n):
    """periodic box/bilinear resample of (h,w[,c]) to (n,n[,c])"""
    h, w = a.shape[:2]
    def axis(x, m, ax):
        L = x.shape[ax]
        if L == m: return x
        if L % m == 0:   # box down
            sh = list(x.shape); sh[ax:ax + 1] = [m, L // m]; return x.reshape(sh).mean(ax + 1)
        c = (np.arange(m) + 0.5) * L / m - 0.5; i0 = np.floor(c).astype(int); f = (c - i0).astype(np.float32)
        a0 = np.take(x, i0 % L, axis=ax); a1 = np.take(x, (i0 + 1) % L, axis=ax)
        sh = [1] * x.ndim; sh[ax] = m; f = f.reshape(sh)
        return a0 * (1 - f) + a1 * f
    return axis(axis(a, n, 0), n, 1)


def main():
    a = sys.argv[1:]
    proj, out = a[0], a[1]
    sizes = [int(s) for s in opt(a, "--res", "256").split(",")]
    only = opt(a, "--only"); ktx = opt(a, "--ktx")
    os.makedirs(out, exist_ok=True)
    tex = load_tex(proj)
    cat = {m["name"]: m for m in json.load(open(os.path.join(proj, "docs", "materials.json")))["materials"]}
    big = max(sizes)
    layers, info = [], []
    for name, tile in LAYERS:
        if only and name not in only.split(","): continue
        t0 = time.time()
        spec = importlib.util.spec_from_file_location("mat_" + name, os.path.join(proj, "materials", name + ".py"))
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        meta = dict(cat.get(name, {})); meta.update(getattr(mod, "META", {}))
        tl = tile or meta.get("tile", 1.0); tl = (tl, tl) if isinstance(tl, (int, float)) else tuple(tl)
        # bake at >= 1 mm-ish texels where cheap, square pixel grid in metres, then resample to big x big
        base = int(min(1024, max(big, 2 ** round(np.log2(max(tl) / 0.0025)))))
        t = tex.Canvas((base, max(4, int(round(base * tl[1] / tl[0] / 4)) * 4)), tl, seed=meta.get("seed", 1))
        maps = mod.build(t)
        alb = np.clip(tex._full(t, maps["albedo"], 3), 0, 1)
        hgt = tex._full(t, maps.get("height", 0.0))
        rgh = np.clip(tex._full(t, maps.get("rough", 0.7)), 0.03, 1)
        nrm = t.normal(hgt, float(meta.get("normal_strength", 1.0)))
        hr = float(hgt.max() - hgt.min())
        ao = np.clip(tex._full(t, maps["ao"]), 0, 1) if maps.get("ao") is not None else \
            t.ao(hgt, radius=float(meta.get("ao_radius", max(hr * 2.0, 0.003))), strength=float(meta.get("ao_strength", 1.0)))
        lum = (alb * np.array([0.2126, 0.7152, 0.0722], np.float32)).sum(-1) * ao ** 0.7
        mean = alb.reshape(-1, 3).mean(0); ml = float(lum.mean())
        ratio = lum / max(ml, 1e-4)
        L = resample(ratio, big); N = resample(nrm, big); R = resample(rgh, big)
        N = N / np.maximum(np.linalg.norm(N, axis=-1, keepdims=True), 1e-6)
        rgba = np.stack([np.sqrt(np.clip(L / 4.0, 0, 1)), N[..., 0] * 0.5 + 0.5, N[..., 1] * 0.5 + 0.5, R], -1)
        layers.append(np.clip(rgba * 255 + 0.5, 0, 255).astype(np.uint8))
        info.append(dict(name=name, tile=[float(tl[0]), float(tl[1])], mean=[round(float(c), 4) for c in mean],
                         ratio_p5_p95=[round(float(np.percentile(ratio, 5)), 3), round(float(np.percentile(ratio, 95)), 3)],
                         rough=round(float(R.mean()), 3), msq=round(float(4 * np.sqrt(np.clip(L / 4.0, 0, 1)).mean() ** 2), 4), height_m=round(hr, 4), bake_px=[t.w, t.h], s=round(time.time() - t0, 1)))
        print("%-18s tile %.2fx%.2f  bake %dx%d  ratio p5-p95 %.2f-%.2f  rough %.2f  %.1fs" % (name, tl[0], tl[1], t.w, t.h,
              *info[-1]["ratio_p5_p95"], info[-1]["rough"], info[-1]["s"]), flush=True)
        if "--png" in a:
            os.makedirs(os.path.join(out, "png"), exist_ok=True)
            tex.write_png(os.path.join(out, "png", name + ".png"), layers[-1])
            col = tex._u8(tex.lin2srgb(resample(alb, big)))
            tex.write_png(os.path.join(out, "png", name + "_albedo.png"), col)
    stack = np.stack(layers)
    np.save(os.path.join(out, "layers.npy"), stack) if "--npy" in a else None
    files = {}
    if ktx:
        tmp = tempfile.mkdtemp()
        for n in sizes:
            paths = []
            for i, l in enumerate(stack):
                p = os.path.join(tmp, "l%02d_%d.png" % (i, n)); tex.write_png(p, np.clip(resample(l.astype(np.float32), n) + 0.5, 0, 255).astype(np.uint8)); paths.append(p)
            dst = os.path.join(out, "mat%d.ktx2" % n)
            env = dict(os.environ, LD_LIBRARY_PATH=os.path.join(os.path.dirname(os.path.dirname(ktx)), "lib"))
            subprocess.run([ktx, "create", "--format", "R8G8B8A8_UNORM", "--assign-tf", "linear", "--layers", str(len(paths)),
                            "--generate-mipmap", "--encode", "uastc", "--uastc-quality", "2", "--uastc-rdo", "--uastc-rdo-l", opt(a, "--rdo", "1.0"),
                            "--zstd", "18"] + paths + [dst], check=True, env=env)
            files[str(n)] = dict(file="mat%d.ktx2" % n, bytes=os.path.getsize(dst))
            print("wrote", dst, os.path.getsize(dst), "bytes", flush=True)
        shutil.rmtree(tmp)
    json.dump(dict(format="R=sqrt(lumRatio/4) G,B=normal xy A=roughness", layers=info, files=files), open(os.path.join(out, "mat.json"), "w"), indent=1)


main()
