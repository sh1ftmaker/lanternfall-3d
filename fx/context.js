// WebGL context loss and restore.
//
// A context can be lost at any time (GPU reset, driver update, too many contexts; headless Chrome on ANGLE-Vulkan
// loses and restores one about a second after page load). three.js prevents the default, and on restore builds a
// fresh renderer state: new property maps, so geometries, textures and programs are uploaded again on next use.
// Two things it leaves to the app:
//  1. Every texture, render target, geometry and material that was used before the loss still carries a 'dispose'
//     listener from the OLD renderer state, holding GL handles of the dead context. Disposing it later (HD toggle,
//     composer rebuild, mirror resize) deletes those handles: "INVALID_OPERATION: delete: object does not belong to
//     this context". trackDisposables() remembers every object with a dispose listener, and dropStaleListeners()
//     clears them on restore; three adds fresh ones the next time the object is used.
//  2. Render-target contents (water simulation, captured cube map, history buffers) are gone: the app re-validates
//     them through the onRestored callback.
// While the context is lost the frame loop should not render (see app.js frame()).
const tracked = new Set();
let installed = false;

export function trackDisposables(THREE) {
  if (installed) return; installed = true;
  const P = THREE.EventDispatcher.prototype, add = P.addEventListener, remove = P.removeEventListener;
  P.addEventListener = function (type, listener) { if (type === 'dispose') tracked.add(this); return add.call(this, type, listener); };
  P.removeEventListener = function (type, listener) {
    const r = remove.call(this, type, listener);
    if (type === 'dispose') { const l = this._listeners && this._listeners.dispose; if (!l || !l.length) tracked.delete(this); }
    return r;
  };
}

export function dropStaleListeners() {
  for (const o of tracked) if (o._listeners && o._listeners.dispose) o._listeners.dispose.length = 0;
  tracked.clear();
}

// onLost / onRestored are called after three's own handlers (they are registered later on the same canvas)
export function watchContext(renderer, { onLost, onRestored } = {}) {
  const canvas = renderer.domElement, st = { lost: false, losses: 0 };
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); st.lost = true; st.losses++;
    // three's renderer.extensions caches every answer, and answers null while the context is lost; it is only replaced
    // in three's restore handler, which runs a moment after gl.isContextLost() is false again. A loader checking
    // formats in that gap (KTX2Loader.detectSupport) read the cached nulls and fell back to uncompressed RGBA. Until
    // three builds the new one, renderer.extensions asks the context itself and caches nothing.
    const gl = renderer.getContext(), old = renderer.extensions;
    renderer.extensions = { ...old, has: (n) => !gl.isContextLost() && gl.getExtension(n) !== null, get: (n) => (gl.isContextLost() ? null : gl.getExtension(n)), init() {} };
    onLost && onLost();
  }, false);
  canvas.addEventListener('webglcontextrestored', () => { dropStaleListeners(); st.lost = false; onRestored && onRestored(); }, false);
  return st;
}

// Capability checks must not run while the context is lost: gl.getExtension() then returns null, three's
// renderer.extensions caches that null for as long as that context state lives, and a loader that detects formats once
// (KTX2Loader.detectSupport) keeps "no compressed formats" for good and uploads uncompressed RGBA (4-8x the GPU memory).
// whenLive(renderer, fn) runs fn now if the context is live, else on restore; with { again: true } also after every
// later restore (three rebuilds renderer.extensions then, so re-detect there).
export function whenLive(renderer, fn, { again = false } = {}) {
  const gl = renderer.getContext(), canvas = renderer.domElement;
  const run = () => { try { fn(renderer); } catch (e) { console.warn('whenLive:', e); } };
  if (!gl.isContextLost()) run();
  else canvas.addEventListener('webglcontextrestored', () => setTimeout(run, 0), { once: true });
  if (again) canvas.addEventListener('webglcontextrestored', () => setTimeout(run, 0));     // after three's own handler
}
// a capability check that is honest about a lost context: null = unknown (ask again later), not "unsupported"
export function hasExtension(renderer, name) {
  const gl = renderer.getContext();
  if (gl.isContextLost()) return null;
  return !!gl.getExtension(name);
}
