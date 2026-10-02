// End-to-end check of fx/game/clock: node tools/game/clock.test.mjs [url] [outDir]
// puppeteer-core is found from the working folder, or give PP=/path/to/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js
// Serve the repo first (python3 -m http.server 8901). Writes screenshots to outDir; prints a JSON summary; exit 1 on a failed check.
import fs from 'node:fs';
const puppeteer = (await (process.env.PP ? import(process.env.PP) : import('puppeteer-core'))).default;
const URL0 = process.argv[2] || 'http://127.0.0.1:8901/index.html', OUT = process.argv[3] || '.';
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (name, ok, extra = '') => { if (!ok) fails.push(name + (extra ? ' ' + extra : '')); return ok; };

async function open(mobile, hash) {
  const W = mobile ? 390 : 1280, H = mobile ? 844 : 720;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', `--window-size=${W},${H}`] });
  const page = await browser.newPage(); const errs = new Map(); const add = (k) => errs.set(k, (errs.get(k) || 0) + 1);
  page.on('pageerror', (e) => add('pageerror: ' + e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { const t = m.text(); if (!/GPU stall|Context Lost|Context Restored|ReadPixels|GroupMarker/.test(t)) add(m.type() + ': ' + t.slice(0, 200)); } });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.goto(URL0 + '#weather=clear' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__park && window.__park.loaded && window.__park.game && window.__park.game.started && (window.__park.game.modules.clock || location.hash.includes("no-clock"))', { timeout: 240000 });
  const ev = (js) => page.evaluate(js).catch((e) => { add('eval: ' + e.message.slice(0, 160)); });
  return { browser, page, ev, errs };
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 88 });
const sky = async (t) => { await t.ev("__park.setMode('orbit');__park.gotoPlace(__park.places.find(p=>p.id==='park'))"); await wait(5000); await t.ev('__park.controls.autoRotate=false'); };

async function run(mobile) {
  const tag = mobile ? 'm' : 'd', res = { mobile };
  const t = await open(mobile, ''), { page, ev } = t; await wait(1500);
  await ev('window.__ev=[];__park.game.on("clock:event",e=>__ev.push(e.id))');
  if (t.errs.size) console.log([...t.errs]);
  res.init = await ev('(()=>{const g=__park.game;return {t:g.clock.t,mode:__park.mode,running:g.clock.running,lan:g.modules.clock.lanterns()}})()');
  check(tag + ' opens at 23:00 (frozen in the tour or running)', res.init.t >= 1380 && res.init.t < 1381, JSON.stringify(res.init));
  check(tag + ' lanterns classic at open', res.init.lan === 'classic');
  // Tour holds the clock, Explore lets it run
  await ev("document.querySelector('#m-orbit').click()"); await wait(2500);
  const t1 = await ev('__park.game.clock.t'); await wait(2500); const t2 = await ev('__park.game.clock.t');
  check(tag + ' clock runs in Explore', t2 > t1, `${t1} ${t2}`);
  res.rate = await ev('__park.game.clock.rate');
  // events by jumping
  res.events = {};
  const programme = [['gates', 1050], ['frostfair', 1140], ['stories', 1275], ['fall', 1380], ['close', 1420]];
  await ev('__park.game.modules.clock.hold=true');
  await ev('window.__ph=[];__park.game.on("frame",()=>{const c=__park.game.modules.clock.closing;if(c&&__ph[__ph.length-1]!==c)__ph.push(c)})');
  for (const [id, T] of programme) {
    await ev(`__ev.length=0;__park.game.clock.set(${T})`); await wait(id === 'close' ? 700 : 300);
    if (id === 'fall') { await wait(400); const tr = await ev('document.querySelector("#game-track")?.innerText || ""'); check(tag + ' tracker says the lanterns are in the air during the fall', /Lanterns in the air/.test(tr) && !/Closing time/.test(tr), tr); }
    const got = await ev('__ev.slice()'); res.events[id] = got;
    check(tag + ' event ' + id, got.includes(id), JSON.stringify(got));
    if (id === 'fall') check(tag + ' hush event with the fall', got.includes('hush'));
    if (id === 'fall') check(tag + ' hush on, crowd told', (await ev('__park.game.modules.clock.hush.on')) && (await ev('!!__park.guests.crowd.params.hush')));
    await wait(2300);
  }
  res.toasts = await ev('[...document.querySelectorAll(".game-toast")].map(e=>e.textContent)');
  check(tag + ' toasts shown', res.toasts && res.toasts.length > 0);
  // closing time is a fade through dark, not a jump cut: out, hold (with the line), in, then the evening starts again
  const phases = []; let line = '', maxOp = 0;   // (phases are also recorded every frame in the page: __ph)
  for (let i = 0; i < 80; i++) {
    const s = await ev('(()=>{const v=document.getElementById("ck-close"),c=__park.game.modules.clock.closing;return {ph:c||null,op:v?+v.style.opacity:0,tx:v?v.textContent:"",t:__park.game.clock.t,p:v?[...v.querySelectorAll("p")].map(p=>+p.style.opacity):[]}})()');
    if (s) { maxOp = Math.max(maxOp, s.op); if (s.ph === 'hold' && s.p[1] > 0.9 && !line) { line = s.tx; await shot(page, `${tag}_closing_hold`); } if (!s.ph && s.t < 1100) break; }
    await wait(300);
  }
  const ph = await ev('__ph.join()'); check(tag + ' closing fades out, holds, fades in', ph === 'out,hold,in', ph);
  check(tag + ' closing goes fully dark and says the line', maxOp > 0.98 && /The park closes\.\s*A new evening begins\./.test(line), `${maxOp} ${line}`);
  const tAfter = await ev('__park.game.clock.t'); check(tag + ' clock wrapped to 17:30 after close', tAfter >= 1050 && tAfter < 1060, String(tAfter));
  check(tag + ' lanterns gone at 17:30', (await ev('__park.game.modules.clock.lanterns()')) === 'none', String(await ev('__park.game.modules.clock.lanterns()')));
  // once per evening: jumping to the same event again without going back must not repeat it; going back must allow it
  await ev('__ev.length=0;__park.game.clock.set(1140)'); await wait(200); check(tag + ' frost fair again after going back', (await ev('__ev.slice()')).includes('frostfair'));
  // programme taps in the journal and the hold switch
  await ev('__park.game.journal.open()'); await wait(400);
  const rows = await ev('document.querySelectorAll(".ck-row").length'); check(tag + ' six programme rows', rows === 6, String(rows));
  await page.evaluate('document.querySelectorAll(".ck-row")[2].click()'); await wait(300);
  check(tag + ' tap jumps to 21:15', (await ev('__park.game.clock.t')) === 1275);
  check(tag + ' current item marked', (await ev('document.querySelector(".ck-row.now i")?.textContent')) === '21:15');
  await page.evaluate('(()=>{const i=document.querySelector(".ck-hold input");i.checked=true;i.dispatchEvent(new Event("change"))})()'); await wait(300);
  check(tag + ' hold stops the clock', (await ev('__park.game.clock.running')) === false);
  if (mobile || !mobile) await shot(page, `${tag}_journal`);
  await ev('__park.game.journal.close()');
  res.tracker = await ev('document.querySelector("#game-track")?.innerText');
  // the storyteller (21:15-22:00), as Wick
  await ev("__park.game.clock.set(1290);__park.setMode('walk',{at:[31.5,-178.5],yaw:-1.0})"); await wait(3500);
  res.promptStory = await ev('(()=>{const p=document.querySelector("#game-prompt");return p&&!p.hidden?p.textContent:null})()');
  check(tag + ' story prompt near the stage', !!res.promptStory && /story/i.test(res.promptStory), String(res.promptStory));
  await shot(page, `${tag}_storyteller`);
  await ev("__park.setMode('walk',{at:[31.5,-178.5],yaw:-1.0})"); await wait(800);
  await ev('document.querySelector("#game-prompt").click()'); await wait(400);
  check(tag + ' card opens', !!(await ev('document.querySelector("#ck-card")')));
  await shot(page, `${tag}_story_card`);
  for (let i = 0; i < 3; i++) { await ev('document.querySelector("#ck-card button")?.click()'); await wait(150); }
  check(tag + ' card closes after the last page', !(await ev('document.querySelector("#ck-card")')));
  const heard = await ev('[...__park.game.modules.clock.story.heard]'); check(tag + ' story recorded', heard.length === 1, JSON.stringify(heard));
  // keepsake at the pagoda terrace
  await ev("__park.setMode('walk',{at:[67.5,-176.5],yaw:-0.75})"); await wait(2500);
  const prompt = await ev('(()=>{const p=document.querySelector("#game-prompt");return p&&!p.hidden?p.textContent:null})()');
  check(tag + ' keepsake prompt at the pagoda', !!prompt && /Take/.test(prompt), String(prompt));
  await ev('document.querySelector("#game-prompt").click()'); await wait(400);
  check(tag + ' keepsake found', (await ev('[...__park.game.modules.clock.story.found]')).length === 1);
  // outside story time the figure is absent
  await ev('__park.game.clock.set(1400)'); await wait(600);
  check(tag + ' storyteller absent at 23:20', (await ev('__park.game.modules.clock.story.present')) === false);
  // tour keeps the fall
  await ev('__park.game.clock.set(1140)'); await ev("document.querySelector('#m-tour').click()"); await wait(1500);
  const tt = await ev('({t:__park.game.clock.t,run:__park.game.clock.running})'); check(tag + ' tour holds the clock in the fall', tt.t >= 1380 && tt.t < 1420 && !tt.run, JSON.stringify(tt));
  // the evening is saved: a reload comes back to it once the visitor leaves the opening tour, unless the address sets a time
  await ev("document.querySelector('#m-orbit').click()"); await wait(500); await ev('__park.game.modules.clock.hold=false;__park.game.clock.set(1230)'); await wait(2500);
  await ev('__park.game.save.flush()');
  const sv = await ev('__park.game.save.get("clock",{}).t'); check(tag + ' time saved', typeof sv === 'number' && sv > 1229 && sv < 1245, String(sv));
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction('window.__park && window.__park.loaded && window.__park.game && window.__park.game.started && window.__park.game.modules.clock', { timeout: 240000 }); await wait(1500);
  const r0 = await ev('__park.game.clock.t'); check(tag + ' reload opens in the tour at 23:00', r0 >= 1380 && r0 < 1385, String(r0));
  await ev("document.querySelector('#m-orbit').click()"); await wait(1500);
  const r1 = await ev('__park.game.clock.t'); check(tag + ' reload restores the evening on leaving the tour', r1 >= 1229 && r1 < 1260, String(r1));
  await page.goto(URL0 + '#weather=clear&time=19:30'); await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction('window.__park && window.__park.loaded && window.__park.game && window.__park.game.started && window.__park.game.modules.clock', { timeout: 240000 }); await wait(1500);
  const r2 = await ev('__park.game.clock.t'); check(tag + ' #time=19:30 wins over the saved time', r2 >= 1170 && r2 < 1175, String(r2));
  await ev('__park.game.modules.clock.hold=true');
  // the Night Market keepsake stands on the ground, not on a stall roof
  { const [kx, ky] = await ev('__park.game.modules.clock.story.STORIES.find(s=>s.id==="market").at'); const gz = await ev(`__park.game.ground(${kx},${ky})`); check(tag + ' market keepsake on low ground', gz !== null && gz < 1, `${kx},${ky} z=${gz}`); }
  // Wick's swing starts the story
  await ev("document.querySelector('#m-walk').click();__park.game.clock.set(1290);__park.setMode('walk',{at:[31.5,-178.5],yaw:-1.0})"); await wait(4000);
  if (!mobile) {
    await ev("document.querySelector('#ck-card')?.remove()");
    const wick = await ev('!!__park.game.player.wick'); check(tag + ' Wick is walking', wick);
    await ev('__park.platformer.test.input = () => ({ mx: 0, my: 0, a: false, b: true, z: false })'); await wait(900);
    await ev('__park.platformer.test.input = null'); await wait(600);
    check(tag + ' a swing starts the story', !!(await ev('document.querySelector("#ck-card")')));
    await ev('window.__park.game.modules.clock.story.closeCard()');
  }
  // the silent four minutes survive the music toggle
  if (!mobile) {
    await ev("document.querySelector('#btn-snd').click()"); await wait(6000);
    const have = await ev('!!(__park.audio && __park.audio.debug.nodes)');
    if (have) {
      await ev('__park.game.clock.set(1380.2)'); await wait(6000);
      const g1 = await ev('__park.audio.debug.nodes.music.gain.value');
      await ev('__park.audio.setMusic(false)'); await wait(900); await ev('__park.audio.setMusic(true)'); await wait(2500);
      const g2 = await ev('__park.audio.debug.nodes.music.gain.value');
      check(tag + ' hush ducks the music', g1 < 0.2, String(g1)); check(tag + ' the hush survives toggling the music', g2 < 0.2, String(g2));
      await ev('__park.audio.setAmbience(false)'); await wait(500); await ev('__park.audio.setAmbience(true)'); await wait(2500);
      check(tag + ' the hush survives toggling the ambience', (await ev('__park.audio.debug.nodes.amb.gain.value')) < 0.3, String(await ev('__park.audio.debug.nodes.amb.gain.value')));
    } else console.log('(no audio engine in this browser: hush toggle not checked)');
  }
  // crowd bias
  await ev("document.querySelector('#m-orbit').click()"); await ev('__park.game.clock.set(1200)'); await wait(500);
  res.bias = await ev('JSON.stringify(__park.guests.crowd.params.bias)'); check(tag + ' bias to Frostmere at 20:00', /frostmere/.test(res.bias || ''), String(res.bias));
  // the sky: no fall at 22:00, release under way, full fall
  if (!mobile) {
    await ev('__park.game.clock.set(1320)'); await sky(t); await shot(page, 'd_sky_2200');
    await ev('__park.game.clock.set(1380)'); await wait(30000); await shot(page, 'd_sky_2301');
    await ev('__park.game.clock.set(1400)'); await wait(3000); await shot(page, 'd_sky_2320');
    res.lan = await ev('(()=>{const L=__park.lanterns();const u=L.material.uniforms;return {inst:L.geometry.instanceCount,vis:L.visible,gate:u.uGate.value,state:L.userData.fallState}})()');
  }
  res.errs = [...t.errs].map(([k, v]) => v + 'x ' + k);
  await t.browser.close();
  return res;
}

const out = [];
out.push(await run(false));
// the same moment without the clock module: the lanterns must match (classic: gate off, all instances)
{
  const t = await open(false, '&no-clock'); const { page, ev } = t;
  await sky(t); await shot(page, 'd_sky_noclock');
  const lan = await ev('(()=>{const L=__park.lanterns();const u=L.material.uniforms;return {inst:L.geometry.instanceCount,vis:L.visible,gate:u.uGate.value,state:L.userData.fallState||"classic"}})()');
  const mine = out[0].lan; check('23:20 matches #no-clock (instances, visibility, ungated)', mine && lan.inst === mine.inst && lan.vis === mine.vis && lan.gate === 0 && mine.gate === 0, JSON.stringify({ mine, lan }));
  out.push({ noclock: lan, errs: [...t.errs].map(([k, v]) => v + 'x ' + k) }); await t.browser.close();
}
out.push(await run(true));
console.log(JSON.stringify(out, null, 1));
for (const r of out) if (r.errs && r.errs.length) fails.push('console: ' + r.errs.join(' | '));
console.log(fails.length ? 'FAILED:\n' + fails.join('\n') : 'ALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
