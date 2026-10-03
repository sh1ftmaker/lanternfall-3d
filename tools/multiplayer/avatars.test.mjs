// Remote avatars (fx/multiplayer/avatars.js) end to end, desktop and 390x844 touch, driven by fake senders
// (fx/multiplayer/sim.js: realistic send rates, latency, jitter and late packets; one 'fp' sender in four; one teleport).
// Usage: node avatars.test.mjs [url] (needs puppeteer-core next to it); SHOTS=dir for screenshots.
import puppeteer from 'puppeteer-core'; import fs from 'fs';
const URL = process.argv[2] || 'http://127.0.0.1:8963/index.html', SHOTS = process.env.SHOTS || '/tmp/mp-avatars-shots'; fs.mkdirSync(SHOTS, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = async (mobile) => {
  const W = mobile ? 390 : 1280, H = mobile ? 844 : 720, tag = mobile ? 'm' : 'd';
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 300000, args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', `--window-size=${W},${H}`] });
  const page = await browser.newPage(); const errs = new Map(), res = []; const add = (k) => errs.set(k, (errs.get(k) || 0) + 1);
  page.on('pageerror', (e) => add('pageerror: ' + e.message.slice(0, 160))); page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') add(m.type() + ': ' + m.text().slice(0, 160)); });
  page.on('response', (r) => { if (r.status() >= 400) add('http ' + r.status() + ' ' + r.url().slice(-60)); });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.goto(URL + '#fp,weather=clear');
  await page.waitForFunction('window.__park && window.__park.loaded && window.__park.game', { timeout: 180000 }); await wait(2500);
  const ev = (js) => page.evaluate(js).catch((e) => { add('eval: ' + e.message.slice(0, 160)); });
  const ok = (name, cond, info = '') => { res.push((cond ? 'ok   ' : 'FAIL ') + name + (info ? ' ' + info : '')); if (!cond) add('FAIL ' + name); };
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${tag}_${n}.jpg`, type: 'jpeg', quality: 85 });
  // stand on the East Gate plaza facing the lake; the visitors walk 6 to 30 m ahead
  await ev("__park.setMode('walk',{at:[300,0],yaw:Math.PI})"); await wait(1500);
  const base = await ev('({children:__park.scene.children.length,tex:__park.renderer.info.memory.textures,geo:__park.renderer.info.memory.geometries,inter:__park.game.interactables.length})');
  // 1. eight senders, ordinary jitter (latency 40 ms + exponential jitter, mean 15 ms): the drawn position against the
  // true path 120 ms + the base latency behind, within 0.5 m; a teleport is cut; nothing snaps
  await ev(`(async()=>{window.__sim=await __park.mpSim(8,{teleport:true,measure:true,center:[284,0],radius:12,latency:40,jitter:15,spikes:0});return 1})()`);
  await wait(3000); await shot('eight');
  await wait(11000);
  const rep = await ev('__sim.report()');
  const a = await ev(`(()=>{const A=__sim.avatars;return {count:A.count,drawn:A.stats.drawn,tags:A.stats.tags,tagNames:A.tags.filter(t=>t.owner).map(t=>t.text),fp:__sim.senders.filter(s=>s.kind==='fp').length,inter:__park.game.interactables.length,cpu:+A.stats.cpuMs.toFixed(3)}})()`);
  const plain = rep.per.filter((p) => p.n > 0);
  const worst = Math.max(...plain.map((p) => p.max)), meanAll = plain.reduce((s, p) => s + p.mean, 0) / plain.length, snap = Math.max(...plain.map((p) => p.snap));
  console.log(tag, 'ordinary jitter, error (m) per sender [id, kind, speed, frames, mean, p95, max, snap]:', JSON.stringify(rep.per.map((p) => [p.id, p.kind, p.speed, p.n, p.mean, p.p95, p.max, p.snap, p.teleported ? 'tp slid=' + p.slid : ''])));
  ok('8 avatars known and drawn', a.count === 8 && a.drawn === 8, `count ${a.count} drawn ${a.drawn}`);
  ok('one fp sender at least', a.fp >= 1, String(a.fp));
  ok('every sender measured', plain.length === 8 && plain.every((p) => p.n > 100), plain.map((p) => p.n).join(','));
  ok('drawn position within 0.5 m of the delayed path', worst <= 0.5, `max ${worst.toFixed(3)} mean ${meanAll.toFixed(3)}`);
  ok('no snap on ordinary jitter', snap < 0.25, `largest excess step ${snap.toFixed(3)} m`);
  const tp = rep.per.find((p) => p.teleported);
  ok('teleport cut, not slid', tp && tp.slid === 0, tp ? 'slid frames ' + tp.slid : 'no teleport happened');
  ok('name tags exist', a.tags >= 1 && a.tagNames.length >= 1, `${a.tags} shown: ${a.tagNames.join(' | ')}`);
  ok('no interactables added', a.inter === base.inter);
  // 1b. late packets too: 3% arrive 150 ms late (beyond the 120 ms buffer): logged; still no snap, within 1 m
  await ev(`(async()=>{window.__simB=await __park.mpSim(8,{measure:true,center:[284,0],radius:12,latency:40,jitter:18,spikes:0.03,seed:11});return 1})()`);
  await wait(11000);
  const repB = await ev('__simB.report()'), plainB = repB.per.filter((p) => p.n > 0);
  const worstB = Math.max(...plainB.map((p) => p.max)), meanB = plainB.reduce((s, p) => s + p.mean, 0) / plainB.length, snapB = Math.max(...plainB.map((p) => p.snap));
  console.log(tag, 'with 3% late packets, error (m) per sender:', JSON.stringify(repB.per.map((p) => [p.id, p.kind, p.speed, p.n, p.mean, p.p95, p.max, p.snap])));
  ok('late packets: within 1 m, no snap', worstB <= 1 && snapB < 0.25, `max ${worstB.toFixed(3)} mean ${meanB.toFixed(3)} snap ${snapB.toFixed(3)}`);
  await ev(`(async()=>{window.__sim=await __park.mpSim(8,{center:[284,0],radius:12,seed:7});return 1})()`); await wait(2500);     // mpSim replaces the previous run
  // 2. one leaves: fades, then its objects are freed
  const kids0 = await ev('__sim.avatars.root.children.length');
  await ev('__sim.leave(2)'); const c1 = await ev('__sim.avatars.count'); await wait(1600);
  const kids1 = await ev('__sim.avatars.root.children.length');
  ok('remove: count drops at once, objects freed after the fade', c1 === 7 && kids1 === kids0 - 4, `count ${c1}, children ${kids0} -> ${kids1}`);
  // 3. all leave; module disposed: scene, textures, geometries back to where they were
  await ev('__park.mpSim(0)'); await wait(2200);
  const after = await ev('({children:__park.scene.children.length,tex:__park.renderer.info.memory.textures,geo:__park.renderer.info.memory.geometries})');
  ok('dispose frees everything', after.children === base.children && after.tex === base.tex && after.geo === base.geo, JSON.stringify({ base, after }));
  // 4. thirty: the nearest 24 are drawn
  await ev(`(async()=>{window.__sim=await __park.mpSim(30,{center:[270,0],radius:30});return 1})()`); await wait(4000);
  const b = await ev(`(()=>{const A=__sim.avatars;const vis=A.root.children.filter(o=>o.name==='mp-avatar'&&o.visible).length;return {count:A.count,drawn:A.stats.drawn,vis,tags:A.stats.tags,pool:A.tags.length,cpu:+A.stats.cpuMs.toFixed(3)}})()`);
  ok('30 known, 24 drawn', b.count === 30 && b.drawn === 24 && b.vis === 24, JSON.stringify(b));
  ok('tag pool at most 12', b.pool <= 12 && b.tags <= 12, String(b.pool));
  ok('a name with markup is kept as plain text', (await ev("__sim.avatars.debug('sim29').name")) === 'Moth <b>&amp;</b> Co');
  await shot('thirty');
  await ev('__park.mpSim(0)'); await wait(2000);
  const after2 = await ev('({children:__park.scene.children.length,tex:__park.renderer.info.memory.textures,geo:__park.renderer.info.memory.geometries})');
  ok('dispose after 30 frees everything', after2.children === base.children && after2.tex === base.tex && after2.geo === base.geo, JSON.stringify(after2));
  const out = { mobile, err: { worst: +worst.toFixed(3), mean: +meanAll.toFixed(3), lateWorst: +worstB.toFixed(3), lateMean: +meanB.toFixed(3) }, cpu8: a.cpu, cpu30: b.cpu, errs: [...errs].map(([k, v]) => v + 'x ' + k) };
  console.log(res.join('\n'));
  console.log(JSON.stringify(out)); await browser.close();
};
await run(false); await run(true);
