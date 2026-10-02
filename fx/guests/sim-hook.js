// Guests: local test wiring for the crowd simulation (the orchestrator does the final wiring in app.js).
// '#guests-sim' runs the simulation with the debug figures; '#guests-map' adds the top-down overlay;
// '#guests=N' sets the crowd size. Exposed as window.__park.guests = { crowd, debug view }.
import { createCrowd } from './sim.js';
import { createSimDebug } from './sim-debug.js';

export async function hookGuests({ THREE, scene, nav, manifest, mobile, reduceMotion, hash }) {
  let pois = null;
  try { const r = await fetch('data/guests.json', { cache: 'no-cache' }); if (r.ok) pois = await r.json(); } catch (e) { /* no points of interest: the crowd uses its own */ }
  const m = /guests=(\d+)/.exec(location.hash);
  const count = m ? +m[1] : mobile ? 350 : 1300;
  const crowd = createCrowd({ nav, manifest, pois, count, seed: 1, reduceMotion, max: Math.max(2200, count) });
  const view = createSimDebug({ THREE, scene, crowd, overlay: hash.has('guests-map') });
  const focus = { x: 0, y: 0, z: 0, mode: 'tour', tour: -1 };
  const api = {
    crowd, view, focus,
    update(dt, time, camera, mode, tour) {
      focus.x = camera.position.x; focus.y = -camera.position.z; focus.z = camera.position.y; focus.mode = mode; focus.tour = mode === 'tour' ? tour : -1;
      if (mode === 'walk' && window.__park) { const w = window.__park.walk; focus.x = w.x; focus.y = w.y; focus.z = w.z; }
      crowd.update(dt, time, focus);
      view.update();
    },
  };
  return api;
}
