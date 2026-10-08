// Frame-time reports, summarised per device (fx/telemetry.js -> party/frames.ts).
//   node tools/telemetry/read.mjs [--host lanternfall-3d.<sub>.workers.dev] [--key <READ_KEY>] [--days 7] [--json] [--visits]
// The host defaults to data/mp.json's, the key to $LF_READ_KEY. One line per device (class, OS, browser, GPU, screen):
// visits, the last report of each visit pooled: frame-time median / p90 / p99 (ms), share of frames over 34 ms, fps,
// presets seen (* = chosen by the visitor), pixel ratio, adapt steps, load to first frame / walkable (s), context
// losses, errors. --visits lists every visit instead.
import fs from 'node:fs';
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
let host = opt('host', '');
if (!host) try { host = JSON.parse(fs.readFileSync(new URL('../../data/mp.json', import.meta.url), 'utf8')).host || ''; } catch (e) { /* none */ }
host = host.replace(/^(https?|wss?):\/\//, '').replace(/\/+$/, '');
const key = opt('key', process.env.LF_READ_KEY || ''), days = +opt('days', 7);
if (!host || !key) { console.error('need --host (or data/mp.json) and --key (or LF_READ_KEY)'); process.exit(1); }
const local = /^(localhost|127\.|192\.168\.|10\.)/.test(host);
const res = await fetch(`${local ? 'http' : 'https'}://${host}/api/frames?days=${days}`, { headers: { authorization: 'Bearer ' + key } });
if (!res.ok) { console.error('HTTP', res.status); process.exit(1); }
const rows = await res.json();
if (a.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }

const last = new Map();                                     // the latest report of each visit carries its whole-visit stats
for (const r of rows) { const p = last.get(r.sid); if (!p || r.seq >= p.seq) last.set(r.sid, r); }
const visits = [...last.values()];
const med = (x) => { const s = x.filter((v) => v != null).sort((p, q) => p - q); return s.length ? s[s.length >> 1] : null; };
const f = (v, d = 1) => (v == null ? '-' : (+v).toFixed(d));
const devKey = (r) => [r.dev.cls, `${r.dev.os}${r.dev.osv || ''}`, `${r.dev.br}${r.dev.brv || ''}`, r.dev.gpu || '?', `${r.dev.sw}x${r.dev.sh}@${r.dev.dpr}`].join(' | ');
const presets = (list) => { const c = {}; for (const r of list) { const k = (r.view.q || '?') + (r.view.chosen ? '*' : ''); c[k] = (c[k] || 0) + 1; } return Object.entries(c).map(([k, n]) => `${k}:${n}`).join(' '); };

if (a.includes('--visits')) {
  for (const r of visits.sort((x, y) => x.at - y.at)) console.log([new Date(r.at).toISOString().slice(0, 16), r.sid, devKey(r), `${r.view.q}${r.view.chosen ? '*' : ''} pr ${r.view.pr} steps ${r.view.steps}`,
    `frames ${r.all.n} med ${f(r.all.med)} p90 ${f(r.all.p90)} p99 ${f(r.all.p99)} slow ${f(100 * (r.all.slow || 0))}%`, `load ${f(r.load.ready)}/${f(r.load.walk)} s`, r.err.length ? 'errors: ' + r.err.join(' ; ') : ''].join('  '));
  process.exit(0);
}
const groups = new Map();
for (const r of visits) { const k = devKey(r); (groups.get(k) || groups.set(k, []).get(k)).push(r); }
console.log(`${rows.length} reports, ${visits.length} visits, last ${days} days (${host})\n`);
console.log('visits  med   p90   p99   >34ms  fps    pr    steps  first/walk s  lost  err  presets   device');
for (const [k, list] of [...groups].sort((x, y) => y[1].length - x[1].length)) {
  const errs = list.reduce((s, r) => s + r.err.length, 0), lost = list.reduce((s, r) => s + (r.load.lost || 0), 0);
  console.log([String(list.length).padStart(6), f(med(list.map((r) => r.all.med))).padStart(5), f(med(list.map((r) => r.all.p90))).padStart(5), f(med(list.map((r) => r.all.p99))).padStart(5),
    (f(100 * med(list.map((r) => r.all.slow))) + '%').padStart(6), f(med(list.map((r) => r.all.fps))).padStart(6), f(med(list.map((r) => r.view.pr)), 2).padStart(5),
    f(med(list.map((r) => r.view.steps)), 0).padStart(6), `${f(med(list.map((r) => r.load.ready)))}/${f(med(list.map((r) => r.load.walk)))}`.padStart(13),
    String(lost).padStart(5), String(errs).padStart(4), ' ' + presets(list).padEnd(9), ' ' + k].join(' '));
}
const allErr = {}; for (const r of visits) for (const e of r.err) allErr[e] = (allErr[e] || 0) + 1;
const top = Object.entries(allErr).sort((x, y) => y[1] - x[1]).slice(0, 10);
if (top.length) { console.log('\nerrors (visits):'); for (const [e, n] of top) console.log(String(n).padStart(5), e); }
