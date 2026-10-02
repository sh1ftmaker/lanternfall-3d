// usage: node run.mjs <script.mjs> [--url U] [--mobile] [--w W --h H] [--gl] [--hash '#...']
// script.mjs exports default async (page, ctx) => result; ctx = { shot(name), log, sleep, evaluate }
import puppeteer from 'puppeteer-core';
import path from 'node:path';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const mobile = args.includes('--mobile');
const W = +opt('w', mobile ? 390 : 1280), H = +opt('h', mobile ? 844 : 720);
const angle = args.includes('--gl') ? ['--use-angle=gl'] : ['--use-angle=vulkan', '--enable-features=Vulkan'];
const extra = args.includes('--novsync') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', ...angle, ...extra, `--window-size=${W},${H}`] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : +opt('dsf', 1), isMobile: mobile, hasTouch: mobile });
const logs = [];
page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text().slice(0, 400)));
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message.slice(0, 400)));
const url = opt('url', 'http://127.0.0.1:8851/index.html') + (opt('hash', '') || '');
await page.goto(url, { waitUntil: 'domcontentloaded' });
try { await page.waitForFunction(opt('until', 'window.__park && window.__park.loaded'), { timeout: 240000, polling: 500 }); } catch (e) { logs.push('[timeout waiting for load]'); }
const out = opt('out', path.resolve('/tmp/claude-1000/-home-zalo/253e908b-4e3c-4d12-a43e-a8b3b88482f6/scratchpad/agents/platformer/shots'));
const ctx = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  shot: async (name, o = {}) => { const p = path.join(out, name + '.jpg'); await page.screenshot({ path: p, type: 'jpeg', quality: o.q || 85, clip: o.clip }); return p; },
  logs, args, opt,
};
const mod = await import(path.resolve(args[0]));
let res;
try { res = await mod.default(page, ctx); } catch (e) { res = 'SCRIPT ERROR ' + e.stack; }
if (res !== undefined) console.log(typeof res === 'string' ? res : JSON.stringify(res, null, 1));
const keep = logs.filter((l) => !/GPU stall|Context Lost|Context Restored|CONTEXT_LOST/.test(l));
if (keep.length) console.log('--- console ---\n' + [...new Set(keep)].slice(0, 40).join('\n'));
await browser.close();
