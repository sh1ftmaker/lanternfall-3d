// secrets module end to end: finds every secret by script, as Wick on desktop, as Wick on a 390x844 touch screen (the short set) and in first person
// (#fp: what only Wick can reach must stay unfound). Usage: node secrets.test.mjs [url] (needs puppeteer-core next to it); SHOTS=dir for screenshots,
// ONLY=desktop|mobile|fp to run one pass. Ends with a JSON line; "errs" must be empty. The nap test waits for Wick to fall asleep (about 80 s).
import puppeteer from 'puppeteer-core'; import fs from 'fs';
const URL = process.argv[2] || 'http://127.0.0.1:8905/index.html', SHOTS = process.env.SHOTS || '/tmp/secrets-shots'; fs.mkdirSync(SHOTS, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LANDS = ['wanderers', 'meridian', 'frostmere', 'guildhollow', 'rosewick', 'lantern-row', 'brinewatch'];
const run = async (kind) => {
  const mobile = kind === 'mobile', fp = kind === 'fp', W = mobile ? 390 : 1280, H = mobile ? 844 : 720;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', `--window-size=${W},${H}`] });
  const page = await browser.newPage(); const errs = new Map(), res = []; const add = (k) => errs.set(k, (errs.get(k) || 0) + 1);
  page.on('pageerror', (e) => add('pageerror: ' + e.message.slice(0, 160)));
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warn') && !/GPU stall|Context Lost|Context Restored|CONTEXT_LOST/.test(m.text())) add(m.type() + ': ' + m.text().slice(0, 160)); });
  page.on('response', (r) => { if (r.status() >= 400) add('http ' + r.status() + ' ' + r.url().slice(-60)); });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.evaluateOnNewDocument(() => { if (!sessionStorage.getItem('secrets-test')) { sessionStorage.setItem('secrets-test', '1'); try { localStorage.removeItem('lanternfall.game.v1'); } catch (e) {} } });
  const ready = async () => { await page.waitForFunction('window.__park && window.__park.loaded && window.__park.game && window.__park.game.modules.secrets && window.__park.game.modules.secrets.S.api.doors && window.__park.game.modules.secrets.S.api.garden', { timeout: 240000 }); await wait(2500); };
  await page.goto(URL + (fp ? '#fp&weather=clear' : '#weather=clear')); await ready();
  const ev = (js) => page.evaluate(js).catch((e) => { add('eval: ' + e.message.slice(0, 140)); });
  const ok = (name, cond, info = '') => { res.push((cond ? 'ok   ' : 'FAIL ') + name + (info ? ' ' + info : '')); if (!cond) add('FAIL ' + name); };
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${kind}_${n}.jpg`, type: 'jpeg', quality: 85 });
  const until = async (js, ms = 9000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(js)) return true; await wait(150); } return false; };
  const G = '__park.game', M = `${G}.modules.secrets`, API = `${M}.S.api`;
  const found = (id) => ev(`${M}.isFound('${id}')`);
  const wx = (land, lx, ly) => ev(`${M}.lib.world('${land}',${lx},${ly})`);
  const weather = (w) => ev(`__park.weather.set('${w}',{instant:true})`);
  const place = (x, y, yaw) => ev(`${G}.teleport(${x},${y},${yaw})`);
  const hook = () => ev(`window.__found=[];${G}.on('secrets:found',d=>__found.push(d))`);
  const prompt = () => ev(`(()=>{const p=document.querySelector('#game-prompt');return p&&!p.hidden?p.textContent:''})()`);
  const tapPrompt = async () => { const b = await (await page.$('#game-prompt')).boundingBox(); if (mobile) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); else await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
  await ev(`__park.setMode('walk',{at:[288,0],yaw:Math.PI})`); await wait(1500);
  if (!fp) ok('Wick is the player', await until(`${G}.player.wick`, 30000)); else ok('first person', await ev(`!${G}.player.wick&&${G}.player.mode==='walk'`));
  await hook();

  /* 1. the Paper Doors: each weather opens somewhere else; a return door stands there */
  const door = await ev(`${API}.doors.doorWorld()`);
  const dest = { clear: [6.2, 0.2], mist: await wx('lantern-row', 0, 28), rain: await wx('meridian', 14, 4.5), storm: await wx('guildhollow', 0, 22.6), snow: await wx('frostmere', 36, 5) };
  for (const w of mobile ? ['mist', 'rain'] : ['clear', 'mist', 'rain', 'storm', 'snow']) {
    await weather(w); const f = await wx('wanderers', -1.33, 21.5); await place(f[0], f[1], await ev(`${M}.lib.outward('wanderers')`)); await wait(2500);
    ok(`door prompt (${w})`, /Open door/.test(await prompt()), await prompt());
    if (w === 'mist') { await shot('door_prompt'); }
    if (mobile && w === 'mist') await tapPrompt(); else await ev(`${G}.use()`);
    await wait(4200);
    const p = await ev(`(({x,y,z,land})=>({x,y,z,land}))(${G}.player)`), d = dest[w], dd = Math.hypot(p.x - d[0], p.y - d[1]);
    // first person cannot stand on the island or a tower deck: it lands on the nearest walk-grid spot, so only demand a move away from the door
    if (fp && (w === 'clear' || w === 'rain')) ok(`door (${w}) moves the visitor`, Math.hypot(p.x - door[0], p.y - door[1]) > 15, `${p.x.toFixed(0)},${p.y.toFixed(0)}`);
    else ok(`door (${w}) arrives`, dd < 12 && (w !== 'rain' || fp || p.z > 30), `d=${dd.toFixed(1)} z=${p.z.toFixed(1)} land=${p.land}`);
    ok(`return door (${w})`, !!(await ev(`!!${API}.doors.returnDoor`)));
    if (w === 'storm' || w === 'mist') await shot('door_' + w);
    // step back through it
    await ev(`(()=>{const it=${API}.doors.returnDoor.it, p=${G}.player, x=it.x-Math.cos(p.yaw)*0.7, y=it.y-Math.sin(p.yaw)*0.7; if (p.wick) __park.platformer.enter({ x, y, z: it.z - 0.5, yaw: p.yaw }); else ${G}.teleport(x, y, p.yaw)})()`); await wait(2600);
    await ev(`${G}.use()`); await wait(4200);
    const q = await ev(`(({x,y})=>({x,y}))(${G}.player)`); ok(`back through the return door (${w})`, Math.hypot(q.x - door[0], q.y - door[1]) < 8, `d=${Math.hypot(q.x - door[0], q.y - door[1]).toFixed(1)}`);
  }
  ok('doors found once', await found('doors') && (await ev(`__found.filter(f=>f.id==='doors').length`)) === 1);
  ok('secrets:found carries count and total', await ev(`(()=>{const f=__found[0];return f&&f.count===1&&f.total===8})()`));
  await weather('clear');

  /* 7. the bell, 23 times (our own bell appears ten seconds in if nobody has put one there) */
  await wait(8000);
  const bell = await ev(`(()=>{const b=${G}.modules.bounty;if(b&&b.positions){const p=b.positions().bell;return [p.x,p.y]}return ${API}.bell.own?[${API}.bell.own.x,${API}.bell.own.y]:null})()`);
  ok('a bell to ring (the bounty module\'s, else our fallback)', !!bell);
  if (bell) {
    await place(bell[0] - 1.2, bell[1] - 1.4, 0.7); await wait(2500); ok('bell prompt', /bell/i.test(await prompt()), await prompt());
    if (mobile) { await shot('bell'); await tapPrompt(); } else await ev(`${G}.use()`);
    for (let i = 0; i < 21; i++) { await ev(`${G}.use()`); await wait(60); }
    ok('22 rings: not yet', !(await found('bell')) && (await ev(`${API}.bell.count`)) === 22);
    await ev(`${G}.use()`); await wait(1500);
    ok('the 23rd ring finds it', await found('bell')); await wait(1200); if (!mobile) await shot('bell_column');
  }

  /* 4. the guest in the red coat: seen in each land, gone within 12 m, then the rail and the button */
  if (!mobile) {
    const spots = await ev(`${API}.redcoat.spots.map(s=>[s.id,s.x,s.y])`);
    ok('seven vantage spots', spots.length === 7);
    for (const [id, sx, sy] of spots) {
      const d = Math.hypot(sx, sy), ux = -sx / d, uy = -sy / d;                                       // from the spot toward the lake, 40 m out
      await place(sx + ux * 40, sy + uy * 40, Math.atan2(sy - (sy + uy * 40), sx - (sx + ux * 40)));
      const seen = await until(`${API}.redcoat.current&&${API}.redcoat.current.id==='${id}'`, 12000); await wait(3500);
      if (id === 'wanderers' || id === 'meridian') { await place(sx + ux * 20, sy + uy * 20, Math.atan2(sy - (sy + uy * 20), sx - (sx + ux * 20))); await wait(3000); await shot('redcoat_' + id); }
      ok(`red coat seen in ${id}`, seen && (await ev(`${M}.state().coat.seen.includes('${id}')`)));
    }
    // within 12 m it fades and goes (the first land again: it is re-armed once we have been far away)
    { const [id0, sx, sy] = spots[0], d0 = Math.hypot(sx, sy), ux0 = -sx / d0, uy0 = -sy / d0;
      await place(sx + ux0 * 30, sy + uy0 * 30, Math.atan2(-uy0, -ux0)); ok('seen again at a distance', await until(`${API}.redcoat.current&&${API}.redcoat.current.id==='${id0}'`, 14000)); await wait(2500);
      await place(sx + ux0 * 6, sy + uy0 * 6, Math.atan2(-uy0, -ux0)); await wait(700);
      const fading = await ev(`${API}.redcoat.current?'fading':'gone'`); await wait(2200); ok('gone once within 12 m', await ev(`!${API}.redcoat.current`), fading); }
    // all seven seen: it waits at the lake rail
    ok('all seven lands seen', await ev(`${M}.state().coat.seen.length===7`));
    const rail = await ev(`[${API}.redcoat.rail.x,${API}.redcoat.rail.y]`);
    await place(rail[0] + 36, rail[1] + 14, Math.atan2(rail[1] - (rail[1] + 14), rail[0] - (rail[0] + 36)));
    ok('at the lake rail facing the Spire', await until(`${API}.redcoat.current&&${API}.redcoat.current.id==='rail'`, 14000)); await wait(3500); await shot('redcoat_rail');
    await place(rail[0] + 4, rail[1] + 1.4, Math.atan2(-rail[1], -rail[0])); await wait(3500);
    ok('it leaves a red button on the rail', await ev(`!!${API}.redcoat.button`));
    await ev(`(()=>{const b=${API}.redcoat.button;${G}.teleport(b.x+0.6,b.y+0.5,0)})()`); await wait(2500); ok('button prompt', /button/i.test(await prompt()), await prompt());
    await ev(`${G}.use()`); await wait(800); ok('the button is picked up: found', await found('redcoat'));
  }

  /* 2. the keep: only in a storm, only when looked at for two seconds */
  if (!mobile) {
    const kp = await ev(`${API}.keep.pos`), cw = await wx('guildhollow', 0, 22);
    await place(cw[0], cw[1], await ev(`${M}.lib.outward('guildhollow')`)); await wait(2000);
    const aim = () => ev(fp ? `(()=>{const w=__park.walk;const dx=${kp[0]}-w.x,dy=${kp[1]}-w.y,dz=${kp[2] + 1.3}-(w.z+1.68);w.yaw=Math.atan2(dy,dx);w.pitch=Math.atan2(dz,Math.hypot(dx,dy))})()`
      : `(()=>{const g=${G};window.__rel=g.takeCamera(()=>{g.camera.position.set(${cw[0]},1.7,${-cw[1]});g.camera.lookAt(${kp[0]},${kp[2] + 1.3},${-kp[1]})},{name:'test'})})()`);
    await weather('clear'); await aim(); await wait(3500);
    ok('not there in clear weather', !(await found('keep')) && (await ev(`!${API}.keep.visible`)));
    await weather('storm'); await wait(2500);
    ok('the figure stands in the window in a storm', await ev(`${API}.keep.visible`)); await shot('keep'); await wait(1500);
    ok('looking at it for two seconds finds it', await until(`${M}.isFound('keep')`, 9000));
    await ev(`window.__rel&&__rel()`); await weather('clear');
  }

  /* 3. the snow: footprints and a music box, only while it snows */
  if (!mobile) {
    await weather('clear'); await wait(3000); ok('no trail in clear weather', await ev(`!${API}.snow.visible`));
    await weather('snow'); await wait(6000); ok('the trail appears in snow', await ev(`${API}.snow.visible`));
    const bx = await ev(`${API}.snow.boxPos`), first = await ev(`(({x,y})=>[x,y])(${API}.snow.pts[0])`);
    await place(first[0] + 2.5, first[1] + 2, 3); await wait(2500); await shot('snow_trail');
    await place(bx[0] + 0.9, bx[1] + 0.9, Math.atan2(-0.9, -0.9)); await wait(2500); ok('music box prompt', /music box/i.test(await prompt()), await prompt());
    await shot('snow_box'); await ev(`${G}.use()`); await wait(600); ok('using the music box finds it', await found('snow'));
    await weather('clear'); await wait(6000); ok('trail gone again', await ev(`!${API}.snow.visible`));
  }

  /* 6 and 5 and 8 need Wick: unfound in first person, found by diving, a triple jump and a long nap */
  if (!fp && !mobile) {
    // 6. the lake bed
    const hz = await ev(`${API}.lakebed.pos`);
    await ev(`__park.platformer.enter({x:${hz[0] + 2.2},y:${hz[1]},z:-2.2,yaw:0})`); await wait(2500);
    await ev(`__park.platformer.test.input=()=>({mx:0,my:-1,a:true,b:false,z:false})`); const dived = await until(`${M}.isFound('lakebed')`, 14000); await ev(`__park.platformer.test.input=null`);
    ok('diving near the sunken horse finds it', dived); await wait(800); await shot('lakebed');
    // 5. the garden: triple jump at the arcade's east wall from about 28 m (timing depends on the frame rate: up to four tries)
    let roof = false, tries = 0;
    for (const D of [28, 26, 28, 29]) {
      if (roof) break; tries++;
      await ev(`(()=>{const pf=__park.platformer,D=${D},x0=90.5+D*0.94,y0=115.6-D*0.33;pf.enter({x:x0,y:y0,z:0.6,yaw:2.8})})()`); await wait(2500);
      await ev(`(()=>{const pf=__park.platformer,t0=pf.S.t;window.__T={n:0,hold:0,wasAir:false};pf.test.input=(t,v)=>{const T=window.__T,dt=t-t0,act=v&&v.s?v.s.action:0,air=!!(act&0x800),into=[-0.94,-0.33];if(T.wasAir&&!air&&T.n<3&&T.n>0){T.hold=0.22;T.n++}T.wasAir=air;if(dt>1.0&&T.n===0){T.n=1;T.hold=0.3}if(T.hold>0){T.hold-=1/60;return{world:into,a:true}}return{world:into}}})()`);
      roof = await until(`${M}.isFound('garden')`, 12000); await ev(`__park.platformer.test.input=null`);
    }
    ok('the triple jump reaches the arcade roof and finds the garden', roof, `try ${tries} ` + JSON.stringify(await ev(`(({x,y,z})=>[x,y,z])(${G}.player)`))); await shot('garden');
    // 8. the long nap
    const nb = await ev(`${API}.nap.BENCH`); await place(nb[0] + 1, nb[1], Math.PI); await wait(1500);
    const t0 = Date.now(); const slept = await until(`${G}.player.action==='sleeping'`, 110000); ok('Wick falls asleep when left alone', slept, `${((Date.now() - t0) / 1000).toFixed(0)} s`);
    ok('five seconds asleep on the bench: he wakes on the Spire gallery', await until(`${M}.isFound('nap')&&${G}.player.z>20`, 20000)); await wait(2500); await shot('nap');
  }
  if (fp) {
    ok('Wick-only secrets stay unfound in first person', !(await found('lakebed')) && !(await found('garden')) && !(await found('nap')));
  }

  /* journal, then persistence */
  await ev(`${G}.journal.open()`); await wait(700); await ev(`document.querySelector('#game-journal').scrollTop=1e5`); await wait(300); await shot('journal');
  const jtxt = await ev(`document.querySelector('#game-journal').textContent`), nf = await ev(`Object.keys(${M}.state().found).length`);
  ok('journal lists Curiosities and the found ones', /Curiosities/.test(jtxt) && (nf === 0 || /Twenty-three rings|paper door/.test(jtxt)), `found ${nf}`);
  ok('journal fits the screen width', await ev(`(()=>{const r=document.querySelector('#game-journal').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`));
  if (nf >= 3) ok('a faint hint for what is not found', await ev(`!!document.querySelector('.sx-jrow.hint')`) || nf === 8);
  await ev(`${G}.journal.close()`);
  await wait(1200); await page.reload(); await ready();
  const nf2 = await ev(`Object.keys(${M}.state().found).length`); ok('finds survive a reload', nf2 === nf, `${nf2}/${nf}`);
  await ev(`${G}.journal.open()`); await wait(500); ok('journal after reload', (await ev(`document.querySelectorAll('.sx-jrow:not(.none):not(.hint)').length`)) === nf);
  await shot('journal_reload'); await ev(`${G}.journal.close()`);
  console.log(JSON.stringify({ kind, results: res, errs: [...errs].map(([k, v]) => v + 'x ' + k) }, null, 1)); await browser.close();
  return !errs.size;
};
const only = process.env.ONLY; let all = true;
for (const k of ['desktop', 'mobile', 'fp']) if (!only || only === k) all = (await run(k)) && all;
console.log(all ? 'ALL OK' : 'FAILURES'); process.exit(all ? 0 : 1);
