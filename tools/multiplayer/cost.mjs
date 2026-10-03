// What other visitors cost a page: frame time and the networking's own main-thread time with 0, 8 and 24 walkers
// (tools/multiplayer/bots.mjs) around a Wick on the gate plaza, desktop 1280x720 and the 390x844 phone layout.
// Frames are timed without vsync. The figures module's cost is included in the frame time, not in "net ms".
// usage: node tools/multiplayer/cost.mjs [http://127.0.0.1:8962/index.html] [--port 8970] [--only desktop|phone]
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
const { default: puppeteer } = await import(process.env.PUPPETEER_CORE ? pathToFileURL(process.env.PUPPETEER_CORE).href : 'puppeteer-core');
const args = process.argv.slice(2), opt = (k, d) => (args.includes('--' + k) ? args[args.indexOf('--' + k) + 1] : d);
const URL0 = (args[0] && !args[0].startsWith('--') ? args[0] : 'http://127.0.0.1:8962/index.html').split('#')[0];
const PORT = +opt('port', 8970), HOST = `127.0.0.1:${PORT}`, only = opt('only', '');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const up = () => fetch(`http://${HOST}/parties/main/park`).then((r) => r.json()).catch(() => null);
let pk = null;
if (!(await up())) { pk = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], { cwd: ROOT, detached: true, stdio: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }); for (let i = 0; i < 120 && !(await up()); i++) await wait(500); }
const children = [];
const stop = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } } if (pk) { try { process.kill(-pk.pid, 'SIGTERM'); } catch (e) { /* gone */ } pk = null; } };
process.on('exit', stop);
const rows = [];
for (const mobile of [false, true]) {
  if (only && only !== (mobile ? 'phone' : 'desktop')) continue;
  const W = mobile ? 390 : 1280, H = mobile ? 844 : 720;
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/chromium', headless: 'new', protocolTimeout: 300000,
    args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', '--disable-gpu-vsync', '--disable-frame-rate-limit', `--window-size=${W},${H}`] });
  const page = (await browser.pages())[0];
  await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.goto(`${URL0}#mp=${HOST}&weather=clear`);
  await page.waitForFunction('window.__park && window.__park.loaded && __park.multiplayer && __park.multiplayer.status === "open"', { timeout: 240000 });
  await page.evaluate(`__park.setMode('walk', { at: [284, 0], yaw: 0 })`);
  await page.waitForFunction('__park.platformer && __park.platformer.active && __park.platformer.view.s', { timeout: 60000 }).catch(() => {});
  await wait(4000);
  let bots = null;
  for (const n of [0, 8, 24]) {
    if (bots) { bots.kill('SIGTERM'); bots = null; await wait(2500); }
    if (n) { bots = spawn('node', [path.join(ROOT, 'tools/multiplayer/bots.mjs'), String(n), '--host', HOST, '--at', '290,0'], { stdio: 'ignore' }); children.push(bots); }
    await page.waitForFunction(`__park.multiplayer.count === ${n}`, { timeout: 15000 }).catch(() => {});
    await wait(4000);
    const r = await page.evaluate(() => new Promise((res) => {
      const s = __park.multiplayer.stats, ms0 = s.ms, in0 = s.inBytes, dts = []; let last = performance.now(); const t0 = last;
      const tick = () => { const now = performance.now(); dts.push(now - last); last = now; if (now - t0 < 5000) requestAnimationFrame(tick); else { dts.sort((a, b) => a - b); const sum = dts.reduce((a, b) => a + b, 0);
        res({ frames: dts.length, medianMs: +dts[dts.length >> 1].toFixed(2), meanMs: +(sum / dts.length).toFixed(2), p95Ms: +dts[Math.floor(dts.length * 0.95)].toFixed(2), netMsPerFrame: +((s.ms - ms0) / dts.length).toFixed(4), inBps: Math.round((s.inBytes - in0) / ((now - t0) / 1000)), drawn: __park.multiplayer.count }); } };
      requestAnimationFrame(tick);
    }));
    rows.push({ layout: mobile ? 'phone 390x844@2' : 'desktop 1280x720', others: n, ...r });
    console.error(JSON.stringify(rows[rows.length - 1]));
  }
  if (bots) bots.kill('SIGTERM');
  await browser.close();
}
stop();
console.log(JSON.stringify(rows, null, 1));
process.exit(0);
