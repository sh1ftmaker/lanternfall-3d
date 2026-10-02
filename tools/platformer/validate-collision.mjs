// Independent check of the Platformer's collision export, run inside the park page (puppeteer):
//   node tools/platformer/validate-collision.mjs [--url http://127.0.0.1:8851/index.html] [--out dir] [--shots]
// (puppeteer-core must be resolvable: run it from a directory that has it, e.g. the scratch tooling, or set NODE_PATH.)
// For a set of windows it reports triangle counts by kind, coordinate ranges, winding (floors face up, ceilings down,
// walls vertical within the snap), gather and library load times, and compares the library's floor height with the
// walk grid (data/nav.bin) at random walkable cells: the walk grid is an independent survey of where people can stand.
// With --shots it also renders each window's collision triangles over the park (floors green, walls blue, ceilings
// red, ice cyan, perimeter walls yellow, lake bed teal) and saves JPEGs.
import puppeteer from 'puppeteer-core';
import path from 'node:path';
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const out = opt('out', '.'), shots = args.includes('--shots');
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--window-size=1280,800'] });
const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
const logs = []; page.on('console', (m) => logs.push(m.type() + ': ' + m.text().slice(0, 300))); page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
await page.goto(opt('url', 'http://127.0.0.1:8851/index.html') + ('?' + (args.includes('--noflip') ? 'noflip&' : '') + 'minWall=' + opt('minWall', '0.16') + '&minFloor=' + opt('minFloor', '0.015')) + '#no-guests', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__park && window.__park.loaded', { timeout: 240000, polling: 500 });
const WINDOWS = { gate: [288, 0], avenue: [200, 0], spire: [0, 30], lakeEdge: [100, 0], guildhollow: [-170, 10], frostmere: [-94, 62], meridian: [55, 110], wanderers: [150, 45], brinewatch: [130, -60], lanternRow: [30, -120], rosewick: [-110, -90], perimeterEast: [335, 30] };
const report = await page.evaluate(async (WINDOWS) => {
  const P = window.__park;
  const { createCollision, UNITS } = await import('/fx/platformer/collision.js');
  const { loadSM64 } = await import('/fx/platformer/sm64.js');
  const { animTable } = await import('/fx/platformer/anims.js');
  const park = P.scene.children.find((o) => o.isGroup && o.children.length > 100);
  const manifest = await (await fetch('/data/manifest.json')).json();
  const col = createCollision({ park, lodMeshes: P.lodMeshes, manifest, nav: P.nav, flipDown: !/noflip/.test(location.search), minWall: +(/minWall=([\d.]+)/.exec(location.search) || [0, 0.16])[1], minFloor: +(/minFloor=([\d.]+)/.exec(location.search) || [0, 0.015])[1] });
  const it = col.prepareSteps(Infinity); while (!it.next().done);
  const sm = await loadSM64('/fx/platformer/sm64.wasm'); sm.init(animTable());
  const nav = P.nav, navH = (v) => (v - 1) / 100 - 2;
  const res = { prepare: { ms: col.stats.prepMs, seen: col.stats.seen, kept: col.stats.kept, dropped: col.stats.dropped, big: col.stats.big, perimeterSegments: col.stats.perimeter, bedCells: col.stats.bedCells }, windows: {} };
  for (const [name, [bx, by]] of Object.entries(WINDOWS)) {
    const cx = bx, cz = -by;
    const g = col.gather(cx, cz, 30), A = g.packed, n = g.count;
    let lo = 2 ** 31, hi = -(2 ** 31), up = 0, down = 0, vert = 0, steep = 0, maxEdge = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 11 + 2;
      for (let k = 0; k < 9; k++) { lo = Math.min(lo, A[o + k]); hi = Math.max(hi, A[o + k]); }
      const ux = A[o + 3] - A[o], uy = A[o + 4] - A[o + 1], uz = A[o + 5] - A[o + 2], vx = A[o + 6] - A[o + 3], vy = A[o + 7] - A[o + 4], vz = A[o + 8] - A[o + 5];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1, yn = ny / l;
      if (yn > 0.01) up++; else if (yn < -0.01) down++; else vert++;
      if (Math.abs(yn) > 0.01 && Math.abs(yn) < 0.06) steep++;
      maxEdge = Math.max(maxEdge, Math.hypot(ux, uz), Math.hypot(vx, vz));
    }
    const t0 = performance.now(); try { sm.loadSurfaces(A, n); } catch (e) { res.windows[name] = { count: n, error: String(e), rangeUnits: [lo, hi] }; continue; } const loadMs = performance.now() - t0;
    // nav survey: random walkable cells within 24 m of the window centre
    const hist = { within10cm: 0, within30cm: 0, within1m: 0, off: 0, missing: 0, samples: 0 }, worst = [];
    for (let s = 0; s < 4000 && hist.samples < 600; s++) {
      const x = cx + (Math.random() * 2 - 1) * 24, z = cz + (Math.random() * 2 - 1) * 24;
      const i = Math.floor((x - nav.x0) / nav.cell), j = Math.floor((-z - nav.y0) / nav.cell);
      if (i < 0 || j < 0 || i >= nav.w || j >= nav.h) continue;
      const v = nav.A[j * nav.w + i]; if (!v) continue;
      const h = navH(v); hist.samples++;
      const f = sm.findFloor(x * UNITS, (h + 1.0) * UNITS, z * UNITS) / UNITS;
      if (f < -100) { hist.missing++; worst.push([+x.toFixed(1), +(-z).toFixed(1), +h.toFixed(2), 'none']); continue; }
      const d = Math.abs(f - h);
      if (d < 0.1) hist.within10cm++; else if (d < 0.3) hist.within30cm++; else if (d < 1) hist.within1m++; else { hist.off++; worst.push([+x.toFixed(1), +(-z).toFixed(1), +h.toFixed(2), +f.toFixed(2)]); }
    }
    res.windows[name] = { count: n, ...g.stats, rangeUnits: [lo, hi], facing: { up, down, vertical: vert, nearVerticalSnapped: steep }, maxEdgeM: +(maxEdge / UNITS).toFixed(1), libLoadMs: +loadMs.toFixed(1), wasmMB: +(sm.memoryBytes / 1048576).toFixed(1), nav: hist, worst: worst.slice(0, 5) };
  }
  window.__colcheck = { col };
  return res;
}, WINDOWS);
console.log(JSON.stringify(report, null, 1));
if (shots) {
  for (const name of ['gate', 'spire', 'frostmere', 'brinewatch', 'perimeterEast']) {
    const [bx, by] = WINDOWS[name];
    await page.evaluate(async (bx, by) => {
      const P = window.__park, THREE = await import('three'), col = window.__colcheck.col;
      if (window.__colmesh) { P.scene.remove(window.__colmesh); window.__colmesh.geometry.dispose(); }
      const g = col.gather(bx, -by, 30), A = g.packed, n = g.count, pos = new Float32Array(n * 9), colr = new Float32Array(n * 9);
      const st = g.stats, nf = st.floors + st.flipped, kinds = [];
      for (let i = 0; i < n; i++) {
        const o = i * 11; for (let k = 0; k < 9; k++) pos[i * 9 + k] = A[o + 2 + k] / 100 + (k % 3 === 1 ? 0.03 : 0);
        const ux = A[o + 5] - A[o + 2], uy = A[o + 6] - A[o + 3], uz = A[o + 7] - A[o + 4], vx = A[o + 8] - A[o + 2], vy = A[o + 9] - A[o + 3], vz = A[o + 10] - A[o + 4];
        const ny = (uz * vx - ux * vz) / (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) || 1);
        const type = A[o] & 0xffff, terrain = A[o + 1];
        let c = ny > 0.06 ? [0.2, 0.9, 0.3] : ny < -0.06 ? [0.9, 0.2, 0.2] : [0.25, 0.45, 1];
        if (type === 0x2e) c = [0.2, 1, 1]; if (terrain === 5) c = [0.1, 0.6, 0.6];
        if (Math.abs(ny) <= 0.06 && Math.max(A[o + 3], A[o + 6], A[o + 9]) >= 4400) c = [1, 0.85, 0.1];
        for (let k = 0; k < 3; k++) colr.set(c, i * 9 + k * 3);
      }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(colr, 3));
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, wireframe: true, transparent: true, opacity: 0.55, depthTest: true }));
      m.frustumCulled = false; m.renderOrder = 20; P.scene.add(m); window.__colmesh = m;
      P.setMode('orbit'); P.controls.target.set(bx, 2, -by); P.camera.position.set(bx + 34, 46, -by + 40); P.controls.update();
    }, bx, by);
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(out, `collision_${name}.jpg`), type: 'jpeg', quality: 82 });
  }
}
const errs = logs.filter((l) => /error|warn/i.test(l) && !/GPU stall|Context/.test(l));
if (errs.length) console.log('console:', errs.slice(0, 10));
await browser.close();
