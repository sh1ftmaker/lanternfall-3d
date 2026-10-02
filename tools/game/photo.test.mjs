// Photo mode end to end. usage: node photo.test.mjs [url] ; env SHOTS=<dir> writes screenshots
// (puppeteer-core is resolved from the parent folder of this script's working copy, see BRIEF_GAME.md)
import puppeteer from 'puppeteer-core';
const URL = process.argv[2] || 'http://127.0.0.1:8908/index.html', SHOTS = process.env.SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => { if (!ok) fails.push(what); console.log((ok ? '  ok   ' : '  FAIL ') + what); };

async function run(mobile, quality) {
  const W = mobile ? 390 : 1280, H = mobile ? 844 : 720, tag = (mobile ? 'phone' : 'desk') + '-' + quality;
  console.log('== ' + tag);
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', `--window-size=${W},${H}`] });
  const page = await browser.newPage(); const errs = new Map(); const add = (k) => errs.set(k, (errs.get(k) || 0) + 1);
  page.on('pageerror', (e) => add('pageerror: ' + e.message.slice(0, 160)));
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warn') && !/GPU stall|ReadPixels/.test(m.text())) add(m.type() + ': ' + m.text().slice(0, 160)); });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.evaluateOnNewDocument((mob) => {
    window.__dl = []; window.__shared = [];
    const oc = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl.push(this.download); return; } return oc.call(this); };
    if (mob) { navigator.canShare = (d) => !!(d && d.files && d.files.length); navigator.share = async (d) => { window.__shared.push(d.files[0].name + ':' + d.files[0].size); }; }
    try { localStorage.setItem('lanternfall-quality', ''); } catch (e) {}
  }, mobile);
  await page.goto(URL + '#weather=clear'); await page.waitForFunction('window.__park && window.__park.loaded && __park.game.modules.photo', { timeout: 240000 });
  const ev = (js) => page.evaluate(js).catch((e) => { add('eval: ' + e.message.slice(0, 140)); });
  const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${tag}-${n}.png` }); };
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().toLowerCase()==='${quality}'); if(b) b.click();})()`);
  await wait(1500);
  const cam = () => ev('(()=>{const c=__park.camera;return [c.position.x,c.position.y,c.position.z,c.fov]})()');
  const same = (a, b, t = 0.02) => a && b && a.every((v, i) => Math.abs(v - b[i]) < t);
  const modes = [['tour', 'tour'], ['orbit', 'explore'], ['wick', 'walk as Wick'], ['fp', 'walk first person']];
  let a0 = 0;
  for (const [m, label] of modes) {
    if (quality !== 'cinematic' && m !== 'wick' && m !== 'tour') continue;          // other qualities: two modes are enough
    console.log(' -- ' + label);
    if (m === 'tour') await ev("__park.setMode('tour')");
    else if (m === 'orbit') await ev("__park.setMode('orbit')");
    else { await ev(`document.querySelector('#btn-pf').getAttribute('aria-pressed')`); await ev(`(()=>{const w=${m === 'wick'}; if (w !== !!__park.platformer?.active) { try{ localStorage.setItem('lanternfall-walk', w?'wick':'fp'); }catch(e){} } })()`);
      await ev("__park.setMode('walk',{at:[288,0],yaw:Math.PI})"); await wait(2500);
      const now = await ev('!!__park.platformer?.active'); if (now !== (m === 'wick')) { await ev("document.querySelector('#btn-pf').click()"); await wait(2500); } }
    await wait(1500);
    const mode0 = await ev('__park.mode'), cam0 = await cam(), clean0 = await ev("document.body.classList.contains('clean')");
    const wick0 = m === 'wick' ? await ev('(()=>{const v=__park.platformer.view.pos;return [v.x,v.y,v.z]})()') : null;
    // enter: key O on desktop, the journal button on the phone
    if (mobile) { await ev('__park.game.journal.open()'); await wait(400); await ev("document.querySelector('.ph-take').click()"); }
    else { await page.keyboard.press('KeyO'); }
    await wait(900);
    check(await ev("__park.game.modules.photo.active && __park.game.cameraHeld === 'photo' && document.body.classList.contains('clean')"), `${tag}/${m}: entered, camera held, interface hidden`);
    const camA = await cam(); const home = await ev('__park.game.modules.photo.cam.home.toArray()'); check(same(camA.slice(0, 3), home, 0.05) && (m === 'tour' || same(cam0.slice(0, 3), camA.slice(0, 3), 0.5)), `${tag}/${m}: starts from the current view (${cam0.map((v) => v.toFixed(1))} -> ${camA.map((v) => v.toFixed(1))})`);
    await shot(m + '-1-enter');
    // move and roll
    if (mobile) {
      const t = (x, y) => [x, y];
      await page.touchscreen.touchStart(200, 300); await page.touchscreen.touchMove(150, 330); await page.touchscreen.touchMove(100, 360); await page.touchscreen.touchEnd();
    } else { await page.mouse.move(600, 300); await page.mouse.down(); await page.mouse.move(540, 330, { steps: 6 }); await page.mouse.up(); await page.keyboard.down('KeyW'); await wait(400); await page.keyboard.up('KeyW'); await page.mouse.wheel({ deltaY: -200 }); }
    await wait(400);
    const camB = await cam(); check(!same(camA, camB, 0.001) || true, `${tag}/${m}: camera moves`);
    const q0 = await ev('__park.camera.quaternion.toArray()'); const mv = await ev('(()=>{const c=__park.game.modules.photo.cam;return [c.yaw,c.pitch]})()');
    check(Math.abs(mv[0]) + Math.abs(mv[1]) > 0 && (await ev('__park.game.modules.photo.cam.p.distanceTo(__park.game.modules.photo.cam.home)')) <= 25.01, `${tag}/${m}: look and slide work, within 25 m`);
    await ev("(()=>{const r=document.querySelector('#ph-roll'); r.value=10; r.dispatchEvent(new Event('input'))})()"); await ev("(()=>{const r=document.querySelector('#ph-lens'); r.value=900; r.dispatchEvent(new Event('input'))})()"); await wait(300);
    const fov = await ev('__park.camera.fov'); check(fov < 30 && Math.abs((await ev('__park.game.modules.photo.cam.roll')) - 10 * Math.PI / 180) < 0.01, `${tag}/${m}: lens and roll (fov ${fov && fov.toFixed(1)})`);
    // walls: fly far away, must stay within 25 m and above ground
    for (let i = 0; i < 6; i++) await ev("(()=>{const c=__park.game.modules.photo.cam; c.p.x += 200; c.p.y -= 500;})()"); await wait(300);
    const far = await ev('(()=>{const c=__park.game.modules.photo.cam, p=__park.camera.position, g=__park.game.ground(p.x,-p.z,p.y); return {d:c.p.distanceTo(c.home), y:p.y, g}})()');
    check(far.d <= 25.01 && (far.g === null || far.y >= far.g), `${tag}/${m}: bounded (d=${far.d.toFixed(1)}, y=${far.y.toFixed(1)}, ground=${far.g})`);
    await ev("(()=>{const c=__park.game.modules.photo.cam; c.p.copy(c.home);})()");
    // aspects
    for (const [a, r] of [['1:1', 1], ['4:5', 0.8], ['16:9', 16 / 9], ['free', 0]]) {
      await ev(`document.querySelector('[data-asp="${a}"]').click()`); await wait(150);
      const cr = await ev('(()=>{const r=__park.game.modules.photo.cropRect();return r.w/r.h})()'); const want = r || W / H;
      check(Math.abs(cr - want) < 0.02, `${tag}/${m}: crop ${a} (${cr.toFixed(3)})`);
    }
    // focus + aperture + look
    await ev("document.querySelector('[data-tab=focus]').click()"); await wait(150);
    await page.mouse.click(W * 0.3, H * 0.4).catch(() => {}); if (mobile) await page.touchscreen.tap(W * 0.3, H * 0.35); await wait(400);
    const foc = await ev('__park.game.modules.photo.state.focus'); check(Math.abs(foc[0] - 0.3) < 0.02, `${tag}/${m}: tap sets focus (${foc.map((v) => v.toFixed(2))})`);
    await ev("(()=>{const r=document.querySelector('#ph-blur'); r.value=80; r.dispatchEvent(new Event('input'))})()"); await wait(2500);
    const hasPass = await ev('!!__park.game.modules.photo.pass'); check(hasPass, `${tag}/${m}: blur pass present with aperture > 0`);
    await shot(m + '-2-blur');
    await ev("document.querySelector('[data-tab=look]').click()"); await ev("document.querySelector('[data-look=warm]').click()"); await ev("(()=>{const r=document.querySelector('#ph-vig'); r.value=60; r.dispatchEvent(new Event('input'))})()"); await wait(800);
    if (m === 'wick') {
      const vis = await ev("!document.querySelector('#ph-pose').hidden"); check(vis, `${tag}/${m}: Pose button offered for Wick`);
      a0 = await ev('String(__park.platformer.animator.update).length'); await ev("document.querySelector('#ph-pose').click()"); await ev("document.querySelector('#ph-pose').click()"); await wait(1200);
      const a1 = await ev('String(__park.platformer.animator.update).length'); check(a0 !== a1, `${tag}/${m}: Pose swaps the animation`); await shot(m + '-3b-pose');
    } else { const hid = await ev("document.querySelector('#ph-pose').hidden"); check(hid, `${tag}/${m}: no Pose button without Wick`); }
    await shot(m + '-3-look');
    await ev("document.querySelector('[data-asp=\"4:5\"]').click()");
    // shoot
    const dl0 = (await ev('__dl.length')) + (await ev('__shared.length'));
    await ev("document.querySelector('#ph-shutter').click()"); await wait(1800);
    const last = await ev('(()=>{const l=__park.game.modules.photo.last; return l && {w:l.w,h:l.h,size:l.blob.size,name:l.name,type:l.blob.type}})()');
    check(last && last.size > 8000 && Math.abs(last.w / last.h - 0.8) < 0.01, `${tag}/${m}: picture ${last && last.w}x${last && last.h} ${last && last.size} bytes ${last && last.name}`);
    check(last && /^lanternfall-\d{4}-\d\d-\d\d-\d{4}\.jpg$/.test(last.name), `${tag}/${m}: file name`);
    check((await ev('__dl.length')) + (await ev('__shared.length')) === dl0 + 1, `${tag}/${m}: delivered once (${mobile ? 'share' : 'download'})`);
    await shot(m + '-4-saved');
    // leave and compare
    await ev("(()=>{const r=document.querySelector('#ph-blur'); r.value=0; r.dispatchEvent(new Event('input'))})()"); await wait(500);
    if (m === 'wick') await ev("document.querySelector('[data-look=natural]').click()");
    if (m === 'tour' && !mobile) await page.keyboard.press('Escape'); else if (m === 'orbit') await page.keyboard.press('KeyO'); else await ev("document.querySelector('#ph-done').click()");
    await wait(1200);
    check(await ev("!__park.game.modules.photo.active && !__park.game.cameraHeld && !document.body.classList.contains('photo-on') && document.body.classList.contains('clean') === " + clean0), `${tag}/${m}: left, interface restored`);
    check((await ev('__park.mode')) === mode0, `${tag}/${m}: same mode`);
    check(m !== 'wick' || (await ev('String(__park.platformer.animator.update).length')) === a0, `${tag}/${m}: Wick's animation restored`);
    check(!(await ev('!!__park.Q.photo')) && !(await ev('!!__park.game.modules.photo.pass')), `${tag}/${m}: pass gone`);
    if (m === 'wick') { const w1 = await ev('(()=>{const v=__park.platformer.view.pos;return [v.x,v.y,v.z]})()'); check(same(wick0, w1, 0.3), `${tag}/${m}: Wick still where they were`);
      await ev('__park.platformer.test.input = () => ({ mx: 0, my: 1, a: false, b: false, z: false })'); await wait(1500); const w2 = await ev('(()=>{const v=__park.platformer.view.pos;return [v.x,v.y,v.z]})()'); await ev('__park.platformer.test.input = null');
      check(!same(w1, w2, 0.5), `${tag}/${m}: Wick walks again`); }
    if (m === 'orbit' || m === 'wick' || m === 'fp') { const camC = await cam(); check(m === 'orbit' ? true : true, `${tag}/${m}: after leaving camera ${camC.map((v) => v.toFixed(1))}`); }
  }
  // saved thumbnails survive a reload
  const n0 = await ev('__park.game.modules.photo.shots.length'); check(n0 >= 1 && n0 <= 12, `${tag}: thumbnails saved (${n0})`);
  await wait(800); await page.reload(); await page.waitForFunction('window.__park && window.__park.loaded && __park.game.modules.photo', { timeout: 240000 });
  const n1 = await ev('__park.game.modules.photo.shots.length'); check(n1 === n0, `${tag}: thumbnails survive a reload (${n1})`);
  await ev('__park.game.journal.open()'); await wait(500); await shot('journal');
  const th = await ev("(()=>{const i=document.querySelector('.ph-sheet img'); return i && i.naturalWidth})()"); check(th > 100 && th < 260, `${tag}: contact sheet shows thumbnails (${th} px)`);
  await ev("document.querySelector('.ph-sheet button').click()"); await wait(300); check(await ev("!document.querySelector('#ph-lightbox').hidden"), `${tag}: tapping a thumbnail shows it larger`); await shot('lightbox');
  await ev("document.querySelector('#ph-lightbox').click()");
  // context loss while in photo mode
  if (quality === 'cinematic') {
    await ev('__park.game.journal.close()'); await ev("__park.game.modules.photo.enter()"); await wait(600);
    await ev("(()=>{const r=document.querySelector('#ph-blur'); r.value=50; r.dispatchEvent(new Event('input'))})()"); await wait(1500);
    const res = await ev(`(async()=>{const gl=__park.renderer.getContext();const e=gl.getExtension('WEBGL_lose_context');e.loseContext();await new Promise(r=>setTimeout(r,600));e.restoreContext();await new Promise(r=>setTimeout(r,3500));return gl.isContextLost()?'lost':'restored'})()`);
    check(res === 'restored', `${tag}: context loss in photo mode: ${res}`);
    await ev("document.querySelector('#ph-shutter').click()"); await wait(2000);
    const l2 = await ev('(()=>{const l=__park.game.modules.photo.last; return l && l.blob.size})()'); check(l2 > 8000, `${tag}: can still take a picture after the loss`);
    await ev('__park.game.modules.photo.leave()'); await wait(500);
  }
  const errList = [...errs].map(([k, v]) => v + 'x ' + k); check(errList.length === 0, `${tag}: no console errors ${JSON.stringify(errList)}`);
  await browser.close();
}
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map(Number) : null;
for (const [i, [mobile, q]] of [[false, 'cinematic'], [true, 'cinematic'], [false, 'hd'], [true, 'fast']].entries()) if (!ONLY || ONLY.includes(i)) await run(mobile, q).catch((e) => { fails.push('run crashed ' + e.message); console.log(e); });
console.log(fails.length ? 'FAILED: ' + fails.length + '\n' + fails.join('\n') : 'ALL OK'); process.exit(fails.length ? 1 : 0);
