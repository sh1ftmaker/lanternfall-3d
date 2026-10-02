// Platformer functional + console checks, desktop and phone emulation, ANGLE GL backend. node pfunc.mjs [url]
import puppeteer from 'puppeteer-core';
const URL = process.argv[2] || 'http://127.0.0.1:8851/index.html';
const SHOT = '/tmp/claude-1000/-home-zalo/253e908b-4e3c-4d12-a43e-a8b3b88482f6/scratchpad/agents/platformer/shots/';
const run = async (mobile) => {
  const W = mobile ? 390 : 1280, H = mobile ? 844 : 720;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 300000, args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', `--window-size=${W},${H}`] });
  const page = await browser.newPage(); const errs = new Map(); const add = (k) => errs.set(k, (errs.get(k) || 0) + 1);
  page.on('pageerror', (e) => add('pageerror: ' + e.message.slice(0, 200))); page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') add(m.type() + ': ' + m.text().slice(0, 200)); });
  page.on('response', (r) => { if (r.status() >= 400) add('http ' + r.status() + ' ' + r.url().slice(-60)); });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.goto(URL); await page.waitForFunction('window.__park && window.__park.loaded', { timeout: 180000 });
  const ev = (js) => page.evaluate(js).catch((e) => { add('eval: ' + e.message.slice(0, 160)); }); const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { mobile };
  out.btnHiddenInTour = await ev("getComputedStyle(document.querySelector('#btn-pf')).display");
  await ev("document.querySelector('#m-walk').click()"); await wait(500);
  await ev("__park.setMode('walk',{at:[288,0],yaw:Math.PI})"); await wait(300);
  out.btnInWalk = await ev("getComputedStyle(document.querySelector('#btn-pf')).display");
  const req0 = await ev("performance.getEntriesByType('resource').filter(e=>/platformer/.test(e.name)).length");
  out.lazyBefore = req0;      // must be 0: nothing loads before the switch
  if (mobile) await page.tap('#btn-pf'); else await page.click('#btn-pf');
  await page.waitForFunction('__park.platformer && __park.platformer.active && __park.platformer.S.latest > 5', { timeout: 90000 }).catch(() => add('platformer did not start'));
  out.loaded = await ev("performance.getEntriesByType('resource').filter(e=>/platformer/.test(e.name)).map(e=>e.name.split('/').pop()+':'+Math.round(e.transferSize||e.encodedBodySize))");
  await wait(800);
  const p0 = await ev('__park.platformer.view.pos.toArray().map(v=>+v.toFixed(2))');
  if (mobile) {
    out.touchUi = await ev("!document.querySelector('.pf-touch').hidden");
    const cdp = await page.target().createCDPSession();
    const tp = (id, x, y) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(1, 90, 600)] }); await wait(50);
    for (let k = 1; k <= 6; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [tp(1, 90, 600 - k * 9)] }); await wait(30); }
    await wait(1200);
    const jb = await page.$('.pf-jump'); const box = await jb.boundingBox();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(1, 90, 546), tp(2, box.x + box.width / 2, box.y + box.height / 2)] }); await wait(250);
    out.jumpAction = await ev('__park.platformer.view.s && __park.platformer.view.s.action');
    await page.screenshot({ path: SHOT + 'pf_mobile_jump.jpg', type: 'jpeg', quality: 80 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(800);
    // drag elsewhere to orbit
    const yaw0 = await ev('__park.platformer.S.cam.yaw');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(3, 250, 300)] });
    for (let k = 1; k <= 8; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [tp(3, 250 - k * 12, 300)] }); await wait(20); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    out.orbit = +((await ev('__park.platformer.S.cam.yaw')) - yaw0).toFixed(2);
    await page.screenshot({ path: SHOT + 'pf_mobile.jpg', type: 'jpeg', quality: 80 });
  } else {
    await page.click('canvas');
    await page.keyboard.down('KeyW'); await wait(1200); await page.keyboard.press('Space'); await wait(300);
    out.jumpAction = await ev('__park.platformer.view.s && __park.platformer.view.s.action');
    await page.keyboard.up('KeyW'); await wait(900);
    // mouse drag orbit
    const yaw0 = await ev('__park.platformer.S.cam.yaw');
    await page.mouse.move(700, 300); await page.mouse.down(); await page.mouse.move(600, 300, { steps: 6 }); await page.mouse.up();
    out.orbit = +((await ev('__park.platformer.S.cam.yaw')) - yaw0).toFixed(2);
  }
  out.moved = +Math.hypot(...(await ev('__park.platformer.view.pos.toArray()')).map((v, i) => v - p0[i])).toFixed(2);
  // picture quality while active
  out.quality = await ev(`(async()=>{const r=[];const w=(ms)=>new Promise(s=>setTimeout(s,ms));document.querySelector('#btn-set').click();await w(300);const bs=[...document.querySelectorAll('.seg button')];for(const b of bs){if(b.disabled)continue;b.click();await w(1200);r.push(b.textContent.trim()+':'+(__park.platformer.active?'on':'off'))}document.querySelector('.sheet-close').click();return r.join(' ')})()`);
  // reduce motion on/off while active
  out.reduceMotion = await ev(`(async()=>{const w=(ms)=>new Promise(s=>setTimeout(s,ms));document.querySelector('#btn-set').click();await w(200);const t=[...document.querySelectorAll('.tog')].find(e=>/Reduce motion/.test(e.textContent));t.click();await w(800);const a=__park.platformer.active;t.click();await w(300);document.querySelector('.sheet-close').click();return a})()`);
  // WebGL context loss while active
  out.ctx = await ev(`(async()=>{const gl=__park.renderer.getContext();const e=gl.getExtension('WEBGL_lose_context');if(!e)return 'no ext';e.loseContext();await new Promise(r=>setTimeout(r,600));e.restoreContext();await new Promise(r=>setTimeout(r,2500));return (gl.isContextLost()?'still lost':'restored')+' active:'+__park.platformer.active+' ticks:'+__park.platformer.S.latest})()`);
  await wait(500);
  // P / button back to Walk, then Tab back in; then Explore leaves it
  if (mobile) { await page.tap('#btn-pf'); } else { await page.keyboard.press('KeyP'); }
  await wait(600); out.backToWalk = await ev('__park.mode + ":" + __park.platformer.active');
  if (mobile) { await page.tap('#btn-pf'); } else { await page.keyboard.press('Tab'); }
  await wait(2000); out.backIn = await ev('__park.platformer.active');
  await ev("document.querySelector('#m-orbit').click()"); await wait(1500); out.explore = await ev('__park.mode + ":" + __park.platformer.active + ":" + __park.platformer.character.group.visible');
  await ev("document.querySelector('#m-tour').click()"); await wait(1500); out.tour = await ev('__park.mode');
  out.errs = [...errs].map(([k, v]) => v + 'x ' + k);
  console.log(JSON.stringify(out)); await browser.close();
};
await run(false); await run(true);
