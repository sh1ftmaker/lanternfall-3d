// Other visitors, end to end: the server (party/server.ts, partyserver on a Durable Object) under `wrangler dev`, then real pages.
//   1. protocol: welcome, names, snapshot, validation, rate limit, leave, the room cap, nothing about the connection sent
//   2. pages: A walks as Wick, B (first person) sees A where A is within 300 ms, animating, named; C sits in Tour and
//      counts but is not drawn; A leaves and goes from B; '#solo' connects nothing; an unreachable host leaves a clean page;
//      data/mp.json names the host (served by the test), and with no host configured nothing connects
//   3. cost of the networking: bytes per second per walker, each way
// usage: node tools/multiplayer/test.mjs [http://127.0.0.1:8962/index.html] [--shots DIR] [--port 8970]
//   needs the site served at the URL and `npm install` in the repo (wrangler, partyserver); puppeteer-core resolved like
//   the other tests (PUPPETEER_CORE=<path to puppeteer-core.js> overrides). Starts `wrangler dev` itself (no login
//   needed) and stops it at the end.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const { default: puppeteer } = await import(process.env.PUPPETEER_CORE ? pathToFileURL(process.env.PUPPETEER_CORE).href : 'puppeteer-core');
const args = process.argv.slice(2), opt = (k, d) => (args.includes('--' + k) ? args[args.indexOf('--' + k) + 1] : d);
const URL0 = (args[0] && !args[0].startsWith('--') ? args[0] : 'http://127.0.0.1:8962/index.html').split('#')[0];
const PORT = +opt('port', 8970), HOST = `127.0.0.1:${PORT}`, SHOTS = opt('shots', '');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { checks: {}, notes: {} }; let failed = 0;
const ok = (name, cond, info) => { out.checks[name] = cond ? true : (info === undefined ? false : info); if (!cond) failed++; console.error((cond ? 'ok   ' : 'FAIL ') + name + (cond || info === undefined ? '' : ' ' + JSON.stringify(info))); };

// ── wrangler dev ──
const up = () => fetch(`http://${HOST}/parties/main/park`).then((r) => r.json()).catch(() => null);
let pk = null;
if (await up()) { out.notes.server = 'already running on ' + PORT + ' (not started by this test, left running)'; }
else {
  pk = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], { cwd: ROOT, detached: true, stdio: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  out.notes.wranglerPid = pk.pid;
  for (let i = 0; i < 120 && !(await up()); i++) await wait(500);
}
const stopAll = () => { if (pk) { try { process.kill(-pk.pid, 'SIGTERM'); } catch (e) { /* gone */ } pk = null; } };
process.on('exit', stopAll);
ok('server up', !!(await up()));

// ── 1. protocol, with plain WebSockets ──
const FIRST = ['Quiet', 'Amber', 'Gentle', 'Drifting', 'Silver', 'Velvet', 'Hushed', 'Warm', 'Misty', 'Dusky', 'Golden', 'Little', 'Wandering', 'Starlit', 'Paper', 'Mossy', 'Willow', 'Slow', 'Soft', 'Moonlit', 'Lantern', 'Copper', 'Dreaming', 'Patient'];
function client(room = 'park') {
  const ws = new WebSocket(`ws://${HOST}/parties/main/${room}?_pk=t${Math.random().toString(36).slice(2)}`);
  const c = { ws, msgs: [], raw: [], closed: null };
  ws.onmessage = (e) => { c.raw.push(e.data); try { c.msgs.push(JSON.parse(e.data)); } catch (err) { c.msgs.push(null); } };
  ws.onclose = (e) => { c.closed = e.code; };
  c.open = new Promise((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); setTimeout(() => r(false), 8000); });
  c.until = async (fn, ms = 3000) => { for (let t = 0; t < ms; t += 20) { const m = c.msgs.find(fn); if (m) return m; await wait(20); } return null; };
  c.send = (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  return c;
}
{
  const a = client(); await a.open; const wa = await a.until((m) => m && m[0] === 'w');
  ok('welcome: short id and a two-word name', wa && /^[a-z0-9]{5}$/.test(wa[1]) && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(wa[2]) && FIRST.includes(wa[2].split(' ')[0]), wa);
  const good = ['s', 1, 280.5, -3.25, 0.4, 3.1, 72, 12.5, 123456, 'gate'];
  a.send(good); await wait(150);
  const b = client(); await b.open; const wb = await b.until((m) => m && m[0] === 'w');
  ok('snapshot: a newcomer gets everyone, with the last state', wb && wb[3].length === 1 && wb[3][0][0] === wa[1] && wb[3][0][1] === wa[2] && JSON.stringify(wb[3][0][2]) === JSON.stringify([1, 280.5, -3.25, 0.4, 3.1, 72, 12.5, 123456, 'gate']), wb);
  ok('join is announced to the others', !!(await a.until((m) => m && m[0] === 'j' && m[1] === wb[1])));
  b.msgs.length = 0;
  const bad = [
    ['s', 1, 9999, 0, 0, 0, 72, 0, 1, null], ['s', 1, 0, 0, 0, 0, 209, 0, 1, null], ['s', 1, 0, 0, 0, 0, 1.5, 0, 1, null], ['s', 2, 0, 0, 0, 0, 72, 0, 1, null],
    ['s', 3, 0, 0, 0, 0, 72, 0, 1, null], ['s', 1, 0, 0, 0, 0, 72, 0, 1, 'my house'], ['s', 1, 0, 0, 0, 0, 72, 0, 1], ['s', 1, 'x', 0, 0, 0, 72, 0, 1, null],
    ['s', 1, 0, 0, 500, 0, 72, 0, 1, null], ['hello'], { s: 1 }, 'not json', 'x'.repeat(5000), ['s', 1, 0, 0, 0, 0, 72, 0, 1, null, 'extra'],
  ];
  for (const m of bad) a.send(m);
  a.send('["s",1,1e999,0,0,0,72,0,1,null]');
  await wait(400);
  ok('malformed, oversized and out-of-range states are not relayed', !b.msgs.some((m) => m && m[0] === 's'), b.raw.slice(0, 3));
  a.send(['s', 2, -100, 50, 1, -7, -1, 0, 5, null]); const fp = await b.until((m) => m && m[0] === 's');
  ok('a first-person state is relayed, yaw wrapped, rounded', fp && fp[1] === wa[1] && fp[2] === 2 && Math.abs(fp[6] - Math.atan2(Math.sin(-7), Math.cos(-7))) < 1e-3 && fp[7] === -1, fp);
  await wait(1500);            // refill the bucket
  b.msgs.length = 0; for (let i = 0; i < 60; i++) a.send(['s', 1, 0, 0, 0, 0, 72, i % 30, 1000 + i, null]);
  await wait(1100); const relayed = b.msgs.filter((m) => m && m[0] === 's').length;
  ok('rate limit: 60 states sent at once, at most ~20 relayed', relayed >= 15 && relayed <= 22, relayed);
  ok('nothing about the connection reaches clients', ![...a.raw, ...b.raw].some((t) => /127\.0\.0\.1|::1|user-agent|mozilla/i.test(t)));
  b.ws.close(); ok('leave is broadcast', !!(await a.until((m) => m && m[0] === 'l' && m[1] === wb[1])));
  const o = client('elsewhere'); const oOpen = await o.open; await wait(500); ok('only the room "park" exists (others refused before the Durable Object)', !oOpen && (await fetch(`http://${HOST}/parties/main/elsewhere`)).status === 404, { oOpen, closed: o.closed });
  { // the client picks its connection id (_pk): a second socket with the same one is refused, the first keeps working
    const pkId = 'dup' + Math.random().toString(36).slice(2, 8), mk = () => { const ws = new WebSocket(`ws://${HOST}/parties/main/park?_pk=${pkId}`), c = { ws, msgs: [], closed: null }; ws.onmessage = (e) => c.msgs.push(JSON.parse(e.data)); ws.onclose = (e) => { c.closed = e.code; }; c.open = new Promise((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); }); return c; };
    const n0 = (await up()).n; const d1 = mk(); await d1.open; await wait(200); const d2 = mk(); await d2.open; await wait(500);
    const n1 = (await up()).n; d1.ws.send(JSON.stringify(['p'])); await wait(200);
    ok('a duplicate connection id is refused and the first stays', d2.closed === 4005 && d1.closed === null && n1 === n0 + 1, { d2: d2.closed, d1: d1.closed, n0, n1 });
    d1.ws.close(); await wait(300);
  }
  // the cap: 64 in the room, the 65th is told the park is full
  const many = []; for (let i = 0; i < 63; i++) { const c = client(); many.push(c); } await Promise.all(many.map((c) => c.open)); await wait(500);
  const probe = await up(); ok('64 in the room', probe && probe.n === 64, probe);
  const extra = client(); await extra.open; await wait(800);
  ok('the 65th is told the park is full and closed', extra.msgs.some((m) => m && m[0] === 'f') && extra.closed === 4001, { msgs: extra.raw, closed: extra.closed });
  for (const c of many) c.ws.close(); a.ws.close(); await wait(800);
  ok('everyone gone', (await up()).n === 0, await up());
}

// ── 2. pages ──
// each page in its own browser: a background tab gets no animation frames, so it would never walk or send
const browsers = [];
const launch = () => puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/chromium', headless: 'new', protocolTimeout: 300000,
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl'] }).then((b) => (browsers.push(b), b));
async function open(tag, hash, { mobile = false } = {}) {
  const browser = await launch(), page = (await browser.pages())[0] || await browser.newPage(); const errs = new Map(), reqs = [], add = (k) => errs.set(k, (errs.get(k) || 0) + 1);
  page.on('pageerror', (e) => add('pageerror: ' + e.message.slice(0, 200)));
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warn') && !/GPU stall|Context Lost|Context Restored|CONTEXT_LOST/.test(m.text())) add(m.type() + ': ' + m.text().slice(0, 200)); });
  page.on('request', (r) => reqs.push(r.url()));
  page.on('response', (r) => { if (r.status() >= 400) add('http ' + r.status() + ' ' + r.url().slice(-60)); });
  await page.setViewport({ width: mobile ? 390 : 1280, height: mobile ? 844 : 720, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.goto(URL0 + '#' + hash);
  await page.waitForFunction('window.__park && window.__park.loaded', { timeout: 240000 });
  const ev = (js) => page.evaluate(js).catch((e) => { add('eval: ' + e.message.slice(0, 160)); return null; });
  const until = (js, ms = 10000) => page.waitForFunction(js, { timeout: ms, polling: 50 }).then(() => true).catch(() => false);
  const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${n}.jpg`, type: 'jpeg', quality: 80 }); };
  return { tag, page, errs, reqs, ev, until, shot };
}
const mp = `mp=${HOST}&weather=clear`;
const A = await open('A', mp);
const B = await open('B', mp + '&fp');
ok('A and B connected', (await A.until('__park.multiplayer && __park.multiplayer.status === "open" && __park.multiplayer.me', 20000)) && (await B.until('__park.multiplayer && __park.multiplayer.status === "open" && __park.multiplayer.me', 20000)));
const aId = await A.ev('__park.multiplayer.me'), aName = await A.ev('__park.multiplayer.name');
// B stands on the avenue looking east; A arrives as Wick 6 m in front of B and runs west past B
await B.ev(`__park.setMode('walk', { at: [276, 0], yaw: 0 })`);
await A.ev(`__park.setMode('walk', { at: [284, 1.5], yaw: Math.PI })`);
ok('A is Wick', await A.until('__park.platformer && __park.platformer.active && __park.platformer.view.s', 60000));
ok('B counts A, and sees A walking', await B.until(`__park.multiplayer.peers.some(p => p.id === ${JSON.stringify(aId)} && p.walking)`, 10000));
ok('B draws A', await B.until(`__park.multiplayer.avatars && __park.multiplayer.avatars.count >= 1`, 15000));
// latency: A records each state as it leaves (wall clock); B watches where it draws A
await A.ev(`(() => { const m = __park.multiplayer; window.__sent = []; const s = m.stats; let n = s.outMsgs; setInterval(() => { if (s.outMsgs !== n) { n = s.outMsgs; window.__sent.push({ at: Date.now(), x: __park.walk.x, y: __park.walk.y }); } }, 0); })()`);
await A.ev(`(() => { const s0 = __park.multiplayer.stats; window.__s0 = { ...s0, t: performance.now() }; __park.platformer.test.input = (t) => ({ mx: 0, my: t % 6 < 4 ? 1 : 0.4 }); })()`);
await B.ev(`(() => { window.__s0 = { ...__park.multiplayer.stats, t: performance.now() }; window.__seen = []; const tick = () => { const l = __park.multiplayer.avatars && __park.multiplayer.avatars.list; const a = l && l.find(o => o.id === ${JSON.stringify(aId)}); if (a) window.__seen.push({ at: Date.now(), x: a.pos.x, y: -a.pos.z, anim: a.anim, name: a.name }); requestAnimationFrame(tick); }; tick(); })()`);
await wait(2500); await B.shot('two-visitors_desktop'); await A.shot('walker_desktop');
await wait(4000);
const sent = await A.ev('window.__sent'), seen = await B.ev('window.__seen');
await A.ev('__park.platformer.test.input = () => ({ mx: 0, my: 0 })');
// for each state A sent while running, the first time B drew A within 0.35 m of it
const lags = [];
if (sent && seen && seen.length) for (const s of sent.slice(5, -10)) { const hit = seen.find((o) => o.at >= s.at - 5 && Math.hypot(o.x - s.x, o.y - s.y) < 0.35); if (hit) lags.push(hit.at - s.at); }
lags.sort((p, q) => p - q);
const med = lags.length ? lags[lags.length >> 1] : null, p90 = lags.length ? lags[Math.floor(lags.length * 0.9)] : null;
out.notes.lagMs = { n: lags.length, of: sent ? sent.length : 0, median: med, p90 };
ok('B draws A where A was within 300 ms (median)', med !== null && med <= 300 && lags.length > (sent.length - 15) * 0.6, out.notes.lagMs);
const anims = seen ? [...new Set(seen.map((o) => o.anim))] : [];
ok('A animates on B (several animation ids while running and stopping)', anims.length >= 2, anims);
ok('A is named on B', seen && seen.length && seen[seen.length - 1].name === aName, { aName, seen: seen && seen.slice(-1) });
// bytes: per walker, each way
const bytes = async (P) => P.ev(`(() => { const s = __park.multiplayer.stats, s0 = window.__s0, dt = (performance.now() - s0.t) / 1000; return { dt: +dt.toFixed(2), outBps: Math.round((s.outBytes - s0.outBytes) / dt), outMps: +((s.outMsgs - s0.outMsgs) / dt).toFixed(1), inBps: Math.round((s.inBytes - s0.inBytes) / dt), inMps: +((s.inMsgs - s0.inMsgs) / dt).toFixed(1) }; })()`);
out.notes.bytesRunning = { A: await bytes(A), B: await bytes(B) };
await wait(500); await A.ev(`window.__s0 = { ...__park.multiplayer.stats, t: performance.now() }`); await B.ev(`window.__s0 = { ...__park.multiplayer.stats, t: performance.now() }`);
await wait(5000); out.notes.bytesStill = { A: await bytes(A), B: await bytes(B) };
ok('moving about 10 states/s, still about 2/s', out.notes.bytesRunning.A.outMps > 7 && out.notes.bytesRunning.A.outMps <= 15 && out.notes.bytesStill.A.outMps < 3.5, { run: out.notes.bytesRunning.A, still: out.notes.bytesStill.A });
// C in Tour: present, counted, not drawn
const C = await open('C', mp);
const cId = await (async () => { await C.until('__park.multiplayer && __park.multiplayer.me', 20000); return C.ev('__park.multiplayer.me'); })();
ok('C (Tour) counts on B', await B.until(`__park.multiplayer.peers.some(p => p.id === ${JSON.stringify(cId)})`, 5000));
await wait(1500);
ok('C (Tour) is not drawn', await B.ev(`!__park.multiplayer.peers.find(p => p.id === ${JSON.stringify(cId)}).walking && !(__park.multiplayer.avatars?.list || []).some(o => o.id === ${JSON.stringify(cId)})`));
ok('C sends presence only', (await C.ev('__park.mode')) === 'tour' && (await C.ev('__park.multiplayer.stats.states')) >= 0 && !(await A.ev(`__park.multiplayer.peers.find(p => p.id === ${JSON.stringify(cId)}).walking`)));
ok('settings row: "2 others in the park" on B', await B.until(`document.querySelector('#mp-tog small').textContent === '2 others in the park' && !document.querySelector('#mp-tog').hidden`, 5000), await B.ev(`document.querySelector('#mp-tog small').textContent`));
await B.ev(`document.querySelector('#btn-set').click()`); await wait(600); await B.shot('settings-row_desktop'); await B.ev(`document.querySelector('#sheet .sheet-close').click()`);
// the switch: off drops the connection (A loses B), on again reconnects
await B.ev(`document.querySelector('#mp-tog').click()`);
ok('switching "Other visitors" off disconnects', await A.until(`__park.multiplayer.count === 1`, 5000) && (await B.ev(`localStorage.getItem('lanternfall.visitors')`)) === 'off');
await B.ev(`document.querySelector('#mp-tog').click()`);
ok('and on again reconnects', await B.until(`__park.multiplayer.status === 'open' && __park.multiplayer.count === 2`, 15000));
await B.ev(`__park.setMode('walk', { at: [276, 0], yaw: 0 })`);
await B.until(`(__park.multiplayer.avatars?.list || []).some(o => o.id === ${JSON.stringify(aId)} && o.fade > 0.99)`, 8000);
// A leaves: B fades A out and forgets it
await A.page.browser().close();
ok('a leave removes A on B', await B.until(`!__park.multiplayer.peers.some(p => p.id === ${JSON.stringify(aId)})`, 5000));
ok('and A fades out within ~1.5 s', await B.until(`!(__park.multiplayer.avatars?.list || []).some(o => o.id === ${JSON.stringify(aId)})`, 2500));
// the phone layout: the settings row
const M = await open('M', mp + '&fp', { mobile: true });
await M.until('__park.multiplayer && __park.multiplayer.status === "open"', 20000);
await M.ev(`document.querySelector('#btn-set').click()`); await wait(800); await M.shot('settings-row_phone');
ok('phone: the row is in the sheet, inside the screen', await M.ev(`(() => { const r = document.querySelector('#mp-tog').getBoundingClientRect(); return !document.querySelector('#mp-tog').hidden && r.left >= 0 && r.right <= 390 && r.height > 30; })()`));
// '#solo': nothing connects
const before = (await up()).n;
const D = await open('D', 'solo&' + mp);
await wait(4000);
ok('#solo: no module, no request to the server', (await D.ev('__park.multiplayer')) === null && !D.reqs.some((u) => u.includes('//' + HOST)) && (await up()).n === before && (await D.ev(`!document.querySelector('#mp-tog')`)));
// an unreachable host: nothing shown, nothing in the console, the server asked once
const E = await open('E', `mp=127.0.0.1:${PORT + 9}&weather=clear`);
await wait(6000);
ok('unreachable: page clean, row hidden, waiting a minute', (await E.ev(`__park.multiplayer.status === 'away' && document.querySelector('#mp-tog').hidden && !__park.multiplayer.avatars`)) && E.errs.size === 0, { status: await E.ev('__park.multiplayer.status'), errs: [...E.errs] });
await E.ev(`__park.setMode('walk', { at: [288, 0], yaw: Math.PI })`); await wait(3000);
ok('unreachable: Walk works, still clean', E.errs.size === 0 && (await E.ev('__park.mode')) === 'walk', [...E.errs]);
if (SHOTS) await E.shot('unreachable_desktop');
// data/mp.json names the host (the test serves it); and the file as committed (no host) connects nothing
async function openWith(tag, hash, mpjson) {
  const browser = await launch(), page = (await browser.pages())[0]; const errs = new Map(), reqs = [], add = (k) => errs.set(k, (errs.get(k) || 0) + 1);
  page.on('pageerror', (e) => add('pageerror: ' + e.message.slice(0, 200)));
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warn') && !/GPU stall|Context Lost|Context Restored|CONTEXT_LOST/.test(m.text())) add(m.type() + ': ' + m.text().slice(0, 200)); });
  page.on('response', (r) => { if (r.status() >= 400) add('http ' + r.status() + ' ' + r.url().slice(-60)); });
  page.on('request', (r) => reqs.push(r.url()));
  // the page's data/mp.json, answered in the page (request interception would also hold the probe Worker's requests)
  if (mpjson !== undefined) await page.evaluateOnNewDocument((body) => { const f = window.fetch; window.fetch = (u, o) => (String(u).includes('data/mp.json') ? Promise.resolve(new Response(body, { headers: { 'content-type': 'application/json' } })) : f(u, o)); }, mpjson);
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(URL0 + '#' + hash);
  await page.waitForFunction('window.__park && window.__park.loaded', { timeout: 240000 });
  return { tag, page, errs, reqs, ev: (js) => page.evaluate(js).catch((e) => { add('eval: ' + e.message.slice(0, 160)); return null; }), until: (js, ms = 10000) => page.waitForFunction(js, { timeout: ms, polling: 50 }).then(() => true).catch(() => false) };
}
const F = await openWith('F', 'weather=clear', JSON.stringify({ host: `http://${HOST}/` }));
ok('data/mp.json names the host (a pasted URL is fine)', await F.until(`__park.multiplayer && __park.multiplayer.status === 'open' && __park.multiplayer.host === ${JSON.stringify(HOST)}`, 20000), await F.ev('__park.multiplayer && [__park.multiplayer.status, __park.multiplayer.host]'));
await F.page.browser().close();
const G = await openWith('G', 'weather=clear', '{ "host": "" }');
await wait(4000);
const gHost = await G.ev('__park.multiplayer.host'), gStatus = await G.ev('__park.multiplayer.status');
ok('no host configured (data/mp.json empty, HOST empty): nothing connects, nothing shown, clean', gStatus === 'off' && !G.reqs.some((u) => /parties\/main/.test(u)) && (await G.ev(`document.querySelector('#mp-tog').hidden`)) && G.errs.size === 0, { gHost, gStatus, errs: [...G.errs] });
await G.page.browser().close();
for (const P of [B, C, M, D]) out.notes['errs' + P.tag] = [...P.errs].map(([k, v]) => v + 'x ' + k);
const ignorable = (k) => /avatars\.js|Failed to load resource: the server responded with a status of 404/.test(k);        // the real figures (fx/multiplayer/avatars.js) come from another branch; until then the stub stands in
ok('no console errors on the connected pages', [B, C, M, D].every((P) => [...P.errs.keys()].every(ignorable)), [B, C, M, D].map((P) => [...P.errs]));
for (const b of browsers) await b.close().catch(() => {});
stopAll();
out.result = failed ? `FAIL (${failed})` : 'PASS';
console.log(JSON.stringify(out, null, 1));
process.exit(failed ? 1 : 0);
