// End-to-end test of fx/game/rides: the monorail, the harbor cruise and the carousel riders, on desktop and on the 390x844 touch layout.
//   node rides.test.mjs [url] [--quick] [--mobile-only|--desktop-only]
// Needs puppeteer-core (resolved from this folder or any parent) and a system Chromium; the viewer served over http (python3 -m http.server).
// --quick skips the natural ends of the rides (the monorail lap is about 105 s, the cruise about 165 s, the carousel 60 s).
// Screenshots go to $OUT (default /tmp/rides-test); look at them: the view from the train should show the park ahead.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const args = process.argv.slice(2), URL = args.find((a) => a.startsWith('http')) || 'http://127.0.0.1:8907/index.html', QUICK = args.includes('--quick');
const OUT = process.env.OUT || '/tmp/rides-test'; fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const errs = new Map();
const check = (name, pass, detail = '') => { results.push({ name, pass: !!pass, detail }); console.log((pass ? 'ok   ' : 'FAIL ') + name + (detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); };

async function run(mobile, fp) {
  const tag = (mobile ? 'phone' : 'desk') + (fp ? '-fp' : '-wick'), W = mobile ? 390 : 1280, H = mobile ? 844 : 720;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', `--window-size=${W},${H}`] });
  const page = await browser.newPage();
  const add = (k) => errs.set(tag + ' ' + k, (errs.get(tag + ' ' + k) || 0) + 1);
  page.on('pageerror', (e) => add('pageerror: ' + e.message.slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') add(m.type() + ': ' + m.text().slice(0, 160)); });
  page.on('response', (r) => { if (r.status() >= 400) add('http ' + r.status() + ' ' + r.url().slice(-60)); });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  await page.goto(URL + '#weather=clear' + (fp ? '&fp' : ''));
  await page.waitForFunction('window.__park && window.__park.loaded && window.__park.game && window.__park.game.modules.rides', { timeout: 240000 });
  const ev = (js) => page.evaluate(js);
  const until = async (cond, ms, what) => { try { await page.waitForFunction(cond, { timeout: ms, polling: 250 }); return true; } catch (e) { check(what + ' (timed out)', false); return false; } };
  const shot = (name) => page.screenshot({ path: `${OUT}/${tag}-${name}.jpg`, type: 'jpeg', quality: 80 });
  await ev(`window.__ev = []; const g = __park.game; for (const t of ['rides:board', 'rides:leave']) g.on(t, (d) => __ev.push([t, d.ride, d.why || '']));
    window.__fwd = () => { const d = new g.THREE.Vector3(); __park.camera.getWorldDirection(d); return d; };`);
  await wait(1500);

  const tap = async (sel) => {                      // a real click or touch on an element's centre
    const b = await (await page.$(sel)).boundingBox(); const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (mobile) await page.touchscreen.tap(x, y); else { await page.mouse.move(x, y); await page.mouse.click(x, y); }
  };
  const drag = async (dx) => {                      // look round: drag the canvas horizontally by dx px
    const y = H * 0.4, x0 = W / 2;
    if (mobile) { await page.touchscreen.touchStart(x0, y); for (let i = 1; i <= 8; i++) { await page.touchscreen.touchMove(x0 + dx * i / 8, y); await wait(30); } await page.touchscreen.touchEnd(); }
    else { await page.mouse.move(x0, y); await page.mouse.down(); for (let i = 1; i <= 8; i++) { await page.mouse.move(x0 + dx * i / 8, y); await wait(30); } await page.mouse.up(); }
  };
  const use = async () => { if (fp && !mobile) { await page.keyboard.press('KeyE'); } else await tap('#game-prompt'); };
  const standAt = async (x, y, z, yaw) => { await ev(`__park.setMode('walk',{at:[${x},${y}],yaw:${yaw}}); ${z > 1 ? `__park.walk.z = __park.walk.cz = ${z};` : ''}`); await wait(2200); };
  const player = () => ev('(() => { const p = __park.game.player; return [p.x, p.y, p.z, p.mode, p.wick]; })()');
  const held = () => ev('__park.game.cameraHeld');
  const walkerWorks = async (back = false) => {     // move a few metres with scripted input, as Wick or as the first-person walker
    const wick = await ev('!!(__park.platformer && __park.platformer.active)');
    if (wick) {
      const p0 = await ev('__park.platformer.view.pos.toArray()');
      await ev(`__park.platformer.test.input = () => ({ mx: 0, my: ${back ? -1 : 1}, a: false, b: false, z: false })`); await wait(1800);
      const p1 = await ev('__park.platformer.view.pos.toArray()'); await ev('__park.platformer.test.input = null');
      const d = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]); check(tag + ' Wick moves again', d > 1.5, +d.toFixed(2)); return;
    }
    const p0 = await ev('[__park.walk.x, __park.walk.y]');
    if (mobile) { await page.touchscreen.touchStart(80, 560); await wait(60); await page.touchscreen.touchMove(80, back ? 612 : 508); await wait(1500); await page.touchscreen.touchEnd(); }
    else { await page.mouse.click(W / 2, H / 3).catch(() => {}); await page.keyboard.down(back ? 'KeyS' : 'KeyW'); await wait(1500); await page.keyboard.up(back ? 'KeyS' : 'KeyW'); }
    const p1 = await ev('[__park.walk.x, __park.walk.y]'); const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]); check(tag + ' walker moves again', d > 1.2, +d.toFixed(2));
  };
  const trackText = () => ev('document.querySelector("#game-track").innerText.replace(/\\n/g, " ")');

  // ───────────────────────── monorail ─────────────────────────
  const mono = await ev('(() => { const r = __park.game.modules.rides.monorail; return { x: r.board.x, y: r.board.y, z: r.board.z, yaw: r.faceYaw }; })()');
  await standAt(mono.x, mono.y, mono.z, mono.yaw);
  let pr = await ev('(() => { const e = document.querySelector("#game-prompt"); return [e.hidden, e.textContent]; })()');
  check(tag + ' monorail prompt', !pr[0] && /Board the monorail/.test(pr[1]), pr[1]);
  const pl = await player(); check(tag + ' standing on the platform', Math.abs(pl[2] - 10) < 0.6, pl[2]);
  await shot('0-platform');
  await use();
  check(tag + ' camera borrowed', await until('__park.game.cameraHeld === "rides"', 4000, tag + ' board'));
  await wait(1200);
  const t1 = await trackText(); check(tag + ' waiting text', /next train is \d+ seconds away|train is coming in/.test(t1), t1);
  const wickHidden = await ev('(() => { const g = __park.platformer && __park.platformer.character && __park.platformer.character.group; return g ? g.visible : "n/a"; })()');
  check(tag + ' Wick hidden while riding', wickHidden === false || wickHidden === 'n/a', wickHidden);
  await shot('1-waiting');
  if (await until('(() => { const r = __park.game.modules.rides.monorail.run; return !!r && r.phase === "ride"; })()', 100000, tag + ' train arrives')) {
    await wait(1500);
    check(tag + ' board event', await ev('__ev.some((e) => e[0] === "rides:board" && e[1] === "monorail")'));
    const s = []; for (let i = 0; i < 5; i++) { s.push(await ev('(() => { const f = __fwd(), c = __park.camera.position; return [c.x, c.y, c.z, f.x, f.y, f.z]; })()')); await wait(i === 0 ? 1000 : 4500); }
    const dist = Math.hypot(s[4][0] - s[0][0], s[4][2] - s[0][2]);
    check(tag + ' moving along the track', dist > 60, `${dist.toFixed(0)} m in about 19 s`);
    check(tag + ' camera height on the train', s.every((p) => p[1] > 11.8 && p[1] < 14.2), s.map((p) => +p[1].toFixed(2)));
    const v = [s[2][0] - s[1][0], s[2][2] - s[1][2]], vl = Math.hypot(...v), al = Math.hypot(s[1][3], s[1][5]);
    check(tag + ' looking forward along the track', (v[0] * s[1][3] + v[1] * s[1][5]) / (vl * al) > 0.85, +((v[0] * s[1][3] + v[1] * s[1][5]) / (vl * al)).toFixed(2));
    check(tag + ' tracker names the land', /over /.test(await trackText()), await trackText());
    await shot('2-ride');
    const f0 = await ev('(() => { const f = __fwd(); return Math.atan2(f.x, f.z); })()');
    await drag(mobile ? 220 : 300); await wait(300);
    const f1 = await ev('(() => { const f = __fwd(); return Math.atan2(f.x, f.z); })()');
    let dy = Math.abs(f1 - f0); if (dy > Math.PI) dy = 2 * Math.PI - dy;
    check(tag + ' drag looks round', dy > 0.25, +dy.toFixed(2)); await shot('3-looking');
    await drag(mobile ? -220 : -300);
    await wait(2500);
    // early exit
    await tap('#rides-leave'); await until('!__park.game.cameraHeld', 8000, tag + ' get off');
    await wait(500);
    const p = await player(); check(tag + ' back on the platform', Math.hypot(p[0] - mono.x, p[1] - mono.y) < 1.5 && Math.abs(p[2] - 10) < 0.7 && p[3] === 'walk', p.map((v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
    check(tag + ' leave event', await ev('__ev.some((e) => e[0] === "rides:leave" && e[1] === "monorail" && e[2] === "button")'));
    check(tag + ' tracker line gone', !/monorail/i.test(await trackText()));
    await shot('4-after');
    await walkerWorks();
  }

  // ───────────────────────── cruise ─────────────────────────
  const cr = await ev('(() => { const r = __park.game.modules.rides.cruise; return r ? { x: r.board.x, y: r.board.y, z: r.board.z, len: r.length } : null; })()');
  check(tag + ' cruise present', !!cr);
  if (cr) {
    await standAt(cr.x, cr.y, 0, 0);
    pr = await ev('(() => { const e = document.querySelector("#game-prompt"); return [e.hidden, e.textContent]; })()');
    check(tag + ' cruise prompt', !pr[0] && /Take the harbor cruise/.test(pr[1]), pr[1]);
    await shot('5-jetty');
    await use();
    check(tag + ' cruise camera borrowed', await until('__park.game.cameraHeld === "rides"', 4000, tag + ' cruise board'));
    await wait(2500);
    const q = []; for (let i = 0; i < 4; i++) { q.push(await ev('(() => { const c = __park.camera.position; return [c.x, c.y, c.z, Math.hypot(c.x, c.z)]; })()')); await wait(5000); }
    check(tag + ' boat under way, towards the Spire', q[3][3] < q[0][3] - 8, q.map((p) => +p[3].toFixed(1)));
    check(tag + ' camera at water level in the boat', q.every((p) => p[1] > 0.2 && p[1] < 2.2), q.map((p) => +p[1].toFixed(2)));
    check(tag + ' tracker', /Harbor cruise/.test(await trackText()), await trackText());
    await shot('6-cruise');
    await drag(mobile ? 200 : 280); await wait(300); await shot('7-cruise-look'); await drag(mobile ? -200 : -280);
    await tap('#rides-leave'); await until('!__park.game.cameraHeld', 8000, tag + ' cruise leave'); await wait(500);
    const p = await player(); check(tag + ' back at the jetty', Math.hypot(p[0] - cr.x, p[1] - cr.y) < 2 && p[3] === 'walk', p.map((v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
    const bp = await ev('(() => { const b = __park.game.modules.rides.cruise.boat.position; return [b.x, b.z]; })()');
    await wait(1000); const bp2 = await ev('(() => { const b = __park.game.modules.rides.cruise.boat.position; return [b.x, b.z]; })()');
    check(tag + ' boat rests at the jetty', Math.hypot(bp2[0] - bp[0], bp2[1] - bp[1]) < 0.3 && Math.hypot(bp[0] - cr.x, -bp[1] - cr.y) < 12, bp.map((v) => +v.toFixed(1)));
    await walkerWorks(true);
  }

  // ───────────────────────── carousel ─────────────────────────
  const car = await ev('(() => { const c = __park.game.modules.rides.carousel; return c ? { x: c.board.x, y: c.board.y } : null; })()');
  check(tag + ' carousel present', !!car);
  if (car) {
    const cx = -135.04, cy = -125.18;
    await standAt(cx + 14.5, cy + 3, 0, Math.atan2(-3, -14.5)); await wait(500);
    const poses = []; for (let i = 0; i < 3; i++) { await shot(`8-carousel-${i}`); poses.push(await ev('(() => { const c = __park.game.modules.rides.carousel, f = __park.game.ctx.getFx().animated.uniforms, o = []; for (let i = 0; i < c.seats.length; i++) { const h = c.horse(i, f.uFxTime.value, f.uFxMotion.value); o.push([h.p.x, h.p.y, h.p.z]); } const m = c.mesh, M = new __park.game.THREE.Matrix4(), v = new __park.game.THREE.Vector3(), r = []; for (let i = 0; i < c.seats.length; i++) { m.getMatrixAt(i, M); v.setFromMatrixPosition(M); r.push([v.x, v.y, v.z]); } return { t: f.uFxTime.value, horses: o, riders: r, vis: m.visible, n: m.count }; })()')); await wait(1000); }
    const dev = Math.max(...poses.map((p) => Math.max(...p.horses.map((h, i) => Math.hypot(h[0] - p.riders[i][0], h[2] - p.riders[i][2]) + Math.abs(h[1] - p.riders[i][1])))));
    check(tag + ' twelve riders, visible', poses[0].n === 12 && poses[0].vis, poses[0].n);
    check(tag + ' riders on their horses (matrix = horse pose, within one frame)', dev < 0.5, +dev.toFixed(3));
    // they really turn: the angle of rider 0 about the carousel centre advances by 0.24 rad/s, and the height moves
    const ang = (p) => Math.atan2(p.riders[0][2] - 125.18, p.riders[0][0] + 135.04); let da = ang(poses[2]) - ang(poses[0]); da = ((da + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const dt = poses[2].t - poses[0].t; check(tag + ' riders turn with the carousel', Math.abs(da / dt - 0.24) < 0.03, +(da / dt).toFixed(3));
    check(tag + ' riders rise and fall', new Set(poses.map((p) => p.riders[0][1].toFixed(2))).size === 3, poses.map((p) => +p.riders[0][1].toFixed(2)));
    pr = await ev('(() => { const e = document.querySelector("#game-prompt"); return [e.hidden, e.textContent]; })()');
    await standAt(car.x, car.y, 0.7, Math.atan2(cy - car.y, cx - car.x));
    pr = await ev('(() => { const e = document.querySelector("#game-prompt"); return [e.hidden, e.textContent]; })()');
    check(tag + ' carousel prompt', !pr[0] && /Ride the carousel/.test(pr[1]), pr[1]);
    await use(); check(tag + ' carousel camera borrowed', await until('__park.game.cameraHeld === "rides"', 4000, tag + ' carousel board'));
    await wait(2500);
    const r1 = await ev('(() => { const c = __park.camera.position; return [Math.hypot(c.x + 135.04, c.z - 125.18), c.y, Math.atan2(c.z - 125.18, c.x + 135.04)]; })()'); await wait(2000);
    const r2 = await ev('(() => { const c = __park.camera.position; return [Math.hypot(c.x + 135.04, c.z - 125.18), c.y, Math.atan2(c.z - 125.18, c.x + 135.04)]; })()');
    check(tag + ' on a horse, going round', Math.abs(r1[0] - 8.15) < 0.6 && Math.abs(r2[2] - r1[2]) > 0.2, `${r1[0].toFixed(2)} m out, ${(r2[2] - r1[2]).toFixed(2)} rad in 2 s`);
    await shot('9-carousel-ride');
    if (!QUICK && !mobile && !fp) {
      check(tag + ' carousel ends by itself', await until('!__park.game.cameraHeld', 75000, tag + ' carousel natural end'));
      await wait(500); check(tag + ' leave event (done)', await ev('__ev.some((e) => e[0] === "rides:leave" && e[1] === "carousel" && e[2] === "done")'));
    } else { await tap('#rides-leave'); await until('!__park.game.cameraHeld', 8000, tag + ' carousel leave'); }
    await wait(500); const p = await player(); check(tag + ' back at the carousel edge', Math.hypot(p[0] - car.x, p[1] - car.y) < 2 && p[3] === 'walk', p.map((v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
    check(tag + ' counts saved', await ev('(() => { const s = __park.game.save.get("rides", {}); return s.monorail >= 1 && s.cruise >= 1 && s.carousel >= 1; })()'));
  }

  // ───────────────────────── modes during a ride, Tour and Explore ─────────────────────────
  await standAt(mono.x, mono.y, mono.z, mono.yaw); await use(); await until('__park.game.cameraHeld === "rides"', 4000, tag + ' board for mode test'); await wait(1500);
  await ev("document.querySelector('#m-tour').click()"); await wait(1500);
  check(tag + ' Tour ends the ride cleanly', !(await held()) && (await ev('__park.mode')) === 'tour' && !(await ev('document.querySelector("#rides-leave") && !document.querySelector("#rides-leave").hidden')));
  const c0 = await ev('__park.camera.position.toArray()'); await wait(2500); const c1 = await ev('__park.camera.position.toArray()');
  check(tag + ' Tour flies on', Math.hypot(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]) > 1, +Math.hypot(c1[0] - c0[0], c1[2] - c0[2]).toFixed(1));
  await ev("document.querySelector('#m-orbit').click()"); await wait(2500); check(tag + ' Explore works', (await ev('__park.mode')) === 'orbit' && !(await held()));
  await ev("document.querySelector('#m-walk').click()"); await wait(2500);
  const gv = await ev('(() => { const g = __park.platformer && __park.platformer.character && __park.platformer.character.group; return [__park.mode, g ? g.visible : "n/a", __park.platformer ? __park.platformer.active : "n/a"]; })()');
  check(tag + ' back in Walk after Tour/Explore', gv[0] === 'walk' && (fp || gv[1] === true || gv[1] === 'n/a'), gv);
  await standAt(288, 0, 0, Math.PI); await walkerWorks();     // an open spot: where Walk drops you after Tour is arbitrary
  check(tag + ' camera near plane restored', await ev('__park.camera.near') >= 0.2, await ev('__park.camera.near'));

  // natural end of the lap, once (desktop, Wick)
  if (!QUICK && !mobile && !fp) {
    await standAt(mono.x, mono.y, mono.z, mono.yaw); await use();
    if (await until('(() => { const r = __park.game.modules.rides.monorail.run; return !!r && r.phase === "ride"; })()', 100000, 'natural lap: arrive')) {
      const t0 = Date.now(); check('natural lap ends by itself at the station', await until('!__park.game.cameraHeld', 150000, 'natural lap end'), `${((Date.now() - t0) / 1000).toFixed(0)} s`);
      await wait(600); const p = await player(); check('natural lap: walker at the platform', Math.hypot(p[0] - mono.x, p[1] - mono.y) < 1.5 && Math.abs(p[2] - 10) < 0.7, p.map((v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
      check('natural lap: leave event (done)', await ev('__ev.some((e) => e[0] === "rides:leave" && e[1] === "monorail" && e[2] === "done")'));
    }
    if (cr) {
      await standAt(cr.x, cr.y, 0, 0); await use(); await until('__park.game.cameraHeld === "rides"', 4000, 'cruise again'); const t0 = Date.now();
      check('natural cruise ends by itself', await until('!__park.game.cameraHeld', 240000, 'natural cruise end'), `${((Date.now() - t0) / 1000).toFixed(0)} s`);
      await wait(600); const p = await player(); check('natural cruise: walker at the jetty', Math.hypot(p[0] - cr.x, p[1] - cr.y) < 2, p.map((v) => +v.toFixed(2)));
      check('natural cruise: leave event (done)', await ev('__ev.some((e) => e[0] === "rides:leave" && e[1] === "cruise" && e[2] === "done")'));
    }
  }
  await browser.close();
}

const only = args.includes('--mobile-only') ? 'm' : args.includes('--desktop-only') ? 'd' : '';
if (only !== 'm') { await run(false, false); await run(false, true); }
if (only !== 'd') await run(true, false);
const fails = results.filter((r) => !r.pass);
console.log(JSON.stringify({ checks: results.length, failed: fails.map((f) => f.name), errs: [...errs].map(([k, v]) => v + 'x ' + k) }));
process.exit(fails.length ? 1 : 0);
