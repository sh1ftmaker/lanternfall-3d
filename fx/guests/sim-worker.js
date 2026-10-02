// Guests: module Worker for the crowd's preparation (sim-prep.js) and on-demand local flow fields.
import { prepare, localField } from './sim-prep.js';

let D = null;
self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'prepare') {
      D = prepare(m.nav, m.manifest, m.pois, m.seed, m.ground);
      const { N, P, hubF, times } = D;
      // the main thread gets copies (the worker keeps its own for local fields)
      const Nm = { W: N.W, H: N.H, x0: N.x0, y0: N.y0, cell: N.cell, A: null, clr: N.clr.slice(), cw: N.cw, ch: N.ch, cidx: N.cidx.slice(), m: N.m,
        ccell: N.ccell.slice(), cfine: N.cfine.slice(), chgt: N.chgt.slice(), ccost: N.ccost.slice(), csurf: N.csurf.slice(), cnb: N.cnb.slice(), times: N.times };
      const S = P.slots, Sm = { n: S.n, cap: S.cap, x: S.x.slice(), y: S.y.slice(), z: S.z.slice(), yaw: S.yaw.slice(), ax: S.ax.slice(), ay: S.ay.slice(), anim: S.anim.slice(), site: S.site.slice(), occ: S.occ.slice() };
      const Pm = { sites: P.sites, slots: Sm, hubs: P.hubs, railSites: P.railSites.map((s) => s.id), gate: P.gate, stats: P.stats, comp: { lab: P.comp.lab.slice(), sizes: P.comp.sizes }, main: P.main };
      const hub = hubF; D.hubF = null;          // the worker does not need them again
      const transfer = [Nm.clr.buffer, Nm.cidx.buffer, Nm.ccell.buffer, Nm.cfine.buffer, Nm.chgt.buffer, Nm.ccost.buffer, Nm.csurf.buffer, Nm.cnb.buffer, Pm.comp.lab.buffer, ...hub.map((f) => f.buffer)];
      self.postMessage({ type: 'ready', prep: { N: Nm, P: Pm, hubF: hub, times } }, transfer);
    } else if (m.type === 'local' && D) {
      const f = localField(D.N, D.P, m.site);
      self.postMessage({ type: 'local', site: m.site, f }, [f.dir.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err && err.stack || err) });
  }
};
