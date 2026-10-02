"""Stalls, lake-rail views, landmark views, photo spots, stage audiences and tables -> POIs."""
import re, math
import numpy as np
from scipy.spatial import cKDTree
import common as C
import geo as G
import stalls as ST
import park_common as pc

# (regex on the full object name, POI type, human name, d_min, d_max, spots, options)
#   options: z = height above the object's base to look at (default: centroid), face = preferred viewing direction
#   'lake' (stand between the object and the lake, looking out) or a yaw in radians; 'aim' = point (x, y) to look at.
TARGETS = [
    # East Gate + Lamplighters' Walk
    (r"^transit_gate_sign_east$", "photo", "LANTERNFALL gate sign", 9, 22, 3, {}),
    (r"^transit_gate_wall$", "view", "The Lamplighters' Wall", 4, 10, 3, {}),
    (r"^transit_gate_wings$", "photo", "East Gate", 8, 24, 2, {}),
    # Guildhollow
    (r"^guildhollow_gate_sign$", "photo", "Guildhollow gate", 6, 16, 2, {}),
    (r"^guildhollow_keep$", "view", "Guildhollow Keep", 6, 25, 3, {}),
    (r"^guildhollow_armory_arch$", "photo", "Armory Square", 5, 12, 2, {}),
    (r"^guildhollow_sword_dais$", "view", "Armory Square: the sword dais", 3, 7, 4, {}),
    (r"^guildhollow_midway_arch$", "photo", "Guild Fair Midway", 5, 12, 2, {}),
    (r"^guildhollow_strength_bell$", "view", "The strength bell", 2.5, 6, 3, {}),
    (r"^guildhollow_yard_arch$", "photo", "The Training Yard", 5, 12, 2, {}),
    (r"^guildhollow_lookout_sign$", "view", "Guildhollow lookout", 1, 6, 4, {"face": "lake"}),
    (r"^guildhollow_archery_gallery$", "view", "Archery gallery", 2, 7, 2, {}),
    # Frostmere
    (r"^frostmere_snowbound_gate$", "photo", "Snowbound Gate", 8, 20, 3, {}),
    (r"^frostmere_keep$", "view", "Frostmere Keep", 6, 25, 3, {}),
    (r"^frostmere_crystal_towers$", "view", "The Crystal Court", 4, 12, 4, {}),
    (r"^frostmere_sign_fair$", "photo", "The Frost Fair", 5, 12, 2, {}),
    (r"^frostmere_frozen_mere$", "view", "The frozen mere", 1.5, 7, 3, {}),
    (r"^frostmere_rink$", "view", "The skating rink", 1.5, 6, 4, {}),
    (r"^frostmere_overlook$", "view", "Frostmere overlook", 0.5, 6, 4, {"face": "lake"}),
    (r"^frostmere_sign_land$", "photo", "Frostmere Keep sign", 5, 14, 2, {}),
    # Meridian
    (r"^meridian_gate_sign$", "photo", "Meridian Rail gate", 6, 16, 2, {}),
    (r"^meridian_sign_meridian_loop", "photo", "The Meridian Loop", 6, 18, 2, {}),
    (r"^meridian_gyre_core$", "view", "The Gyre", 3, 9, 4, {}),
    (r"^meridian_capsule_dome$", "view", "Capsule store", 5, 14, 2, {}),
    (r"^meridian_deck_sign$", "view", "Launch Deck", 6, 30, 3, {}),
    (r"^meridian_overlook$", "view", "Meridian overlook", 0.5, 6, 4, {"face": "lake"}),
    (r"^meridian_sign_signal$", "photo", "Signal Plaza", 5, 14, 2, {}),
    (r"^meridian_ta_body", "view", "Meridian towers", 10, 40, 2, {}),
    # Wanderers' Hall
    (r"^wanderers_sign_hall$", "photo", "The Wanderers' Hall", 8, 20, 3, {}),
    (r"^wanderers_hall_domeglass$", "view", "The Wanderers' Hall dome", 6, 30, 3, {}),
    (r"^wanderers_doors_portal", "view", "The Paper Doors", 3, 9, 1, {}),
    (r"^wanderers_ground_jet$", "view", "Wanderers' fountain", 2, 7, 4, {}),
    (r"^wanderers_tables_tabletop$", "view", "The Signing Tables", 1.5, 5, 4, {}),
    (r"^wanderers_lostfound_shopwall$", "view", "The Lost & Found", 2, 7, 2, {}),
    (r"^wanderers_gallery_vitrine$", "view", "The gallery", 1.5, 5, 3, {}),
    # Brinewatch
    (r"^brinewatch_bounty_board$", "view", "Bounty Board", 2, 6, 4, {}),
    (r"^brinewatch_galleon_hull$", "photo", "The galleon", 4, 30, 4, {}),
    (r"^brinewatch_tavern_hanging_sign$", "photo", "The Brine & Barrel", 5, 14, 2, {}),
    (r"^brinewatch_cruise_arch$", "photo", "Harbor Cruise", 4, 12, 2, {}),
    (r"^brinewatch_pier_arch$", "photo", "Brinewatch pier", 4, 14, 2, {}),
    (r"^brinewatch_prom_arch(\.\d+)?$", "photo", "Brinewatch Wharf", 5, 14, 2, {}),
    (r"^brinewatch_harbour_light$", "view", "The harbour light", 5, 30, 3, {}),
    (r"^brinewatch_anchor_plinth$", "view", "The anchor", 2, 6, 3, {}),
    (r"^brinewatch_crane$", "view", "The harbour crane", 4, 12, 2, {}),
    (r"^brinewatch_sloop_hull$", "view", "The sloop", 3, 14, 2, {}),
    # Lantern Row
    (r"^lantern_row_sign_torii$", "photo", "The great torii", 8, 24, 3, {}),
    (r"^lantern_row_water_torii$", "photo", "The water torii", 6, 30, 3, {}),
    (r"^lantern_row_sign_wishes_board$", "view", "Shrine of Wishes: the wish plaques", 1.5, 5, 4, {}),
    (r"^lantern_row_sign_shrine_plaque$", "view", "Shrine of Wishes", 5, 16, 3, {}),
    (r"^lantern_row_pagoda$", "view", "The pagoda", 5, 22, 3, {}),
    (r"^lantern_row_sign_the_night_market", "photo", "The Night Market", 5, 14, 2, {}),
    (r"^lantern_row_sign_market_square$", "view", "Night Market square", 3, 10, 2, {}),
    (r"^lantern_row_sign_chase_start$", "view", "Rooftop Chase", 3, 10, 2, {}),
    (r"^lantern_row_sign_cards$", "view", "The card table", 2, 6, 2, {}),
    # Rosewick
    (r"^rosewick_fountain$", "view", "Rosewick fountain", 3, 10, 6, {}),
    (r"^rosewick_carousel_pavilion$", "view", "Pavilion of Wings", 4, 12, 6, {}),
    (r"^rosewick_sign_pavilion$", "photo", "Pavilion of Wings", 5, 14, 2, {}),
    (r"^rosewick_gate_arches$", "photo", "Rosewick Gardens gate", 6, 16, 2, {}),
    (r"^rosewick_sign_rosewick$", "photo", "Rosewick Gardens", 5, 14, 2, {}),
    (r"^rosewick_belvedere$", "view", "The belvedere", 4, 12, 2, {}),
    (r"^rosewick_bridge$", "view", "The pond bridge", 0, 1.5, 3, {"on": True}),
    (r"^rosewick_pond$", "view", "The lily pond", 1.5, 6, 4, {}),
    (r"^rosewick_winged_statue", "photo", "Winged statue", 3, 8, 1, {}),
    (r"^rosewick_sign_maze$", "photo", "The Rose Maze", 4, 10, 1, {}),
    (r"^rosewick_conservatory$", "view", "The conservatory", 5, 14, 2, {}),
    (r"^rosewick_sign_lane$", "photo", "Blossom Lane", 4, 12, 1, {}),
    (r"^rosewick_sign_promenade$", "photo", "The Moonlit Promenade", 4, 12, 1, {}),
]

STAGES = [  # (regex, name, radius from the stage centre to the first row, rows, opening half-angle deg)
    (r"^lantern_row_sign_ghost$", "Ghost stories", 3.0, 2, 60),
    (r"^rosewick_bandstand$", "The bandstand", 5.5, 2, 70),
    (r"^brinewatch_tavern_stage$", "Shanty Corner", 2.5, 2, 60),
    (r"^guildhollow_training_yard$", "The Training Yard", 0, 0, 0),
    (r"^frostmere_sign_judges$", "The judges' dais", 3.5, 2, 55),
    (r"^meridian_dance_floor$", "Signal Plaza dance floor", 0, 0, 0),
    (r"^meridian_arena_floor$", "Meridian training arena", 0, 0, 0),
]

# hand-placed standing spots inside interiors and enclosed places (land-local x, y of the spot and of what it looks at)
HAND = [
    ("brinewatch", "view", "The Brine & Barrel: the bar", (-21.5, -40.2), (-21.5, -38.0)),
    ("brinewatch", "view", "The Brine & Barrel: the bar", (-19.4, -40.8), (-19.4, -38.0)),
    ("brinewatch", "view", "The Brine & Barrel: the hearth", (-30.2, -41.0), (-32.7, -41.0)),
    ("rosewick", "view", "The Rose Maze: the secret garden", (-48.2, 14.6), (-48.0, 12.0)),
    ("rosewick", "view", "The Rose Maze: the secret garden", (-50.6, 12.0), (-48.0, 12.0)),
    ("guildhollow", "view", "Guildhollow: the castle well", (17.4, 25.0), (20.0, 25.0)),
    ("guildhollow", "view", "Guildhollow: the castle well", (20.0, 22.4), (20.0, 25.0)),
    ("guildhollow", "view", "Guildhollow: the castle courtyard", (-6.0, 26.0), (0.0, 37.0)),
]

TABLES = [  # (regex, name)
    (r"^guildhollow_table_top", "Tavern table"), (r"^brinewatch_prop_table_set", "Dockside table"),
]


class Walk:
    """Walkable cells of the nav grid with a KD-tree, for spot searches."""
    def __init__(self, nav):
        self.nav = nav
        pts = []
        for lev in ("zA", "zB"):
            j, i = np.nonzero(~np.isnan(nav[lev]))
            pts.append(np.stack([nav["x0"] + (i + 0.5) * nav["cell"], nav["y0"] + (j + 0.5) * nav["cell"], nav[lev][j, i]], 1))
        self.P = np.concatenate(pts)
        self.kd = cKDTree(self.P[:, :2])
        # "solid" cells: all 8 neighbours walkable at a similar height (a guest can stand there without touching an edge)
        z = self.P[:, 2]; ok = np.ones(len(z), bool)
        for dx, dy in ((0.5, 0), (-0.5, 0), (0, 0.5), (0, -0.5), (0.5, 0.5), (-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5)):
            h = C.nav_height(nav, self.P[:, 0] + dx, self.P[:, 1] + dy, z, 0.3)
            ok &= ~np.isnan(h)
        self.solid = ok

    def near(self, x, y, r):
        idx = np.array(self.kd.query_ball_point([x, y], r), np.int64)
        return idx

def lake_inward(x, y):
    return math.atan2(-y, -x)

def spot_search(walk, vox, tx, ty, tz, dmin, dmax, n, face=None, on=False, min_sep=2.5, zband=(-3.0, 1.5), base=0.0, box=None):
    """Best n standing spots looking at (tx, ty, tz). face: preferred direction FROM the target TO the viewer (yaw)."""
    ext = 0.0 if box is None else 0.5 * math.hypot(box[1][0] - box[0][0], box[1][1] - box[0][1])
    idx = walk.near(tx, ty, dmax + ext + 0.01)
    if not len(idx): return []
    P = walk.P[idx]; dc = np.hypot(P[:, 0] - tx, P[:, 1] - ty)
    if box is None: d = dc
    else:   # distance to the object's footprint (bounding box), so big buildings are seen from outside
        ddx = np.maximum(np.maximum(box[0][0] - P[:, 0], P[:, 0] - box[1][0]), 0); ddy = np.maximum(np.maximum(box[0][1] - P[:, 1], P[:, 1] - box[1][1]), 0)
        d = np.hypot(ddx, ddy)
    keep = (d >= dmin) & walk.solid[idx] & (P[:, 2] - base > zband[0]) & (P[:, 2] - base < zband[1])
    P, d, dc = P[keep], d[keep], dc[keep]
    if not len(P): return []
    ang = np.arctan2(P[:, 1] - ty, P[:, 0] - tx)
    mid = (dmin + dmax) / 2
    score = -np.abs(d - mid) / max(1.0, dmax - dmin)
    if face is not None: score += 1.5 * np.cos(ang - face)
    order = np.argsort(-score)
    out = []
    for k in order[:4000]:
        x, y, z = P[k]
        if any(math.hypot(x - a, y - b) < min_sep for a, b, _, _ in out): continue
        if not on and not vox.clear((x, y, z + 1.6), (tx, ty, tz), skip_end=(dc[k] - d[k]) + min(1.5, d[k] * 0.4)): continue
        out.append((float(x), float(y), float(z), float(score[k])))
        if len(out) >= n: break
    return out

def lake_rail(geo, walk, nav, step=1.5, log=print):
    """Standing spots along the lake edge, every `step` m, facing the Spire; rail=True where a balustrade is in front."""
    poly = np.array(pc.LAKE)
    seg = np.roll(poly, -1, 0) - poly; L = np.hypot(seg[:, 0], seg[:, 1]); acc = np.r_[0, np.cumsum(L)]
    out = []
    for s in np.arange(0, acc[-1], step):
        k = np.searchsorted(acc, s, side="right") - 1; f = (s - acc[k]) / L[k]
        ex, ey = poly[k] + seg[k] * f; tx, ty = seg[k] / L[k]
        nx, ny = ty, -tx                                     # CCW polygon: the right-hand normal points away from the water
        if nx * ex + ny * ey < 0: nx, ny = -nx, -ny
        spot = None
        for dd in np.arange(0.0, 7.0, 0.25):
            x, y = ex + nx * dd, ey + ny * dd
            h = C.nav_height(nav, x, y)
            if np.isnan(h): continue
            if all(not np.isnan(C.nav_height(nav, x + a, y + b, float(h), 0.3)) for a, b in ((0.3, 0), (-0.3, 0), (0, 0.3), (0, -0.3))):
                spot = (x, y, float(h), dd); break
        if spot is None: continue
        x, y, z, dd = spot
        # rail: geometry 0.7-1.25 m above the floor between the spot and the water (within 1.3 m)
        loc, _ = geo.local_box(x - nx * 0.75, y - ny * 0.75, tx, ty, 0.5, 0.65, z + 0.6, z + 1.3, step=0.06)
        rail = len(loc) > 20
        if any(math.hypot(x - p["x"], y - p["y"]) < 1.1 for p in out[-3:]): continue
        out.append(dict(type="view", x=x, y=y, z=z, yaw=lake_inward(x, y), land="core", cap=2, rail=rail, name="Stillwater: the Spire and the lantern fall", src="lake_rail"))
    log("lake rail: %d spots, %d with a rail to lean on" % (len(out), sum(p["rail"] for p in out)))
    return out

def land_of_obj(o):
    return o["part"]

def target_point(o):
    c = o["c"]; lo, hi = o["lo"], o["hi"]
    z = float(min(max(c[2], lo[2] + 1.0), lo[2] + 8.0))
    return float(c[0]), float(c[1]), z

def extract(geo, nav, log=print):
    walk = Walk(nav); vox = G.Vox(geo, nav, log=log); objs = G.objects(geo)
    pois = []
    st = ST.extract_all(geo, nav, log=log)
    for p in st:
        p.pop("diag", None)
    pois += st
    pois += lake_rail(geo, walk, nav, log=log)
    names = list(objs)
    missing = []
    for rx, typ, nm, dmin, dmax, n, opt in TARGETS:
        hits = [k for k in names if re.search(rx, k)]
        if not hits: missing.append(rx); continue
        for k in hits[:12]:
            o = objs[k]; tx, ty, tz = target_point(o)
            base = float(o["lo"][2])
            face = opt.get("face")
            if face == "lake": face = math.atan2(-ty, -tx) + math.pi        # viewer between target and... (see below)
            if opt.get("face") == "lake":
                # lookouts: stand on the object's lake side and look out over the water
                sp = spot_search(walk, vox, tx, ty, tz, dmin, dmax, n, face=math.atan2(-ty, -tx), on=True, base=base)
                for x, y, z, _ in sp:
                    pois.append(dict(type=typ, x=x, y=y, z=z, yaw=lake_inward(x, y), land=o["part"], cap=2, name=nm, src=k))
                continue
            sp = spot_search(walk, vox, tx, ty, tz, dmin, dmax, n, face=face, on=opt.get("on", False), base=base, zband=(-6, 2.5), box=None if opt.get("on") else (o["lo"], o["hi"]))
            if opt.get("on"):
                for x, y, z, _ in sp:
                    pois.append(dict(type=typ, x=x, y=y, z=z, yaw=math.atan2(-y, -x), land=o["part"], cap=2, name=nm, src=k))
                continue
            for x, y, z, _ in sp:
                pois.append(dict(type=typ, x=x, y=y, z=z, yaw=math.atan2(ty - y, tx - x), land=o["part"], cap=2 if typ == "view" else 1, name=nm, src=k))
        if len(hits) > 1 and n == 1 and False: pass
    if missing: log("targets not found:", missing)
    # stages: audience arcs
    for rx, nm, r0, rows, half in STAGES:
        hits = [k for k in names if re.search(rx, k)]
        if not hits: missing.append(rx); continue
        o = objs[hits[0]]; tx, ty, tz = target_point(o)
        if rows == 0:
            # an arena or a floor: the audience stands around its edge, looking in
            lo, hi = o["lo"], o["hi"]; rad = 0.5 * math.hypot(hi[0] - lo[0], hi[1] - lo[1])
            sp = spot_search(walk, vox, tx, ty, float(lo[2]) + 1.0, rad * 0.55, rad + 3.0, 14, min_sep=1.6, base=float(lo[2]), zband=(-1.0, 1.5))
            for x, y, z, _ in sp:
                pois.append(dict(type="stage", x=x, y=y, z=z, yaw=math.atan2(ty - y, tx - x), land=o["part"], cap=2, name=nm, src=hits[0], tag=hits[0]))
            continue
        # direction of the open side: most walkable cells within 8 m
        idx = walk.near(tx, ty, r0 + 5)
        P = walk.P[idx]; a = np.arctan2(P[:, 1] - ty, P[:, 0] - tx)
        best = max(np.linspace(-math.pi, math.pi, 72, endpoint=False), key=lambda f: np.sum(np.cos(a - f) > math.cos(math.radians(half))))
        for row in range(rows):
            rr = r0 + row * 1.1
            nseat = max(2, int(2 * math.radians(half) * rr / 1.1))
            for k in range(nseat):
                f = best + math.radians(half) * (2 * (k + 0.5) / nseat - 1)
                x, y = tx + rr * math.cos(f), ty + rr * math.sin(f)
                hit = walk.near(x, y, 0.4)
                hit = [h for h in hit if walk.solid[h]]
                if not hit: continue
                X, Y, Z = walk.P[hit[np.argmin(np.hypot(walk.P[hit, 0] - x, walk.P[hit, 1] - y))]]
                if not vox.clear((X, Y, Z + 1.6), (tx, ty, tz), skip_end=1.2): continue
                pois.append(dict(type="stage", x=float(X), y=float(Y), z=float(Z), yaw=math.atan2(ty - Y, tx - X), land=o["part"], cap=1, name=nm, src=hits[0], tag=hits[0]))
    # tables: a POI at the table centre (z = table top); guests stand/sit on a ring of radius r around it
    for rx, nm in TABLES:
        for k in [k for k in names if re.search(rx, k)]:
            o = objs[k]; lo, hi = o["lo"], o["hi"]
            cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
            ids = o["ids"]; up = ids[(geo.n[ids, 2] > 0.9)]
            ztop = float(geo.P[up][:, :, 2].max()) if len(up) else float(hi[2])
            free = 0
            for extra in (0.35, 0.6, 0.85):
                rad = 0.5 * max(hi[0] - lo[0], hi[1] - lo[1]) + extra
                ring = [(cx + rad * math.cos(a), cy + rad * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 8, endpoint=False)]
                free = sum(not np.isnan(C.nav_height(nav, x, y, float(lo[2]) + 0.1, 0.8)) for x, y in ring)
                if free >= 2: break
            if free == 0: log("  table without room:", k); continue
            pois.append(dict(type="table", x=cx, y=cy, z=ztop, yaw=0.0, land=o["part"], cap=int(min(4, free)), r=rad, name=nm, src=k))
    for land, typ, nm, (sx, sy), (tx, ty) in HAND:
        (x, y), (wx, wy) = pc.to_world(land, (sx, sy)), pc.to_world(land, (tx, ty))
        h = C.nav_height(nav, x, y)
        if np.isnan(h) or not walk.solid[walk.kd.query([x, y])[1]]: log("  hand spot not walkable:", nm, sx, sy); continue
        pois.append(dict(type=typ, x=x, y=y, z=float(h), yaw=math.atan2(wy - y, wx - x), land=land, cap=2, name=nm, src="hand"))
    log("places: %d pois" % len(pois))
    return pois
