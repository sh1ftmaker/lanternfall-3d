"""Surface type per walk cell -> data/guestground.bin (gzip of a w*h uint8 grid, the nav grid's cells)."""
import os, re, gzip
import numpy as np
import common as C

CLASSES = ["none", "paved", "lawn", "bed", "gravel", "wood", "snow", "ice", "floor", "stairs", "bridge", "pier", "water"]
K = {n: i for i, n in enumerate(CLASSES)}
MAT = [  # (regex on the material name without the part prefix, class); first match wins
    (r"water|pool|basin", "water"),
    (r"snow", "snow"), (r"ice|rink|frozen", "ice"),
    (r"earth|dirt", "gravel"),
    (r"flower|rose_|rosebed|bed|soil|shrub|hedge|leaf|boxwood|topiary|blossom|moss|reed", "bed"),
    (r"grass|lawn|turf", "lawn"),
    (r"gravel|sand|straw", "gravel"),
    (r"boardwalk|wharf|deck|plank|wood|timber|pile|tar_board", "wood"),
    (r"carpet|floor|tactile|platform|dance|tile|tatami|escalator", "floor"),
    (r"pave|paving|cobble|flag|plaza|prom|stone|kerb|terrace|court|concrete|quay|asphalt|road|inlay|coping|marble|esplanade|slab|ground|stucco", "paved"),
]
OBJ = [(r"bridge", "bridge"), (r"pier|jetty|gangway|pontoon", "pier")]

def mat_kind(name, part):
    n = C.strip(name, part)
    for rx, k in MAT:
        if re.search(rx, n): return K[k]
    return K["paved"]

def write(nav, out_dir, log=print, dens=0.03):
    H, W = nav["h"], nav["w"]; NK = len(CLASSES)
    acc = np.zeros((H * W, NK), np.float32)
    rng = np.random.default_rng(5)
    for part in C.PARTS:
        r = C.load_part(part); P = r["P"]; nz = r["n"][:, 2]
        mk = np.array([mat_kind(m["name"], part) for m in r["mats"]])
        ok_obj = np.zeros(len(r["names"]), np.int64)
        for i, nm in enumerate(r["names"]):
            for rx, k in OBJ:
                if re.search(rx, C.strip(nm, part)): ok_obj[i] = K[k]; break
        sel = np.nonzero(nz > 0.7)[0]
        kind = mk[r["mi"][sel]]
        ov = ok_obj[r["oid"][sel]]
        kind = np.where((ov > 0) & (kind != K["water"]), ov, kind)
        Pt = P[sel]; area = r["area"][sel]
        n = np.minimum(np.ceil(area / dens).astype(np.int64) + 1, 3000)
        for s in range(0, len(Pt), 100000):
            Pb = Pt[s:s + 100000]; nb = n[s:s + 100000]; kb = kind[s:s + 100000]; ab = area[s:s + 100000]
            idx = np.repeat(np.arange(len(Pb)), nb)
            u = rng.random(len(idx)); v = rng.random(len(idx)); fl = u + v > 1; u = np.where(fl, 1 - u, u); v = np.where(fl, 1 - v, v)
            pts = Pb[idx, 0] * (1 - u - v)[:, None] + Pb[idx, 1] * u[:, None] + Pb[idx, 2] * v[:, None]
            ix = np.floor((pts[:, 0] - nav["x0"]) / nav["cell"]).astype(np.int64); iy = np.floor((pts[:, 1] - nav["y0"]) / nav["cell"]).astype(np.int64)
            ok = (ix >= 0) & (iy >= 0) & (ix < W) & (iy < H)
            ix, iy, pts, idx = ix[ok], iy[ok], pts[ok], idx[ok]
            zl = nav["zA"][iy, ix]
            m = ~np.isnan(zl) & (np.abs(pts[:, 2] - zl) < 0.06)
            c = iy[m] * W + ix[m]
            np.add.at(acc, (c, kb[idx[m]]), (ab / nb)[idx[m]])
    g = acc.argmax(1).astype(np.uint8)
    walk = ~np.isnan(nav["zA"]).reshape(-1)
    known = acc.max(1) > 0
    from scipy import ndimage           # cells without a sample at the walk height (sloped terrain): nearest sampled class
    _, (jj, ii) = ndimage.distance_transform_edt(~known.reshape(H, W), return_indices=True)
    g = g.reshape(H, W)[jj, ii].reshape(-1)
    g[~walk] = K["none"]
    # stairs: walk cells whose height steps 0.08..0.35 m to a neighbour on both sides of one axis (a flight of steps)
    z = nav["zA"]
    st = np.zeros_like(walk).reshape(H, W)
    for ax in (0, 1):
        d1 = np.abs(np.diff(z, axis=ax, prepend=np.nan)); d2 = np.abs(np.diff(z, axis=ax, append=np.nan))
        step = lambda d: (d > 0.12) & (d < 0.4)
        st |= step(d1) & step(d2)
        st |= (step(d1) | step(d2)) & ((np.nan_to_num(d1) > 0.1) & (np.nan_to_num(d2) > 0.1))
    g = g.reshape(H, W); hard = (g == K["paved"]) | (g == K["wood"]) | (g == K["floor"])
    g[st & walk.reshape(H, W) & hard] = K["stairs"]
    gz = gzip.compress(g.tobytes(), 9)
    open(os.path.join(out_dir, "guestground.bin"), "wb").write(gz)
    cnt = np.bincount(g[walk.reshape(H, W)], minlength=NK)
    log("guestground.bin: %d bytes; walk cells by class: %s" % (len(gz), {CLASSES[i]: int(cnt[i]) for i in range(NK) if cnt[i]}))
    return dict(file="guestground.bin", w=W, h=H, x0=nav["x0"], y0=nav["y0"], cell=nav["cell"], classes=CLASSES, bytes=len(gz))
