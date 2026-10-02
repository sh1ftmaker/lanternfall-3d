// per-frame smoothness of the platformer: displayed character and camera steps while running straight
import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'http://127.0.0.1:8800/index.html', mobile = process.argv.includes('--mobile'), thr = +(process.argv.find((a) => a.startsWith('--cpu=')) || '--cpu=1').slice(6);
const W = mobile ? 390 : 1280, H = mobile ? 844 : 720;
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 600000, args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', `--window-size=${W},${H}`] });
const page = await browser.newPage(); const errs = [];
page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') errs.push(m.text().slice(0, 160)); });
await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
await page.goto(url); await page.waitForFunction('window.__park && window.__park.loaded', { timeout: 180000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await page.evaluate("__park.setMode('walk',{at:[255,4],yaw:Math.PI})"); await wait(800);
await page.waitForFunction(() => __park.platformer && __park.platformer.active && __park.platformer.S.latest > 5, { timeout: 90000 }); await wait(1500);
if (thr > 1) { const c = await page.target().createCDPSession(); await c.send('Emulation.setCPUThrottlingRate', { rate: thr }); }
const res = await page.evaluate(async (free) => {
  const pf = __park.platformer, cam = __park.camera; const rows = [];
  if (!free) pf.test.input = () => ({ mx: 0, my: 1 }); else pf.test.input = () => ({ mx: 0.35, my: 1, follow: true });
  await new Promise((r) => setTimeout(r, 1500));
  await new Promise((done) => { let n = 0, last = performance.now(); const f = () => { const t = performance.now(); rows.push([t - last, pf.view.pos.x, pf.view.pos.z, cam.position.x, cam.position.z, pf.S.cam.yaw, cam.position.y]); last = t; if (++n < 300) requestAnimationFrame(f); else done(); }; requestAnimationFrame(f); });
  pf.test.input = null; return rows;
}, process.argv.includes('--free'));
const st = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); return { mean: +m.toFixed(4), sd: +sd.toFixed(4), cv: +(sd / Math.abs(m || 1)).toFixed(3), min: +Math.min(...a).toFixed(4), max: +Math.max(...a).toFixed(4) }; };
const d = (i, j) => res.slice(1).map((r, k) => Math.hypot(r[i] - res[k][i], r[j] - res[k][j]));
const dts = res.slice(1).map((r) => r[0]);
// speed per frame (m/s): removes frame-time variation from the step size
const sp = (i, j) => d(i, j).map((x, k) => x / (dts[k] / 1000));
const rel = res.map((r) => Math.hypot(r[1] - r[3], r[2] - r[4]));   // character-to-camera distance on the ground: what the eye sees wobble
const zero = d(1, 2).filter((x) => x < 1e-4).length;
const yawRate = res.slice(1).map((r, k) => (r[5] - res[k][5]) / (dts[k] / 1000)); const yawAcc = yawRate.slice(1).map((x, k) => Math.abs(x - yawRate[k]));
console.log(JSON.stringify({ yawRate: st(yawRate), yawJerk: st(yawAcc), dt: st(dts), charSpeed: st(sp(1, 2)), camSpeed: st(sp(3, 4)), relDist: st(rel), relStep: st(rel.slice(1).map((x, k) => Math.abs(x - rel[k]))), framesCharStill: zero, errs }));
await browser.close();
