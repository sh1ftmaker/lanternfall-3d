// Culling for Lanternfall 3D ('#no-cull' turns all of it off; window.__park.cull has the switch and the numbers).
//
// What it does, per camera (main view, the lake's mirror, its environment cube, the moon shadow map, the weather cover
// map: every renderer.render() of the park scene goes through one hook, so a chunk hidden from one camera is never
// hidden from another):
//  1. Park chunks: an exact box-against-frustum test on each chunk's world bounding box (three.js only tests the
//     bounding sphere, which for a 64 m cell 10-200 m tall is far looser: 8-9 more chunks culled in a street-level
//     view, 20-35 % fewer park triangles there). Rejected chunks are hidden for that one render call and shown again
//     right after it, so the shadow / cover passes, the platformer, the guests and fx/depth.js see the park unchanged.
//  2. The forest (8.9k instanced trees in six species, frustumCulled = false before): each species keeps ONE
//     instance buffer, laid out by polar cell around the lake (sector x ring); per camera the visible cells are found
//     with the same box test and drawn as contiguous runs of that buffer (an instanced attribute view with an offset),
//     so the draw-call count stays 1-3 per species while the trees out of view are not submitted. The trees drawn are
//     exactly the ones drawn before for any forest fraction (Q.forest / adapt()): the buffer is laid out as
//     [the drawn trees, by cell][the rest], re-laid on setFraction().
// Occlusion culling (ideal ID-buffer bound, depth pre-pass, three-mesh-bvh ray casts) was measured and is not done:
// tools/culling/README.md has the numbers.
export function createCull({ THREE, renderer, scene, camera, park, on = true }) {
  const st = { on, chunks: 0, visible: 0, tris: 0, forestTris: 0, forestCells: 0, forestCellsVisible: 0, forestDraws: 0, ms: 0, renders: 0 };
  const fr = new THREE.Frustum(), pm = new THREE.Matrix4(), PAD = 0.1;
  let items = [], seen = -1;                                     // park chunks: { mesh, box (world, padded) }
  const species = [];
  function refresh() {                                           // the park grows while it loads: pick up new chunks
    seen = park.children.length; items = [];
    for (const m of park.children) {
      if (!m.isMesh || !m.geometry.boundingBox) continue;
      m.updateWorldMatrix(true, false);
      items.push({ mesh: m, box: m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld).expandByScalar(PAD) });
    }
    st.chunks = items.length;
  }
  function frustumOf(cam) {                                      // what WebGLRenderer.render() will use for this camera
    if (cam.parent === null) { if (cam.matrixWorldAutoUpdate) cam.updateMatrixWorld(); }
    else { let r = cam; while (r.parent) r = r.parent; if (r === scene && scene.matrixWorldAutoUpdate) cam.updateWorldMatrix(true, false); }
    return fr.setFromProjectionMatrix(pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse), THREE.WebGLCoordinateSystem, cam.reversedDepth);
  }

  /* ── the forest ── */
  // cells: S sectors round the lake x two rings (split at R1 m), ordered ring-major so neighbouring sectors are
  // neighbours in the buffer and a view's visible cells form one or two arcs per ring; at most MAXR runs (draw calls)
  // per species: beyond that the runs with the fewest trees between them are merged (those trees are drawn too)
  const S = 24, R1 = 360, SEC = (2 * Math.PI) / S, MAXR = 3;
  function splitForest(list) {
    if (!st.on) return;
    const M = new THREE.Matrix4(), bb = new THREE.Box3();
    for (let s = 0; s < list.length; s++) {
      const im = list[s]; if (!im.isInstancedMesh || !im.userData.total) continue;
      const N = im.userData.total, src = im.instanceMatrix.array, geo = im.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const C = S * 2, cell = new Uint16Array(N), boxes = Array.from({ length: C }, () => new THREE.Box3());
      for (let k = 0; k < N; k++) {                              // k = rank in the original shuffled order
        const x = src[k * 16 + 12], z = src[k * 16 + 14];
        const a = Math.min(S - 1, Math.floor((Math.atan2(z, x) + Math.PI) / SEC)), c = (Math.hypot(x, z) < R1 ? 0 : S) + a;
        cell[k] = c; M.fromArray(src, k * 16); boxes[c].union(bb.copy(geo.boundingBox).applyMatrix4(M));
      }
      for (const b of boxes) if (!b.isEmpty()) b.expandByScalar(PAD);
      const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(N * 16), 16, 1);
      const sp = { im, N, src, cell, boxes, buf, C, start: new Int32Array(C + 1), views: new Map(), runs: [], rr: new Int32Array(2 * S * 2 + 2), lim: im.count, grp: new THREE.Group(), sphere: (im.computeBoundingSphere(), im.boundingSphere.clone()) };
      sp.grp.name = 'forest-' + s; sp.grp.visible = im.visible; sp.grp.userData.total = N;
      sp.grp.userData.setFraction = (f) => { layout(sp, Math.floor(N * f)); sp.grp.visible = f > 0; };
      layout(sp, im.count);
      scene.remove(im); scene.add(sp.grp); im.dispose();
      list[s] = sp.grp; species.push(sp); st.forestCells += boxes.filter((b) => !b.isEmpty()).length;
    }
    configureAll();
  }
  // [trees with rank < lim, sorted by cell][the rest]: start[c]..start[c+1] are the drawn trees of cell c
  function layout(sp, lim) {
    const { N, src, cell, C, start } = sp, dst = sp.buf.array; sp.lim = lim;
    start.fill(0);
    for (let k = 0; k < lim; k++) start[cell[k] + 1]++;
    for (let c = 0; c < C; c++) start[c + 1] += start[c];
    const fill = start.slice(0, C); let rest = lim;
    for (let k = 0; k < N; k++) { const o = k < lim ? fill[cell[k]]++ : rest++; dst.set(src.subarray(k * 16, k * 16 + 16), o * 16); }
    sp.buf.needsUpdate = true;
  }
  function view(sp, at) {                                        // the instance buffer seen from instance `at` on
    let v = sp.views.get(at);
    if (!v) { v = new THREE.InterleavedBufferAttribute(sp.buf, 16, at * 16); sp.views.set(at, v); }
    return v;
  }
  function run(sp, i) {
    let r = sp.runs[i];
    if (!r) {
      r = new THREE.InstancedMesh(sp.im.geometry, sp.im.material, 1);
      // the sort key three uses for opaque objects (frustumCulled is off) is the whole species' sphere, as before the split:
      // every run of a species sorts where the unsplit forest did, in buffer order (object id), so the draw order
      // relative to the park, and between trees, is the same with culling on or off (no depth-tie flips)
      r.frustumCulled = false; r.matrixAutoUpdate = false; r.boundingSphere = sp.sphere; r.name = sp.grp.name + '-run' + i;
      sp.runs[i] = r; sp.grp.add(r);
    }
    return r;
  }
  function setRun(sp, i, c0, c1) {                               // cells c0..c1-1 drawn by run i
    const r = run(sp, i), a = sp.start[c0], b = sp.start[c1];
    r.instanceMatrix = view(sp, a); r.count = b - a; r.visible = b > a;
    return b - a;
  }
  function configureAll() { for (const sp of species) { setRun(sp, 0, 0, sp.C); for (let i = 1; i < sp.runs.length; i++) sp.runs[i].visible = false; } }
  function configureForest(f, main) {
    let draws = 0, cells = 0, tris = 0;
    for (const sp of species) {
      if (!sp.grp.visible) continue;
      const C = sp.C, tv = sp.im.geometry.attributes.position.count / 3, R = sp.rr; let c = 0, k = 0;
      while (c < C) {                                            // runs of visible cells (empty cells join either side)
        while (c < C && !(sp.start[c + 1] > sp.start[c] && f.intersectsBox(sp.boxes[c]))) c++;
        if (c >= C) break;
        const c0 = c; while (c < C && (sp.start[c + 1] === sp.start[c] || f.intersectsBox(sp.boxes[c]))) { if (sp.start[c + 1] > sp.start[c]) cells++; c++; }
        R[k++] = c0; R[k++] = c;
      }
      while (k > 2 * MAXR) {                                     // merge the two runs with the fewest trees between them
        let best = 2, bg = Infinity;
        for (let i = 2; i < k; i += 2) { const g = sp.start[R[i]] - sp.start[R[i - 1]]; if (g < bg) { bg = g; best = i; } }
        R[best - 1] = R[best + 1]; R.copyWithin(best, best + 2, k); k -= 2;
      }
      for (let i = 0; i < k; i += 2) tris += setRun(sp, i >> 1, R[i], R[i + 1]) * tv;
      for (let i = k >> 1; i < sp.runs.length; i++) sp.runs[i].visible = false;
      draws += k >> 1;
    }
    if (main) { st.forestCellsVisible = cells; st.forestDraws = draws; st.forestTris = tris; }
  }

  /* ── the hook ── */
  const r0 = renderer.render;
  const hidden = []; let acc = 0;
  renderer.render = function (s, cam) {
    if (!st.on || s !== scene) return r0.call(this, s, cam);
    const t0 = performance.now(), main = cam === camera;
    if (park.children.length !== seen) refresh();
    const f = frustumOf(cam);
    let vis = 0, tris = 0;
    for (const it of items) {
      const m = it.mesh; if (!m.visible) continue;
      if (f.intersectsBox(it.box)) { vis++; if (main) { const g = m.geometry; tris += Math.min(g.drawRange.count, g.index ? g.index.count : 0); } }
      else { m.visible = false; hidden.push(m); }
    }
    if (species.length) configureForest(f, main);
    if (main) { st.visible = vis; st.tris = Math.round(tris / 3); }
    acc += performance.now() - t0; st.renders++;
    if (main) { st.ms += (acc - st.ms) * 0.05; acc = 0; }       // CPU ms per frame (all passes up to the main view), smoothed
    try { return r0.call(this, s, cam); }
    finally { for (const m of hidden) m.visible = true; hidden.length = 0; }
  };
  function set(b) {
    st.on = !!b;
    if (!st.on) configureAll();
  }
  return { st, stats: st, set, splitForest, get on() { return st.on; }, refresh };
}
