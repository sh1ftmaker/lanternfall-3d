"""Top-down debug images: walk grid as background, every POI as an oriented glyph.

  python tools/guests/debugmap.py OUT_PREFIX [cx cy half_size px_per_m] ...
"""
import os, sys, json, math
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

COL = dict(bench=(80, 200, 255), stall=(255, 170, 40), queue=(255, 120, 0), view=(120, 255, 120), photo=(255, 80, 200),
           stage=(255, 255, 80), table=(200, 140, 255))

def render(nav, pois, cx, cy, half, ppm, light=None, ground=None):
    x0, y0 = cx - half, cy - half; N = int(2 * half * ppm)
    xs = x0 + (np.arange(N) + 0.5) / ppm; ys = y0 + (np.arange(N) + 0.5) / ppm
    X, Y = np.meshgrid(xs, ys[::-1])
    zA = C.nav_height(nav, X, Y)
    i, j = C.nav_ij(nav, X, Y); ok = (i >= 0) & (j >= 0) & (i < nav["w"]) & (j < nav["h"])
    zB = np.where(ok, nav["zB"][np.clip(j, 0, nav["h"] - 1), np.clip(i, 0, nav["w"] - 1)], np.nan)
    img = np.full((N, N, 3), 18, np.uint8)
    w = ~np.isnan(zA)
    shade = np.clip(70 + (np.nan_to_num(zA) * 25), 40, 200).astype(np.uint8)
    img[w] = np.stack([shade[w] * 0.55, shade[w] * 0.6, shade[w] * 0.7], -1).astype(np.uint8)
    img[~np.isnan(zB)] = (120, 90, 60)
    im = Image.fromarray(img); d = ImageDraw.Draw(im)
    def P(x, y): return ((x - x0) * ppm, (y0 + 2 * half - y) * ppm)
    s = max(3.0, ppm * 0.35)
    for p in pois:
        if abs(p["x"] - cx) > half + 2 or abs(p["y"] - cy) > half + 2: continue
        c = COL.get(p["type"], (255, 255, 255)); x, y = P(p["x"], p["y"])
        fx, fy = math.cos(p["yaw"]), math.sin(p["yaw"])
        if p["type"] == "bench":
            L = p.get("len", 0.6) / 2; rx, ry = fy, -fx
            a = P(p["x"] - rx * L, p["y"] - ry * L); b = P(p["x"] + rx * L, p["y"] + ry * L)
            d.line([a, b], fill=c, width=max(1, int(ppm * 0.25)))
            if "ax" in p: d.ellipse([P(p["ax"], p["ay"])[0] - 2, P(p["ax"], p["ay"])[1] - 2, P(p["ax"], p["ay"])[0] + 2, P(p["ax"], p["ay"])[1] + 2], outline=c)
        else:
            d.ellipse([x - s / 2, y - s / 2, x + s / 2, y + s / 2], outline=c, width=1)
        e = P(p["x"] + fx * max(0.8, 6 / ppm), p["y"] + fy * max(0.8, 6 / ppm))
        d.line([(x, y), e], fill=(255, 255, 255) if p["type"] == "bench" else c, width=1)
        if p["type"] in ("stall", "queue") and "qyaw" in p:
            q = P(p["x"] + math.cos(p["qyaw"]) * p.get("qlen", 2), p["y"] + math.sin(p["qyaw"]) * p.get("qlen", 2))
            d.line([(x, y), q], fill=(255, 60, 0), width=1)
    return im

if __name__ == "__main__":
    nav = C.load_nav()
    g = json.load(open(os.path.join(C.REPO, "data", "guests.json")))
    out = sys.argv[1]; a = sys.argv[2:]
    if not a:
        render(nav, g["pois"], 35, 0, 312, 2).save(out + "_all.png")
    for k in range(0, len(a), 4):
        cx, cy, half, ppm = map(float, a[k:k + 4])
        render(nav, g["pois"], cx, cy, half, ppm).save(out + "_%d_%d.png" % (cx, cy))
