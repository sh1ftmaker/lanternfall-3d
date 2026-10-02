// Platformer cost: node pfperf.mjs W H DSF [fx hash]. Vsync off, Vulkan.
import puppeteer from 'puppeteer-core';
const [W, H, DSF, HASH] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 300000, args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', `--window-size=${W},${H}`, '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage();
await page.setViewport({ width: +W, height: +H, deviceScaleFactor: +DSF });
await page.goto('http://127.0.0.1:8851/index.html' + (HASH || '')); await page.waitForFunction('window.__park && window.__park.loaded', { timeout: 180000 });
const ev = (js) => page.evaluate(js); const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await ev('__park.perf.locked = true');
await ev("__park.setMode('walk',{at:[200,0],yaw:Math.PI})"); await wait(800);
await ev('__park.togglePlatformer()');
await page.waitForFunction('__park.platformer && __park.platformer.active && __park.platformer.S.latest > 5', { timeout: 90000 });
await wait(2500);
const time = () => ev(`new Promise((res)=>{const gl=__park.renderer.getContext();let n=0,t0=performance.now();const f=()=>{gl.finish();if(++n===90)res((performance.now()-t0)/90);else requestAnimationFrame(f)};requestAnimationFrame(f)})`);
const a = [], b = [];
for (let k = 0; k < 4; k++) {
  await ev('__park.platformer.character.group.visible = true'); await wait(200); a.push(await time());
  await ev('__park.platformer.character.group.visible = false'); await wait(200); b.push(await time());
}
await ev('__park.platformer.character.group.visible = true');
// main-thread cost of pf.update while running (scripted), per frame
const cpu = await ev(`new Promise((res)=>{const pf=__park.platformer;const t0=pf.S.t;pf.test.input=(t)=>({world:[-1,Math.sin(t*0.7)*0.4],a:(t%2)<0.3});const xs=[];let n=0;const f=()=>{xs.push(pf.stats().frameMs);if(++n<600)requestAnimationFrame(f);else{pf.test.input=null;xs.sort((p,q)=>p-q);res({frames:n,mean:+(xs.reduce((s,x)=>s+x,0)/n).toFixed(3),p50:+xs[n>>1].toFixed(3),p99:+xs[Math.floor(n*0.99)].toFixed(3),max:+xs[n-1].toFixed(3),loads:pf.S.loads,tickMs:+pf.S.tickMs.toFixed(3),tris:pf.character.tris})}};requestAnimationFrame(f)})`);
console.log(JSON.stringify({ size: `${W}x${H}@${DSF}`, hash: HASH || '', withChar: Math.min(...a).toFixed(2), without: Math.min(...b).toFixed(2), deltaMs: (Math.min(...a) - Math.min(...b)).toFixed(2), dpr: await ev('__park.renderer.getPixelRatio()'), cpu }));
await browser.close();
