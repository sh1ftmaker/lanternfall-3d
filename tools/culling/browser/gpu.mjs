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
    if (!T.on || !ext) return r0(s, c);
    const name = c === P.camera ? 'main' : c.isPerspectiveCamera ? 'mirror' : 'other';
    const qq = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, qq); const o = r0(s, c); gl.endQuery(ext.TIME_ELAPSED_EXT); T.pend.push([name, qq]); return o;
  };
  T.poll = () => { T.pend = T.pend.filter(([n, qq]) => { if (!gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE)) return true; (T.acc[n] ||= []).push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(qq); return false; }); };
  const park = P.scene.children.find((o) => o.isGroup && o.children.length > 100); P.__parkGroup = park;
  const meshes = park.children.filter((m) => m.material === P.bakedMat);
  const triv = new THREE_SM();
  function THREE_SM() { const M = P.bakedMat.constructor; return new M({ vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: 'void main(){ gl_FragColor = vec4(0.02, 0.02, 0.03, 1.0); }' }); }
  P.__var = {
    base: [() => {}, () => {}],
    nopark: [() => { park.visible = false; }, () => { park.visible = true; }],
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
console.log(`${W}x${H}@${DSF} q=${q}  (GPU ms per frame: main scene pass / mirror / other; wall ms)`);
for (const [name, js] of views) {
  await ev(js); await wait(name[0] === 'w' ? 1800 : 900);
  const row = {};
  for (let r = 0; r < 2; r++) for (const v of variants) {
    if (name[0] === 't') await ev(js);
    await ev((v) => __park.__var[v][0](), v); await wait(100);
    const m = await measure(); await ev((v) => __park.__var[v][1](), v);
    if (!row[v] || m.main < row[v].main) row[v] = m;
  }
  console.log(name.padEnd(7), variants.map((v) => `${v}: main ${row[v].main?.toFixed(2)} mir ${(row[v].mirror || 0).toFixed(2)} oth ${(row[v].other || 0).toFixed(2)} wall ${row[v].ms.toFixed(2)}`).join(' | '));
}
await browser.close();
