// fx/game/bounty: the Bounty Board (nightly jobs), the strength bell, the stamp passport, the reward hut (lantern colours)
// and the Lost & Found. See README.md. Everything is a run-time prop; the park's baked geometry is untouched.
import { SPOTS, STAMPS, JOBS, LOST, COLORS, LAND_NAME, LAND_ORDER, DRINK_SECONDS, world } from './data.js';
import { createArt } from './art.js';

const KEY = 'bounty';
const CSS = `
.bty-card{box-sizing:border-box;right:auto;left:50%;transform:translateX(-50%);width:min(380px,calc(100vw - 32px));z-index:9}
.bty-card .bty-date{margin:0 0 8px;font:400 12.5px/1.4 var(--ui);color:var(--muted)}
.bty-job{border-top:1px solid var(--line);padding:9px 0 8px} .bty-job h3{margin:0 0 3px;font:600 15px var(--display);color:var(--paper)}
.bty-job p{margin:0 0 7px;font:400 13px/1.45 var(--ui);color:var(--paper);opacity:.9}
.bty-job.done h3,.bty-job.done p{opacity:.55} .bty-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bty-btn{appearance:none;border:1px solid rgba(255,181,71,.7);border-radius:999px;background:rgba(255,181,71,.1);color:var(--paper);font:600 12.5px var(--ui);padding:7px 14px;cursor:pointer;touch-action:manipulation}
.bty-btn.quiet{border-color:var(--line);background:transparent;opacity:.75;font-weight:500} .bty-btn[disabled]{opacity:.45;cursor:default}
.bty-tag{font:600 10.5px var(--ui);letter-spacing:.12em;text-transform:uppercase;color:var(--amber)}
.bty-in{width:64px;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.06);color:var(--paper);font:600 14px var(--ui);padding:6px 8px;text-align:center}
.bty-stamped{display:inline-block;border:2px solid var(--amber);color:var(--amber);border-radius:6px;padding:1px 8px;font:700 11px var(--ui);letter-spacing:.14em;text-transform:uppercase;transform:rotate(-5deg);opacity:.9}
.bty-foot{margin:8px 0 0;font:400 12.5px/1.4 var(--ui);color:var(--muted)}
.bty-reward{display:flex;align-items:center;gap:10px;border-top:1px solid var(--line);padding:9px 0}
.bty-reward i{flex:none;width:22px;height:22px;border-radius:50%;box-shadow:0 0 10px currentColor;background:currentColor} .bty-reward.lock i{opacity:.28;box-shadow:none}
.bty-reward div{flex:1;min-width:0;font:500 13px/1.35 var(--ui)} .bty-reward small{display:block;color:var(--muted);font:400 12px/1.35 var(--ui)}
.bty-swatches{display:flex;gap:8px;flex-wrap:wrap;margin:2px 0 6px}
.bty-sw{appearance:none;width:32px;height:32px;border-radius:50%;border:2px solid transparent;background:currentColor;box-shadow:0 0 9px currentColor;cursor:pointer;padding:0}
.bty-sw.on{border-color:var(--paper)}
.bty-pass{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:4px 0 6px}
.bty-slot{text-align:center;font:500 10.5px/1.2 var(--ui);color:var(--muted)} .bty-slot svg{width:100%;max-width:64px;height:auto;display:block;margin:0 auto 2px}
.bty-slot.on{color:var(--paper)}
.bty-clues{margin:4px 0 0;padding:0;list-style:none;font:400 12.5px/1.4 var(--ui)} .bty-clues li{margin:0 0 5px;padding-left:12px;position:relative;opacity:.9}
.bty-clues li::before{content:'';position:absolute;left:0;top:.55em;width:6px;height:6px;border-radius:50%;border:1px solid var(--muted)}
.bty-clues b{font-weight:600;color:var(--amber)}
.bty-lf{margin:0;padding:0;list-style:none;font:400 12.5px/1.4 var(--ui)} .bty-lf li{margin:0 0 5px} .bty-lf .got{opacity:.6} .bty-lf b{font-weight:600}
@media (max-width:640px){.bty-card{top:calc(env(safe-area-inset-top,0px) + 110px);max-height:calc(100dvh - 130px)}}
`;
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const rng = (seed) => () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
export function drawJobs(key) { const r = rng(hashStr('bounty|' + key)), ids = JOBS.map((j) => j.id); for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; } return ids.slice(0, 3); }
export const boatCount = (key) => 3 + (hashStr('boats|' + key) % 4);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function init(game) {
  const { THREE: T } = game;
  const art = createArt(game);
  const lands = {}; for (const l of game.manifest.lands) lands[l.id] = l;
  const landHex = (id) => (id === 'spire' ? '#ffdd94' : (game.places.find((p) => p.id === id) || {}).color || '#ffb547');
  const jobById = Object.fromEntries(JOBS.map((j) => [j.id, j]));
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

  /* ── saved state ── */
  const fresh = () => ({ v: 1, day: '', ids: [], jobs: {}, jobsDone: 0, stamps: {}, rings: 0, carry: [], lost: {}, colors: ['amber'], color: 'amber', claimed: {}, hinted: {}, notified: {}, drinkT0: 0, candle: '' });
  const S = Object.assign(fresh(), game.save.get(KEY, {}));
  const commit = () => game.save.set(KEY, S);
  function rollDay(force) {
    const k = force || dayKey(); if (S.day === k) return false;
    stopAllJobs(); S.day = k; S.ids = drawJobs(k); S.jobs = {}; S.drinkT0 = 0; S.candle = '';
    S.carry = S.carry.filter((c) => c.startsWith('lost:')); commit(); return true;
  }

  /* ── placing things ── */
  const P = (s, zr) => { const [x, y] = world(lands, s); return { x, y, z: s.z ?? game.ground(x, y, zr) ?? 0.1 }; };
  const glints = [];    // { sprite, base, ph } pulsed every frame
  const warm = [0.8, 0.62, 0.34];
  function glint(p, { size = 0.4, color = warm, lift = 0.3 } = {}) {
    const g = game.props.glow({ x: p.x, y: p.y, z: p.z + lift, color, size }); const e = { g, base: size, ph: Math.random() * 6, c: color }; glints.push(e);
    return { remove() { g.remove(); const i = glints.indexOf(e); if (i >= 0) glints.splice(i, 1); }, set visible(v) { g.sprite.visible = v; } };
  }
  // a thing in the world: a model, a glint, a prompt. Returns { remove(), prop, hide(), show() }
  function thing({ id, kind, spot, label, use, show, r = 2.2, model = {}, glow = true, size = 0.4, color, scale, lift, yaw }) {
    const p = P(spot);
    const prop = kind ? art.build(kind, { x: p.x, y: p.y, z: p.z, yaw: yaw ?? (hashStr(id || kind || 'x') % 628) / 100, scale, ...model }) : null;
    const gl = glow ? glint(p, { size, color, lift: (lift ?? 0) + 0.45 }) : null;
    const it = id ? game.interact({ id, x: p.x, y: p.y, z: p.z + (lift ?? 0), r, label, use, show }) : null;
    const t = { prop, it, p, remove() { prop && prop.remove(); gl && gl.remove(); it && it.remove(); }, hide() { if (prop) prop.visible = false; if (gl) gl.visible = false; }, reveal() { if (prop) prop.visible = true; if (gl) gl.visible = true; } };
    return t;
  }

  /* ── what you carry ── */
  const ITEM = { letter: 'sealed letter', balloon: 'red balloon', bow: "busker's bow", drink: 'hot cider', log: "ferry master's log" };
  for (const l of LOST) ITEM['lost:' + l.id] = l.name;
  const has = (k) => S.carry.includes(k);
  const give = (k) => { if (!has(k)) S.carry.push(k); commit(); refreshTrack(); };
  const take = (k) => { S.carry = S.carry.filter((c) => c !== k); commit(); refreshTrack(); };
  const state = (id) => (S.jobs[id] && S.jobs[id].s) || 'open';
  const active = (id) => state(id) === 'active';
  const passportCount = () => Object.keys(S.stamps).length;
  const lostCount = () => Object.keys(S.lost).length;

  /* ── the tracker line ── */
  function refreshTrack() {
    const parts = [];
    if (has('drink')) { const left = Math.max(0, DRINK_SECONDS - (Date.now() - S.drinkT0) / 1000); parts.push(`Hot cider: ${Math.floor(left / 60)}:${pad(Math.floor(left % 60))} to the Frostmere gate`); }
    else {
      const act = S.ids.filter(active);
      if (act.length) { const j = jobById[act[0]]; parts.push(j.short + (act.length > 1 ? ` (+${act.length - 1})` : '')); }
    }
    const lost = S.carry.filter((c) => c.startsWith('lost:')).map((c) => ITEM[c]);
    if (lost.length) parts.push(`${lost.join(', ')} for the Lost & Found`);
    else if (!parts.length) { const other = S.carry.filter((c) => !c.startsWith('lost:')).map((c) => ITEM[c]); if (other.length) parts.push('Carrying: ' + other.join(', ')); }
    game.track(KEY, parts.length ? parts.join(' · ') : null, { order: 12 });
  }

  /* ───────────────────────── jobs ───────────────────────── */
  const live = {};       // job id -> [things] while active
  const keep = (id, t) => { (live[id] ||= []).push(t); return t; };
  const stopJob = (id) => { for (const t of live[id] || []) t.remove(); delete live[id]; };
  function stopAllJobs() { for (const id of Object.keys(live)) stopJob(id); stopBoats(); }

  // a pick-up for a job (shown while the job is active and the thing is not in your pocket)
  const pick = (id, item, spot, kind, label, extra = {}) => {
    const t = thing({
      id: `job-${id}-${item}`, kind, spot, label, r: extra.r ?? 2.2, scale: extra.scale, lift: extra.lift, model: extra.model, show: () => active(id) && !has(item),
      use() { if (item === 'drink') S.drinkT0 = Date.now(); give(item); game.toast(`You have the <b>${ITEM[item]}</b>.`, { tone: 'good' }); game.sound('ui_click'); if (extra.once !== false) t.hide(); },
    });
    if (has(item) && extra.once !== false) t.hide();
    return keep(id, t);
  };
  // a hand-over for a job
  const drop = (id, item, spot, kind, o, labelHave, labelNot, line) => {
    const th = keep(id, thing({
      id: `job-${id}-give`, kind, spot, r: 2.6, model: o, glow: true, size: 0.6, lift: kind === 'figure' ? 1.3 : undefined,
      label: () => (has(item) ? labelHave : labelNot),
      use() { if (has(item)) { take(item); if (item === 'drink') S.drinkT0 = 0; complete(id); } else game.toast(line); },
    }));
    return th;
  };

  const START = {
    balloon() {
      pick('balloon', 'balloon', SPOTS.balloon, 'balloon', 'Untangle the balloon', { r: 3.4, lift: 2.8, model: { len: 2.6 } });
      drop('balloon', 'balloon', SPOTS.child, 'figure', { coat: 0x4a90d0, hat: 0xd8c040, scale: 0.62 }, 'Give Pip the balloon', 'Talk to Pip', 'Pip: "My balloon! It blew away over Lantern Row."');
    },
    letter() { give('letter'); drop('letter', 'letter', SPOTS.signing, 'tray', {}, 'Leave the letter on the tray', 'The letter tray', 'A tray for letters. Nothing to leave yet.'); },
    bell() { /* done by the bell's own 'use' event */ },
    boats() { startBoats(); },
    bow() {
      pick('bow', 'bow', SPOTS.bow, 'bow', "Pick up the busker's bow", { scale: 2.2 });
      keep('bow', thing({ kind: 'stool', spot: SPOTS.busker, glow: false }));
      drop('bow', 'bow', { ...SPOTS.busker, x: SPOTS.busker.x + 0.9 }, 'figure', { coat: 0xb04a7a, hat: 0x3a2a4a }, "Give the busker her bow", 'Talk to the busker', 'The busker: "Somebody has seen my bow, I hope. Blossom Lane, I think."');
    },
    drink() {
      pick('drink', 'drink', SPOTS.tavern, 'cup', 'Take a hot cider from the bar', { scale: 2.4, once: false });
      drop('drink', 'drink', SPOTS.gatekeeper, 'figure', { coat: 0x5a6a8a, hat: 0xc0c8d0 }, 'Hand over the hot cider', 'Talk to the gatekeeper', 'The gatekeeper: "Is the Brine & Barrel sending cider? It is cold up here."');
    },
    candle() { keep('candle', thing({ id: 'job-candle', kind: null, spot: SPOTS.shrine, label: 'Light a candle for the wish', r: 2.8, size: 0.8, show: () => active('candle'), use() { lightCandle(); complete('candle'); } })); },
    log() {
      pick('log', 'log', SPOTS.logTable, 'logbook', "Take the ferry master's log", { scale: 2.2 });
      keep('log', thing({ id: 'job-log-give', kind: null, spot: SPOTS.dock, label: () => (has('log') ? 'Leave the log at the cruise dock' : 'The cruise dock'), r: 3, size: 0.8, use() { if (has('log')) { take('log'); complete('log'); } else game.toast('The cruise dock. The ferry master wants his log.'); } }));
    },
  };
  let candleThing = null;
  function lightCandle() { if (candleThing) return; const t = thing({ kind: 'candle', spot: SPOTS.shrine, glow: true, size: 1.1, color: [1.3, 0.8, 0.35], scale: 1.6 }); candleThing = t; S.candle = S.day; commit(); }

  /* boats off the wharf: N of them, floating at the water surface; the answer is given on the board card */
  let boats = [];
  function startBoats() {
    if (boats.length) return; const n = boatCount(S.day), c = SPOTS.boatsAt, r = rng(hashStr('b|' + S.day));
    for (let i = 0; i < n; i++) {
      const x = c.x - 11 + (22 * (i + 0.5 + (r() - 0.5) * 0.4)) / n, y = c.y - r() * 6 - Math.abs(i - n / 2) * 0.4;
      const [wx, wy] = world(lands, { land: c.land, x, y }); const b = art.build('boat', { x: wx, y: wy, z: -0.8, yaw: lands.brinewatch.phi + (r() - 0.5) * 0.4, scale: 1.2 });
      boats.push({ b, y0: -0.8, ph: r() * 6 });
    }
  }
  function stopBoats() { for (const o of boats) o.b.remove(); boats = []; }
  function answerBoats(n) {
    if (!active('boats')) return;
    if (n === boatCount(S.day)) { game.toast('Right. Every boat accounted for.', { tone: 'good' }); complete('boats'); }
    else game.toast(n > boatCount(S.day) ? 'Fewer than that. Count again.' : 'More than that. Count again.');
  }

  function accept(id) {
    if (!S.ids.includes(id) || state(id) !== 'open') return false;
    S.jobs[id] = { s: 'active' }; commit(); START[id](); refreshTrack();
    game.toast(`Job taken: <b>${esc(jobById[id].title)}</b>`, { tone: 'good' }); game.emit('bounty:job', { id, state: 'active' }); renderCard();
    return true;
  }
  function drop_(id) {   // give a job back
    if (!active(id)) return; stopJob(id); if (id === 'boats') stopBoats();
    for (const c of ['letter', 'balloon', 'bow', 'drink', 'log']) if (jobItems[id] === c) take(c);
    delete S.jobs[id]; S.drinkT0 = id === 'drink' ? 0 : S.drinkT0; commit(); refreshTrack(); game.emit('bounty:job', { id, state: 'dropped' }); renderCard();
  }
  const jobItems = { letter: 'letter', balloon: 'balloon', bow: 'bow', drink: 'drink', log: 'log' };
  function complete(id) {
    if (state(id) === 'done') return; stopJob(id); if (id === 'boats') stopBoats();
    S.jobs[id] = { s: 'done' }; S.jobsDone++; commit(); refreshTrack();
    const left = S.ids.filter((j) => state(j) !== 'done').length;
    game.toast(`Done: <b>${esc(jobById[id].title)}</b>. A stamp for the board.${left ? '' : ' That is tonight\'s work.'}`, { tone: 'good' });
    game.sound('ui_click'); game.emit('bounty:job', { id, state: 'done' }); notifyRewards(); renderCard(); game.journal.refresh();
  }

  /* ───────────────────────── the Bounty Board card ───────────────────────── */
  const card = document.createElement('div'); card.className = 'sheet bty-card'; card.hidden = true; card.setAttribute('role', 'dialog');
  card.innerHTML = '<div class="sheet-head"><h2></h2><button type="button" class="sheet-close" aria-label="Close">&times;</button></div><div class="bty-body"></div>';
  document.body.appendChild(card);
  let cardMode = '', cardAt = null;
  const closeCard = () => { card.hidden = true; cardMode = ''; };
  card.querySelector('.sheet-close').addEventListener('click', closeCard);
  addEventListener('keydown', (e) => { if (e.code === 'Escape' && !card.hidden) { e.stopPropagation(); e.preventDefault(); closeCard(); } }, true);
  card.addEventListener('keydown', (e) => e.stopPropagation());
  const openCard = (mode, at) => { cardMode = mode; cardAt = at; card.hidden = false; renderCard(); };
  const nice = (d) => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  function renderCard() {
    if (card.hidden) return;
    const h = card.querySelector('h2'), body = card.querySelector('.bty-body'); body.textContent = '';
    if (cardMode === 'board') {
      h.textContent = 'Bounty Board';
      const date = document.createElement('p'); date.className = 'bty-date'; date.textContent = `${nice(new Date())}. Three jobs, the same for everyone tonight.`; body.appendChild(date);
      for (const id of S.ids) {
        const j = jobById[id], s = state(id), box = document.createElement('div'); box.className = 'bty-job ' + s;
        box.innerHTML = `<h3>${esc(j.title)}</h3><p>${esc(j.text)}</p>`;
        const row = document.createElement('div'); row.className = 'bty-row';
        if (s === 'open') { const b = document.createElement('button'); b.type = 'button'; b.className = 'bty-btn'; b.textContent = 'Take the job'; b.onclick = () => accept(id); row.appendChild(b); }
        else if (s === 'done') row.innerHTML = '<span class="bty-stamped">Done</span>';
        else {
          const tag = document.createElement('span'); tag.className = 'bty-tag'; tag.textContent = 'On it'; row.appendChild(tag);
          if (id === 'boats') {
            const inp = document.createElement('input'); inp.className = 'bty-in'; inp.type = 'number'; inp.inputMode = 'numeric'; inp.min = 0; inp.max = 99; inp.placeholder = '?'; inp.setAttribute('aria-label', 'Number of boats');
            const go = document.createElement('button'); go.type = 'button'; go.className = 'bty-btn'; go.textContent = 'Answer'; const send = () => { const n = parseInt(inp.value, 10); if (!isNaN(n)) answerBoats(n); };
            go.onclick = send; inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); }); row.append(inp, go);
          }
          const q = document.createElement('button'); q.type = 'button'; q.className = 'bty-btn quiet'; q.textContent = 'Give it back'; q.onclick = () => drop_(id); row.appendChild(q);
        }
        box.appendChild(row); body.appendChild(box);
      }
      const f = document.createElement('p'); f.className = 'bty-foot'; f.textContent = `Jobs done in all: ${S.jobsDone}. The reward counter is across the square.`; body.appendChild(f);
    } else {
      h.textContent = 'Rewards';
      const p = document.createElement('p'); p.className = 'bty-date'; p.textContent = "The clerk slides a tray of tinted glass across the counter: a new colour for the lamplighter's lantern."; body.appendChild(p);
      for (const c of COLORS.filter((c) => !c.free)) {
        const ready = rewardReady(c.id), got = S.claimed[c.id], row = document.createElement('div'); row.className = 'bty-reward' + (got || ready ? '' : ' lock'); row.style.color = c.css;
        row.innerHTML = `<i></i><div style="color:var(--paper)">${esc(c.name)}<small>${got ? 'In your journal, to choose from.' : ready ? 'Earned.' : esc(c.need)}</small></div>`;
        if (ready && !got) { const b = document.createElement('button'); b.type = 'button'; b.className = 'bty-btn'; b.textContent = 'Take it'; b.onclick = () => claim(c.id); row.appendChild(b); }
        body.appendChild(row);
      }
      const f = document.createElement('p'); f.className = 'bty-foot'; f.textContent = 'Choose the colour in the journal (B). The lantern shows on the lamplighter, not in first person.'; body.appendChild(f);
    }
  }

  /* ───────────────────────── rewards: Wick's lantern colour ───────────────────────── */
  function rewardReady(id) {
    if (id === 'moss') return S.jobsDone >= 3 || passportCount() >= 8;
    if (id === 'violet') return passportCount() >= 8;
    if (id === 'rose') return lostCount() >= 8;
    if (id === 'frost') return S.jobsDone >= 6;
    return false;
  }
  function notifyRewards() {
    for (const c of COLORS) if (!c.free && rewardReady(c.id) && !S.claimed[c.id] && !S.notified[c.id]) {
      S.notified[c.id] = 1; commit(); setTimeout(() => game.toast(`Something is waiting at the <b>reward counter</b> in Brinewatch: ${esc(c.name)}.`, { ms: 6000 }), 1800);
    }
  }
  function claim(id) {
    const c = COLORS.find((x) => x.id === id); if (!c || !rewardReady(id) || S.claimed[id]) return;
    S.claimed[id] = 1; if (!S.colors.includes(id)) S.colors.push(id); S.color = id; commit(); applyColor(true);
    game.toast(`A new lantern colour: <b>${esc(c.name)}</b>.`, { tone: 'good', ms: 5200 });
    if (!game.player.wick) setTimeout(() => game.toast('There is no lantern in first person. The colour is kept: switch to the lamplighter (P) to see it.', { ms: 6500 }), 900);
    game.emit('bounty:reward', { id }); renderCard(); game.journal.refresh();
  }
  const colorOf = (id) => COLORS.find((c) => c.id === id) || COLORS[0];
  let applied = '', colTick = 0;
  function applyColor(force) {
    const u = game.platformer && game.platformer.character && game.platformer.character.uniforms && game.platformer.character.uniforms.uLanternCol; if (!u) return false;
    const v = u.value || u, c = colorOf(S.color).rgb, cur = v.isColor ? [v.r, v.g, v.b] : [v.x, v.y, v.z];
    if (force || Math.abs(cur[0] - c[0]) + Math.abs(cur[1] - c[1]) + Math.abs(cur[2] - c[2]) > 1e-3) { if (v.isColor) v.setRGB(c[0], c[1], c[2]); else v.set(c[0], c[1], c[2]); }
    return true;
  }
  function chooseColor(id) {
    if (!S.colors.includes(id)) return; S.color = id; commit(); applyColor(true); game.journal.refresh();
    if (!game.player.wick) game.toast('Chosen. There is no lantern in first person: it shows on the lamplighter (P).', { ms: 5000 });
  }

  /* ───────────────────────── the strength bell ───────────────────────── */
  const bellP = P(SPOTS.bell), towerP = P(SPOTS.bellTop);
  const bellGlows = []; let ringT = -1;
  for (let i = 0; i < 9; i++) { const g = game.props.glow({ x: towerP.x, y: towerP.y, z: 0.9 + i * 0.85, color: [1.3, 0.95, 0.4], size: i === 8 ? 3.4 : 1.5 }); g.sprite.visible = false; bellGlows.push(g); }
  let actx = null;
  function bellSound() {
    if (!game.ctx.sound || !game.ctx.sound.on) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume();
      const d = Math.hypot(game.player.x - towerP.x, game.player.y - towerP.y), vol = 0.35 / (1 + d / 18), t0 = actx.currentTime, out = actx.createGain(); out.gain.value = vol; out.connect(actx.destination);
      for (const [k, a, dec] of [[1, 1, 2.4], [2.0, 0.55, 1.8], [2.76, 0.5, 1.3], [4.1, 0.3, 0.9], [0.5, 0.45, 2.8]]) {
        const o = actx.createOscillator(), g = actx.createGain(); o.type = 'sine'; o.frequency.value = 392 * k; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(a * 0.5, t0 + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dec);
        o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + dec + 0.05);
      }
    } catch (e) { /* no audio: fine */ }
  }
  function ringBell() {
    S.rings++; commit(); ringT = 0; bellSound();
    if (active('bell')) complete('bell');
    else if (S.rings === 1) game.toast('<b>Clang.</b> Ring it as often as you like.', { ms: 3000 });
    game.emit('bounty:ring', { count: S.rings });
  }
  const bellIt = game.interact({ id: 'strength-bell', x: bellP.x, y: bellP.y, z: bellP.z, r: 3.8, label: 'Ring the strength bell', use: ringBell });

  /* ───────────────────────── stamp posts ───────────────────────── */
  const posts = {}, fx = [];
  const ringGeo = new T.RingGeometry(0.2, 0.3, 40).rotateX(-Math.PI / 2);
  function paintPost(land) {
    const o = posts[land], on = !!S.stamps[land], c = new T.Color(landHex(land));
    o.prop.parts.flag.material.color.copy(c).multiplyScalar(on ? 1 : 0.38); o.glow.set({ color: on ? [c.r * 2.4, c.g * 2.4, c.b * 2.4] : [0.9, 0.7, 0.4] });
  }
  function flourish(p, land) {
    const c = new T.Color(landHex(land)), m = new T.MeshBasicMaterial({ color: new T.Color(c.r * 2, c.g * 2, c.b * 2), transparent: true, blending: T.AdditiveBlending, depthWrite: false, fog: false, side: T.DoubleSide });
    const ring = new T.Mesh(ringGeo, m); game.v3(p.x, p.y, p.z + 0.1, ring.position); game.scene.add(ring); fx.push({ ring, m, t: 0 });
  }
  function stamp(land) {
    const s = STAMPS[land], name = LAND_NAME[land];
    if (S.stamps[land]) { game.toast(`<b>${esc(name)}</b> is already inked. ${passportCount()} of 8.`); return; }
    S.stamps[land] = Date.now(); commit(); paintPost(land); flourish(posts[land].p, land); game.sound('ui_click');
    const n = passportCount(); game.toast(`Stamped: <b>${esc(name)}</b>. ${n} of 8.${n === 8 ? ' The passport is complete.' : ''}`, { tone: 'good', ms: 5200 });
    game.emit('bounty:stamp', { land, count: n }); game.journal.refresh(); notifyRewards();
    return s;
  }

  /* ───────────────────────── Lost & Found ───────────────────────── */
  const lostThings = {}, shelfProps = {};
  const SHELF_SCALE = { net: 0.45, sword: 1.1, crown: 2.2, mitten: 2.6, ticket: 2.8, cap: 2.0, tag: 2.6, postcard: 2.8 };
  const LOST_SCALE = { net: 1.1, sword: 1.6, crown: 2.2, mitten: 2.6, ticket: 3.2, cap: 2.4, tag: 3, postcard: 3.2 };
  let deskIt = null, shelfBase = null; const SHELF_TILT = 1.0;
  function shelfSlot(i) { const [x, y] = world(lands, { land: SPOTS.shelf.land, x: SPOTS.shelf.x - 3.0 + i * 0.86, y: SPOTS.shelf.y }); return { x, y, z: SPOTS.shelf.z }; }
  function putOnShelf(i) {
    const l = LOST[i]; if (shelfProps[l.id]) return; const p = shelfSlot(i), phi = lands.wanderers.phi;
    const o = art.build(l.id, { x: p.x, y: p.y, z: p.z + 0.03, yaw: phi + Math.PI / 2, scale: SHELF_SCALE[l.id] || 1.5, tint: [0.62, 0.56, 0.5] }); o.g.rotation.order = 'YXZ'; o.g.rotation.x = SHELF_TILT;
    const gl = game.props.glow({ x: p.x, y: p.y, z: p.z + 0.35, color: [0.55, 0.42, 0.24], size: 0.9 }); const rm = o.remove; o.remove = () => { rm(); gl.remove(); };
    shelfProps[l.id] = o;
  }
  function buildLost() {
    LOST.forEach((l, i) => {
      if (S.lost[l.id]) { putOnShelf(i); return; }
      const t = thing({
        id: 'lost-' + l.id, kind: l.id, spot: l.spot, label: `Pick up the ${l.name}`, r: 2.2, scale: LOST_SCALE[l.id] || 2, size: 0.55, lift: 0.1,
        show: () => !has('lost:' + l.id) && !S.lost[l.id],
        use() { give('lost:' + l.id); t.hide(); game.sound('ui_click'); game.toast(`You have the <b>${esc(l.name)}</b>. The Lost & Found is in the Wanderers' Hall grounds.`, { tone: 'good' }); },
      });
      if (has('lost:' + l.id)) t.hide();
      lostThings[l.id] = t;
    });
    const dp = P(SPOTS.desk);
    deskIt = game.interact({ id: 'lostfound-desk', x: dp.x, y: dp.y, z: dp.z, r: 3.4, label: () => (S.carry.some((c) => c.startsWith('lost:')) ? 'Hand in lost things' : 'Lost & Found desk'), use: deskUse });
    const sp = P({ ...SPOTS.shelf, x: SPOTS.shelf.x }); shelfBase = art.build('plank', { x: sp.x, y: sp.y, z: SPOTS.shelf.z - 0.03, yaw: lands.wanderers.phi - Math.PI / 2, tint: [0.62, 0.56, 0.5] });
  }
  function deskUse() {
    const mine = S.carry.filter((c) => c.startsWith('lost:'));
    if (!mine.length) {
      const miss = LOST.find((l) => !S.lost[l.id]);
      game.toast(miss ? `The clerk: "Nothing for me? Somebody is still missing a thing. ${esc(miss.clue)}"` : 'The clerk: "Everything is home. Even the very large hat is claimed."', { ms: 5600 });
      return;
    }
    for (const c of mine) {
      const id = c.slice(5), i = LOST.findIndex((l) => l.id === id); S.lost[id] = Date.now(); take(c); putOnShelf(i); const l = LOST[i];
      game.toast(`Returned: <b>${esc(l.name)}</b>. ${lostCount()} of 8.`, { tone: 'good' }); game.emit('bounty:found', { id, count: lostCount() });
    }
    commit(); game.sound('ui_click'); if (lostCount() >= 8) setTimeout(() => game.toast('All eight things are home. The reward counter in Brinewatch has noticed.', { ms: 5600 }), 1600);
    notifyRewards(); game.journal.refresh();
  }

  /* ───────────────────────── board and hut ───────────────────────── */
  function buildFixed() {
    const bp = P(SPOTS.board), hp = P(SPOTS.hut);
    game.interact({ id: 'bounty-board', x: bp.x, y: bp.y, z: bp.z, r: 3.6, label: 'Read the Bounty Board', use: () => openCard('board', bp) });
    game.interact({ id: 'reward-hut', x: hp.x, y: hp.y, z: hp.z, r: 3.2, label: () => (COLORS.some((c) => !c.free && rewardReady(c.id) && !S.claimed[c.id]) ? 'Collect a reward' : 'The reward counter'), use: () => openCard('hut', hp) });
    for (const land of LAND_ORDER) {
      const s = STAMPS[land], [x, y] = world(lands, s), p = { x, y, z: s.z ?? game.ground(x, y) ?? 0.1 };
      const prop = art.build('post', { x, y, z: p.z, yaw: (hashStr(land) % 628) / 100, color: landHex(land) }), glow = game.props.glow({ x, y, z: p.z + 2.0, color: [0.9, 0.7, 0.4], size: 1.4 });
      glints.push({ g: glow, base: 0.9, ph: Math.random() * 6, c: null });
      posts[land] = { prop, glow, p, it: game.interact({ id: 'stamp-' + land, x, y, z: p.z, r: 2.4, label: () => (S.stamps[land] ? 'Look at the stamp' : 'Stamp the passport'), use: () => stamp(land) }) };
      paintPost(land);
    }
  }

  /* ───────────────────────── the journal ───────────────────────── */
  function stampSvg(land, on, i) {
    const c = landHex(land), rot = ((hashStr(land) % 17) - 8) * 1.2, letter = (LAND_NAME[land].replace(/^The /, '')[0] || '?');
    return `<svg viewBox="0 0 64 64" aria-hidden="true" style="transform:rotate(${rot}deg)">` + (on
      ? `<circle cx="32" cy="32" r="29" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-width="3"/><circle cx="32" cy="32" r="23" fill="none" stroke="${c}" stroke-width="1.4" stroke-dasharray="3 2.4"/><path d="M32 12l3.3 8.2 8.7.7-6.6 5.7 2 8.5-7.4-4.6-7.4 4.6 2-8.5-6.6-5.7 8.7-.7z" fill="${c}" fill-opacity=".85" transform="translate(0 6)"/><text x="32" y="55" text-anchor="middle" font-family="Fraunces,serif" font-weight="700" font-size="11" fill="${c}">${letter}</text>`
      : `<circle cx="32" cy="32" r="29" fill="none" stroke="#9a96b4" stroke-opacity=".5" stroke-width="2" stroke-dasharray="4 4"/><text x="32" y="40" text-anchor="middle" font-family="Fraunces,serif" font-size="22" fill="#9a96b4" fill-opacity=".5">${letter}</text>`) + '</svg>';
  }
  game.journal.section({ id: 'bounty', title: 'Bounty Board', order: 40, render(el) {
    const day = document.createElement('div');
    day.innerHTML = `<p class="gj-empty" style="margin:0 0 6px">Tonight's jobs, from the board at Brinewatch Wharf.</p>`;
    for (const id of S.ids) { const s = state(id), p = document.createElement('p'); p.innerHTML = `${s === 'done' ? '<span class="bty-stamped">Done</span> ' : s === 'active' ? '<span class="bty-tag">On it</span> ' : '<span style="opacity:.6">Open</span> '}${esc(jobById[id].title)}`; day.appendChild(p); }
    el.appendChild(day);
    const meta = document.createElement('p'); meta.className = 'bty-foot'; meta.textContent = `Jobs done in all: ${S.jobsDone}. Strength bell rung ${S.rings} time${S.rings === 1 ? '' : 's'}.`; el.appendChild(meta);
    const h = document.createElement('p'); h.style.margin = '8px 0 2px'; h.innerHTML = '<span class="bty-tag">Wick\'s lantern</span>'; el.appendChild(h);
    const sw = document.createElement('div'); sw.className = 'bty-swatches';
    for (const id of S.colors) { const c = colorOf(id), b = document.createElement('button'); b.type = 'button'; b.className = 'bty-sw' + (S.color === id ? ' on' : ''); b.style.color = c.css; b.title = c.name; b.setAttribute('aria-label', c.name + (S.color === id ? ' (chosen)' : '')); b.onclick = () => chooseColor(id); sw.appendChild(b); }
    el.appendChild(sw);
    const more = COLORS.filter((c) => !c.free && !S.colors.includes(c.id));
    const note = document.createElement('p'); note.className = 'bty-foot'; note.style.marginTop = '0';
    note.textContent = `${colorOf(S.color).name}.` + (more.length ? ` ${more.length} more to earn at the reward counter.` : '') + (game.player.wick ? '' : ' It shows on the lamplighter, not in first person.'); el.appendChild(note);
  } });
  game.journal.section({ id: 'passport', title: `Passport`, order: 41, render(el) {
    const n = passportCount(); const sum = document.createElement('p'); sum.className = 'bty-foot'; sum.style.marginTop = '0'; sum.textContent = `${n} of 8 stamps. One post in each land, and one on the Spire's island.`; el.appendChild(sum);
    const grid = document.createElement('div'); grid.className = 'bty-pass';
    LAND_ORDER.forEach((land, i) => { const on = !!S.stamps[land], d = document.createElement('div'); d.className = 'bty-slot' + (on ? ' on' : ''); d.innerHTML = stampSvg(land, on, i) + esc(LAND_NAME[land].replace(/^The /, '')); grid.appendChild(d); });
    el.appendChild(grid);
    const miss = LAND_ORDER.filter((l) => !S.stamps[l]);
    if (miss.length) { const ul = document.createElement('ul'); ul.className = 'bty-clues'; for (const l of miss) { const li = document.createElement('li'); li.innerHTML = `<b>${esc(LAND_NAME[l])}.</b> ${esc(STAMPS[l].clue)}`; ul.appendChild(li); } el.appendChild(ul); }
  } });
  game.journal.section({ id: 'lostfound', title: 'Lost & Found', order: 42, render(el) {
    const sum = document.createElement('p'); sum.className = 'bty-foot'; sum.style.marginTop = '0'; sum.textContent = `${lostCount()} of 8 things back on the shelf. The desk is in the Wanderers' Hall grounds, by the lake axis.`; el.appendChild(sum);
    const ul = document.createElement('ul'); ul.className = 'bty-lf';
    for (const l of LOST) { const li = document.createElement('li'); const back = S.lost[l.id], mine = has('lost:' + l.id); li.className = back ? 'got' : ''; li.innerHTML = back ? `<b>${esc(l.name)}.</b> ${esc(l.back)}` : mine ? `<b>${esc(l.name)}.</b> In your pocket. Take it to the desk.` : `<b>${esc(l.name)}.</b> ${esc(l.clue)}`; ul.appendChild(li); }
    el.appendChild(ul);
  } });

  /* ───────────────────────── hints, frame loop ───────────────────────── */
  const HINTS = [
    { id: 'board', get: () => P(SPOTS.board), r: 14, text: 'The <b>Bounty Board</b>: three jobs a night, and a reward counter across the square.' },
    { id: 'bell', get: () => bellP, r: 14, text: 'A <b>strength bell</b>. Ring it as often as you like.' },
    { id: 'desk', get: () => P(SPOTS.desk), r: 12, text: 'The <b>Lost & Found</b>. Eight things are missing around the park.' },
  ];
  let slow = 0, sec = 0, dayT = 0;
  game.on('frame', ({ dt, time }) => {
    for (const e of glints) { const s = 1 + 0.22 * Math.sin(time * 2.6 + e.ph); e.g.sprite.scale.setScalar(e.base * s); e.g.sprite.material.opacity = 0.65 + 0.35 * Math.sin(time * 2.1 + e.ph * 1.7); }
    for (const o of boats) o.b.g.position.y = o.y0 + 0.05 * Math.sin(time * 1.3 + o.ph);
    if (ringT >= 0) {
      ringT += dt; for (let i = 0; i < 9; i++) { const k = ringT - i * 0.085, v = k < 0 ? 0 : Math.exp(-k * 2.2) * Math.min(1, k * 14); bellGlows[i].sprite.visible = v > 0.02; bellGlows[i].sprite.material.opacity = v; }
      if (ringT > 2.4) { ringT = -1; for (const g of bellGlows) g.sprite.visible = false; }
    }
    for (let i = fx.length - 1; i >= 0; i--) { const f = fx[i]; f.t += dt; const u = f.t / 0.9; f.ring.scale.setScalar(1 + u * 9); f.m.opacity = Math.max(0, 1 - u); if (u >= 1) { game.scene.remove(f.ring); f.m.dispose(); fx.splice(i, 1); } }
    if ((slow += dt) > 0.5) {
      slow = 0; if (S.color !== applied || (colTick++ % 4 === 0)) { if (applyColor()) applied = S.color; }
      if (game.player.mode === 'walk') {
        for (const h of HINTS) if (!S.hinted[h.id]) { const p = h.get(); if (Math.hypot(p.x - game.player.x, p.y - game.player.y) < h.r) { S.hinted[h.id] = 1; commit(); game.toast(h.text, { ms: 5200 }); } }
        for (const land of LAND_ORDER) { const o = posts[land]; if (o && !S.hinted['p' + land] && Math.hypot(o.p.x - game.player.x, o.p.y - game.player.y) < 12 && Math.abs(o.p.z - game.player.z) < 6) { S.hinted['p' + land] = 1; commit(); game.toast(`A <b>stamp post</b> for ${esc(LAND_NAME[land])}. Use it to stamp your passport.`, { ms: 5200 }); break; } }
      }
      if (!card.hidden && cardAt && Math.hypot(cardAt.x - game.player.x, cardAt.y - game.player.y) > 18) closeCard();
    }
    if ((sec += dt) > 1) {
      sec = 0;
      if (has('drink')) { if ((Date.now() - S.drinkT0) / 1000 > DRINK_SECONDS) { take('drink'); S.drinkT0 = 0; commit(); const t = live.drink && live.drink.find((x) => x.p && x.it && x.it.id === 'job-drink-drink'); if (t) t.reveal(); game.toast('The cider has gone cold. Fetch a fresh cup from the Brine & Barrel bar.', { ms: 5600 }); game.emit('bounty:job', { id: 'drink', state: 'failed' }); } else refreshTrack(); }
      if ((dayT += 1) > 20) { dayT = 0; if (S.day !== dayKey()) { rollDay(); resume(); renderCard(); game.journal.refresh(); } }
    }
  });
  game.on('mode', ({ wick }) => { applied = ''; if (wick) slow = 1; });

  function resume() {   // start whatever is active (after a reload or a new day)
    for (const id of S.ids) if (active(id)) START[id]();
    if (has('drink') && (Date.now() - S.drinkT0) / 1000 > DRINK_SECONDS) { take('drink'); S.drinkT0 = 0; }
    if (S.candle === S.day) lightCandle();
    refreshTrack();
  }
  const go = () => { rollDay(); buildFixed(); buildLost(); resume(); notifyRewards(); applied = ''; };
  if (game.started && game.nav) go(); else game.on('start', go);

  // verification + test hooks: every placed thing with its walk-grid height
  const api = {
    state: () => S, jobsToday: () => S.ids.map((id) => ({ id, state: state(id) })), accept, complete, drop: drop_, stamp, claim, chooseColor, answerBoats, ringBell, openCard, closeCard, deskUse,
    boatCount: () => boatCount(S.day), shelfProps: () => Object.keys(shelfProps), stampPosts: () => Object.fromEntries(Object.entries(posts).map(([k, o]) => [k, o.p])), lostPos: () => Object.fromEntries(Object.entries(lostThings).map(([k, t]) => [k, t.p])),
    positions: () => ({ board: P(SPOTS.board), hut: P(SPOTS.hut), bell: bellP, tower: towerP, desk: P(SPOTS.desk), shelf: shelfSlot(0), signing: P(SPOTS.signing), tavern: P(SPOTS.tavern), logTable: P(SPOTS.logTable), dock: P(SPOTS.dock), gatekeeper: P(SPOTS.gatekeeper), shrine: P(SPOTS.shrine), balloon: P(SPOTS.balloon), child: P(SPOTS.child), bow: P(SPOTS.bow), busker: P(SPOTS.busker) }),
    lanternColour: () => colorOf(S.color), applyColor,
    test: { setJobs(ids) { stopAllJobs(); S.ids = ids; S.jobs = {}; S.carry = S.carry.filter((c) => c.startsWith('lost:')); commit(); refreshTrack(); renderCard(); }, newDay(key) { rollDay(key); resume(); renderCard(); }, reset() { stopAllJobs(); Object.assign(S, fresh()); commit(); location.reload(); } },
  };
  return api;
}
