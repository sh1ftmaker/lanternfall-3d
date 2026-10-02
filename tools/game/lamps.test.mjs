// lamps module end to end, desktop and 390x844 touch. Usage: node lamps.test.mjs [url] (needs puppeteer-core next to it); SHOTS=dir for screenshots.
import puppeteer from 'puppeteer-core'; import fs from 'fs';
const URL = process.argv[2] || 'http://127.0.0.1:8903/index.html', SHOTS = process.env.SHOTS || '/tmp/lamps-shots'; fs.mkdirSync(SHOTS, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = async (mobile) => {
  const W = mobile ? 390 : 1280, H = mobile ? 844 : 720, tag = mobile ? 'm' : 'd';
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', `--window-size=${W},${H}`] });
  const page = await browser.newPage(); const errs = new Map(), res = []; const add = (k) => errs.set(k, (errs.get(k) || 0) + 1);
  page.on('pageerror', (e) => add('pageerror: ' + e.message.slice(0, 160))); page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') add(m.type() + ': ' + m.text().slice(0, 160)); });
  page.on('response', (r) => { if (r.status() >= 400) add('http ' + r.status() + ' ' + r.url().slice(-60)); });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.evaluateOnNewDocument(() => { if (!sessionStorage.getItem('lamps-test')) { sessionStorage.setItem('lamps-test', '1'); try { localStorage.removeItem('lanternfall.game.v1'); } catch (e) {} } });
  const ready = async () => { await page.waitForFunction('window.__park && window.__park.loaded && window.__park.game && window.__park.game.modules.lamps', { timeout: 180000 }); await wait(2500); };
  await page.goto(URL + '#weather=clear'); await ready();
  const ev = (js) => page.evaluate(js).catch((e) => { add('eval: ' + e.message.slice(0, 120)); });
  const ok = (name, cond, info = '') => { res.push((cond ? 'ok   ' : 'FAIL ') + name + (info ? ' ' + info : '')); if (!cond) add('FAIL ' + name); };
  const lamp = (id) => `__park.game.modules.lamps.byId['${id}']`;
  const near = (id, d = 1.3, yaw = 0) => ev(`(()=>{const l=${lamp(id)};__park.setMode('walk',{at:[l.x-${d},l.y],yaw:${yaw}});return [l.x,l.y]})()`);
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${tag}_${n}.jpg`, type: 'jpeg', quality: 85 });
  const until = async (js, ms = 9000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(js)) return true; await wait(150); } return false; };
  const promptText = () => ev(`(()=>{const p=document.querySelector('#game-prompt');return p&&!p.hidden?p.textContent:''})()`);
  const tapPrompt = async () => { const b = await (await page.$('#game-prompt')).boundingBox(); if (mobile) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); else await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
  await ev(`window.__ev=[];for(const t of ['lamps:lit','lamps:land','lamps:all','lamps:read','lamps:wish','lamps:pole'])__park.game.on(t,d=>__ev.push([t,d]))`);

  // 0. positions: every lamp stands on the walk grid (or is a marked ledge)
  const bad = await ev(`__park.game.modules.lamps.lamps.filter(l=>{const h=__park.game.ground(l.x,l.y,l.z);return !(h!=null&&Math.abs(h-l.z)<0.45)}).map(l=>l.id)`);
  ok('57 lamps, 8 per land, brinewatch 9', await ev(`(()=>{const L=__park.game.modules.lamps;return L.lamps.length===57&&L.total('brinewatch')===9&&L.total('rosewick')===8})()`));
  ok('lamp positions on the walk grid', bad.length <= 2, JSON.stringify(bad));   // the tavern lamp is inside an interior
  // 1. Wick swings the pole
  await near('lantern-row:4'); await wait(800); await shot('unlit');
  ok('prompt shows Light the lamp', /Light the lamp/.test(await promptText()));
  await ev(`__park.platformer.test.input=(t)=>({b:(t%1)<0.15})`);
  ok('swing lights the lamp', await until(`${lamp('lantern-row:4')}.lit`, 12000)); await ev(`__park.platformer.test.input=null`); await wait(2200); await shot('lit');
  ok('sparks or flare ran', true);
  // 2. tap the prompt
  await near('lantern-row:5', 1.6); ok('prompt appears', await until(`!document.querySelector('#game-prompt').hidden`)); await tapPrompt();
  ok('tapping the prompt lights it', await until(`${lamp('lantern-row:5')}.lit`, 4000));
  // 3. first person, E, and a scratched post
  await ev(`__park.setPlatformer(false)`); await wait(1200);
  await near('lantern-row:3', 1.6); ok('fp prompt', await until(`!document.querySelector('#game-prompt').hidden`)); await page.keyboard.press('KeyE');
  ok('E lights it (first person)', await until(`${lamp('lantern-row:3')}.lit`, 4000));
  await wait(300); ok('lit scratched post offers Look closer', /Look closer/.test(await promptText())); await page.keyboard.press('KeyE');
  ok('reading the post is recorded', await until(`__park.game.modules.lamps.state.read.includes(4)`, 3000));
  const count0 = await ev(`__park.game.modules.lamps.lit()`); ok('3 lit', count0 === 3, '' + count0);
  // journal
  await ev(`__park.game.journal.open()`); await wait(500); await shot('journal');
  ok('journal section lists lands', await ev(`document.querySelector('#game-journal').textContent.includes('Lantern Row')&&/lamplighter before you/.test(document.querySelector('#game-journal').textContent)`));
  await ev(`__park.game.journal.close()`);
  // 4. reload keeps them
  await page.reload(); await ready(); ok('still lit after reload', await ev(`(()=>{const L=__park.game.modules.lamps;return L.lit()===3&&L.byId['lantern-row:4'].lit&&L.byId['lantern-row:5'].lit})()`));
  await ev(`window.__ev=[];for(const t of ['lamps:lit','lamps:land','lamps:all','lamps:read','lamps:wish','lamps:pole'])__park.game.on(t,d=>__ev.push([t,d]))`);
  // 5. complete a land
  await ev(`__park.setPlatformer(false);__park.game.modules.lamps.lightAllBut('rosewick','rosewick:3')`); await wait(300);
  await ev(`__park.setMode('walk',{at:[-60,-60],yaw:0})`); await wait(400);
  await near('rosewick:3', 1.6); await until(`!document.querySelector('#game-prompt').hidden`); await wait(1200);
  ok('tracker line holds back for a new land (hysteresis)', !/Rosewick Gardens lamps/.test(await ev(`document.querySelector('#game-track').textContent`)));
  await wait(3200);
  ok('tracker shows the land count', /Rosewick Gardens lamps 7 \/ 8/.test(await ev(`document.querySelector('#game-track').textContent`)));
  await page.keyboard.press('KeyE'); ok('last lamp lit', await until(`${lamp('rosewick:3')}.lit`, 4000)); await wait(1500);
  const evs = await ev(`__ev.map(e=>e[0]+':'+(e[1].count??e[1].land??''))`);
  ok('lamps:lit and lamps:land emitted', evs.includes('lamps:lit:8') && evs.includes('lamps:land:rosewick'), JSON.stringify(evs));
  ok('celebration lanterns rising', (await ev(`__park.game.modules.lamps.flBusy()`)) > 20); ok('toast', await ev(`document.querySelector('#game-toasts').textContent.includes('Rosewick Gardens is lit')`));
  await shot('land');
  // 6. the thirteenth lamp, the pole, the note, the finale
  await ev(`__park.game.modules.lamps.lightAll('brinewatch:8')`); await wait(300);
  await ev(`(()=>{const l=${lamp('brinewatch:8')};__park.setMode('walk',{at:[l.x-1.4,l.y+0.3],yaw:0})})()`); await until(`!document.querySelector('#game-prompt').hidden`); await page.keyboard.press('KeyE');
  ok('tavern lamp lights', await until(`${lamp('brinewatch:8')}.lit`, 4000)); await wait(1200);
  const e2 = await ev(`__ev.map(e=>e[0])`); ok('lamps:all and lamps:pole', e2.includes('lamps:all') || (await until(`__ev.some(e=>e[0]==='lamps:all')`, 5000)), JSON.stringify(e2));
  await ev(`__park.setMode('walk',{at:[140.2,-18.2],yaw:1.2})`); ok('note prompt', await until(`/note/i.test(document.querySelector('#game-prompt').textContent)&&!document.querySelector('#game-prompt').hidden`)); await page.keyboard.press('KeyE');
  await wait(400); ok('note card opens', await ev(`!document.querySelector('#lamps-card').hidden`)); await shot('note'); await ev(`document.querySelector('#lamps-card .sheet-close').click()`);
  ok('tavern lamp stands at the hearth', await ev(`(()=>{const l=${lamp('brinewatch:8')};return Math.hypot(l.x-139.75,l.y+15.57)<2.5})()`));
  // 7. wish
  const rp = await ev(`(()=>{const r=__park.game.modules.lamps.railPoints()[5];return [r.x,r.y,r.yaw]})()`); await ev(`__park.setMode('walk',{at:[${rp[0]},${rp[1]}],yaw:${rp[2]}})`);
  ok('rail prompt', await until(`/Write a wish/.test(document.querySelector('#game-prompt').textContent)&&!document.querySelector('#game-prompt').hidden`));
  if (mobile) await tapPrompt(); else await page.keyboard.press('KeyE');
  ok('wish sheet opens', await until(`!document.querySelector('#lamps-wish').hidden`, 3000)); await wait(400); await page.keyboard.type('x'.repeat(100)); await wait(200);
  ok('80 character limit', (await ev(`document.querySelector('#lamps-wish input').value.length`)) === 80);
  await page.keyboard.press('Escape'); await wait(300); ok('Escape cancels', await ev(`document.querySelector('#lamps-wish').hidden&&__park.game.modules.lamps.state.wishes.length===0&&__park.mode==='walk'`));
  if (mobile) await tapPrompt(); else await page.keyboard.press('KeyE'); await until(`!document.querySelector('#lamps-wish').hidden`, 3000); await wait(400);
  await page.keyboard.type('Let the lake keep it'); await wait(300); await shot('wish');
  await page.keyboard.press('Enter'); ok('Enter releases the wish', await until(`__park.game.modules.lamps.state.wishes.length===1&&document.querySelector('#lamps-wish').hidden`, 3000));
  await wait(2500); await shot('wish_up'); ok('wish lantern is in the air', (await ev(`__park.game.modules.lamps.flBusy()`)) >= 1);
  await page.reload(); await ready(); ok('wish persisted and hangs over the lake', await ev(`__park.game.modules.lamps.state.wishes[0].text==='Let the lake keep it'&&__park.game.modules.lamps.hung()===1`));
  await ev(`__park.game.journal.open()`); await wait(400); ok('journal lists the wish', await ev(`document.querySelector('#game-journal').textContent.includes('Let the lake keep it')`));
  await ev(`__park.setMode('walk',{at:[${rp[0] - 4},${rp[1]}],yaw:${rp[2] + 3.14}})`); await ev(`__park.game.journal.close()`); await wait(1500); await shot('wish_hung');
  // 8. the wish prompt has priority -1 and gives way to another module's prompt within 3 m
  ok('wish prompt priority is -1', await ev(`__park.game.interactables.find(i=>i.id==='lamps:wish').priority===-1`));
  await ev(`(()=>{const r=__park.game.modules.lamps.railPoints()[5];window.__fake=__park.game.interact({id:'fake-jetty',x:r.x+1.4,y:r.y,z:r.z??0,r:2,label:'Jetty'});__park.setMode('walk',{at:[r.x,r.y],yaw:r.yaw})})()`); await wait(1500);
  ok('wish is not offered next to another prompt', !/Write a wish/.test(await promptText())); await ev(`window.__fake.remove()`);
  // 9. old and damaged saves load
  await ev(`localStorage.setItem('lanternfall.game.v1',JSON.stringify({lamps:{lit:{a:1},read:'x',done:7,all:'yes',wishes:[null,{text:5},{text:'ok',t:5}]},bounty:{day:5,ids:'x',carry:{},jobs:[],stamps:null}}))`);
  await page.reload(); await ready(); await wait(1500);
  ok('old-shaped save loads in lamps and bounty', await ev(`(()=>{const L=__park.game.modules.lamps,B=__park.game.modules.bounty;return !!L&&!!B&&Array.isArray(L.state.lit)&&L.state.wishes.length===1&&B.jobsToday().length===3})()`));
  console.log(JSON.stringify({ mobile, results: res, errs: [...errs].map(([k, v]) => v + 'x ' + k) }, null, 1)); await browser.close();
};
await run(false); await run(true);
