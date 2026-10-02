// Guests: the crowd simulation's module Worker. It prepares the navigation data, runs the simulation (sim.js, in its
// own thread) and posts the state array back after every step; local flow fields are computed here between steps.
import { createCrowd } from './sim.js';

let crowd = null;
const pool = [];
let statT = 0;
self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      crowd = createCrowd({ ...m.opts, sync: true, manualLocal: true });
      crowd.params.budget = 2.0;            // off the main thread: a looser budget (the adaptive LOD still caps the cost)
      self.postMessage({ type: 'ready', ready: crowd.ready, times: crowd.debug.times, error: crowd.debug.error });
    } else if (m.type === 'step' && crowd) {
      if (crowd.want !== m.want) crowd.setCount(m.want);
      crowd.update(m.dt, m.time, m.focus);
      const buf = pool.length ? pool.pop() : new Float32Array(crowd.state.length);
      buf.set(crowd.state);
      let stats = null;
      if (++statT % 30 === 0) { const d = crowd.debug; stats = { frameMean: d.frameMean, frameMax: d.frameMax, lodK: d.lodK, thinkers: d.thinkers, times: d.times }; }
      self.postMessage({ type: 'state', buf, active: crowd.active, stats }, [buf.buffer]);
      // between steps: one local flow field (a few ms; the state is already on its way)
      crowd.debug.pumpLocal(1);
    } else if (m.type === 'buf') { if (pool.length < 3) pool.push(m.buf); }
    else if (m.type === 'motion' && crowd) crowd.setReduceMotion(m.on);
    else if (m.type === 'params' && crowd) Object.assign(crowd.params, m.params);
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err && err.stack || err) });
  }
};
