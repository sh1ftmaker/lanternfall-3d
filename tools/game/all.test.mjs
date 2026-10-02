// The whole game layer in one quick smoke test (about 3 minutes): a fresh save, every module initialised, one real
// interaction per module through the shared prompt / journal, the save written and read back after a reload, no console
// errors or warnings. Desktop as Wick (1280x720) and the 390x844 touch layout in first person.
// usage: node tools/game/all.test.mjs [url] [--only desktop|phone] [--shots DIR]
//   (puppeteer-core is resolved like the other tests; PUPPETEER_CORE=<path to puppeteer-core.js> overrides it)
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
const { default: puppeteer } = await import(process.env.PUPPETEER_CORE ? pathToFileURL(process.env.PUPPETEER_CORE).href : 'puppeteer-core');
const args = process.argv.slice(2), URL0 = (args[0] && !args[0].startsWith('--') ? args[0] : 'http://127.0.0.1:8915/index.html').split('#')[0];
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : '', SHOTS = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const MODULES = ['clock', 'daynight', 'lamps', 'bounty', 'secrets', 'trials', 'rides', 'photo'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

async function run(mobile) {
  const W = mobile ? 390 : 1280, H = mobile ? 844 : 720, tag = mobile ? 'phone' : 'desktop';
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/chromium', headless: 'new', protocolTimeout: 300000,
    args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', `--window-size=${W},${H}`] });
  const page = await browser.newPage(); const errs = new Map(); const add = (k) => errs.set(k, (errs.get(k) || 0) + 1);
  page.on('pageerror', (e) => add('pageerror: ' + e.message.slice(0, 200)));
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warn') && !/GPU stall|Context Lost|Context Restored|CONTEXT_LOST/.test(m.text())) add(m.type() + ': ' + m.text().slice(0, 200)); });
  page.on('response', (r) => { if (r.status() >= 400) add('http ' + r.status() + ' ' + r.url().slice(-60)); });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const res = { tag, checks: {} }, ok = (name, cond, info) => { res.checks[name] = cond ? true : (info === undefined ? false : info); if (!cond) failed++; };
  const ev = (js) => page.evaluate(js).catch((e) => { add('eval: ' + e.message.slice(0, 160)); return null; });
  const until = (js, ms = 8000) => page.waitForFunction(js, { timeout: ms, polling: 100 }).then(() => true).catch(() => false);
  const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${tag}_${n}.jpg`, type: 'jpeg', quality: 75 }); };
  const tap = (sel) => page.click(sel).then(() => true).catch(() => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`));
  const load = async () => {
    await page.goto(URL0 + '#weather=clear' + (mobile ? '&fp' : ''));
    await page.waitForFunction('window.__park && window.__park.loaded', { timeout: 240000 });
    await until(`__park.game && __park.game.started && ${MODULES.length} === Object.keys(__park.game.modules).length`, 60000);
  };
  // stand next to an interactable (first person or Wick), wait for its prompt, tap it
  let lastPos = null;
  const useAt = async (id, label, dx = 1.2) => {
    const it = await ev(`(()=>{const i=__park.game.interactables.find(o=>o.id===${JSON.stringify(id)});return i&&[i.x,i.y,i.z]})()`);
    if (!it) return 'no interactable ' + id;
    await ev(`__park.game.teleport(${it[0] + dx}, ${it[1]}, Math.PI, { z: ${it[2]} })`);
    const seen = await until(`(()=>{const p=document.querySelector('#game-prompt');return !p.hidden&&p.textContent.includes(${JSON.stringify(label)})})()`, 15000);
    if (!seen) return 'prompt not shown: ' + (await ev(`document.querySelector('#game-prompt').hidden?'(none)':document.querySelector('#game-prompt').textContent`));
    lastPos = await ev('[__park.game.player.x, __park.game.player.y]'); await tap('#game-prompt'); return true;
  };
  const t0 = Date.now();
  await load();
  res.loadS = Math.round((Date.now() - t0) / 1000);
  ok('modules', (await ev('Object.keys(__park.game.modules).sort().join()')) === [...MODULES].sort().join(), await ev('Object.keys(__park.game.modules).join()'));
  ok('fresh save', await ev("(()=>{const g=__park.game,M=g.modules;return M.lamps.lit()===0&&M.photo.shots.length===0&&!M.secrets.isFound('doors')})()"));   // (modules may write their own defaults at start)
  ok('tour: no game interface', await ev("document.querySelector('#game-track').hidden && document.querySelector('#game-prompt').hidden && !document.querySelector('#game-toasts').children.length"));
  await shot('0-tour');
  await tap('#m-walk'); await wait(1500);
  ok('walk: tracker pill', await until("!document.querySelector('#game-track').hidden && document.querySelector('#game-track').textContent.includes(':')", 8000));
  if (!mobile) ok('wick', await until('__park.platformer && __park.platformer.active', 30000));

  // lamps: light one with the prompt
  ok('lamps: prompt', (await useAt('lamp:wanderers:1', 'Light the lamp')) === true);
  ok('lamps: lit', await until('__park.game.modules.lamps.lit() === 1', 5000), await ev('__park.game.modules.lamps.lit()'));
  await shot('1-lamp');
  // bounty: read the board
  ok('bounty: prompt', (await useAt('bounty-board', 'Bounty Board')) === true);
  ok('bounty: card', await until("[...document.querySelectorAll('.bty-card')].some(e=>!e.hidden&&e.offsetHeight>0)", 5000));
  await shot('2-board'); await ev('__park.game.modules.bounty.closeCard()');
  // trials: start the Lake Lap at its post, then call it off
  ok('trials: prompt', (await useAt('trial-lake', 'Lake Lap', 1.5)) === true);
  ok('trials: race', await until("(()=>{const r=__park.game.modules.trials.race;return r&&r.course==='lake'})()", 5000));
  await ev('__park.game.modules.trials.cancel()'); ok('trials: cancelled', await until('!__park.game.modules.trials.race', 4000));
  // rides: the carousel takes the camera, the leave button gives it back
  ok('rides: prompt', (await useAt('rides:carousel', 'carousel', 3)) === true);
  ok('rides: camera', await until("__park.game.cameraHeld === 'rides'", 6000));
  ok('rides: no prompt while riding', await until("document.querySelector('#game-prompt').hidden", 3000), await ev("document.querySelector('#game-prompt').textContent"));
  await wait(1500); await shot('3-carousel');
  await ev('__park.game.modules.rides.session.end()'); ok('rides: back', await until('!__park.game.cameraHeld && __park.mode === "walk"', 8000));
  // secrets: door VI goes somewhere else
  ok('secrets: prompt', (await useAt('secrets-door', 'door', 1)) === true);
  ok('secrets: through the door', await until(`Math.hypot(__park.game.player.x-${lastPos[0]}, __park.game.player.y-${lastPos[1]}) > 15`, 8000), lastPos);
  ok('secrets: found', await until("!!__park.game.modules.secrets.isFound('doors')", 3000));
  // clock + daynight: tap 17:30 in the journal; dusk comes; tap 23:00 to come back
  await tap('#game-track'); ok('journal opens', await until('__park.game.journal.isOpen', 3000));
  const jr = await ev("(()=>{const j=document.querySelector('#game-journal'),r=j.getBoundingClientRect();return {l:r.left,r:r.right,t:r.top,b:r.bottom,W:innerWidth,H:innerHeight,titles:[...j.querySelectorAll('.gj-sec h3')].map(h=>h.textContent)}})()");
  ok('journal fits the screen', jr && jr.l >= 0 && jr.r <= jr.W && jr.b <= jr.H, jr);
  ok('journal: a section per module', jr && jr.titles.length >= 8, jr && jr.titles);
  await shot('4-journal');
  const row = (hhmm) => ev(`(()=>{const b=[...document.querySelectorAll('#game-journal .ck-row')].find(b=>b.textContent.startsWith(${JSON.stringify(hhmm)}));if(!b)return false;b.click();return true})()`);
  ok('clock: 17:30 row', await row('17:30'));
  ok('clock: at 17:30', await until('Math.abs(__park.game.clock.t - 1050) < 2', 3000), await ev('__park.game.clock.t'));
  ok('clock: gates toast', await until("[...document.querySelectorAll('.game-toast')].some(t=>/gates are open/i.test(t.textContent))", 5000));
  ok('daynight: dusk', await until("__park.game.modules.daynight.state.phase !== 'night'", 5000), await ev('JSON.stringify(__park.game.modules.daynight.state)'));
  await ev('__park.game.journal.open()'); ok('clock: 23:00 row', await row('23:00'));
  ok('daynight: night again', await until("Math.abs(__park.game.clock.t - 1380) < 2", 3000));
  await ev('__park.game.journal.close()');
  // photo: enter, shoot, leave (phones: from the journal's button; desktop: the top-bar camera)
  if (mobile) { await ev('__park.game.journal.open()'); await ev("[...document.querySelectorAll('#game-journal button')].find(b=>/photo/i.test(b.textContent))?.click()"); }
  else await tap('#btn-photo');
  ok('photo: camera', await until("__park.game.cameraHeld === 'photo' || __park.game.modules.photo.active", 6000));
  await wait(800); await shot('5-photo');
  await ev('__park.game.modules.photo.shoot()'); ok('photo: kept', await until('__park.game.modules.photo.shots.length === 1', 10000));
  await ev('__park.game.modules.photo.leave()'); ok('photo: left', await until('!__park.game.cameraHeld', 5000));
  // the save, after a reload
  await ev('__park.game.save.flush()');
  res.saveChars = await ev("(localStorage.getItem('lanternfall.game.v1')||'').length");
  await load();
  const back = await ev("(()=>{const g=__park.game;return {lamps:g.modules.lamps.lit(),photos:g.modules.photo.shots.length,rides:(g.save.get('rides',{})||{}).carousel||0,door:!!g.modules.secrets.isFound('doors')}})()");
  ok('save survives a reload', back && back.lamps === 1 && back.photos === 1 && back.rides >= 1 && back.door, back);
  res.errs = [...errs].map(([k, v]) => v + 'x ' + k); ok('no console errors or warnings', !res.errs.length, res.errs);
  res.secs = Math.round((Date.now() - t0) / 1000);
  await browser.close();
  console.log(JSON.stringify(res));
}
if (only !== 'phone') await run(false);
if (only !== 'desktop') await run(true);
console.log(failed ? `FAILED ${failed}` : 'PASS');
process.exit(failed ? 1 : 0);
