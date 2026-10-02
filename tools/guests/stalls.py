"""Stall / kiosk service fronts -> stall POIs (first customer spot, facing the counter, queue direction and length).

Counters are found geometrically: up-facing surfaces 0.8-1.2 m above the nearby walk level, 0.6-5 m long, 0.2-1.3 m
deep, with a roof or canopy over them and walkable ground in front. Machines (vending, ticket machines, arcade
cabinets) are added from object names.
"""
import re, math
import numpy as np
from scipy import ndimage
import common as C

def floor_min(nav, r=4):
    z = np.where(np.isnan(nav["zA"]), 1e9, nav["zA"])
    return ndimage.minimum_filter(z, size=2 * r + 1, mode="nearest")

def rect(xy):
    """Min-area-ish rectangle by PCA: centre, unit long axis u, unit normal v, length L, depth D."""
    m = xy.mean(0); w, V = np.linalg.eigh(np.cov((xy - m).T)); u = V[:, 1]; v = np.array([-u[1], u[0]])
    pu = (xy - m) @ u; pv = (xy - m) @ v
    a0, a1 = np.percentile(pu, [0.5, 99.5]); b0, b1 = np.percentile(pv, [0.5, 99.5])
    c = m + u * (a0 + a1) / 2 + v * (b0 + b1) / 2
    return c, u, v, float(a1 - a0), float(b1 - b0)

def find_counters(geo, nav, log=print):
    fm = floor_min(nav)
    up = (geo.n[:, 2] > 0.9) & (geo.area > 0.002)
    c = geo.P.mean(1)
    i, j = C.nav_ij(nav, c[:, 0], c[:, 1]); ok = (i >= 0) & (j >= 0) & (i < nav["w"]) & (j < nav["h"])
    f = np.full(len(c), 1e9); f[ok] = fm[j[ok], i[ok]]
    rel = c[:, 2] - f
    sel = np.nonzero(up & (rel > 0.78) & (rel < 1.22))[0]
    pts, tid = geo.points(sel, 0.05)
    log("counters: %d candidate tris" % len(sel))
    # raster at 0.1 m, label
    x0, y0 = nav["x0"], nav["y0"]; cs = 0.1
    ij = np.floor((pts[:, :2] - [x0, y0]) / cs).astype(np.int64)
    W = int(nav["w"] * nav["cell"] / cs); H = int(nav["h"] * nav["cell"] / cs)
    k = (ij[:, 0] >= 0) & (ij[:, 1] >= 0) & (ij[:, 0] < W) & (ij[:, 1] < H)
    ij, pts, tid = ij[k], pts[k], tid[k]
    # label sparse occupancy via unique keys -> small dense crops would be costly; use a dense bool grid (6200x4500)
    occ = np.zeros((H, W), bool); occ[ij[:, 1], ij[:, 0]] = True
    lab, n = ndimage.label(occ, structure=np.ones((3, 3)))
    pl = lab[ij[:, 1], ij[:, 0]]
    order = np.argsort(pl); pl = pl[order]; pts = pts[order]; tid = tid[order]; ijo = ij[order]
    cut = np.searchsorted(pl, np.arange(1, n + 2))
    out = []
    for l in range(n):
        a, b = cut[l], cut[l + 1]
        if b - a < 40: continue
        P = pts[a:b]; area = len(np.unique(ijo[a:b, 0] * 100000 + ijo[a:b, 1])) * cs * cs
        if area < 0.2: continue
        cen, u, v, L, D = rect(P[:, :2])
        if not (0.6 <= L <= 6.0 and 0.18 <= D <= 1.4): continue
        if area < 0.45 * L * D: continue
        out.append(dict(c=cen, u=u, v=v, L=L, D=D, z=float(np.percentile(P[:, 2], 90)), tris=np.unique(tid[a:b])))
    log("counters: %d counter-shaped surfaces" % len(out))
    return out

def assess(geo, nav, s):
    """Roof over the counter? Which long side is the customer side? Returns dict or None."""
    cx, cy = s["c"]; u, v, L, D, zt = s["u"], s["v"], s["L"], s["D"], s["z"]
    loc, tid = geo.local_box(cx, cy, u[0], u[1], L / 2 + 0.3, D / 2 + 1.2, zt - 1.3, zt + 3.2, step=0.07)
    inn = (np.abs(loc[:, 0]) < L / 2) & (np.abs(loc[:, 1]) < D / 2 + 0.6)
    roof = inn & (loc[:, 2] > zt + 0.9) & (loc[:, 2] < zt + 3.1)
    cells = np.unique(np.floor(loc[roof, :2] / 0.2), axis=0)
    rcov = len(cells) / max(1.0, (L / 0.2) * ((D + 1.2) / 0.2))
    sides = {}
    floor = zt - 1.0
    for sg in (1, -1):
        k = np.linspace(-L / 2 * 0.7, L / 2 * 0.7, max(2, int(L / 0.4) + 1))
        fx = cx + u[0] * k + v[0] * sg * (D / 2 + 0.45); fy = cy + u[1] * k + v[1] * sg * (D / 2 + 0.45)
        h = C.nav_height(nav, fx, fy, floor, 0.35)
        walk = float(np.mean(~np.isnan(h)))
        vv = loc[:, 1] * sg
        blk = (np.abs(loc[:, 0]) < L / 2 * 0.8) & (vv > D / 2 + 0.1) & (vv < D / 2 + 0.9) & (loc[:, 2] > floor + 0.25) & (loc[:, 2] < floor + 1.7)
        bc = len(np.unique(np.floor(loc[blk, 0] / 0.1))) / max(1, L * 0.8 / 0.1)
        # how much walkable room further out (a queue / crowd area)
        room = 0
        for dd in np.arange(1.0, 4.1, 0.5):
            hh = C.nav_height(nav, cx + v[0] * sg * (D / 2 + dd), cy + v[1] * sg * (D / 2 + dd), floor, 0.5)
            if np.isnan(hh): break
            room += 1
        sides[sg] = dict(walk=walk, block=bc, room=room, h=h)
    return dict(roof=rcov, sides=sides)

# objects (prefix stripped) that sell or serve something; joined meshes (Lantern Row's market) count per counter
STALL_RX = {
    "guildhollow": r"^stall_\d|^stall$",
    "frostmere": r"^stall_(toss|ring|prize)|^cider_stand",
    "meridian": r"^kiosk_\d|^kiosk$|^vending|^ticket_machines|^arcade_cab|^capsule_store",
    "wanderers": r"^kiosk_(tickets|info)_counter|^lostfound_counter",
    "brinewatch": r"^prop_stall_|^prop_goods_|^prop_cart|^reward_hut$|^cruise_shack$|^stamp_podium$",
    "lantern-row": r"^market$|^teahouses$",
    "rosewick": r"^flower_stall|^flower_cart",
}
NAMES = [  # (regex on the full object name, human name)
    (r"frostmere_cider", "Cider stand"), (r"frostmere_stall_toss", "Frost Fair ring toss"), (r"frostmere_stall_ring", "Frost Fair ring toss"),
    (r"frostmere_stall_prize", "Frost Fair prize table"), (r"guildhollow_stall", "Guild Fair Midway stall"),
    (r"meridian_kiosk", "Snack kiosk"), (r"meridian_vending", "Vending wall"), (r"meridian_ticket", "Ticket machines"),
    (r"meridian_arcade", "Arcade cabinet"), (r"meridian_capsule", "Capsule store"),
    (r"wanderers_kiosk_tickets", "Ticket kiosk"), (r"wanderers_kiosk_info", "Information kiosk"), (r"wanderers_lostfound", "The Lost & Found"),
    (r"brinewatch_reward", "Bounty reward hut"), (r"brinewatch_cruise_shack", "Harbor Cruise tickets"), (r"brinewatch_stamp", "Bounty stamp podium"),
    (r"brinewatch_prop_(stall|goods)", "Rogues' market stall"), (r"brinewatch_prop_cart", "Market cart"),
    (r"lantern_row_market", "Night Market stall"), (r"lantern_row_teahouses", "Lakeside stall"),
    (r"rosewick_flower_stall", "Florist"), (r"rosewick_flower_cart", "Flower cart"),
]

def nice(name):
    for rx, n in NAMES:
        if re.search(rx, name): return n
    return None

def front_side(geo, nav, s):
    cx, cy = s["c"]; u, v, L, D, zt = s["u"], s["v"], s["L"], s["D"], s["z"]
    loc, _ = geo.local_box(cx, cy, u[0], u[1], L / 2 + 0.3, D / 2 + 1.2, zt - 1.3, zt + 3.2, step=0.06)
    a = assess(geo, nav, s); res = {}
    ub = max(1, L * 0.8 / 0.1)
    for sg in (1, -1):
        vv = loc[:, 1] * sg; uu = np.abs(loc[:, 0]) < L / 2 * 0.8
        panel = uu & (vv > D / 2 - 0.3) & (vv < D / 2 + 0.15) & (loc[:, 2] > zt + 0.15) & (loc[:, 2] < zt + 1.1)
        over = uu & (vv > D / 2 + 0.15) & (vv < D / 2 + 0.8) & (loc[:, 2] > zt + 0.9)
        sd = a["sides"][sg]
        r = dict(panel=len(np.unique(np.floor(loc[panel, 0] / 0.1))) / ub, over=len(np.unique(np.floor(loc[over, 0] / 0.1))) / ub, **sd)
        r["score"] = 1.0 * r["walk"] - 1.5 * r["panel"] + 0.8 * r["over"] - 1.0 * r["block"] + 0.08 * r["room"]
        res[sg] = r
    sg = 1 if res[1]["score"] >= res[-1]["score"] else -1
    return sg, res, a["roof"]

def queue_line(nav, x, y, z, dx, dy, step=0.7, nmax=8):
    """Walkable places in a straight line from the first customer outward. Returns count (>= 1 if the first spot is ok)."""
    n = 0
    for k in range(nmax):
        px, py = x + dx * step * k, y + dy * step * k
        ok = True
        for ox, oy in ((0, 0), (0.25 * dy, -0.25 * dx), (-0.25 * dy, 0.25 * dx)):
            if np.isnan(C.nav_height(nav, px + ox, py + oy, z, 0.35)): ok = False
        if not ok: break
        n += 1
    # (crowd-geo) a queue keeps to its own half of a lane: when something stands across the way within 12 m (stalls on
    # the far side of a market aisle, a house front), the line stops 0.8 m short of the middle so walkers keep a lane
    free = 0.0
    while free < 12.0 and not np.isnan(C.nav_height(nav, x + dx * free, y + dy * free, z, 0.35)): free += 0.25
    if free < 12.0: n = min(n, 1 + int(max(0.0, free / 2 - 0.8) / step))
    return n

def extract(geo, nav, log=print):
    counters = find_counters(geo, nav, log=log)
    out = []; used_objs = set(); rejected = []
    for s in counters:
        names = [geo.name(t) for t in s["tris"]]
        from collections import Counter
        top = Counter(names).most_common()
        hit = None
        for nm, _ in top:
            part = geo.parts[geo.part[s["tris"][0]]]
            for k, p in enumerate(geo.parts):
                if nm.startswith(p.replace("-", "_") + "_"): part = p
            if re.search(STALL_RX.get(part, r"^$"), C.strip(nm, part)): hit = (part, nm); break
        if not hit: continue
        part, nm = hit
        sg, res, roof = front_side(geo, nav, s)
        r = res[sg]
        cx, cy = s["c"]; v = s["v"] * sg; u = s["u"]
        if re.search(r"prop_goods", nm) and roof < 0.5: continue          # fish crates on the quay, not a stall
        spot = None
        for d in (0.35, 0.5, 0.65, 0.8, 1.0, 1.2):
            for o in (0.0, -0.25 * s["L"], 0.25 * s["L"]):
                fx, fy = cx + v[0] * (s["D"] / 2 + d) + u[0] * o, cy + v[1] * (s["D"] / 2 + d) + u[1] * o
                fz = C.nav_height(nav, fx, fy, s["z"] - 1.0, 0.4)
                if np.isnan(fz): continue
                if all(not np.isnan(C.nav_height(nav, fx + a, fy + b, float(fz), 0.35)) for a, b in ((0.25, 0), (-0.25, 0), (0, 0.25), (0, -0.25))):
                    spot = (fx, fy, float(fz), d); break
            if spot: break
        if spot is None:
            rejected.append((nm, round(cx, 1), round(cy, 1), "front not walkable")); continue
        fx, fy, fz, dd = spot
        n = queue_line(nav, fx, fy, fz, v[0], v[1])
        if n < 1:
            rejected.append((nm, round(cx, 1), round(cy, 1), "no room")); continue
        used_objs.add(nm)
        out.append(dict(type="stall", x=fx, y=fy, z=fz, gap=dd, yaw=math.atan2(-v[1], -v[0]), land=part, cap=n, qyaw=math.atan2(v[1], v[0]),
                        qlen=(n - 1) * 0.7, name=nice(nm), src=nm, L=s["L"], diag=dict(roof=roof, **{str(k): dict((a, b) for a, b in vv.items() if a != "h") for k, vv in res.items()})))
    # merge counters of one stall that face the same way within 1.5 m (L-shaped counters, goods on a counter)
    keep = []
    for p in sorted(out, key=lambda p: -p["L"]):
        if any(math.hypot(p["x"] - q["x"], p["y"] - q["y"]) < 1.5 and abs(math.remainder(p["yaw"] - q["yaw"], 2 * math.pi)) < 0.6 for q in keep): continue
        keep.append(p)
    log("stalls: %d counters with a walkable front (%d before merging), %d rejected" % (len(keep), len(out), len(rejected)))
    for r in rejected: log("  rejected", r)
    return keep, used_objs


JOINED = r"^lantern_row_(market|teahouses)$"

def obj_front(geo, nav, ids):
    """Service side of a stand-alone stall object from its own geometry. Returns (centre, n, e, w, floor, score dict)."""
    pts, _ = geo.points(ids, 0.05)
    floor = float(np.percentile(pts[:, 2], 1))
    c, u, v, L, D = rect(pts[:, :2])
    sides = [(v, D / 2, L / 2), (-v, D / 2, L / 2)]
    if L < 1.6 * D: sides += [(u, L / 2, D / 2), (-u, L / 2, D / 2)]
    best = None
    for n, e, w in sides:
        t = np.array([-n[1], n[0]])
        rel = pts - np.r_[c, floor]
        dn = rel[:, :2] @ n; dt = rel[:, :2] @ t; z = rel[:, 2]
        bins = max(1, w * 2 * 0.8 / 0.1)
        inb = np.abs(dt) < w * 0.8
        cnt = inb & (dn > e - 0.6) & (z > 0.75) & (z < 1.3)
        pan = inb & (dn > e - 0.35) & (z > 1.35) & (z < 2.2)
        counter = len(np.unique(np.floor(dt[cnt] / 0.1))) / bins
        panel = len(np.unique(np.floor(dt[pan] / 0.1))) / bins
        k = np.linspace(-w * 0.7, w * 0.7, 5)
        fx = c[0] + n[0] * (e + 0.45) + t[0] * k; fy = c[1] + n[1] * (e + 0.45) + t[1] * k
        walk = float(np.mean(~np.isnan(C.nav_height(nav, fx, fy, floor, 0.4))))
        room = 0
        for dd in np.arange(1.0, 4.1, 0.5):
            if np.isnan(C.nav_height(nav, c[0] + n[0] * (e + dd), c[1] + n[1] * (e + dd), floor, 0.5)): break
            room += 1
        sc = walk + 0.8 * min(counter, 1) - 1.2 * min(panel, 1) + 0.05 * room + (0.15 if e < max(L, D) / 2 - 0.01 else 0)
        r = dict(walk=walk, counter=counter, panel=panel, room=room, score=sc)
        if best is None or sc > best[-1]["score"]: best = (c, n, e, w, floor, r)
    return best

def extract_objects(geo, nav, log=print):
    """Stand-alone stall objects (everything in STALL_RX except the joined market meshes)."""
    import geo as G
    objs = G.objects(geo); out = []; rej = []
    for nm, o in objs.items():
        part = o["part"]
        if not re.search(STALL_RX.get(part, r"^$"), C.strip(nm, part)) or re.search(JOINED, nm): continue
        c, n, e, w, floor, r = obj_front(geo, nav, o["ids"])
        t = np.array([-n[1], n[0]]); spot = None
        for d in (0.35, 0.5, 0.65, 0.8, 1.0, 1.2):
            for off in (0.0, -0.3 * w, 0.3 * w):
                fx, fy = c[0] + n[0] * (e + d) + t[0] * off, c[1] + n[1] * (e + d) + t[1] * off
                fz = C.nav_height(nav, fx, fy, floor, 0.4)
                if np.isnan(fz): continue
                if all(not np.isnan(C.nav_height(nav, fx + a, fy + b, float(fz), 0.35)) for a, b in ((0.25, 0), (-0.25, 0), (0, 0.25), (0, -0.25))):
                    spot = (fx, fy, float(fz)); break
            if spot: break
        if spot is None: rej.append((nm, "front not walkable")); continue
        fx, fy, fz = spot
        q = queue_line(nav, fx, fy, fz, n[0], n[1])
        out.append(dict(type="stall", x=fx, y=fy, z=fz, yaw=math.atan2(-n[1], -n[0]), land=part, cap=max(1, q), qyaw=math.atan2(n[1], n[0]),
                        qlen=max(0, q - 1) * 0.7, name=nice(nm), src=nm, L=2 * w, diag=r))
    # one POI per physical stall: Brinewatch stalls and their goods are separate objects at the same spot
    out.sort(key=lambda p: (0 if re.search(r"prop_goods", p["src"]) else -1, -p["diag"]["score"]))
    keep = []
    for p in out:
        if any(math.hypot(p["x"] - k["x"], p["y"] - k["y"]) < 2.0 for k in keep): continue
        keep.append(p)
    log("stall objects: %d (%d before merging), rejected %s" % (len(keep), len(out), rej))
    return keep

def extract_all(geo, nav, log=print):
    cnt, _ = extract(geo, nav, log=log)
    cnt = [p for p in cnt if re.search(JOINED, p["src"])]
    return cnt + extract_objects(geo, nav, log=log)
