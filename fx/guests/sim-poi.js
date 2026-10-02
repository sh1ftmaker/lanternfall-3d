// Guests: points of interest -> sites with slots, plus the destinations the crowd simulation derives itself
// (lake-rail slots, promenade waypoints, the gate) and the hubs (clusters of sites) that get a global flow field.
// Pure JS (main thread, Worker or Node).
//
// A site = { id, type, kind, x, y, z, yaw, land, cap, name, hub, slots: [slot indices], weight, open }
// A slot (struct of arrays in `S`) = standing / sitting spot: x, y, z, yaw (facing), ax, ay (approach point: where the
// guest walks to before settling into the slot; on open ground), anim (what the guest does there), site.
// Kinds: 'sit' (bench / table seats), 'queue' (a spaced line, slot 0 = front), 'look' (view / photo spots),
// 'stage' (audience), 'rail' (lake balustrade), 'walk' (waypoint: pass through, maybe pause), 'gate' (leave the park).
import { clearance, ground, lineClear, nearestCell, cellAt, components } from './sim-nav.js';

export const ANIM = { walk: 0, stand: 1, look: 2, wave: 3, sit: 4, lean: 5, hidden: 255 };
const TAU = Math.PI * 2;

// provisional sites per land when data/guests.json is missing: the viewer's hand-checked Walk arrival points (app.js
// WALK_AT): an open view of the land's landmark
const WALK_AT = {
  spire: [85.5, 31.1, -2.79], guildhollow: [-149.9, 36.1, -2.36], frostmere: [-65.0, 107.5, 3.14], meridian: [81.7, 93.8, 2.36],
  wanderers: [139.9, 48.2, 0.39], brinewatch: [114.9, -81.5, 0.39], 'lantern-row': [-16.6, -118.5, -0.26], rosewick: [-136.6, -57.6, -1.18],
};
// how busy each land is (share of land-bound trips), loosely after the evening programme: the night market, Signal
// Plaza's dance floor, the Wanderers' Hall by the gate and the wharf draw the most people
const LAND_POP = { 'lantern-row': 1.35, meridian: 1.25, wanderers: 1.2, brinewatch: 1.1, frostmere: 1.0, rosewick: 0.95, guildhollow: 0.85 };

function pip(poly, x, y) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }

export function buildSites(N, manifest, poiData, rnd) {
  const lake = manifest.lake, lands = manifest.lands || [];
  const comp = components(N);
  const gateCell = nearestCell(N, 288, 0, 8);
  const main = gateCell >= 0 ? comp.lab[gateCell] : -1;
  const reachable = (x, y) => { const c = cellAt(N, x, y); return c >= 0 && comp.lab[c] === main; };
  const landOf = (x, y) => {
    let best = null, bd = 1e9; const phi = Math.atan2(y, x), r = Math.hypot(x, y);
    if (r < 112) return 'lake';
    for (const l of lands) { let d = Math.abs(((phi - l.phi + Math.PI * 3) % TAU) - Math.PI); if (d < bd) { bd = d; best = l.id; } }
    if (x > 150 && Math.abs(y) < 40) return 'gate';
    return bd < 0.34 ? best : 'ring';
  };
  // ── slot store ──
  const S = { n: 0, cap: 0, x: null, y: null, z: null, yaw: null, ax: null, ay: null, anim: null, site: null, occ: null };
  const grow = () => {
    const cap = Math.max(1024, S.cap * 2), F = (a) => { const b = new Float32Array(cap); if (a) b.set(a); return b; };
    S.x = F(S.x); S.y = F(S.y); S.z = F(S.z); S.yaw = F(S.yaw); S.ax = F(S.ax); S.ay = F(S.ay);
    const an = new Uint8Array(cap); if (S.anim) an.set(S.anim); S.anim = an;
    const si = new Int32Array(cap); if (S.site) si.set(S.site); S.site = si;
    const oc = new Int32Array(cap).fill(-1); if (S.occ) oc.set(S.occ); S.occ = oc; S.cap = cap;
  };
  // slots never overlap: a new one closer than DEDUP to an existing one (any site) is dropped
  const DEDUP = 0.6, hash = new Map(), hkey = (i, j) => i * 100003 + j;
  const nearSlot = (x, y, r) => {
    const i0 = Math.floor(x), j0 = Math.floor(y);
    for (let j = j0 - 1; j <= j0 + 1; j++) for (let i = i0 - 1; i <= i0 + 1; i++) { const l = hash.get(hkey(i, j)); if (l) for (const k of l) if (Math.hypot(S.x[k] - x, S.y[k] - y) < r) return true; }
    return false;
  };
  const addSlot = (site, x, y, z, yaw, ax, ay, anim) => {
    if (nearSlot(x, y, anim === ANIM.sit ? 0.42 : DEDUP)) return -1;
    if (S.n >= S.cap) grow();
    const k = S.n++; S.x[k] = x; S.y[k] = y; S.z[k] = z; S.yaw[k] = yaw; S.ax[k] = ax; S.ay[k] = ay; S.anim[k] = anim; S.site[k] = site.id; S.occ[k] = -1;
    site.slots.push(k);
    const hk = hkey(Math.floor(x), Math.floor(y)); let l = hash.get(hk); if (!l) hash.set(hk, l = []); l.push(k);
    return k;
  };
  const sites = [];
  const newSite = (o) => { const s = { id: sites.length, slots: [], weight: 1, open: true, hub: -1, ...o }; sites.push(s); return s; };
  const okStand = (x, y, r = 0.32) => clearance(N, x, y) >= r && reachable(x, y);
  // the nearest open standing point to (x, y) within `R` m (spiral over 0.25 m steps)
  const findStand = (x, y, R = 2.0, r = 0.4) => {
    if (okStand(x, y, r)) return [x, y];
    for (let rad = 0.25; rad <= R; rad += 0.25) {
      const n = Math.ceil(TAU * rad / 0.25);
      for (let k = 0; k < n; k++) { const a = k / n * TAU, px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad; if (okStand(px, py, r)) return [px, py]; }
    }
    return null;
  };
  const stats = { data: 0, skipped: 0, byType: {} };
  const stageOf = new Map();
  // room to lean on a rail facing (fx, fy): elbows 0.3 m to either side and the shoulders 0.25 m ahead are clear
  // (a balustrade post or a lamp pillar beside the spot would cut through the figure)
  const leanRoom = (x, y, fx, fy) => {
    const rx = fy, ry = -fx;
    for (const [o, f] of [[0.32, 0], [-0.32, 0], [0.3, 0.22], [-0.3, 0.22], [0, 0.25]]) if (clearance(N, x + rx * o + fx * f, y + ry * o + fy * f) < 0.04) return false;
    return true;
  };

  // ── points of interest from data/guests.json ──
  const list = poiData ? (Array.isArray(poiData) ? poiData : poiData.pois || []) : [];
  for (const p of list) {
    if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
    const type = String(p.type || 'view'), yaw = isFinite(p.yaw) ? +p.yaw : 0, cap = Math.max(1, Math.min(12, +p.cap || 1));
    const fx = Math.cos(yaw), fy = Math.sin(yaw), rx = Math.sin(yaw), ry = -Math.cos(yaw);   // facing and right
    const land = p.land || landOf(p.x, p.y);
    let site = null;
    if (type === 'table') {
      // a ring of standing places round the table (radius r), facing its centre
      site = newSite({ type, kind: 'look', x: p.x, y: p.y, z: p.z, yaw, land, cap: Math.min(4, cap), name: p.name || 'table' });
      const r = +p.r > 0.4 ? Math.min(1.8, +p.r) : 0.9;
      for (let k = 0; k < 8 && site.slots.length < site.cap; k++) {
        const a = yaw + k * TAU / 8, sp = findStand(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 0.25, 0.3); if (!sp) continue;
        addSlot(site, sp[0], sp[1], ground(N, sp[0], sp[1]), Math.atan2(p.y - sp[1], p.x - sp[0]), sp[0], sp[1], k & 1 ? ANIM.look : ANIM.stand);
      }
    } else if (type === 'bench') {
      // seats along the bench (perpendicular to the facing) or round the table; approach = 0.5 m in front of the seat
      site = newSite({ type, kind: 'sit', x: p.x, y: p.y, z: p.z, yaw, land, cap, name: p.name });
      const pitch = type === 'bench' ? (+p.len > 0 ? +p.len / cap : 0.58) : 0;     // seat k at ((k + 0.5) / cap - 0.5) * len (guests-data FORMAT.md)
      for (let i = 0; i < cap; i++) {
        let sx, sy, syaw, ax, ay;
        if (type === 'bench') {
          const o = (i - (cap - 1) / 2) * pitch; sx = p.x + rx * o; sy = p.y + ry * o; syaw = yaw;
        } else { const a = yaw + Math.PI + i * TAU / cap, r = +p.r > 0.4 ? Math.min(1.6, +p.r) : 0.75; sx = p.x + Math.cos(a) * r; sy = p.y + Math.sin(a) * r; syaw = a + Math.PI; }
        // approach: the first open standing spot straight in front of the seat (0.35 - 1.3 m)
        const cx = Math.cos(syaw), cy = Math.sin(syaw); let ap = null;
        for (let t = 0.35; t <= 1.3; t += 0.05) { const qx = sx + cx * t, qy = sy + cy * t; if (okStand(qx, qy, 0.27)) { ap = [qx + cx * 0.05, qy + cy * 0.05]; break; } }
        if (!ap) continue;
        // seat height: the bench's own, else a chair's (0.45 m above the floor at the approach point). Seats higher than
        // 0.8 m above the approach (upper bleacher tiers) or lower than 0.3 m (Meridian's plaza slabs) are skipped.
        const gA = ground(N, ap[0], ap[1]);
        if (type === 'bench' && isFinite(p.z) && isFinite(gA) && (p.z - gA > 0.8 || p.z - gA < 0.3)) continue;
        const z = type === 'bench' && isFinite(p.z) ? p.z : (isFinite(gA) ? gA : 0) + 0.45;
        addSlot(site, sx, sy, z, syaw, ap[0], ap[1], ANIM.sit);
      }
    } else if (type === 'stall' || type === 'queue') {
      // a spaced line behind the first customer (along `qyaw` for `qlen` m when given); it bends round obstacles
      const qn = isFinite(p.qlen) ? 1 + Math.floor(+p.qlen / 0.75 + 0.01) : (cap > 1 ? cap : 5);
      site = newSite({ type, kind: 'queue', x: p.x, y: p.y, z: p.z, yaw, land, cap: Math.max(2, Math.min(7, Math.min(qn, cap > 1 ? cap : 7))), name: p.name });
      let x = p.x, y = p.y, a = isFinite(p.qyaw) ? +p.qyaw + Math.PI : yaw;
      const first = findStand(x, y, 0.8, 0.3); if (first) { x = first[0]; y = first[1]; }
      for (let i = 0; i < site.cap; i++) {
        if (i > 0) {
          let ok = false;
          for (const da of [0, 0.35, -0.35, 0.7, -0.7, 0.9, -0.9]) {
            const b = a + da, nx = x - Math.cos(b) * 0.75, ny = y - Math.sin(b) * 0.75;
            // keep the line out of narrow lanes: each place needs 0.55 m all round (a lane of about 1.6 m stays passable)
            if (okStand(nx, ny, 0.55) && lineClear(N, x, y, nx, ny, 0.25)) { x = nx; y = ny; a = b; ok = true; break; }
          }
          if (!ok) break;
        } else if (!okStand(x, y, 0.28)) break;
        const g = ground(N, x, y);
        if (addSlot(site, x, y, isFinite(g) ? g : p.z || 0, i === 0 ? yaw : a, x, y, ANIM.stand) < 0) break;
      }
    } else if (type === 'stage') {
      // audience: one POI per position (cap 1, or 2 side by side); all positions of a stage (same `tag`) form one
      // site, so a party stands together
      const key = p.tag || p.name || null;
      site = key && stageOf.get(key);
      if (!site) { site = newSite({ type, kind: 'stage', x: p.x, y: p.y, z: p.z, yaw, land, cap: 0, name: p.name, dance: /dance/i.test(p.name || '') }); if (key) stageOf.set(key, site); }
      for (const o of cap > 1 ? [0.4, -0.4] : [0]) {
        const sp = findStand(p.x + rx * o, p.y + ry * o, 0.3, 0.3); if (!sp) continue;
        if (addSlot(site, sp[0], sp[1], ground(N, sp[0], sp[1]), yaw, sp[0], sp[1], ANIM.stand) >= 0) site.cap++;
      }
    } else {
      // view / photo / anything else: the spot plus neighbours to either side and a second row
      // a rail in front (blocked 0.7 m ahead): guests lean on it; on the lake shore that makes it part of the lake rail
      const lean = p.rail !== undefined ? !!p.rail : clearance(N, p.x + fx * 0.7, p.y + fy * 0.7) < 0.1;
      const kind = lean && distPoly(lake, p.x, p.y) < 8 ? 'rail' : 'look';
      site = newSite({ type, kind, x: p.x, y: p.y, z: p.z, yaw, land, cap: Math.max(cap, 2) + (kind === 'rail' ? 1 : 0), name: p.name });
      const offs = [[0, 0], [0.8, 0], [-0.8, 0], [1.6, -0.3], [-1.6, -0.3], [0.4, -1.0], [-0.4, -1.0], [1.2, -1.1]];
      for (let i = 0, n = 0; i < offs.length && n < site.cap; i++) {
        const [o, b] = offs[i], sx = p.x + rx * o + fx * b, sy = p.y + ry * o + fy * b;
        if (kind === 'rail' && b < -0.5) continue;          // no second row at the lake rail: the walk behind the leaners stays free
        const sp = findStand(sx, sy, 0.4, 0.28); if (!sp) continue;
        if (lean && b === 0 && !leanRoom(sp[0], sp[1], fx, fy)) continue;
        const ap = lean ? (findStand(sp[0] - fx * 0.85, sp[1] - fy * 0.85, 0.5, 0.35) || sp) : sp;
        const g = ground(N, sp[0], sp[1]);
        if (addSlot(site, sp[0], sp[1], g, yaw, ap[0], ap[1], lean && b === 0 ? ANIM.lean : type === 'photo' ? ANIM.look : ANIM.stand) >= 0) n++;
      }
    }
    if (site) {
      stats.byType[type] = (stats.byType[type] || 0) + 1;
      if (!site.slots.length || !reachable(S.ax[site.slots[0]], S.ay[site.slots[0]])) { site.open = false; stats.skipped++; }
      else stats.data++;
    }
  }

  // ── the lake balustrade: a slot every 0.8 m where the shore promenade meets the water ──
  const railSites = [];
  {
    // lake polygon orientation: outward normal = (dy, -dx) for a counter-clockwise polygon
    let area = 0; for (let i = 0, j = lake.length - 1; i < lake.length; j = i++) area += lake[j][0] * lake[i][1] - lake[i][0] * lake[j][1];
    const sgn = area > 0 ? 1 : -1;
    const pts = [];
    for (let i = 0; i < lake.length; i++) {
      const [x0, y0] = lake[i], [x1, y1] = lake[(i + 1) % lake.length];
      const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(L / 0.8));
      const nx = sgn * (y1 - y0) / L, ny = -sgn * (x1 - x0) / L;
      for (let k = 0; k < n; k++) { const t = k / n; pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, nx, ny]); }
    }
    let run = null, prev = -10;
    for (let i = 0; i < pts.length; i++) {
      const [px, py, nx, ny] = pts[i];
      let found = null;
      for (let t = -1.0; t <= 4.0; t += 0.1) {
        const x = px + nx * t, y = py + ny * t;
        if (pip(lake, x, y) && t < 0) continue;
        const c = clearance(N, x, y);
        if (c >= 0.3) { const g = ground(N, x, y); if (isFinite(g) && g > -0.3 && g < 0.6) found = [x, y, g]; break; }
      }
      if (!found || !reachable(found[0], found[1])) { prev = -10; continue; }
      const ax = found[0] + nx * 0.75, ay = found[1] + ny * 0.75;
      if (clearance(N, ax, ay) < 0.35) { prev = -10; continue; }
      // in front: there must be a balustrade/edge within 0.6 m toward the water (otherwise it is a pier or an open edge)
      if (clearance(N, found[0] - nx * 0.6, found[1] - ny * 0.6) > 0.05) { prev = -10; continue; }
      if (!leanRoom(found[0], found[1], -nx, -ny)) { prev = -10; continue; }
      if (!run || i - prev > 1 || run.slots.length >= 10) {
        run = newSite({ type: 'rail', kind: 'rail', x: found[0], y: found[1], z: found[2], yaw: Math.atan2(-ny, -nx), land: 'lake', cap: 10 });
        railSites.push(run);
      }
      addSlot(run, found[0], found[1], found[2], Math.atan2(-ny, -nx), ax, ay, ANIM.lean);
      prev = i;
    }
    for (const s of railSites) { const k = s.slots[s.slots.length >> 1]; s.x = S.x[k]; s.y = S.y[k]; s.cap = s.slots.length; if (s.slots.length < 3) s.open = false; }
  }

  // ── waypoints: the ring promenade under the monorail, the shore promenade, the Lamplighters' Walk ──
  const addWalk = (x, y, land, weight, name) => {
    const p = findStand(x, y, 3.0, 0.9); if (!p) return null;
    const s = newSite({ type: 'walk', kind: 'walk', x: p[0], y: p[1], z: ground(N, p[0], p[1]), yaw: 0, land, cap: 99, weight, name });
    addSlot(s, p[0], p[1], s.z, 0, p[0], p[1], ANIM.stand); return s;
  };
  const ra = manifest.rail ? manifest.rail.a : 160, rb = manifest.rail ? manifest.rail.b : 119;
  for (let k = 0; k < 40; k++) { const t = k / 40 * TAU; const x = ra * Math.cos(t), y = rb * Math.sin(t); addWalk(x, y, landOf(x, y), 1, 'ring'); }
  {
    const shore = manifest.shore || lake;
    for (let i = 0; i < 36; i++) {
      const phi = i / 36 * TAU, dx = Math.cos(phi), dy = Math.sin(phi);
      const rl = polarR(lake, phi), rs = polarR(shore, phi); if (!rl || !rs) continue;
      const r = (rl + rs) / 2 + 1.0; addWalk(r * dx, r * dy, 'lake', 0.8, 'shore');
    }
  }
  for (let x = 130; x <= 330; x += 25) addWalk(x, x > 250 ? 0 : 2.5, 'gate', 1.2, 'avenue');
  // provisional land sites (no data): the Walk arrival point as a viewpoint, the land's centre as a waypoint
  for (const l of lands) {
    const has = sites.some((s) => s.land === l.id && s.type !== 'walk' && s.open);
    const w = WALK_AT[l.id];
    if (w && !has) {
      const p = findStand(w[0], w[1], 2, 0.5);
      if (p) {
        const site = newSite({ type: 'view', kind: 'look', x: p[0], y: p[1], z: ground(N, p[0], p[1]), yaw: w[2], land: l.id, cap: 4, name: l.name, prov: true });
        const rx = Math.sin(w[2]), ry = -Math.cos(w[2]);
        for (const o of [0, 0.8, -0.8, 1.6]) { const q = findStand(p[0] + rx * o, p[1] + ry * o, 0.4, 0.35); if (q) addSlot(site, q[0], q[1], ground(N, q[0], q[1]), w[2], q[0], q[1], o ? ANIM.stand : ANIM.look); }
      }
    }
  }
  // wander points: open paving in each land, at least 14 m apart (guests stroll between them and stop to look round)
  {
    const pts = [];
    for (let c = 0; c < N.m; c += 3) {
      if (N.csurf[c] !== 0 || comp.lab[c] !== main) continue;
      const e = N.clr[N.cfine[c]] / 6 - 0.25; if (e < 1.6) continue;
      const x = N.x0 + ((N.ccell[c] % N.cw) + 0.5) * 2 * N.cell, y = N.y0 + (((N.ccell[c] / N.cw) | 0) + 0.5) * 2 * N.cell;
      const land = landOf(x, y); if (!LAND_POP[land]) continue;
      if (Math.abs(Math.hypot(x / ra, y / rb) - 1) < 0.06) continue;       // the ring promenade has its own points
      pts.push([x, y, land, rnd()]);
    }
    pts.sort((a, b) => a[3] - b[3]);
    const kept = [];
    for (const p of pts) {
      if (kept.some((q) => Math.abs(q[0] - p[0]) < 14 && Math.abs(q[1] - p[1]) < 14 && Math.hypot(q[0] - p[0], q[1] - p[1]) < 14)) continue;
      kept.push(p); addWalk(p[0], p[1], p[2], 0.9, 'land');
    }
  }
  // the gate: arrivals appear and departures leave beyond the turnstiles
  const gate = newSite({ type: 'gate', kind: 'gate', x: 338, y: 0, z: 0.12, yaw: 0, land: 'gate', cap: 999 });
  {
    const p = findStand(338, 0, 6, 0.8) || findStand(300, 0, 6, 0.8) || [288, 0];
    gate.x = p[0]; gate.y = p[1]; gate.z = ground(N, p[0], p[1]) || 0.12;
    for (let k = -4; k <= 4; k++) { const q = findStand(p[0], p[1] + k * 2.0, 1.5, 0.6); if (q) addSlot(gate, q[0], q[1], ground(N, q[0], q[1]) || 0.12, Math.PI, q[0], q[1], ANIM.walk); }
  }
  // every spot must be reachable while its neighbours are in use: a spot whose approach point (or the step from there
  // into the spot) is where someone else stands at another spot is moved back a little, or dropped. Benches are left
  // alone (their seats are ledges; the approach is in front of the bench). Before, rail and view spots on the shore
  // overlapped this way and guests bound for them waited behind the people leaning there until they gave up.
  {
    const near = (x, y, r, self) => { const i0 = Math.floor(x), j0 = Math.floor(y); for (let j = j0 - 1; j <= j0 + 1; j++) for (let i = i0 - 1; i <= i0 + 1; i++) { const l = hash.get(hkey(i, j)); if (l) for (const k of l) if (k !== self && !dropped[k] && Math.hypot(S.x[k] - x, S.y[k] - y) < r) return true; } return false; };
    const dropped = new Uint8Array(S.n);
    let moved = 0, gone = 0;
    for (let k = 0; k < S.n; k++) {
      if (S.anim[k] === ANIM.sit) continue;
      const dx = S.ax[k] - S.x[k], dy = S.ay[k] - S.y[k], L = Math.hypot(dx, dy);
      const blocked = (ax, ay) => near(ax, ay, 0.5, k) || (L > 0.05 && near((ax + S.x[k]) / 2, (ay + S.y[k]) / 2, 0.35, k));
      if (!blocked(S.ax[k], S.ay[k])) continue;
      let ok = false;
      if (L > 0.05) for (const extra of [0.35, 0.7]) { const ax = S.ax[k] + dx / L * extra, ay = S.ay[k] + dy / L * extra; if (okStand(ax, ay, 0.3) && !near(ax, ay, 0.5, k) && lineClear(N, S.x[k], S.y[k], ax, ay, 0.15)) { S.ax[k] = ax; S.ay[k] = ay; ok = true; moved++; break; } }
      if (!ok) { dropped[k] = 1; gone++; }
    }
    if (gone) for (const s of sites) s.slots = s.slots.filter((k) => !dropped[k]);
    stats.slotsMoved = moved; stats.slotsDropped = gone;
  }
  for (const s of sites) { if (s.slots.length === 0) s.open = false; if (s.kind === 'stage') s.weight = 1.5 + Math.min(3, s.slots.length / 8); if (s.kind === 'rail' || s.kind === 'look') s.cap = Math.min(s.cap, s.slots.length); }

  // ── hubs: greedy clusters of open sites (radius HUB_R), each gets a global flow field ──
  const HUB_R = 40;
  const hubs = [];
  const order = sites.filter((s) => s.open).sort((a, b) => (a.kind === 'gate') - (b.kind === 'gate') || a.x - b.x);
  for (const s of order) {
    let best = -1, bd = HUB_R;
    if (s.kind !== 'gate') for (let h = 0; h < hubs.length; h++) { const H = hubs[h]; if (H.gate) continue; const d = Math.hypot(H.x - s.x, H.y - s.y); if (d < bd) { bd = d; best = h; } }
    if (best < 0) { best = hubs.length; hubs.push({ id: best, x: s.x, y: s.y, sites: [], gate: s.kind === 'gate' }); }
    s.hub = best; hubs[best].sites.push(s.id);
  }
  for (const H of hubs) {
    const src = new Set();
    for (const id of H.sites) for (const k of sites[id].slots) { const c = nearestCell(N, S.ax[k], S.ay[k], 2); if (c >= 0) src.add(c); }
    H.src = [...src];
    // the window of the local fields of this hub's sites: every source of the hub plus a margin (coarse cells)
    let I0 = 1e9, J0 = 1e9, I1 = -1e9, J1 = -1e9;
    for (const c of H.src) { const K = N.ccell[c], I = K % N.cw, J = (K / N.cw) | 0; if (I < I0) I0 = I; if (I > I1) I1 = I; if (J < J0) J0 = J; if (J > J1) J1 = J; }
    const M = 14; H.win = { I0: I0 - M, J0: J0 - M, I1: I1 + M + 1, J1: J1 + M + 1 };
  }
  return { sites, slots: S, hubs, railSites, gate, stats, comp, main };
}

function distPoly(poly, x, y) {
  let best = 1e9;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length], ex = x2 - x1, ey = y2 - y1;
    const t = Math.max(0, Math.min(1, ((x - x1) * ex + (y - y1) * ey) / (ex * ex + ey * ey || 1)));
    best = Math.min(best, Math.hypot(x - x1 - ex * t, y - y1 - ey * t));
  }
  return best;
}
function polarR(poly, phi) {
  const dx = Math.cos(phi), dy = Math.sin(phi); let best = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length], ex = x2 - x1, ey = y2 - y1, den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (x1 * ey - y1 * ex) / den, u = (x1 * dy - y1 * dx) / den;
    if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.max(best, t);
  }
  return best;
}
