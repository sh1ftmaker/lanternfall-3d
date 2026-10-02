// daynight: screenshots at five times of the evening in four views, the night pixel comparison against #no-daynight,
// weather at dusk and at night, quality tiers, context loss, phone layout, and a rough frame cost.
//   PUPPETEER_CORE=/path/to/puppeteer-core/lib/puppeteer/puppeteer-core.js node tools/game/daynight.test.mjs [url] [outDir]
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
const { default: puppeteer } = await import(process.env.PUPPETEER_CORE ? pathToFileURL(process.env.PUPPETEER_CORE).href : 'puppeteer-core');
const BASE = process.argv[2] || 'http://127.0.0.1:8902/index.html', OUT = process.argv[3] || '/tmp/daynight-test'; fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const m = (h, mi) => h * 60 + mi;
const TIMES = [['1730', m(17, 30)], ['1815', m(18, 15)], ['1900', m(19, 0)], ['1945', m(19, 45)], ['2300', m(23, 0)]];
const VIEWS = [['gate', { at: [288, 0], yaw: Math.PI }], ['lake', { at: [104.5, 0], yaw: Math.PI }], ['street', { at: [-16.6, -118.5], yaw: -0.26 }], ['tour', { tour: 6 }]];
const NIGHT_VIEWS = [['gate', { at: [288, 0], yaw: Math.PI }], ['spire', { at: [85.5, 31.1], yaw: -2.79 }], ['guildhollow', { at: [-149.9, 36.1], yaw: -2.36 }], ['frostmere', { at: [-65, 107.5], yaw: 3.14 }],
  ['meridian', { at: [81.7, 93.8], yaw: 2.36 }], ['wanderers', { at: [139.9, 48.2], yaw: 0.39 }], ['brinewatch', { at: [114.9, -81.5], yaw: 0.39 }], ['lantern-row', { at: [-16.6, -118.5], yaw: -0.26 }],
  ['rosewick', { at: [-136.6, -57.6], yaw: -1.18 }], ['tour6', { tour: 6 }], ['tour60', { tour: 60 }]];
const fails = [];
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails.push(msg); };

async function open(hash, { mobile = false, freeze = false } = {}) {
  const W = mobile ? 390 : 1280, H = mobile ? 844 : 720;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', `--window-size=${W},${H}`] });
  const page = await browser.newPage(); const logs = [];
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message.slice(0, 200)));
  page.on('console', (c) => { if (c.type() === 'error' || c.type() === 'warn' || c.type() === 'warning') logs.push(c.type() + ': ' + c.text().slice(0, 200)); });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  if (freeze) await page.evaluateOnNewDocument(() => { const t0 = performance.now(), d0 = Date.now(); performance.now = () => t0; Date.now = () => d0; });   // dt = 0: every animation stands still
  await page.goto(BASE + hash); await page.waitForFunction('window.__park && window.__park.loaded', { timeout: 240000 });
  await wait(2500);
  return { browser, page, logs, ev: (js) => page.evaluate(js) };
}
const place = (v) => (v.tour !== undefined ? `__park.setMode('tour');__park.setTour(${v.tour})` : `__park.setMode('walk',{at:[${v.at}],yaw:${v.yaw}})`);
const shot = async (page, file, png = false) => { return png ? page.screenshot({ type: 'png', encoding: 'base64' }) : page.screenshot({ type: 'jpeg', quality: 88, path: file }); };

// ── 1. screenshots: five times, four views ──
if (!process.env.ONLY_PROPS) {
  const { browser, page, logs, ev } = await open('#weather=clear&no-motes&no-fireworks');
  const api = await ev('!!__park.game.modules.daynight');
  check(api, 'game.modules.daynight is present');
  const phases = []; await ev('__park.game.on("daynight:phase", (d) => (window.__ph = (window.__ph || []).concat(d.phase)))');
  for (const [vid, v] of VIEWS) {
    await ev(place(v)); await wait(900);
    for (const [tid, t] of TIMES) {
      await ev(`__park.game.clock.set(${t})`); await wait(3200); if (v.tour !== undefined) { await ev(place(v)); await wait(1500); }
      await shot(page, `${OUT}/${vid}_${tid}.jpg`);
    }
  }
  const st = await ev('(()=>{const d=__park.game.modules.daynight;return [d.at(17*60+30).phase,d.at(19*60+45).phase,d.state.phase,window.__ph]})()');
  check(st[0] === 'dusk' && st[1] === 'night' && st[2] === 'night', 'phases ' + JSON.stringify(st));
  check(logs.length === 0, 'console clean (screenshots): ' + JSON.stringify(logs.slice(0, 4)));
  await browser.close();
}

// ── 2. night pixel comparison: this branch at 23:00 vs the same page with #no-daynight ──
async function nightShots(hash) {
  const { browser, page, logs, ev } = await open(hash, { freeze: true }); const out = [];
  for (const [id, v] of NIGHT_VIEWS) { await ev(place(v)); await wait(+process.env.SETTLE || 2500); const a = await shot(page, '', true); await wait(1200); out.push([id, a, await shot(page, '', true)]); }
  await browser.close(); return { out, logs };
}
if (!process.env.ONLY_PROPS) {
  // the other game modules are off: some place sprites with a random phase, which differ from run to run on their own
  const H = '#weather=clear&no-guests&no-motes&no-fireworks&nosim&noboat&no-emitters&fp&no-lamps&no-bounty&no-secrets&no-trials&no-rides&no-photo' + (process.env.EXTRA || '');
  const A = await nightShots(process.env.NOISE ? H + '&no-daynight' : H), B = await nightShots(H + '&no-daynight');
  const { browser, page } = await open('#no-game');
  let total = 0;
  for (let i = 0; i < A.out.length; i++) {
    // pixels that differ between the two builds but are steady inside each run (the lake's mirror and a few sprites shimmer from run to run on their own)
    const [d, unstable] = await page.evaluate(async (a, a2, b, b2) => {
      const load = async (s) => { const bm = await createImageBitmap(await (await fetch('data:image/png;base64,' + s)).blob()); const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d'); g.drawImage(bm, 0, 0); return g.getImageData(0, 0, bm.width, bm.height).data; };
      const [x, x2, y, y2] = [await load(a), await load(a2), await load(b), await load(b2)]; let n = 0, u = 0;
      for (let k = 0; k < x.length; k += 4) {
        const sx = x[k] === x2[k] && x[k + 1] === x2[k + 1] && x[k + 2] === x2[k + 2], sy = y[k] === y2[k] && y[k + 1] === y2[k + 1] && y[k + 2] === y2[k + 2];
        if (!sx || !sy) u++; else if (x[k] !== y[k] || x[k + 1] !== y[k + 1] || x[k + 2] !== y[k + 2]) n++;
      }
      return [n, u];
    }, A.out[i][1], A.out[i][2], B.out[i][1], B.out[i][2]);
    total += d; check(d === 0, `night pixels identical in ${A.out[i][0]}: ${d} differing (${unstable} shimmer on their own)`);
    if (d) fs.writeFileSync(`${OUT}/diff_${A.out[i][0]}_on.png`, Buffer.from(A.out[i][1], 'base64')), fs.writeFileSync(`${OUT}/diff_${A.out[i][0]}_off.png`, Buffer.from(B.out[i][1], 'base64'));
  }
  await browser.close();
  check(A.logs.length + B.logs.length === 0, 'console clean (night comparison): ' + JSON.stringify([...A.logs, ...B.logs].slice(0, 4)));
}

// ── 3. weather at dusk and at night, quality tiers, context loss, frame cost ──
if (!process.env.ONLY_PROPS) {
  const { browser, page, logs, ev } = await open('#weather=clear&fp');
  await ev("__park.setMode('walk',{at:[288,0],yaw:Math.PI})"); await wait(1200);
  await ev('__park.game.modules.clock && (__park.game.modules.clock.hold = true)');      // the clock module runs the evening: hold it so the time is comparable
  for (const [tid, t] of [['1815', m(18, 15)], ['2300', m(23, 0)]]) {
    await ev(`__park.game.clock.set(${t})`); await wait(2600);
    for (const w of ['rain', 'storm']) { await ev(`__park.weather.set('${w}',{instant:true})`); await wait(2500); await shot(page, `${OUT}/wx_${w}_${tid}.jpg`); }
    await ev("__park.weather.set('clear',{instant:true})"); await wait(1500);
  }
  await ev(`__park.game.clock.set(${m(18, 15)})`); await wait(2600);
  // quality tiers at dusk
  const q = await ev(`(async()=>{const r=[];const w=(ms)=>new Promise(s=>setTimeout(s,ms));const bs=[...document.querySelectorAll('button')].filter(b=>/^(Fast|HD|Cinematic)$/.test(b.textContent.trim()));for(const b of bs){b.click();await w(2500);r.push(b.textContent.trim())}return r})()`);
  check(q.length === 3, 'quality tiers clicked: ' + q.join(','));
  for (const tier of ['Fast', 'HD', 'Cinematic']) { await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='${tier}').click()`); await wait(2600); await shot(page, `${OUT}/tier_${tier}.jpg`); }
  // context loss at dusk: the time of day survives
  const before = await ev('__park.game.modules.daynight.state.phase + "|" + __park.game.modules.daynight.time');
  const lost = await ev(`(async()=>{const gl=__park.renderer.getContext();const e=gl.getExtension('WEBGL_lose_context');e.loseContext();await new Promise(r=>setTimeout(r,600));e.restoreContext();await new Promise(r=>setTimeout(r,3500));return gl.isContextLost()?'lost':'restored'})()`);
  const after = await ev('__park.game.modules.daynight.state.phase + "|" + __park.game.modules.daynight.time');
  const [pb, tb] = before.split('|'), [pa, ta] = after.split('|');   // the shown time still eases toward the clock's for a moment after a set: allow a minute
  check(lost === 'restored' && pb === pa && Math.abs(ta - tb) < 1, `context restore keeps the time of day (${before} -> ${after}, ${lost})`);
  await shot(page, `${OUT}/ctx_restored.jpg`);
  // rough frame cost: frames in 3 s at dusk vs night (other agents share the GPU: only a ballpark)
  const fps = async () => ev('new Promise(r=>{let n=0;const t0=performance.now();const f=()=>{n++;if(performance.now()-t0>3000)r(+((performance.now()-t0)/n).toFixed(1));else requestAnimationFrame(f)};requestAnimationFrame(f)})');
  const dusk = await fps(); await ev(`__park.game.clock.set(${m(23, 0)})`); await wait(3000); const night = await fps();
  console.log(`frame ms (rough, shared GPU): dusk ${dusk}  night ${night}`);
  check(logs.filter((l) => !/GPU stall|Context Lost|Context Restored|CONTEXT_LOST|context/i.test(l)).length === 0, 'console clean (weather, tiers, context): ' + JSON.stringify(logs.slice(0, 5)));
  await browser.close();
}

// ── 3b. the sun's shadow map is freed at night and built again at dusk; run-time props are lit at dusk ──
{
  const { browser, page, logs, ev } = await open('#weather=clear&fp');
  await ev("__park.setMode('walk',{at:[285,0],yaw:Math.PI})"); await ev('__park.game.modules.clock && (__park.game.modules.clock.hold = true)');
  const rt = () => ev('(()=>{const s=__park.game.ctx.surface;return {rt:!!s.sunShadow.rt,on:s.uniforms.uShadowOnS.value,tex:!!s.uniforms.tShadowS.value}})()');
  await ev(`__park.game.modules.daynight.snap(${m(18, 0)})`); await wait(3500);
  const d1 = await rt(); check(d1.rt && d1.on === 1 && d1.tex, 'sun shadow map exists at dusk ' + JSON.stringify(d1));
  // props: the contract is game.props.materials + 'prop'; stand in for it when the core does not have it yet
  const real = await ev('!!__park.game.props.materials');
  await ev(`(()=>{const g=__park.game,T=g.THREE,real=${real};if(!g.props.materials)g.props.materials=new Set();window.__pm=[];
    for(let i=0;i<2;i++){const o=g.props.mesh(new T.BoxGeometry(1,1.2,1),{x:280-i*2,y:0,z:(g.ground(280-i*2,0)??0)+0.6,color:[0.5,0.3,0.2]});window.__pm.push(o.material);if(!real)g.emit('prop',{material:o.material,kind:'mesh'});}
    window.__gl=g.props.glow({x:278,y:0,z:2,color:[1.5,0.9,0.4],size:2});if(!real)g.emit('prop',{material:window.__gl.sprite.material,kind:'glow'});})()`);
  await ev(`(()=>{const g=__park.game; for (const m of window.__pm) g.props.materials.add(m); g.props.materials.add(window.__gl.sprite.material);})()`);
  await ev(`__park.game.modules.daynight.snap(${m(17, 45)})`); await wait(3500);
  const p1 = await ev('__park.game.modules.daynight.props'), op1 = await ev('window.__gl.sprite.material.opacity');
  check(p1.gain[0] > 1.3 && p1.gain[0] > p1.gain[2], 'lit props are brighter and warmer at 17:45 ' + JSON.stringify(p1));
  check(op1 < 0.9, 'glow props dim while the lamps are not up: opacity ' + op1);
  await shot(page, `${OUT}/props_dusk.jpg`);
  await ev(`__park.game.modules.daynight.snap(${m(23, 0)})`); await wait(3500);
  const p2 = await ev('__park.game.modules.daynight.props'), op2 = await ev('window.__gl.sprite.material.opacity'), d2 = await rt();
  check(p2.gain.every((v) => v === 1) && p2.emit === 1 && op2 === 1, 'props are untouched at night ' + JSON.stringify(p2) + ' ' + op2);
  check(!d2.rt && d2.on === 0 && !d2.tex, 'sun shadow map freed at night ' + JSON.stringify(d2));
  await shot(page, `${OUT}/props_night.jpg`);
  await ev(`__park.game.modules.daynight.snap(${m(17, 50)})`); await wait(3500);
  const d3 = await rt(); check(d3.rt && d3.on === 1, 'sun shadow map built again at the next dusk ' + JSON.stringify(d3));
  check(logs.filter((l) => !/GPU stall|Context/i.test(l)).length === 0, 'console clean (shadow, props): ' + JSON.stringify(logs.slice(0, 4)));
  await browser.close();
}

// ── 4. phone layout ──
{
  const { browser, page, logs, ev } = await open('#weather=clear', { mobile: true });
  for (const [tid, t] of [['1730', m(17, 30)], ['1900', m(19, 0)]]) {
    await ev(`__park.game.clock.set(${t})`); await ev("__park.setMode('walk',{at:[288,0],yaw:Math.PI})"); await wait(3500); await shot(page, `${OUT}/phone_gate_${tid}.jpg`);
    await ev("__park.setMode('tour');__park.setTour(6)"); await wait(2500); await shot(page, `${OUT}/phone_tour_${tid}.jpg`);
  }
  check(logs.filter((l) => !/GPU stall|Context/i.test(l)).length === 0, 'console clean (phone): ' + JSON.stringify(logs.slice(0, 4)));
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed'); process.exit(fails.length ? 1 : 0);
