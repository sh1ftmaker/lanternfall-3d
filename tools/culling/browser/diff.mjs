// Pixel A/B of culling on vs off on the same frozen frame, over many camera poses.
// node diff.mjs <url> [--mobile] [--q fast|hd|cinematic] [--hash extra] [--angle gl|vulkan] [--only N]
// Time is frozen (performance.now held) while a pose is captured: the frame is rendered with culling on (A), off (B),
// on again (C). A vs C checks the frame is deterministic; A vs B is the culling result.
import puppeteer from 'puppeteer-core';
const a = process.argv.slice(2); const url = a[0], mobile = a.includes('--mobile');
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const q = opt('q', 'cinematic'), angle = opt('angle', 'vulkan');
const W = mobile ? 390 : 1280, H = mobile ? 844 : 720;
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 900000, args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', `--use-angle=${angle}`, ...(angle === 'vulkan' ? ['--enable-features=Vulkan'] : []), `--window-size=${W},${H}`] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
await page.evaluateOnNewDocument(() => {
  const pn = performance.now.bind(performance); let frozen = null; window.__freeze = (on) => { frozen = on ? pn() : null; };
  performance.now = () => (frozen !== null ? frozen : pn());
  const raf = window.requestAnimationFrame.bind(window); window.__grabs = [];
  window.requestAnimationFrame = (cb) => raf((t) => { cb(t); if (window.__grabReq) { window.__grabReq = false; const P = window.__park, r = P.renderer, gl = r.getContext(); r.setRenderTarget(null);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); window.__grabs.push(px); } });
});
const errs = []; page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => errs.push('pageerror ' + e.message));
await page.goto(url + '#weather=' + opt('weather', 'clear') + ',no-guests' + (opt('hash', '') ? ',' + opt('hash', '') : '')); await page.waitForFunction('window.__park && window.__park.loaded', { timeout: 240000 });
const ev = (js, ...x) => page.evaluate(js, ...x); const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await ev((q) => { __park.perf.locked = true; document.querySelector('#btn-set').click(); document.querySelector('.seg button[data-q=' + q + ']').click(); document.querySelector('#btn-set').click(); }, q);
await wait(4000);
if (a.includes('--ctxloss')) {   // lose and restore the WebGL context first: everything below is drawn by the restored context
  await ev(() => { const x = __park.renderer.getContext().getExtension('WEBGL_lose_context'); window.__lc = x; x.loseContext(); }); await wait(800);
  await ev(() => window.__lc.restoreContext()); await wait(4000); console.log('context lost and restored, losses', await ev('__park.glCtx.losses'));
}
const frames = (n) => ev((n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const grab = async () => { await ev('window.__grabReq = true'); await frames(2); };
const cmp = () => ev(() => { const g = window.__grabs, A = g[0], B = g[1], C = g[2]; let ab = 0, ac = 0, mx = 0;
  for (let i = 0; i < A.length; i += 4) { let d = 0, e = 0; for (let c = 0; c < 3; c++) { d = Math.max(d, Math.abs(A[i + c] - B[i + c])); e = Math.max(e, Math.abs(A[i + c] - C[i + c])); } if (d) ab++; if (e) ac++; if (d > mx) mx = d; }
  window.__grabs = []; const s = __park.cull.stats; return { ab, ac, mx, n: A.length / 4, vis: s.visible + '/' + s.chunks, cells: s.forestCellsVisible + '/' + s.forestCells, draws: s.forestDraws }; });
const T = (t) => [`tour ${t}`, `__park.setMode('tour'); __park.setTour(${t})`, 500];
const poses = [];
for (const t of [0, 4, 9, 13.05, 17, 22, 27, 32.05, 36, 41, 46, 49.05, 54, 60.55, 65, 72.05, 77, 83.55, 89, 95.05, 101, 106.55, 112, 118.05, 124, 131.05, 137, 143, 146.05, 151, 156]) poses.push(T(t));
const walks = [['wMerid', [81.7, 93.8], 2.36], ['wGuild', [-149.9, 36.1], -2.36], ['wGate', [200, 0], Math.PI], ['wRail', [85.5, 31.1], -2.79], ['wGateBack', [200, 0], 0], ['wRailLook', [85.5, 31.1], 0.4]];
for (const [n, at, yaw] of walks) poses.push([n, `__park.setMode('walk',{at:[${at}],yaw:${yaw}})`, 1500]);
for (const id of ['park', 'gate', 'spire', 'wanderers', 'meridian', 'frostmere', 'guildhollow', 'rosewick', 'lantern-row', 'brinewatch'])   // place-chip teleports in Walk: captured on the very next frames
  poses.push(['walk->' + id, `__park.setMode('walk'); __park.gotoPlace(__park.places.find(p=>p.id==='${id}'))`, 60]);
for (const id of ['gate', 'meridian', 'brinewatch']) {   // Explore fly-to: mid-flight and arrived
  poses.push(['fly->' + id + ' mid', `__park.setMode('orbit'); __park.gotoPlace(__park.places.find(p=>p.id==='${id}'))`, 900]);
  poses.push(['fly->' + id + ' end', ``, 2200]);
}
poses.push(['walk look up', `__park.setMode('walk',{at:[-16.6,-118.5],yaw:-0.26}); __park.walk.pitch = 0.9`, 800]);
poses.push(['walk look down', `__park.walk.pitch = -1.1`, 300]);
const only = +opt('only', 0); const list = only ? poses.slice(0, only) : poses;
let bad = 0, nondet = 0; const t0 = Date.now();
for (const [name, js, ms] of list) {
  await ev('__freeze(false)'); if (js) await ev(js); await wait(ms);
  let r;
  for (let tries = 0; tries < 3; tries++) {             // A != C: something else was still changing (a module loading in): settle and retry
    if (tries) { await ev('__freeze(false)'); await wait(1500); }
    await ev('__freeze(true)'); await frames(3);
    await ev('__park.cull.set(true)'); await frames(2); await grab();
    await ev('__park.cull.set(false)'); await frames(2); await grab();
    await ev('__park.cull.set(true)'); await frames(2); await grab();
    r = await cmp(); if (!r.ac) break;
  }
  if (r.ab) bad++; if (r.ac) nondet++;
  console.log(name.padEnd(20), `diff ${r.ab} px (max ${r.mx})`, r.ac ? `NONDET ${r.ac}` : '', `chunks ${r.vis} forest cells ${r.cells} runs ${r.draws}`);
}
await ev('__freeze(false)');
console.log('weather', await ev('__park.weather.state')); console.log(`${list.length} poses, ${mobile ? 'mobile' : 'desktop'} ${q}: ${bad} with differing pixels, ${nondet} non-deterministic; ${((Date.now() - t0) / 1000).toFixed(0)} s; console: ${errs.length ? errs.join(' | ') : 'clean'}`);
await browser.close();
