// Cost of the remote avatars: frame time with 0, 8 and 24 fake visitors walking in view, desktop and phone layout.
// Usage: node perf.mjs [url] (needs puppeteer-core next to it). Vsync off; each frame ends with gl.finish(), so the
// numbers are CPU + GPU time per frame. Also: avatars.update() CPU time, and heap allocated per update() call.
import puppeteer from 'puppeteer-core';
const URL = process.argv[2] || 'http://127.0.0.1:8963/index.html';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = async (mobile) => {
  const W = mobile ? 390 : 1280, H = mobile ? 844 : 720;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 600000,
    args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-precise-memory-info', '--js-flags=--expose-gc', `--window-size=${W},${H}`] });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.goto(URL + '#fp,solo,weather=clear'); await page.waitForFunction('window.__park && window.__park.loaded && window.__park.game', { timeout: 180000 });
  const ev = (js) => page.evaluate(js);
  await wait(3000); await ev('__park.perf.locked = true');
  await ev("__park.setMode('walk',{at:[300,0],yaw:Math.PI})"); await wait(2000);
  const time = () => ev(`new Promise((res)=>{const gl=__park.renderer.getContext();const xs=[];let last=0,n=0;const f=()=>{gl.finish();const t=performance.now();if(last)xs.push(t-last);last=t;if(++n<=150)requestAnimationFrame(f);else{xs.sort((a,b)=>a-b);res({med:xs[xs.length>>1],avg:xs.reduce((a,b)=>a+b,0)/xs.length})}};requestAnimationFrame(f)})`);
  const out = { layout: mobile ? '390x844@2' : '1280x720@1', dpr: await ev('__park.renderer.getPixelRatio()'), quality: await ev('JSON.stringify(__park.Q.post && __park.Q.post.preset)') };
  const res = {};
  for (let rep = 0; rep < 2; rep++) for (const n of [0, 8, 24]) {
    await ev(`(async()=>{window.__sim=await __park.mpSim(${n},{center:[284,0],radius:12,seed:${3 + rep}});return 1})()`);
    await wait(n ? 3500 : 2500);
    const t = await time();
    const cpu = n ? await ev(`new Promise((res)=>{const A=__sim.avatars;let s=0,k=0;const f=()=>{s+=A.stats.cpuMs;if(++k<120)requestAnimationFrame(f);else res({cpu:s/k,drawn:A.stats.drawn,anim:A.stats.animated})};requestAnimationFrame(f)})`) : { cpu: 0 };
    (res[n] = res[n] || []).push({ ...t, ...cpu });
  }
  await ev('__park.mpSim(0)'); await wait(1500);
  for (const n of [0, 8, 24]) { const r = res[n]; out['n' + n] = { frameMs: +Math.min(...r.map((x) => x.med)).toFixed(2), avgMs: +Math.min(...r.map((x) => x.avg)).toFixed(2), updateMs: +(r.reduce((s, x) => s + x.cpu, 0) / r.length).toFixed(3), drawn: r[0].drawn, animatedPerFrame: r[0].anim }; }
  // allocation: a separate set of 24 avatars fed one state each, update() called 600 times with the real camera
  out.alloc = await ev(`(async()=>{
    const M = await import('./fx/multiplayer/avatars.js'); const THREE = await import('three'); const P = __park, g = P.game;
    const A = M.createAvatars({ THREE, scene: P.scene, surface: P.surface, guests: P.guests, manifest: g.manifest, game: g });
    const now = performance.now();
    for (let i = 0; i < 24; i++) for (let k = 0; k < 3; k++) A.upsert('a' + i, { name: 'Test ' + i, kind: i % 4 ? 'wick' : 'fp', x: 284 - (i % 6) * 2 + k * 0.2, y: ((i / 6) | 0) * 2 - 3, z: g.ground(284, 0) || 0, yaw: Math.PI, anim: 0x48, frame: k * 4, t: now - 400 + k * 100 });
    const run = (n) => { for (let i = 0; i < n; i++) A.update(1 / 60, i / 60, P.camera); };
    const measure = () => { run(120); gc(); const h0 = performance.memory.usedJSHeapSize; run(600); const h1 = performance.memory.usedJSHeapSize; gc(); return Math.round((h1 - h0) / 600); };
    const b = measure(), r = { bytesPerUpdate: b, bytesPerAvatarUpdate: Math.round(b / Math.max(1, A.stats.animated)), animated: A.stats.animated, drawn: A.stats.drawn };
    // the same 24 behind the camera: drawn, interpolated, tagged, but not re-posed (out of view), so this is the module's own code
    const now2 = performance.now();
    for (let i = 0; i < 24; i++) A.upsert('a' + i, { x: 330 + (i % 6) * 2, y: ((i / 6) | 0) * 2 - 3, z: g.ground(330, 0) || 0, yaw: 0, anim: 0x48, frame: 0, t: now2 - 150 });
    while (performance.now() < now2 + 300) { /* let 300 ms pass: the drawing time reaches the new state */ }
    for (let i = 0; i < 40; i++) A.update(0.31, i, P.camera);
    r.ownBytesPerUpdate = measure(); r.ownAnimated = A.stats.animated;
    A.dispose(); return r; })()`);
  console.log(JSON.stringify(out));
  await browser.close();
};
await run(false); await run(true);
