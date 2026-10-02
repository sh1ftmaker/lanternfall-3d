// Guests: everything the crowd needs before the first step, computed once (in a Worker when the browser has module
// workers, else on the main thread): the walk-grid clearance + coarse graph (sim-nav.js), the sites and slots
// (sim-poi.js) and one global flow field per hub. Local fields for single sites are computed on request (`local()`).
import { buildNav, field } from './sim-nav.js';
import { buildSites } from './sim-poi.js';

export function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// a site's local field covers its hub's window (all the hub's sources + a margin); this half-size is the fallback
export const LOCAL_HALF = 88;

export function prepare(nav, manifest, pois, seed = 1, ground = null) {
  const t0 = now();
  const N = buildNav(nav, { ground });
  const t1 = now();
  const P = buildSites(N, manifest, pois, mulberry(seed * 7919 + 13));
  const t2 = now();
  const hubF = P.hubs.map((H) => field(N, H.src));
  const t3 = now();
  return { N, P, hubF, times: { nav: t1 - t0, sites: t2 - t1, fields: t3 - t2, total: t3 - t0 } };
}

export function localField(N, P, siteId) {
  const s = P.sites[siteId], S = P.slots, src = [];
  const I = Math.floor((s.x - N.x0) / (2 * N.cell)), J = Math.floor((s.y - N.y0) / (2 * N.cell));
  for (const k of s.slots) {
    const i = Math.floor((S.ax[k] - N.x0) / (2 * N.cell)), j = Math.floor((S.ay[k] - N.y0) / (2 * N.cell));
    let c = N.cidx[j * N.cw + i];
    if (c < 0) { // nearest passable coarse cell within 2 cells
      let bd = 99;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) { const c2 = N.cidx[(j + dj) * N.cw + i + di]; if (c2 >= 0 && di * di + dj * dj < bd) { bd = di * di + dj * dj; c = c2; } }
    }
    if (c >= 0) src.push(c);
  }
  const w = P.hubs[s.hub] && P.hubs[s.hub].win;
  return field(N, src, w || { I0: I - LOCAL_HALF, J0: J - LOCAL_HALF, I1: I + LOCAL_HALF, J1: J + LOCAL_HALF });
}

function now() { return (typeof performance !== 'undefined' ? performance : Date).now(); }
