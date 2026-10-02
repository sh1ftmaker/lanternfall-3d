// GPU time per renderer.render() call, split by camera: main scene pass / mirror / other. Variants change the park.
// node gpu.mjs <url> W H DSF [--mobile] [--variants base,nopark,trivial,prepass] [--views ...] [--q hd]
import puppeteer from 'puppeteer-core';
const a = process.argv.slice(2); const url = a[0], W = +a[1], H = +a[2], DSF = +a[3], mobile = a.includes('--mobile');
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const variants = opt('variants', 'base,nopark,trivial').split(','), q = opt('q', 'hd');
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 900000, args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', `--window-size=${W},${H}`, '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: DSF, isMobile: mobile, hasTouch: mobile });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 200)); });
await page.goto(url + '#' + opt('hash', 'fp,weather=clear')); await page.waitForFunction('window.__park && window.__park.loaded', { timeout: 240000 });
const ev = (js, ...x) => page.evaluate(js, ...x); const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await ev((q) => { __park.perf.locked = true; document.querySelector('#btn-set').click(); document.querySelector('.seg button[data-q=' + q + ']').click(); document.querySelector('#btn-set').click(); }, q);
await ev(() => {
  const P = __park, r = P.renderer, gl = r.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const T = window.__T = { on: false, pend: [], acc: {} , frames: 0};
  const r0 = r.render.bind(r);
  r.render = (s, c) => {
    const name = c === P.camera ? 'main' : c.isPerspectiveCamera ? 'mirror' : 'other';
    if (name === 'main' && T.idReq) { T.idReq = false; T.vis = idPass(s, c); }
    let hid = null; if (name === 'main' && T.vis) { hid = []; for (let i = 0; i < meshes2.length; i++) if (!T.vis.has(i) && meshes2[i].visible) { meshes2[i].visible = false; hid.push(meshes2[i]); } }
    if (!T.on) { const o = r0(s, c); if (hid) for (const m of hid) m.visible = true; return o; }
    const qq = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, qq); const o = r0(s, c); gl.endQuery(ext.TIME_ELAPSED_EXT); T.pend.push([name, qq]); if (hid) for (const m of hid) m.visible = true; return o;
  };
  const park0 = P.scene.children.find((o) => o.isGroup && o.children.length > 100), meshes2 = park0.children.filter((m) => m.isMesh);
  const SM = P.bakedMat.constructor, idMats = meshes2.map((m, i) => new SM({ uniforms: { uId: { value: i + 1 } }, transparent: false, depthWrite: m.material === P.bakedMat, side: 2,
    vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float uId; void main(){ gl_FragColor = vec4(mod(uId, 256.0) / 255.0, floor(uId / 256.0) / 255.0, 0.0, 1.0); }' }));
  let idRT = null;
  function idPass(s, c) {
    const W = r.domElement.width, H = r.domElement.height;
    if (!idRT || idRT.width !== W) idRT = new (P.renderer.getRenderTarget() ? P.renderer.getRenderTarget().constructor : window.__RT)(W, H);
    const saved = meshes2.map((m) => m.material), vis = [];
    P.scene.traverse((o) => { if ((o.isMesh || o.isPoints) && o.visible && o.parent !== park0) { o.visible = false; vis.push(o); } });
    meshes2.forEach((m, i) => m.material = idMats[i]);
    const prev = r.getRenderTarget(), cc = r.getClearColor(new (P.camera.position.constructor)()), ca = r.getClearAlpha();
    r.setRenderTarget(idRT); r.setClearColor(0, 0); r.clear(); r0(s, c);
    const px = new Uint8Array(W * H * 4); r.readRenderTargetPixels(idRT, 0, 0, W, H, px);
    r.setRenderTarget(prev); meshes2.forEach((m, i) => m.material = saved[i]); for (const o of vis) o.visible = true;
    const set = new Set(); for (let k = 0; k < px.length; k += 4) { const id = px[k] + px[k + 1] * 256; if (id) set.add(id - 1); }
    const TH = P.camera.position.constructor; const Fr = new (P.__Frustum)(); const M4 = c.projectionMatrix.clone().multiply(c.matrixWorldInverse); Fr.setFromProjectionMatrix(M4, c.coordinateSystem, c.reversedDepth);
    let sph = 0, box = 0, tS = 0, tB = 0, tV = 0, tA = 0;
    meshes2.forEach((m, i) => { const g = m.geometry, n = Math.min(g.drawRange.count, g.index.count) / 3; tA += n;
      const sp = g.boundingSphere.clone().applyMatrix4(m.matrixWorld), bx = g.boundingBox.clone().applyMatrix4(m.matrixWorld);
      if (Fr.intersectsSphere(sp)) { sph++; tS += n; } if (Fr.intersectsBox(bx)) { box++; tB += n; } if (set.has(i)) tV += n; });
    let tIn = 0; const pl = Fr.planes, V = new TH();
    meshes2.forEach((m, i) => { const g = m.geometry; const bx = g.boundingBox.clone().applyMatrix4(m.matrixWorld); if (!Fr.intersectsBox(bx)) return;
      const p = g.attributes.position.array, idx = g.index.array, n = Math.min(g.drawRange.count, idx.length), s = m.scale.x, o = m.position;
      const out = new Uint8Array(p.length / 3);
      for (let v = 0; v < out.length; v++) { V.set(o.x + p[v * 3] * s, o.y + p[v * 3 + 1] * s, o.z + p[v * 3 + 2] * s); let f = 0; for (let k = 0; k < 6; k++) if (pl[k].distanceToPoint(V) < 0) f |= 1 << k; out[v] = f; }
      for (let t = 0; t < n; t += 3) if (!(out[idx[t]] & out[idx[t + 1]] & out[idx[t + 2]])) tIn++; });
    T.ids = [...set].filter((i) => i < meshes2.length); T.stats = { triInFrustum: (tIn / 1e6).toFixed(2), total: meshes2.length, sph, box, vis: set.size, tA: (tA / 1e6).toFixed(2), tS: (tS / 1e6).toFixed(2), tB: (tB / 1e6).toFixed(2), tV: (tV / 1e6).toFixed(2) };
    T.lastVis = set.size; T.inFr = meshes2.length; return set;
  }
  T.poll = () => { T.pend = T.pend.filter(([n, qq]) => { if (!gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE)) return true; (T.acc[n] ||= []).push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(qq); return false; }); };
  const park = P.scene.children.find((o) => o.isGroup && o.children.length > 100); P.__parkGroup = park;
  const meshes = park.children.filter((m) => m.material === P.bakedMat);
  const triv = new THREE_SM();
  function THREE_SM() { const M = P.bakedMat.constructor; return new M({ vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: 'void main(){ gl_FragColor = vec4(0.02, 0.02, 0.03, 1.0); }' }); }
  P.__var = {
    base: [() => {}, () => {}],
    nopark: [() => { park.visible = false; }, () => { park.visible = true; }],
    prepass: [() => { if (!P.__pre) { const bm = P.bakedMat; const pm = new SM({ uniforms: bm.uniforms, vertexShader: bm.vertexShader, fragmentShader: 'void main(){ gl_FragColor = vec4(0.0); }', colorWrite: false, side: 2 });
        pm.defaultAttributeValues = bm.defaultAttributeValues;
        P.__pre = meshes.map((m) => { const c = new m.constructor(m.geometry, pm); c.matrixAutoUpdate = false; c.matrix.copy(m.matrix); c.matrixWorld.copy(m.matrixWorld); c.renderOrder = -1; return c; }); }
      for (const c of P.__pre) P.scene.add(c); },
      () => { for (const c of P.__pre) P.scene.remove(c); }],
    ideal: [() => { T.idReq = true; }, () => { T.vis = null; }],
    trivial: [() => { for (const m of meshes) m.material = triv; }, () => { for (const m of meshes) m.material = P.bakedMat; }],
  };
});
const measure = () => ev(() => new Promise((res) => {
  const gl = __park.renderer.getContext(); let n = 0, t0 = 0; const T = __T;
  const f = () => { gl.finish(); T.poll();
    if (n === 10) { t0 = performance.now(); T.acc = {}; T.on = true; }
    if (++n === 70) { T.on = false; const ms = (performance.now() - t0) / 60; setTimeout(() => { T.poll(); const o = { ms }; for (const [k, v] of Object.entries(T.acc)) { const s = [...v].sort((x, y) => x - y); o[k] = v.reduce((x, y) => x + y, 0) / 60; } res(o); }, 200); }
    else requestAnimationFrame(f); };
  requestAnimationFrame(f);
}));
await wait(3000);
const ALL = [['t6', "__park.setMode('tour');__park.setTour(6)"], ['t20', "__park.setMode('tour');__park.setTour(20)"], ['t40', "__park.setMode('tour');__park.setTour(40)"], ['t55', "__park.setMode('tour');__park.setTour(55)"],
  ['t66', "__park.setMode('tour');__park.setTour(66)"], ['t90', "__park.setMode('tour');__park.setTour(90)"], ['t125', "__park.setMode('tour');__park.setTour(125)"], ['t140', "__park.setMode('tour');__park.setTour(140)"],
  ['wMerid', "__park.setMode('walk',{at:[81.7,93.8],yaw:2.36})"], ['wGuild', "__park.setMode('walk',{at:[-149.9,36.1],yaw:-2.36})"], ['wGate', "__park.setMode('walk',{at:[200,0],yaw:Math.PI})"], ['wRail', "__park.setMode('walk',{at:[85.5,31.1],yaw:-2.79})"]];
const vsel = opt('views', 'all'); const views = vsel === 'all' ? ALL : ALL.filter((v) => vsel.split(',').includes(v[0]));
const out = []; await ev(async () => { const T3 = await import('three'); __park.__Frustum = T3.Frustum; });
for (const [name, js] of views) { await ev(js); await wait(name[0] === 'w' ? 1800 : 900); if (name[0] === 't') await ev(js); await ev('__T.idReq = true'); await wait(400); await ev('__T.vis = null');
  const st = await ev('__T.stats'); console.log(name.padEnd(7), JSON.stringify(st));
  out.push({ name, mw: await ev('__park.camera.matrixWorld.elements'), pm: await ev('__park.camera.projectionMatrix.elements'), w: await ev('__park.renderer.domElement.width'), h: await ev('__park.renderer.domElement.height'), ids: await ev('__T.ids'), stats: st }); }
(await import('node:fs')).writeFileSync(process.env.OUT || 'poses.json', JSON.stringify(out));
await browser.close();
