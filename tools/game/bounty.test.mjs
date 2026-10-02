// Bounty module end to end, desktop and 390x844 touch: node tools/game/bounty.test.mjs http://127.0.0.1:8904/index.html [shots-dir]
// (puppeteer-core is resolved from the parent folders: run it from the scratch tooling folder, or set NODE_PATH.)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const URL = process.argv[2] || 'http://127.0.0.1:8904/index.html', SHOTS = process.argv[3] || '/tmp/bounty-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(mobile) {
  const tag = mobile ? 'm' : 'd', W = mobile ? 390 : 1280, H = mobile ? 844 : 720;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', `--window-size=${W},${H}`] });
  const page = await browser.newPage(); const errs = new Map(), checks = [];
  const add = (k) => errs.set(k, (errs.get(k) || 0) + 1);
  page.on('pageerror', (e) => add('pageerror: ' + e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') add(m.type() + ': ' + m.text().slice(0, 200)); });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const ok = (name, cond, detail) => { checks.push({ name, ok: !!cond, ...(cond ? {} : { detail }) }); if (!cond) console.log(`  FAIL [${tag}] ${name}`, detail === undefined ? '' : JSON.stringify(detail)); };
  const ev = (js, ...a) => page.evaluate(js, ...a).catch((e) => { add('eval: ' + e.message.slice(0, 160)); });
  const shot = (name) => page.screenshot({ path: `${SHOTS}/${tag}_${name}.jpg`, type: 'jpeg', quality: 85 });
  const B = (js) => ev(`(()=>{const b=__park.game.modules.bounty;return ${js}})()`);
  const load = async (hash) => { await page.goto(URL + hash); await page.waitForFunction('window.__park && window.__park.loaded && __park.game.modules.bounty && __park.game.modules.bounty.state', { timeout: 180000 }); await wait(1500); };

  async function wickReady() { await page.waitForFunction('__park.platformer && __park.platformer.active && __park.platformer.view', { timeout: 120000 }).catch(() => add('platformer did not start')); await wait(500); }
  async function toWick(x, y, yaw = 0) { await ev('__park.setPlatformer(true)'); await ev(`__park.setMode('walk',{at:[${x},${y}],yaw:${yaw}})`); await wickReady(); await wait(600); }
  async function toFp(x, y, yaw = 0) { await ev('__park.setPlatformer(false)'); await ev(`__park.setMode('walk',{at:[${x},${y}],yaw:${yaw}})`); await wait(900); }
  async function onRoof(x, y, z) { await ev(`__park.platformer.teleport(${x},${z + 0.15},${-y},0)`); await wait(1800); }
  const prompt = () => ev(`(()=>{const p=document.getElementById('game-prompt');return p&&!p.hidden?p.textContent:''})()`);
  async function waitPrompt(re, ms = 4000) { const t0 = Date.now(); let p = ''; while (Date.now() - t0 < ms) { p = await prompt(); if (re.test(p)) return p; await wait(150); } return p; }
  // use the nearest thing: tap the prompt (touch and Wick) or press E (first person, desktop)
  async function use(fp, re) { const p = await waitPrompt(re); if (!re.test(p)) return false; if (fp && !mobile) await page.keyboard.press('KeyE'); else await page.click('#game-prompt'); await wait(450); return true; }
  const posOf = (k) => B(`b.positions().${k}`);
  const toastText = () => ev(`[...document.querySelectorAll('.game-toast')].map(t=>t.textContent).join(' | ')`);

  // ── fresh start: Wick ──
  await load('#weather=clear'); await ev('localStorage.removeItem("lanternfall.game.v1")'); await load('#weather=clear');
  ok('module loaded', await B('!!b.state().day'));
  await ev('__park.game.modules.bounty.test.setJobs(["letter","bell","boats"])');
  const jobs = await B('b.jobsToday()'); ok('three jobs for the day', jobs.length === 3, jobs);
  // the same three for everyone on a day: the draw is deterministic
  ok('day draw is seeded', await ev(`(async()=>{const m=await import('/fx/game/bounty/index.js');const a=m.drawJobs('2026-10-02'),b=m.drawJobs('2026-10-02'),c=m.drawJobs('2026-10-03');return JSON.stringify(a)===JSON.stringify(b)&&a.length===3&&new Set(a).size===3&&JSON.stringify(a)!==JSON.stringify(c)})()`));

  // ── the board ──
  const bp = await posOf('board');
  await toWick(bp.x, bp.y, -0.342); const pr = await waitPrompt(/Bounty Board/);
  ok('prompt at the board (Wick)', /Bounty Board/.test(pr), pr); await use(false, /Bounty Board/);
  ok('board card open', await ev(`!document.querySelector('.bty-card').hidden`)); await shot('board_card');
  const cardBox = await ev(`(()=>{const r=document.querySelector('.bty-card').getBoundingClientRect();return [r.left,r.top,r.right,r.bottom,innerWidth,innerHeight]})()`);
  ok('card fits the screen', cardBox[0] >= 0 && cardBox[2] <= cardBox[4] && cardBox[3] <= cardBox[5], cardBox);
  const taken = await ev(`(()=>{const bs=[...document.querySelectorAll('.bty-card .bty-btn')].filter(b=>/Take the job/.test(b.textContent));bs.forEach(b=>b.click());return bs.length})()`);
  ok('three jobs taken at the board', taken === 3, taken); await wait(300);
  ok('jobs active', (await B('b.jobsToday()')).every((j) => j.state === 'active'));
  ok('tracker line while active', /letter|Signing|bell|boats/i.test(await ev(`document.getElementById('game-track').textContent`)), await ev(`document.getElementById('game-track').textContent`));
  await shot('board_taken'); await ev('__park.game.modules.bounty.closeCard()');

  // job 1: the letter to the Signing Tables
  ok('carrying the letter', await B(`b.state().carry.includes('letter')`));
  const sg = await posOf('signing'); await toWick(sg.x, sg.y - 1.5, 1.57);
  ok('letter delivered', (await use(false, /Leave the letter/)) && (await B(`b.jobsToday().find(j=>j.id==='letter').state`)) === 'done', await prompt());

  // job 2: the strength bell, rung five times (the pole swing rings it too)
  const be = await posOf('bell'); await toWick(be.x - 3, be.y - 1.5, 0); const r0 = await B('b.state().rings');
  const uses = await ev(`(()=>{window.__bellUses=0;__park.game.on('use',(d)=>{if(d.id==='strength-bell')window.__bellUses++});return 1})()`);
  for (let i = 0; i < 5; i++) { await use(false, /strength bell/); await wait(250); if (i === 1) await shot('bell_ringing'); }
  const r1 = await B('b.state().rings'); ok('bell rung five times', r1 - r0 === 5 && (await ev('window.__bellUses')) === 5, [r0, r1]);
  ok('bell job done by ringing', (await B(`b.jobsToday().find(j=>j.id==='bell').state`)) === 'done');

  // job 3: count the boats
  const wp = await ev(`(()=>{const b=__park.game.modules.bounty;return b.positions().busker})()`); ok('placeholder', !!wp);
  const nBoats = await B('b.boatCount()'); ok('boat count in range', nBoats >= 3 && nBoats <= 6, nBoats);
  await ev(`__park.game.modules.bounty.openCard('board',{x:0,y:0})`); await wait(200);
  await ev(`(()=>{const i=document.querySelector('.bty-in');i.value='${nBoats + 1}';[...document.querySelectorAll('.bty-card .bty-btn')].find(b=>/Answer/.test(b.textContent)).click()})()`); await wait(300);
  ok('wrong boat count refused', (await B(`b.jobsToday().find(j=>j.id==='boats').state`)) === 'active');
  await ev(`(()=>{const i=document.querySelector('.bty-in');i.value='${nBoats}';[...document.querySelectorAll('.bty-card .bty-btn')].find(b=>/Answer/.test(b.textContent)).click()})()`); await wait(400);
  ok('right boat count completes', (await B(`b.jobsToday().find(j=>j.id==='boats').state`)) === 'done'); await ev('__park.game.modules.bounty.closeCard()');
  ok('three jobs done', (await B('b.state().jobsDone')) === 3);

  // ── stamps ──
  const posts = await B('b.stampPosts()');
  // one by the pole swing, on a roof (Wick only)
  const pg = posts.guildhollow; await onRoof(pg.x, pg.y - 1.2, pg.z);
  await ev(`__park.platformer.test.input=(t)=>({ b: (t % 1) < 0.15 })`); await wait(2600); await ev('__park.platformer.test.input=null');
  ok('stamp by pole swing on the stall roof', await B(`!!b.state().stamps.guildhollow`), await B('b.state().stamps')); await shot('stamp_post_roof');
  // another swim/roof one is checked by position; two on foot with E (first person) / prompt tap
  const rs = posts.rosewick; await toFp(rs.x - 1.2, rs.y, 0); ok('stamp in first person', (await use(true, /Stamp the passport/)) && (await B(`!!b.state().stamps.rosewick`)), await prompt()); await shot('stamp_post_fp');
  const mp = posts.meridian; await ev(`__park.game.teleport(${mp.x - 1.5},${mp.y},0)`); await wait(600); await ev('__park.walk.z=__park.walk.cz=10'); await wait(600);
  const gz = await ev(`__park.game.ground(${mp.x - 1.5},${mp.y},10)`); ok('meridian platform is walkable at the post height', gz != null && Math.abs(gz - mp.z) < 0.6, gz);
  ok('stamp on the Meridian platform', (await use(true, /Stamp the passport/)) && (await B(`!!b.state().stamps.meridian`)), await prompt());
  ok('three stamps', (await B('Object.keys(b.state().stamps).length')) === 3);
  await ev('__park.game.journal.open()'); await wait(500); await shot('journal'); await ev(`document.querySelector('#game-journal .gj-list').scrollTop=9999`); await wait(200);
  await ev(`(()=>{const s=[...document.querySelectorAll('#game-journal .gj-sec')].find(s=>/Passport/.test(s.textContent));s&&s.scrollIntoView()})()`); await wait(300); await shot('passport');
  const slots = await ev(`document.querySelectorAll('.bty-slot').length`); const filled = await ev(`document.querySelectorAll('.bty-slot.on').length`);
  ok('passport shows eight slots, three filled', slots === 8 && filled === 3, [slots, filled]);
  await ev('__park.game.journal.close()');

  // ── Lost & Found (first person) ──
  const lp = await B('b.lostPos().cap'); await toFp(lp.x - 1.5, lp.y, 0);
  await ev(`window.__rel=__park.game.takeCamera(()=>{const g=__park.game;g.camera.position.set(${lp.x - 2.4},${lp.z + 1.1},${-lp.y});g.camera.lookAt(${lp.x},${lp.z + 0.3},${-lp.y})},{name:'t'})`); await wait(600); await shot('lost_thing'); await ev('window.__rel()');
  ok('pick up the cap', (await use(true, /Pick up the sailor/)) && (await B(`b.state().carry.includes('lost:cap')`)), await prompt());
  ok('carried item shows in the tracker', /sailor/i.test(await ev(`document.getElementById('game-track').textContent`)));
  const dk = await posOf('desk'); await toFp(dk.x, dk.y - 1, Math.PI / 2 + 0.34 - 0.0);
  ok('hand in at the desk', (await use(true, /Hand in/)) && (await B(`!!b.state().lost.cap`)), await prompt());
  await ev(`window.__rel=__park.game.takeCamera(()=>{const g=__park.game,s=g.modules.bounty.positions().shelf;g.camera.position.set(${dk.x},1.75,${-dk.y});g.camera.lookAt(s.x,s.z,-s.y)},{name:'s'})`); await wait(5500); await shot('shelf'); await ev('window.__rel()');
  ok('a prop on the shelf', (await B('b.shelfProps()')).includes('cap'));

  // ── reload: everything persisted ──
  const before = await B('JSON.stringify({s:Object.keys(b.state().stamps).sort(),r:b.state().rings,d:b.state().jobsDone,l:Object.keys(b.state().lost),j:b.jobsToday()})');
  await wait(900); await load('#weather=clear');
  const after = await B('JSON.stringify({s:Object.keys(b.state().stamps).sort(),r:b.state().rings,d:b.state().jobsDone,l:Object.keys(b.state().lost),j:b.jobsToday()})');
  ok('state survives a reload', before === after, [before, after]);

  // ── reward hut: three jobs done -> a lantern colour, applied to Wick ──
  const hp = await posOf('hut'); await toWick(hp.x, hp.y, 0.5); await use(false, /reward/i);
  ok('hut card open', await ev(`!document.querySelector('.bty-card').hidden`)); await shot('hut_card');
  await ev(`[...document.querySelectorAll('.bty-card .bty-btn')].find(b=>/Take it/.test(b.textContent))?.click()`); await wait(800);
  ok('a lantern colour earned', (await B('b.state().colors.length')) === 2, await B('b.state().colors'));
  await wait(1200); const col = await ev(`(()=>{const u=__park.platformer.character.uniforms.uLanternCol;const v=u.value||u;return [v.x??v.r,v.y??v.g,v.z??v.b]})()`);
  ok("Wick's lantern uses the new colour", Math.abs(col[0] - 0.42) < 0.02 && Math.abs(col[1] - 1) < 0.02, col); await ev(`__park.game.modules.bounty.closeCard()`); await shot('lantern_colour');
  // ── fixes: culling, tracker, carry-over, date guard, candle, wording, net ──
  const visBounty = () => ev(`(()=>{let n=0;__park.scene.traverse((o)=>{if(o.isMesh&&o.userData.bounty){let v=true;for(let q=o;q;q=q.parent)if(!q.visible)v=false;if(v)n++}});return n})()`);
  await ev(`__park.setMode('walk',{at:[288,0],yaw:Math.PI})`); await wait(1800);
  const atGate = await visBounty(); ok('at the East Gate only the nearby postcard draws (merged, <= 3 meshes)', atGate >= 1 && atGate <= 3, atGate);
  await ev(`__park.setMode('tour')`); await wait(1500); ok('nothing from bounty draws in Tour', (await visBounty()) === 0, await visBounty());
  ok('merged props: one mesh per prop', await ev(`(()=>{const b=__park.game.modules.bounty;let m=0;__park.scene.traverse((o)=>{if(o.isMesh&&o.userData.bounty)m++});return m<=40})()`));
  await ev(`__park.setMode('walk',{at:[288,0],yaw:Math.PI})`); await wait(800);
  await ev(`__park.game.modules.bounty.test.setJobs(['letter','balloon','bow'])`); await ev(`(()=>{const b=__park.game.modules.bounty;['letter','balloon','bow'].forEach((id)=>b.accept(id))})()`); await wait(1700);
  const trk = await ev(`document.getElementById('game-track').textContent`); ok('tracker shows one job and "+2 more"', /\(\+2 more\)/.test(trk), trk);
  // midnight: a half-done job is carried over, not lost
  await B(`b.test.newDay('2099-01-01')`); await wait(300);
  ok('a job half done is carried to the new day', (await B('b.jobsToday()')).some((j) => j.state === 'active') && (await B(`b.state().carry.includes('letter')`)), await B('b.jobsToday()'));
  ok('the date going back does not start a new day', await B(`(()=>{b.state().day='2999-01-01';const r=b.test.rollDay();return r===false&&b.state().day==='2999-01-01'})()`));
  // the candle
  await ev(`(()=>{const b=__park.game.modules.bounty;b.test.setJobs(['candle','bell','boats']);b.accept('candle')})()`); await wait(300);
  await ev(`__park.game.interactables.find(i=>i.id==='job-candle').use()`); await wait(300); ok('candle lit by the job', await B('b.test.candle()'));
  await B(`b.test.newDay('2099-01-02')`); await wait(300); ok('candle prop removed when the night ends', !(await B('b.test.candle()')));
  // wording and the net
  const names = await ev(`import('/fx/game/bounty/data.js').then((d)=>d.LOST.map((l)=>l.name))`);
  ok('lost and found names are capitalised, no full stop', names.every((n) => /^[A-Z]/.test(n) && !/\.$/.test(n)), names);
  const nt = await B('b.lostPos().net'); ok('the net is out of the carousel prompt reach', Math.hypot(nt.x + 128, nt.y + 118.9) > 7.4 + 1, nt);
  ok('no console errors', ![...errs.keys()].some((k) => /pageerror|error/.test(k)), [...errs]);
  const out = { mobile, checks: checks.length, failed: checks.filter((c) => !c.ok).map((c) => c.name), errs: [...errs].map(([k, v]) => v + 'x ' + k) };
  await browser.close(); return out;
}
const res = []; res.push(await run(false)); res.push(await run(true));
console.log(JSON.stringify(res)); process.exit(res.some((r) => r.failed.length) ? 1 : 0);
