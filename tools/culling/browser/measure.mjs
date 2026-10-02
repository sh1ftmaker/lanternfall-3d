// node measure.mjs <url> <W> <H> <DSF> [--mobile] [--throttle 4] [--variants base,nopark,tiny] [--views all|t6,...] [--q hd|cinematic|fast]
// Frame time (vsync off, gl.finish per frame), CPU time of the app's frame callback, draw calls + triangles per frame.
import puppeteer from 'puppeteer-core';
const a = process.argv.slice(2); const url = a[0], W = +a[1], H = +a[2], DSF = +a[3], mobile = a.includes('--mobile');
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const variants = opt('variants', 'base').split(','), throttle = +opt('throttle', 1), q = opt('q', 'hd'), N = +opt('frames', 60);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 900000, args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', `--window-size=${W},${H}`, '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: DSF, isMobile: mobile, hasTouch: mobile });
await page.evaluateOnNewDocument(() => {
  const raf = window.requestAnimationFrame.bind(window); window.__raf0 = raf; window.__cpu = { sum: 0, n: 0, on: false };
  window.requestAnimationFrame = (cb) => raf((t) => { const s = performance.now(); cb(t); if (__cpu.on) { __cpu.sum += performance.now() - s; __cpu.n++; } });
});
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('  [console]', m.text().slice(0, 200)); });
const hash = opt('hash', 'fp,weather=clear');
await page.goto(url + '#' + hash); await page.waitForFunction('window.__park && window.__park.loaded', { timeout: 240000 });
const ev = (js, ...x) => page.evaluate(js, ...x); const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await ev((q) => { __park.perf.locked = true; document.querySelector('#btn-set').click(); document.querySelector('.seg button[data-q=' + q + ']').click(); document.querySelector('#btn-set').click(); __park.renderer.info.autoReset = false; }, q);
if (throttle > 1) { const s = await page.target().createCDPSession(); await s.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
await wait(3000);
const ALL = [['t6', "__park.setMode('tour');__park.setTour(6)"], ['t20', "__park.setMode('tour');__park.setTour(20)"], ['t40', "__park.setMode('tour');__park.setTour(40)"], ['t55', "__park.setMode('tour');__park.setTour(55)"],
  ['t66', "__park.setMode('tour');__park.setTour(66)"], ['t90', "__park.setMode('tour');__park.setTour(90)"], ['t125', "__park.setMode('tour');__park.setTour(125)"], ['t140', "__park.setMode('tour');__park.setTour(140)"],
  ['wMerid', "__park.setMode('walk',{at:[81.7,93.8],yaw:2.36})"], ['wGuild', "__park.setMode('walk',{at:[-149.9,36.1],yaw:-2.36})"], ['wGate', "__park.setMode('walk',{at:[200,0],yaw:Math.PI})"], ['wRail', "__park.setMode('walk',{at:[85.5,31.1],yaw:-2.79})"]];
const vsel = opt('views', 'all'); const views = vsel === 'all' ? ALL : ALL.filter((v) => vsel.split(',').includes(v[0]));
const VAR = {
  base: ['', ''],
  nopark: ["__park.scene.children.filter(o=>o.isGroup&&o.children.length>100).forEach(g=>g.visible=false)", "__park.scene.children.filter(o=>o.isGroup&&o.children.length>100).forEach(g=>g.visible=true)"],
  noforest: ["__park.scene.children.filter(o=>o.isInstancedMesh&&o.userData.total).forEach(g=>g.visible=false)", "__park.scene.children.filter(o=>o.isInstancedMesh&&o.userData.total).forEach(g=>g.visible=true)"],
  nocull: ["window.__park.cull&&__park.cull.set(false)", "window.__park.cull&&__park.cull.set(true)"],
};
const measure = () => ev((N) => new Promise((res) => {
  const gl = __park.renderer.getContext(), info = __park.renderer.info; let n = 0, t0 = 0, calls = 0, tris = 0;
  const f = () => { gl.finish();
    if (n === 10) { t0 = performance.now(); __cpu.sum = 0; __cpu.n = 0; __cpu.on = true; info.reset(); }
    if (++n === N + 10) { __cpu.on = false; const fr = N; res({ ms: (performance.now() - t0) / fr, cpu: __cpu.sum / Math.max(1, __cpu.n), calls: info.render.calls / fr, tris: info.render.triangles / fr, cull: window.__park.cull ? +__park.cull.stats.ms.toFixed(3) : null }); }
    else __raf0(f); };
  __raf0(f);
}), N);
const fixPose = (js) => ev(`(()=>{${js}; window.__fix = setInterval(()=>{}, 1e6);})()`);
console.log(`${W}x${H}@${DSF}${mobile ? ' mobile' : ''} q=${q} thr=${throttle} pr=${await ev('__park.renderer.getPixelRatio().toFixed(2)')} buf=${await ev('JSON.stringify(__park.renderer.getDrawingBufferSize(new __park.camera.position.constructor()))')}`);
const rounds = +opt('rounds', 2);
for (const [name, js] of views) {
  await ev(js); await wait(name[0] === 'w' ? 1800 : 900);
  const row = {};
  for (let r = 0; r < rounds; r++) for (const v of variants) {
    if (name[0] === 't') await ev(js);
    await ev(VAR[v][0]); await wait(120);
    const m = await measure(); await ev(VAR[v][1]);
    if (!row[v] || m.ms < row[v].ms) row[v] = m;
  }
  console.log(name.padEnd(7), variants.map((v) => `${v}: ${row[v].ms.toFixed(2)}ms cpu ${row[v].cpu.toFixed(2)} dc ${row[v].calls.toFixed(0)} tri ${(row[v].tris / 1e6).toFixed(2)}M` + (row[v].cull ? ' ' + JSON.stringify(row[v].cull) : '')).join(' | '));
}
await browser.close();
