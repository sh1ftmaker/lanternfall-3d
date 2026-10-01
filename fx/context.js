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
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); st.lost = true; st.losses++; onLost && onLost(); }, false);
  canvas.addEventListener('webglcontextrestored', () => { dropStaleListeners(); st.lost = false; onRestored && onRestored(); }, false);
  return st;
}
