// Time trials, end to end. usage: node trials.test.mjs [url] [--only lake,swim,roof,fp,phone] [--shots DIR]
// Wick is driven with scripted input (__park.platformer.test.input) straight at the next checkpoint. A full lake lap
// takes about a minute of real time. Needs puppeteer-core (resolved from a node_modules above this folder).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const args = process.argv.slice(2), BASE = (args[0] && !args[0].startsWith('--') ? args[0] : 'http://127.0.0.1:8906/index.html');
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const only = (opt('only', '') || '').split(',').filter(Boolean), want = (k) => !only.length || only.includes(k);
const SHOTS = opt('shots', '/tmp/claude-1000/-home-zalo/253e908b-4e3c-4d12-a43e-a8b3b88482f6/scratchpad/agents/trials/shots'); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [], fails = [], errs = new Map();
const check = (name, ok, info = '') => { results.push((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails.push(name); };

async function open(mobile, hash = '#weather=clear') {
  const W = mobile ? 390 : 1280, H = mobile ? 844 : 720;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 900000, args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', `--window-size=${W},${H}`] });
  const page = await browser.newPage();
  const add = (k) => errs.set(k, (errs.get(k) || 0) + 1);
  page.on('pageerror', (e) => add('pageerror: ' + e.message.slice(0, 160)));
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall|Context Lost|ReadPixels/.test(m.text())) add(m.type() + ': ' + m.text().slice(0, 160)); });
  page.on('response', (r) => { if (r.status() >= 400) add('http ' + r.status() + ' ' + r.url().slice(-60)); });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.goto(BASE + hash); await page.waitForFunction('window.__park && window.__park.loaded && window.__park.game && window.__park.game.modules.trials', { timeout: 240000 });
  return { browser, page, shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.jpg`, type: 'jpeg', quality: 86 }) };
}
// in the page: wake Wick at (x, y) and wait for him
const wake = (page, x, y, yaw = Math.PI) => page.evaluate(async (x, y, yaw) => {
  __park.setMode('walk', { at: [x, y], yaw }); __park.setPlatformer(true);
  const t0 = performance.now(); while (!(__park.platformer && __park.platformer.active && __park.platformer.S.latest > 5)) { if (performance.now() - t0 > 90000) return 'timeout'; await new Promise((r) => setTimeout(r, 200)); }
  return 'ok';
}, x, y, yaw);
// in the page: steer Wick at the next checkpoint of the running race until it finishes (or `ms` pass); `moves(t, v, cp, n)` may add { a, z, b }
const AGENT = fs.readFileSync(new URL('./trials-agent.mjs', import.meta.url), 'utf8').replace('export function makeAgent', 'window.__makeAgent = function');
const INSTALL = AGENT + `;window.__tr = {
  driveAgent(id, legs, ms) {
    const T = __park.game.modules.trials, pf = __park.platformer, ag = __makeAgent(legs), start = performance.now(); window.__ag = ag;
    return new Promise((res) => {
      let done = false; const fin = (why) => { if (done) return; done = true; pf.test.input = () => ({}); res(why); };
      const off = __park.game.on('trials:finish', () => { off(); fin('finish'); });
      const iv = setInterval(() => { if (!T.race) { clearInterval(iv); fin('cancelled'); } else if (ag.failed) { clearInterval(iv); fin('route failed at leg ' + ag.i + ' ' + JSON.stringify(ag.landed)); } else if (performance.now() - start > ms) { clearInterval(iv); fin('timeout at leg ' + ag.i); } }, 250);
      let lt = 0; pf.test.input = (t, v) => { const r = T.race; if (!r || r.phase !== 'run') return {}; const dt = lt ? Math.min(0.3, t - lt) : 0; lt = t; return ag.step(v.s, dt); };
    });
  },
  log: [], ev: {},
  hook() { const g = __park.game; this.ev = {}; for (const k of ['trials:start', 'trials:checkpoint', 'trials:finish']) g.on(k, (d) => { (this.ev[k] = this.ev[k] || []).push(d); }); },
  drive(id, plan, ms, via) {
    const T = __park.game.modules.trials, pf = __park.platformer, c = T.courses.find((q) => q.id === id), start = performance.now();
    return new Promise((res) => {
      let done = false; const fin = (why) => { if (done) return; done = true; pf.test.input = () => ({}); res(why); };
      const off = __park.game.on('trials:finish', () => { off(); fin('finish'); });
      const iv = setInterval(() => { if (!T.race) { clearInterval(iv); fin('cancelled'); } else if (performance.now() - start > ms) { clearInterval(iv); fin('timeout'); } }, 250);
      let ck = { t: 0, x: 0, z: 0 }, un = { until: -1, sign: 1 };
      pf.test.input = (t, v) => {
        const r = T.race; if (!r || r.phase !== 'run') return {};
        const cp = (via && via[r.n] && !via[r.n].done ? via[r.n] : c.cps[Math.min(r.n, c.cps.length - 1)]);
        let dx = cp[0] - v.pos.x, dz = -cp[1] - v.pos.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        if (t - ck.t > 0.8) { if (Math.hypot(v.pos.x - ck.x, v.pos.z - ck.z) < 1.2 && (v.s.action & 0x1C0) !== 0xC0) { un.until = t + 1.2; un.sign = -un.sign; un.n = (un.n || 0) + 1; } else if (t > un.until) un.n = 0; ck = { t, x: v.pos.x, z: v.pos.z }; }
        let out = { world: [dx, dz] };
        if (t < un.until) { const a = un.sign * Math.min(2.6, 0.8 + 0.5 * (un.n || 1)), c1 = Math.cos(a), s1 = Math.sin(a); out = { world: [dx * c1 - dz * s1, dx * s1 + dz * c1], a: Math.floor(t * 4) % 2 === 0 }; }   // blocked: jump and sidestep
        if ((v.s.action & 0x1C0) === 0xC0) {            // swimming: strokes, and the stick only turns him (a forward push would dive)
          let err = Math.atan2(dx, dz) - v.yaw; err = Math.atan2(Math.sin(err), Math.cos(err));
          out = { a: (t % 0.5) < 0.15, mx: Math.max(-1, Math.min(1, err * 2)) };
        }
        return { ...out, ...(plan ? plan(r.t, v, cp, r.n, l) : {}) };
      };
    });
  },
};`;

if (want('lake')) try {
  const { browser, page, shot } = await open(false);
  await page.evaluate(INSTALL); await page.evaluate('__tr.hook()');
  check('wick wakes', (await wake(page, 100, 12)) === 'ok');
  const T = 'window.__park.game.modules.trials';
  const posts = await page.evaluate(`${T}.courses.map(c => [c.id, c.post])`); check('three start posts defined', posts.length >= 1, JSON.stringify(posts));
  // walk up to the post: the prompt shows, a swing or use starts the race
  await page.evaluate(`__park.platformer.teleport(103.6 - 1.5, 0.12 + 0.2, -9 + 0, 0)`); await sleep(1500);
  const prompt = await page.evaluate(`(() => { const p = document.getElementById('game-prompt'); return p.hidden ? '' : p.textContent; })()`);
  check('prompt at the post', /Race: The Lake Lap/.test(prompt), prompt); await shot('lake_post_prompt');
  const lakeRun = async (n) => {
    await page.evaluate(`__park.platformer.teleport(103.6 - 1.5, 0.3, -9, 0)`); await sleep(1200);
    await page.evaluate('__park.game.use()'); await sleep(500);
    const phase = await page.evaluate(`${T}.race && ${T}.race.phase`); check(`run ${n}: countdown starts`, phase === 'count', String(phase));
    await sleep(2800);
    const ghost = await page.evaluate(`${T}.race && ${T}.race.ghost`); check(`run ${n}: ghost is ${n === 1 ? 'pace' : 'best'}`, ghost === (n === 1 ? 'pace' : 'best'), String(ghost));
    const p = page.evaluate(`__tr.drive('lake', null, 420000)`);
    let shotDone = false; const iv = setInterval(async () => { if (shotDone) return; const r = await page.evaluate(`${T}.race`).catch(() => null); if (r && r.n >= 5 && n === 2) { shotDone = true; await shot('lake_midrace'); } }, 1000);
    const why = await p; clearInterval(iv); return why;
  };
  let why = await lakeRun(1);
  check('run 1 finishes', why === 'finish', why + ' ' + JSON.stringify(await page.evaluate(`[${T}.race, __park.platformer.view.pos.toArray(), __park.game.player.x, __park.game.player.y]`)));
  await shot('lake_finish');
  const ev1 = await page.evaluate('__tr.ev');
  check('events: 1 start, 14 checkpoints, 1 finish', (ev1['trials:start'] || []).length === 1 && (ev1['trials:checkpoint'] || []).length === 14 && (ev1['trials:finish'] || []).length === 1, JSON.stringify(Object.fromEntries(Object.entries(ev1).map(([k, v]) => [k, v.length]))));
  const f1 = (ev1['trials:finish'] || [])[0] || {}; check('finish payload', f1.course === 'lake' && f1.time > 20 && f1.newBest === true, JSON.stringify(f1));
  await sleep(600); const saved2 = await page.evaluate(`JSON.parse(localStorage.getItem('lanternfall.game.v1')).trials`);
  const e = saved2 && saved2.c && saved2.c['lake.w']; check('best saved', !!e && Math.abs(e.t - f1.time) < 0.02, e && `${e.t}s, ghost ${JSON.stringify(e.g).length} bytes, ${e.g.n} samples`);
  check('ghost is compact (under 6 KB)', !!e && JSON.stringify(e.g).length < 6000);
  const dec = await page.evaluate(`(() => { const T = ${T}, b = T.best('lake'); const a = T.decode(b.g); return [a.length / 3, Array.from(a.slice(0, 3)), Array.from(a.slice(a.length - 3))]; })()`);
  check('ghost decodes to the run', dec[0] > 100 && Math.hypot(dec[2][0] - 100.7, dec[2][1] - 3.3) < 12, JSON.stringify(dec));
  // second run: the ghost is your best
  await page.evaluate('__tr.hook()'); await sleep(3000);
  why = await lakeRun(2); check('run 2 finishes', why === 'finish', why + ' ' + JSON.stringify(await page.evaluate(`[${T}.race, __park.platformer.view.pos.toArray()]`)));
  const ev2 = await page.evaluate('__tr.ev'); const f2 = (ev2['trials:finish'] || [])[0] || {};
  check('run 2 payload has best', typeof f2.best === 'number' && f2.best <= f1.time + 0.01, JSON.stringify(f2));
  // cancel by leaving, by the post, by mode
  await page.evaluate(`__park.platformer.teleport(103.6 - 1.5, 0.3, -9, 0)`); await sleep(1000); await page.evaluate('__park.game.use()'); await sleep(3500);
  check('race running', await page.evaluate(`!!${T}.race && ${T}.race.phase === 'run'`));
  await page.evaluate(`__park.platformer.teleport(-60, 0.3, -200, 0)`); await sleep(1800);
  check('far away cancels quietly', await page.evaluate(`!${T}.race`));
  await page.evaluate(`__park.platformer.teleport(103.6 - 1.5, 0.3, -9, 0)`); await sleep(1500); await page.evaluate('__park.game.use()'); await sleep(800);
  await page.evaluate('__park.game.use()'); await sleep(300);
  check('post again cancels', await page.evaluate(`!${T}.race`));
  await page.evaluate('__park.game.use()'); await sleep(500); check('restarts', await page.evaluate(`!!${T}.race`));
  await page.evaluate(`__park.setMode('orbit')`); await sleep(500);
  check('mode change cancels', await page.evaluate(`!${T}.race`));
  await browser.close();
} catch (e) { check('lake section ran', false, e.message.slice(0, 200)); }

// a Wick-only course: stand at the post, start with the prompt, drive it, check the events and the saved best
async function wickCourse(id, label, postXY, { via, ms = 420000, shotMid, legs, at } = {}) {
  const { browser, page, shot } = await open(false);
  try {
    await page.evaluate(INSTALL); await page.evaluate('__tr.hook()');
    check(`${label}: wick wakes`, (await wake(page, postXY[0] + 3, postXY[1] + 3)) === 'ok');
    const T = 'window.__park.game.modules.trials';
    const st = at || [postXY[0] - 1.5, postXY[1]]; await page.evaluate(`__park.platformer.teleport(${st[0]}, 0.3, ${-st[1]}, 0)`); await sleep(1500);
    const prompt = await page.evaluate(`(() => { const p = document.getElementById('game-prompt'); return p.hidden ? '' : p.textContent; })()`);
    check(`${label}: prompt at the post`, /Race: /.test(prompt), prompt); await shot(`${id}_post_prompt`);
    await page.evaluate('__park.game.use()'); await sleep(3200);
    let shotDone = false; const iv = setInterval(async () => { if (shotDone || !shotMid) return; const r = await page.evaluate(`${T}.race`).catch(() => null); if (r && r.n >= shotMid) { shotDone = true; await shot(`${id}_midrace`); } }, 700);
    const why = legs ? await page.evaluate(`__tr.driveAgent('${id}', ${JSON.stringify(legs)}, ${ms})`) : await page.evaluate(`__tr.drive('${id}', null, ${ms}, ${JSON.stringify(via || null)})`); clearInterval(iv);
    const info = await page.evaluate(`[${T}.race, __park.platformer.view.pos.toArray()]`);
    check(`${label}: finishes`, why === 'finish', why + ' ' + JSON.stringify(info));
    const ev = await page.evaluate('__tr.ev'), n = ev['trials:checkpoint'] ? ev['trials:checkpoint'].length : 0, f = (ev['trials:finish'] || [])[0] || {};
    check(`${label}: events`, (ev['trials:start'] || []).length === 1 && (ev['trials:finish'] || []).length === 1 && n === (await page.evaluate(`${T}.courses.find(c => c.id === '${id}').cps.length`)), JSON.stringify(f));
    await sleep(600); await shot(`${id}_finish`);
    check(`${label}: best saved`, await page.evaluate(`!!${T}.best('${id}')`));
    await browser.close(); return f;
  } catch (e) { check(`${label}: ran`, false, e.message.slice(0, 200)); await browser.close(); }
}
if (want('roof')) await wickCourse('roof', 'rooftops', [28.3, 98.8], { at: [30, 98], shotMid: 5, legs: JSON.parse(fs.readFileSync(new URL('./trials-roof.json', import.meta.url), 'utf8')), ms: 300000 });
if (want('swim')) await wickCourse('swim', 'swim', [100.4, -8], { shotMid: 3 });

// first person (#fp): the prompt carries the key, a race runs through the checkpoints, the best is kept as a first-person time
if (want('fp')) {
  const { browser, page, shot } = await open(false, '#fp&weather=clear');
  try {
    const T = 'window.__park.game.modules.trials';
    await page.evaluate(`__park.setMode('walk', { at: [102, 9], yaw: 0 })`); await sleep(1800);
    check('fp: not Wick', await page.evaluate('!__park.game.player.wick'));
    const prompt = await page.evaluate(`(() => { const p = document.getElementById('game-prompt'); return p.hidden ? '' : p.textContent; })()`);
    check('fp: prompt with the key', /Race: The Lake Lap.*E/.test(prompt), prompt); await shot('fp_post_prompt');
    await page.evaluate('__tr = { n: 0 }; __park.game.on("trials:checkpoint", () => __tr.n++); __park.game.on("trials:finish", (d) => { __tr.fin = d; })');
    await page.keyboard.press('KeyE'); await sleep(2500);
    const r0 = await page.evaluate(`${T}.race`); check('fp: race starts with E', !!r0 && r0.style === 'f', JSON.stringify(r0));
    const cps = await page.evaluate(`${T}.courses.find(c => c.id === 'lake').cps`);
    await sleep(3500);
    for (const c of cps) { await page.evaluate(`__park.setMode('walk', { at: [${c[0]}, ${c[1]}], yaw: 0 })`); await sleep(500); if (c === cps[4]) await shot('fp_midrace'); }
    await sleep(600);
    const fin = await page.evaluate('__tr.fin'); check('fp: finishes through all checkpoints', !!fin && fin.style === 'f' && (await page.evaluate('__tr.n')) === 14, JSON.stringify(fin));
    await sleep(600); check('fp: first-person best saved apart', await page.evaluate(`!!${T}.best('lake', 'f') && !${T}.best('lake', 'w')`));
    await page.evaluate(`__park.setMode('walk', { at: [102, 9], yaw: 0 })`); await sleep(1500);
    await page.keyboard.press('KeyE'); await sleep(800); check('fp: starts again', await page.evaluate(`!!${T}.race`));
    await page.keyboard.press('KeyE'); await sleep(500); check('fp: the post cancels', await page.evaluate(`!${T}.race`));
    await page.keyboard.press('KeyE'); await sleep(500); await page.evaluate(`__park.setMode('orbit')`); await sleep(500); check('fp: mode change cancels', await page.evaluate(`!${T}.race`));
  } catch (e) { check('fp: ran', false, e.message.slice(0, 200)); }
  await browser.close();
}

// the 390x844 touch layout: prompt, tap to start, tracker clear of the other interface, journal section, cancel
if (want('phone')) {
  const { browser, page, shot } = await open(true);
  try {
    const T = 'window.__park.game.modules.trials';
    await page.evaluate(INSTALL);
    check('phone: wick wakes', (await wake(page, 100, 12)) === 'ok');
    await page.evaluate(`__park.platformer.teleport(102.1, 0.3, -9, 0)`); await sleep(1800);
    const prompt = await page.evaluate(`(() => { const p = document.getElementById('game-prompt'); return p.hidden ? '' : p.textContent; })()`);
    check('phone: prompt at the post', /Race: The Lake Lap/.test(prompt), prompt); await shot('phone_post_prompt');
    await page.tap('#game-prompt'); await sleep(1200); await shot('phone_countdown');
    check('phone: tap starts the race', await page.evaluate(`!!${T}.race`));
    await sleep(3500);
    await page.evaluate(`__park.platformer.teleport(60, 0.3, -52, 0)`); await sleep(1500);
    await shot('phone_midrace');
    const box = await page.evaluate(`(() => { const r = (id) => { const e = document.getElementById(id); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom].map(Math.round); }; return { track: r('game-track'), prompt: r('game-prompt'), toasts: r('game-toasts') }; })()`);
    check('phone: tracker line shows', !!box.track && /Lake Lap/.test(await page.evaluate(`document.getElementById('game-track').textContent`)), JSON.stringify(box));
    await page.evaluate(`__park.platformer.teleport(102.1, 0.3, -9, 0)`); await sleep(1500);
    await page.tap('#game-prompt'); await sleep(500); check('phone: tap on the post cancels', await page.evaluate(`!${T}.race`));
    await page.evaluate(`__park.game.save.update('trials', (s) => { s.c['lake.w'] = { runs: 3, t: 83.4, sp: [], g: { n: 1, k: [0, 0, 0], d: '' }, m: 1 }; s.c['swim.w'] = { runs: 1, t: 47.2, sp: [], g: { n: 1, k: [0, 0, 0], d: '' }, m: 2 }; return s; }, { c: {} })`);
    await page.evaluate('__park.game.journal.open()'); await sleep(900); await shot('phone_journal');
    const jt = await page.evaluate(`document.querySelector('#game-journal').textContent`);
    check('phone: journal lists courses with times and posts', /Trials/.test(jt) && /1:23\.4/.test(jt) && /Silver/.test(jt) && /0:47\.2/.test(jt) && /Start post/.test(jt), jt.slice(0, 200));
  } catch (e) { check('phone: ran', false, e.message.slice(0, 200)); }
  await browser.close();
}

console.log(results.join('\n'));
const errl = [...errs].map(([k, v]) => v + 'x ' + k);
console.log(JSON.stringify({ fails, errs: errl }));
process.exit(fails.length ? 1 : 0);
