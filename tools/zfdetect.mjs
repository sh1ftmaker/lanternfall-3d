// Z-fight detector for Lanternfall 3D.
// For a fixed set of camera poses it renders the frame twice with a tiny perturbation and counts the pixels that
// change. Stable geometry renders identically; coplanar or nearly coplanar surfaces whose depth test is decided by
// rounding "flip" and show up as differing pixels. Time is frozen, lanterns are hidden and the reflective Water is
// swapped for the flat lake shader, so nothing else changes between the two frames.
//   near : camera.near * 1.013 (projection x/y unchanged -> zero edge noise; isolates depth-rounding flips)
//   move : ~6 mm camera translation (realistic motion); counts only pixels that a <=1 px image shift cannot explain
// "floor" counts only pixels whose visible surface lies at -0.3 m < y < 0.6 m (an extra mask render).
//
// usage (puppeteer-core must resolve: copy/run this file from $SC/pp/<dir>/):
//   node zfdetect.mjs --url http://127.0.0.1:8802/index.html --out DIR [--hd 1|0] [--w 1280 --h 720 --dsf 1]
//        [--mobile] [--only name,name] [--img name,name] [--seq name,name]   (--seq: 12-frame slow-move flicker test)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const mobile = args.includes('--mobile');
const W = +opt('w', mobile ? 390 : 1280), H = +opt('h', mobile ? 844 : 720), DSF = +opt('dsf', mobile ? 2 : 1);
const URL_ = opt('url', 'http://127.0.0.1:8802/index.html'), OUT = opt('out', 'zf-out'), HD = opt('hd', '1') === '1';
const only = opt('only', ''), imgs = new Set(opt('img', '').split(',').filter(Boolean)), seqs = new Set(opt('seq', '').split(',').filter(Boolean));
fs.mkdirSync(OUT, { recursive: true });

// tour: __park.setTour(t). orbit: Explore pose above a land (place id, height, horizontal offset towards the lake).
// walk: places' walk spot (or explicit at) with yaw and pitch.
const ALL = [
  { name: 'tour06-overview', kind: 'tour', t: 6 },
  { name: 'tour56-wanderers', kind: 'tour', t: 56 },
  { name: 'tour67-meridian', kind: 'tour', t: 67 },
  { name: 'tour79-frostmere', kind: 'tour', t: 79 },
  { name: 'tour90-guildhollow', kind: 'tour', t: 90 },
  { name: 'tour101-rosewick', kind: 'tour', t: 101 },
  { name: 'tour113-lanternrow', kind: 'tour', t: 113 },
  { name: 'tour125-brinewatch', kind: 'tour', t: 125 },
  { name: 'tour152-pullback', kind: 'tour', t: 152 },
  { name: 'ex-meridian-h90', kind: 'orbit', place: 'meridian', h: 90, off: 30 },
  { name: 'ex-guildhollow-h90', kind: 'orbit', place: 'guildhollow', h: 90, off: 30 },
  { name: 'ex-lanternrow-h90', kind: 'orbit', place: 'lantern-row', h: 90, off: 30 },
  { name: 'ex-rosewick-h45', kind: 'orbit', place: 'rosewick', h: 45, off: 18 },
  { name: 'walk-gate-avenue', kind: 'walk', at: [288, 0], yaw: Math.PI, pitch: -0.10 },
  { name: 'walk-spire-plaza', kind: 'walk', place: 'spire', pitch: -0.10 },
  { name: 'walk-wanderers', kind: 'walk', place: 'wanderers', pitch: -0.10 },
  { name: 'walk-frostmere', kind: 'walk', place: 'frostmere', pitch: -0.10 },
  { name: 'walk-rosewick', kind: 'walk', place: 'rosewick', pitch: -0.10 },
  { name: 'walk-lanternrow', kind: 'walk', place: 'lantern-row', pitch: -0.10 },
];
const POSES = ALL.filter((p) => !only || only.split(',').includes(p.name));

const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', `--window-size=${W},${H}`] });
const page = await browser.newPage();
const logs = []; page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); }); page.on('pageerror', (e) => logs.push('pageerror ' + e.message));
await page.setViewport({ width: W, height: H, deviceScaleFactor: DSF, isMobile: mobile, hasTouch: mobile });
await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__park && window.__park.loaded', { timeout: 180000 });
const ev = (f, ...a) => page.evaluate(f, ...a);

await ev(async (hd) => {
  const P = window.__park;
  P.perf.locked = true;
  if (P.Q.hd !== hd) document.querySelector('#btn-hd').click();
  const real = performance.now.bind(performance); let frozen = null, savedNear = 0;
  performance.now = () => (frozen !== null ? frozen : real());
  const water = P.water(), scene = P.scene;
  const flat = scene.children.find((o) => o.isMesh && o !== water && water && o.geometry === water.geometry);
  const SM = water.material.constructor;          // THREE.ShaderMaterial (THREE itself is not global)
  const maskMat = new SM({ side: 2, vertexShader: 'varying float vY; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vY = w.y; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'varying float vY; void main(){ gl_FragColor = vec4(vY > -0.3 && vY < 0.6 ? 1.0 : 0.0, 0.0, 0.0, 1.0); }' });
  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
  const frames = async (n) => { for (let i = 0; i < n; i++) await nextFrame(); };
  // read the canvas in a rAF callback queued after the app's: the drawing buffer still holds the frame just rendered
  const read = () => { const c = P.renderer.domElement, cv = document.createElement('canvas'); cv.width = c.width; cv.height = c.height;
    const x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0); return x.getImageData(0, 0, cv.width, cv.height); };
  const grab = () => new Promise((r) => requestAnimationFrame(() => r(read())));
  const floorMask = () => new Promise((r) => requestAnimationFrame(() => {
    const hide = scene.children.filter((o) => o.visible && (o.isPoints || o.isInstancedMesh || o.renderOrder === -1000));
    for (const o of hide) o.visible = false;
    const r0 = P.renderer, tm = r0.toneMapping; r0.toneMapping = 0;
    scene.overrideMaterial = maskMat; r0.setRenderTarget(null); r0.render(scene, P.camera); scene.overrideMaterial = null; r0.toneMapping = tm;
    for (const o of hide) o.visible = true;
    const im = read(), m = new Uint8Array(im.width * im.height); for (let i = 0; i < m.length; i++) m[i] = im.data[i * 4] > 127 ? 1 : 0; r(m);
  }));
  const diff = (a, b, mask, T = 8) => { let n = 0, nf = 0, s = 0; const d = a.data, e = b.data;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) { const v = Math.max(Math.abs(d[i] - e[i]), Math.abs(d[i + 1] - e[i + 1]), Math.abs(d[i + 2] - e[i + 2])); s += v; if (v > T) { n++; if (mask && mask[p]) nf++; } }
    return { px: n, floor: nf, sum: s }; };
  // flips that a <=1 px image shift cannot explain: b[p] differs by > T from every pixel of a's 3x3 neighbourhood
  const diffX = (a, b, mask, T = 8) => { const w = a.width, h = a.height, d = a.data, e = b.data; let n = 0, nf = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = (y * w + x) * 4; let best = 1e9;
      for (let dy = -1; dy <= 1 && best > T; dy++) for (let dx = -1; dx <= 1; dx++) { const j = i + (dy * w + dx) * 4;
        const v = Math.max(Math.abs(d[j] - e[i]), Math.abs(d[j + 1] - e[i + 1]), Math.abs(d[j + 2] - e[i + 2])); if (v < best) best = v; }
      if (best > T) { n++; if (mask && mask[y * w + x]) nf++; } }
    return { px: n, floor: nf }; };
  const diffImage = (a, b, T = 8) => { const cv = document.createElement('canvas'); cv.width = a.width; cv.height = a.height; const x = cv.getContext('2d'); const o = x.createImageData(a.width, a.height);
    for (let i = 0; i < a.data.length; i += 4) { const v = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
      const g = (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3 * 0.55; if (v > T) { o.data[i] = 255; o.data[i + 1] = 40; o.data[i + 2] = 40; } else { o.data[i] = o.data[i + 1] = o.data[i + 2] = g; } o.data[i + 3] = 255; }
    x.putImageData(o, 0, 0); return cv.toDataURL('image/jpeg', 0.85); };
  const toJpeg = (a) => { const cv = document.createElement('canvas'); cv.width = a.width; cv.height = a.height; cv.getContext('2d').putImageData(a, 0, 0); return cv.toDataURL('image/jpeg', 0.88); };
  window.__zf = { frames, grab, floorMask, diff, diffX, diffImage, toJpeg, freeze: (on) => { frozen = on ? real() : null; },
    prep: () => { if (P.lanterns()) P.lanterns().visible = false; if (water) water.visible = false; if (flat) flat.visible = true; },
    // perturb the depth mapping: a viewer with dynamic near planes exposes __park.depth.jitter
    nearJitter: (k) => { if (P.depth && 'jitter' in P.depth) { P.depth.jitter = k; return; }      // k = 1 restores
      if (k !== 1) { savedNear = P.camera.near; P.camera.near *= k; } else P.camera.near = savedNear; P.camera.updateProjectionMatrix(); } };
  frozen = real();     // time stands still from here on: dt = 0, so tour clock, trains, sky and water are fixed
  return frames(4);    // let the one frame with a non-zero dt pass before any pose is set
}, HD);

async function setPose(p, eps = 0) {      // eps: translation in metres (0 = the pose itself)
  return ev(async (p, eps) => {
    const P = window.__park, Z = window.__zf;
    if (p.kind === 'tour') {
      if (P.mode !== 'tour') P.setMode('tour');
      let dt = 0;
      if (eps) {      // find the tour-time step that moves the camera by eps
        P.setTour(p.t); await Z.frames(2); const a = P.camera.position.clone();
        P.setTour(p.t + 0.05); await Z.frames(2); const v = P.camera.position.distanceTo(a) / 0.05; dt = eps / Math.max(v, 1e-3);
      }
      P.setTour(p.t + dt); await Z.frames(2);
    } else if (p.kind === 'orbit') {
      const pl = P.places.find((q) => q.id === p.place);
      P.setMode('orbit', { keepTarget: true }); await Z.frames(1);
      const tx = pl.target.x + eps * 0.6, tz = pl.target.z + eps * 0.8;
      P.controls.target.set(tx, 0.5, tz);
      P.camera.position.set(tx + pl.lake[0] * p.off, p.h, tz - pl.lake[1] * p.off);
      P.camera.lookAt(P.controls.target); P.controls.update(0);
    } else {
      const pl = p.place && P.places.find((q) => q.id === p.place);
      const at = p.at || pl.walk, yaw = p.yaw !== undefined ? p.yaw : pl.yaw;
      if (P.mode !== 'walk') P.setMode('walk', { at, yaw }); else P.setMode('walk', { at, yaw });
      await Z.frames(2);
      P.walk.x += eps * 0.6; P.walk.y += eps * 0.8; P.walk.pitch = p.pitch; P.walk.yaw = yaw;
      P.camera.position.y = P.walk.z + P.walk.eye;     // no smoothing while frozen
    }
    Z.prep(); await Z.frames(24);                         // LOD updates every 8 frames
    return { pos: P.camera.position.toArray().map((v) => +v.toFixed(3)), near: +P.camera.near.toFixed(4), far: +P.camera.far.toFixed(1) };
  }, p, eps);
}
const save = (name, dataUrl) => fs.writeFileSync(`${OUT}/${name}.jpg`, Buffer.from(dataUrl.split(',')[1], 'base64'));

const results = [];
for (const p of POSES) {
  const info = await setPose(p);
  const r = await ev(async (wantImg) => {
    const Z = window.__zf;
    const mask = await Z.floorMask(); await Z.frames(2);
    const A = await Z.grab(); const A2 = await Z.grab();
    const noise = Z.diff(A, A2, mask);
    Z.nearJitter(1.013); await Z.frames(3); const N = await Z.grab(); Z.nearJitter(1); await Z.frames(2);
    const near = Z.diff(A, N, mask);
    let floorPx = 0; for (const v of mask) floorPx += v;
    window.__zfA = A;
    return { noise, near, floorPx, total: A.width * A.height, img: wantImg ? [Z.toJpeg(A), Z.diffImage(A, N)] : null };
  }, imgs.has(p.name) || imgs.has('all'));
  await setPose(p, 0.006);
  const m = await ev(async (wantImg) => { const Z = window.__zf; const B = await Z.grab(); const mask = await Z.floorMask();
    return { move: Z.diffX(window.__zfA, B, mask), img: wantImg ? Z.diffImage(window.__zfA, B) : null }; }, imgs.has(p.name) || imgs.has('all'));
  if (r.img) { save(p.name + '_frame', r.img[0]); save(p.name + '_dnear', r.img[1]); save(p.name + '_dmove', m.img); }
  const row = { pose: p.name, near: r.near.px, nearFloor: r.near.floor, move: m.move.px, moveFloor: m.move.floor, noise: r.noise.px, floorPx: r.floorPx, total: r.total, cam: info };
  results.push(row);
  console.log(`${p.name.padEnd(22)} near ${String(row.near).padStart(7)} (floor ${String(row.nearFloor).padStart(7)})   move ${String(row.move).padStart(7)} (floor ${String(row.moveFloor).padStart(7)})   noise ${row.noise}   floorPx ${row.floorPx}   near=${info.near} far=${info.far}`);
}

// 12-frame slow-move sequences: consecutive frames 2 cm apart; count floor pixels that change frame to frame in a
// way a <=1 px image shift cannot explain (i.e. shimmer, not motion).
for (const name of seqs) {
  const p = ALL.find((q) => q.name === name) || { name, kind: 'tour', t: +name };
  const counts = [];
  let prev = null;
  for (let k = 0; k < 12; k++) {
    await setPose(p, 0.02 * k);
    const r = await ev(async (k, keep) => { const Z = window.__zf; const mask = await Z.floorMask(); await Z.frames(2); const A = await Z.grab();
      const out = { d: window.__zfPrev ? Z.diffX(window.__zfPrev, A, mask) : null, img: keep ? Z.toJpeg(A) : null };
      if (window.__zfPrev && keep) out.dimg = Z.diffImage(window.__zfPrev, A);
      window.__zfPrev = A; return out; }, k, k === 0 || k === 6 || k === 11);
    if (r.img) save(`seq_${name}_f${k}`, r.img); if (r.dimg) save(`seq_${name}_d${k}`, r.dimg);
    if (r.d) counts.push(r.d.floor);
  }
  await ev(() => { window.__zfPrev = null; });
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  console.log(`seq ${name.padEnd(18)} floor px changed per 2 cm step: ${counts.join(' ')}  (mean ${mean.toFixed(0)})`);
  results.push({ seq: name, counts, mean });
}
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ W, H, DSF, HD, mobile, results, logs: logs.slice(0, 20) }, null, 1));
if (logs.length) console.log('console:', logs.slice(0, 8).join(' | '));
await browser.close();
