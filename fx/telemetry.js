// Frame-time reports: how the park runs on real devices (emulation on a desktop GPU is not a phone).
// What is sent (README "Frame-time reports"): a random id made for this visit (kept only in this page's memory), the
// device class, OS and browser family with major versions, the GPU name the browser reports, CPU cores, memory class,
// screen and canvas size, pixel ratio, the picture preset (and whether the visitor chose it), how many steps the
// automatic quality ladder took, frame-time statistics, load times, context losses and up to five script error
// messages. No accounts, no cookies, nothing stored on the device, no positions, nothing typed; the server reads no
// address or headers (party/frames.ts).
// Sent to POST https://<host>/api/frames, host as for other visitors (data/mp.json, '#mp=' for a local server):
// on open, at ~15 s, ~60 s, then every 4 minutes, and on leave (sendBeacon). Off on local addresses, under automation
// (navigator.webdriver: capture runs), with '#notelemetry' and with '#solo' (a visit that talks to no server);
// '#telemetry' turns it on anyway (with '#mp=127.0.0.1:8970' for a local `npm run party:dev`).
const cleanHost = (v) => { if (typeof v !== 'string') return null; const h = v.trim().replace(/^(wss?|https?):\/\//, '').replace(/\/+$/, ''); return /^[\w.-]+(:\d{1,5})?$/.test(h) ? h : null; };
const isLocal = (h) => /^(localhost|127\.0\.0\.1|192\.168\.|10\.|\[::1\])/.test(h);
const SCHEDULE = [0, 15, 60];                  // s after open; then every EVERY s
const EVERY = 240, MAX_REPORTS = 40;

function platform() {
  const ua = navigator.userAgent, d = navigator.userAgentData;
  let os = 'other', osv = '', br = 'other', brv = '';
  const m = (re) => { const x = re.exec(ua); return x ? x[1] : ''; };
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) { os = 'ios'; osv = m(/OS (\d+)[_.]/) || m(/Version\/(\d+)/); }
  else if (/Android/.test(ua)) { os = 'android'; osv = m(/Android (\d+)/); }
  else if (/Windows/.test(ua)) os = 'windows'; else if (/CrOS/.test(ua)) os = 'chromeos'; else if (/Mac OS X/.test(ua)) os = 'mac'; else if (/Linux/.test(ua)) os = 'linux';
  if (/SamsungBrowser\/(\d+)/.test(ua)) { br = 'samsung'; brv = m(/SamsungBrowser\/(\d+)/); }
  else if (/Edg\/(\d+)/.test(ua)) { br = 'edge'; brv = m(/Edg\/(\d+)/); }
  else if (/Firefox\/(\d+)|FxiOS\/(\d+)/.test(ua)) { br = 'firefox'; brv = m(/(?:Firefox|FxiOS)\/(\d+)/); }
  else if (/CriOS\/(\d+)/.test(ua)) { br = 'chrome'; brv = m(/CriOS\/(\d+)/); }
  else if (/Chrome\/(\d+)/.test(ua)) { br = 'chrome'; brv = m(/Chrome\/(\d+)/); }
  else if (/Safari\//.test(ua)) { br = 'safari'; brv = m(/Version\/(\d+)/); }
  if (d && d.platform && os === 'other') os = String(d.platform).toLowerCase().slice(0, 12);
  return { os, osv, br, brv };
}
function gpuName(gl) {
  try { const e = gl.getExtension('WEBGL_debug_renderer_info'), v = gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER); return v ? String(v).slice(0, 96) : ''; } catch (e) { return ''; }   // '' while the context is lost: asked again at the next report
}
// frame intervals in 0.5 ms bins up to 250 ms: medians and tails without keeping every frame
function makeHist() { return { b: new Uint32Array(501), n: 0, sum: 0, slow: 0, jank: 0 }; }
function addHist(h, ms) { h.b[Math.min(500, Math.round(ms * 2))]++; h.n++; h.sum += ms; if (ms > 34) h.slow++; if (ms > 50) h.jank++; }
function stats(h) {
  if (!h.n) return { n: 0 };
  const q = (f) => { const k = f * (h.n - 1); let c = 0; for (let i = 0; i < h.b.length; i++) { c += h.b[i]; if (c > k) return i / 2; } return 250; };
  return { n: h.n, med: q(0.5), p90: q(0.9), p99: q(0.99), slow: +(h.slow / h.n).toFixed(4), jank: +(h.jank / h.n).toFixed(4), fps: +(1000 * h.n / h.sum).toFixed(1) };
}

// park: window.__park; opts: { quality(), chosen(), weather(), mobile, DATA }
export function startTelemetry(park, opts = {}) {
  const hash = new Set(location.hash.slice(1).split(/[&,+]/));
  if (hash.has('notelemetry') || hash.has('solo')) return null;
  if (!hash.has('telemetry') && (navigator.webdriver || isLocal(location.hostname) || location.protocol === 'file:')) return null;   // '#telemetry' forces it on (testing against a local server)
  const T = { sid: '', seq: 0, host: '', all: makeHist(), win: makeHist(), err: [], ready: 0, walk: 0, failed: false, last: 0, on: true, timers: [] };
  try { T.sid = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')).slice(0, 12); } catch (e) { return null; }
  const r = park.renderer, gl = r.getContext(), P = platform(), coarse = matchMedia('(pointer: coarse)').matches;
  const dev = { cls: opts.mobile ? 'phone' : 'desk', ...P, gpu: gpuName(gl), cores: navigator.hardwareConcurrency || 0, mem: navigator.deviceMemory || 0,
    sw: screen.width, sh: screen.height, dpr: devicePixelRatio || 1, touch: coarse };
  // script errors: the message and the file name only (no query strings, no stack)
  const onErr = (msg) => { if (T.err.length < 5) T.err.push(String(msg).replace(/https?:\/\/[^\s)]*\/([^/\s?)]+)(\?[^\s)]*)?/g, '$1').slice(0, 160)); };
  addEventListener('error', (e) => onErr((e.message || 'error') + (e.filename ? ' @' + e.filename.split('/').pop().split('?')[0] + ':' + e.lineno : '')));
  addEventListener('unhandledrejection', (e) => onErr('rejection: ' + (e.reason && e.reason.message || e.reason)));
  // frame intervals from requestAnimationFrame (what the visitor sees, vsync included), only while visible and loaded
  let prev = 0, skip = 0;
  const tick = (now) => {
    if (!T.on) return;
    requestAnimationFrame(tick);
    if (document.hidden || !park.loaded) { prev = 0; skip = 30; return; }
    if (prev && skip <= 0) { const d = now - prev; if (d > 0 && d < 1000) { addHist(T.all, d); addHist(T.win, d); } }
    skip--; prev = now;
  };
  requestAnimationFrame(tick);
  const veil = document.querySelector('#veil');
  const stamp = setInterval(() => {
    if (!T.ready && veil && veil.classList.contains('done')) T.ready = performance.now();
    if (!T.walk && park.loaded) T.walk = performance.now();
    if (!T.failed && document.querySelector('#veil.failed')) T.failed = true;
    if (T.walk) clearInterval(stamp);
  }, 100);
  function report(why) {
    if (!T.host || T.seq >= MAX_REPORTS) return;
    const s = (ms) => (ms ? +(ms / 1000).toFixed(2) : null);
    if (!dev.gpu) dev.gpu = gpuName(gl);
    const body = JSON.stringify({ v: 1, sid: T.sid, seq: T.seq++, why, t: +(performance.now() / 1000).toFixed(1), build: opts.build ? String(opts.build()).slice(0, 24) : null,
      dev, view: { q: opts.quality ? opts.quality() : null, chosen: opts.chosen ? !!opts.chosen() : null, steps: park.perf ? park.perf.step : null, pr: +r.getPixelRatio().toFixed(3),
        cw: r.domElement.width, ch: r.domElement.height, mode: park.mode || null, weather: opts.weather ? opts.weather() : null, guests: opts.guests ? !!opts.guests() : null },
      load: { ready: s(T.ready), walk: s(T.walk), failed: T.failed, lost: park.glCtx ? park.glCtx.losses : 0 },
      win: stats(T.win), all: stats(T.all), err: T.err });
    T.win = makeHist();
    const url = `${isLocal(T.host) ? 'http' : 'https'}://${T.host}/api/frames`;
    try {
      if (why === 'leave' && navigator.sendBeacon) navigator.sendBeacon(url, body);
      else fetch(url, { method: 'POST', body, keepalive: true, mode: 'cors', credentials: 'omit', headers: { 'content-type': 'text/plain' } }).catch(() => {});
    } catch (e) { /* never in the way */ }
  }
  (async () => {
    let h = '';
    for (const t of hash) if (t.startsWith('mp=')) h = cleanHost(t.slice(3)) || '';
    if (!h) try { const res = await fetch((opts.DATA || 'data/') + 'mp.json', { cache: 'no-cache' }); if (res.ok) h = cleanHost((await res.json()).host) || ''; } catch (e) { /* no host: nothing is sent */ }
    T.host = h; if (!h) return;
    for (const s of SCHEDULE) T.timers.push(setTimeout(() => report(s ? 't' + s : 'open'), s * 1000));
    T.timers.push(setTimeout(() => T.timers.push(setInterval(() => { if (!document.hidden) report('tick'); }, EVERY * 1000)), 60_000));
  })();
  addEventListener('pagehide', () => report('leave'));
  document.addEventListener('visibilitychange', () => { if (document.hidden && T.all.n) report('leave'); });
  return { get state() { return { sid: T.sid, host: T.host, seq: T.seq, all: stats(T.all) }; }, report, stop() { T.on = false; for (const t of T.timers) { clearTimeout(t); clearInterval(t); } } };
}
