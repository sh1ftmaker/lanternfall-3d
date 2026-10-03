// Other visitors: everyone on the site shares one PartyKit room ("park"); visitors walking the park see each other.
// This file is the networking: when to connect, what is sent, what arrives, the settings row and its count. The
// figures are drawn by ./avatars.js (createAvatars, same interface as ./avatars-stub.js), loaded the first time someone
// else is seen walking. Wire format and server: party/README.md. app.js loads this unless the address has '#solo'.
//
// If the server cannot be reached the page stays as it was: the server is asked first with a plain GET from a small
// Worker (so a failed request is not the page's own), at most once a minute, and nothing is shown until it answers.

export const HOST = 'lanternfall-3d.sh1ftmaker.partykit.dev';     // the deployed server: `npx partykit deploy` (party/README.md)
const ROOM = 'park', PARTY = 'main';
const KEY = 'lanternfall.visitors';      // 'off' when the visitor switched "Other visitors" off
const RETRY = 60000, FULL_RETRY = 300000, QUICK = 5000, KEEPALIVE = 25000;
const FAST = 100, SLOW = 500, MIN_GAP = 70;    // ms between states: moving (10 Hz), still (2 Hz), never closer than this
const LANDS = new Set(['spire', 'gate', 'wanderers', 'meridian', 'frostmere', 'guildhollow', 'rosewick', 'lantern-row', 'brinewatch']);
const CSS = `
#mp-tog[hidden]{display:none}
#mp-tog small{display:block;margin-top:1px;font:400 12px var(--ui);color:var(--muted)}
#mp-tog small:empty{display:none}
`;

// '#mp=127.0.0.1:8970' points a page at a local `partykit dev` (tests); anything else in it is ignored
function hostFromHash() {
  for (const t of location.hash.slice(1).split(/[&,+]/)) { const m = /^mp=([\w.-]+(?::\d{1,5})?)$/.exec(t); if (m) return m[1]; }
  return HOST;
}
const isLocal = (h) => /^(localhost|127\.0\.0\.1|192\.168\.|10\.|\[::1\])/.test(h);
const r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;

export function createMultiplayer(ctx) {
  const { THREE, scene, walk, getMode, getPlatformer, game } = ctx;
  const host = hostFromHash(), probeUrl = `${isLocal(host) ? 'http' : 'https'}://${host}/parties/${PARTY}/${ROOM}`;
  let enabled = (() => { try { return localStorage.getItem(KEY) !== 'off'; } catch (e) { return true; } })();
  const S = { status: 'idle', me: null, name: null, peers: new Map(), sock: null, timer: 0, openedAt: 0, wsFails: 0, reached: false,
    last: { at: -1e9, x: 0, y: 0, z: 0, yaw: 0, anim: -2, kind: 0 }, lastAny: 0, walking: false,
    stats: { since: performance.now(), inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0, states: 0 } };
  let avatars = null, avatarsLoading = null, probeWorker = null;

  // ── the settings row: "Other visitors" + how many are here. Shown once the server has answered (or if it was switched off) ──
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const row = document.createElement('button'); row.type = 'button'; row.className = 'tog'; row.id = 'mp-tog'; row.setAttribute('role', 'switch');
  row.innerHTML = '<span>Other visitors<small></small></span><i aria-hidden="true"></i>';
  const countEl = row.querySelector('small');
  row.setAttribute('aria-checked', String(enabled));
  const showRow = () => { row.hidden = enabled && !S.reached; }; showRow();
  const box = document.querySelector('#sheet .toggles'); if (box) box.appendChild(row);
  row.addEventListener('click', () => setEnabled(!enabled));
  function drawCount() {
    const n = S.peers.size;
    countEl.textContent = !enabled ? '' : S.status === 'full' ? 'The park is full just now; walking alone' : S.status !== 'open' ? '' :
      n === 0 ? 'Nobody else in the park just now' : n === 1 ? '1 other in the park' : `${n} others in the park`;
  }

  // ── is the server there? A GET from a Worker; its failure is the Worker's, not the page's ──
  function probe() {
    clearTimeout(S.timer); S.timer = 0;
    if (!enabled || S.sock) return;
    S.status = 'probing';
    if (!probeWorker) {
      const src = 'onmessage=async(e)=>{let r=null;try{const q=await fetch(e.data,{cache:"no-store",credentials:"omit"});if(q.ok)r=await q.json()}catch(_){}postMessage(r)}';
      try { probeWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); } catch (e) { S.status = 'off'; return; }
      probeWorker.onmessage = (e) => onProbe(e.data);
    }
    probeWorker.postMessage(probeUrl);
  }
  function onProbe(r) {
    if (!enabled || S.sock) return;
    if (!r || r.ok !== true) { S.status = 'away'; later(RETRY); return; }
    S.reached = true; showRow();
    if (Number.isFinite(r.n) && Number.isFinite(r.max) && r.n >= r.max) { S.status = 'full'; drawCount(); later(FULL_RETRY); return; }
    connect();
  }
  function later(ms) { clearTimeout(S.timer); if (enabled) S.timer = setTimeout(probe, ms + Math.random() * 5000); }

  // ── the socket (partysocket from the import map in index.html; no retries of its own: we probe again instead) ──
  async function connect() {
    S.status = 'connecting';
    let PartySocket;
    try { PartySocket = (await import('partysocket')).default; } catch (e) { S.status = 'off'; return; }   // the CDN is away: stay solo
    if (!enabled || S.sock) return;
    const sock = new PartySocket({ host, room: ROOM, party: PARTY, maxRetries: 0, maxEnqueuedMessages: 0, connectionTimeout: 8000 });
    S.sock = sock;
    sock.addEventListener('open', () => { if (S.sock !== sock) return; S.status = 'open'; S.openedAt = performance.now(); S.wsFails = 0; S.last.at = -1e9; S.last.anim = -2; S.walking = false; drawCount(); });
    sock.addEventListener('message', (e) => { if (S.sock === sock) receive(e.data); });
    sock.addEventListener('close', () => {
      if (S.sock !== sock) return;
      const was = S.status, lived = S.openedAt ? performance.now() - S.openedAt : 0;
      drop(); if (!enabled) return;
      if (was === 'full') { S.status = 'full'; drawCount(); later(FULL_RETRY); return; }
      if (was !== 'open' && ++S.wsFails >= 3) { S.status = 'off'; return; }   // the server answers but its socket never opens: stay solo this visit
      S.status = 'away'; drawCount(); later(lived > RETRY ? QUICK : RETRY);    // a dropped session tries again soon, once a minute at most
    });
  }
  function drop() {
    const sock = S.sock; S.sock = null; S.openedAt = 0; S.me = S.name = null;
    if (sock) { try { sock.close(); } catch (e) { /* already closed */ } }
    for (const id of S.peers.keys()) if (avatars) avatars.remove(id);
    S.peers.clear(); drawCount();
  }
  function send(msg) {
    const s = S.sock; if (!s || S.status !== 'open' || s.readyState !== 1) return false;
    const txt = JSON.stringify(msg); s.send(txt); S.stats.outMsgs++; S.stats.outBytes += txt.length; S.lastAny = performance.now(); return true;
  }

  // ── what arrives ──
  const okId = (v) => typeof v === 'string' && /^[a-z0-9]{1,8}$/.test(v);
  const okName = (v) => typeof v === 'string' && v.length <= 40 && /^[A-Za-z' -]+$/.test(v);
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  function peer(id, name) { let p = S.peers.get(id); if (!p) { p = { id, name: okName(name) ? name : 'A visitor', walking: false, land: null }; S.peers.set(id, p); } return p; }
  function applyState(id, a) {     // a = [kind, x, y, z, yaw, anim, frame, t, land]
    const p = S.peers.get(id); if (!p || !Array.isArray(a) || a.length !== 9) return;
    const [kind, x, y, z, yaw, anim, frame, t, land] = a;
    if ((kind !== 1 && kind !== 2) || ![x, y, z, yaw, anim, frame, t].every(fin)) return;
    p.walking = true; p.land = LANDS.has(land) ? land : null; S.stats.states++;
    if (!avatars) { loadAvatars(); p.pending = { x, y, z, yaw, anim, frame, t, kind }; return; }
    avatars.upsert(id, { name: p.name, kind: kind === 1 ? 'wick' : 'fp', x, y, z, yaw, anim: kind === 1 ? anim : -1, frame, t });
  }
  function receive(data) {
    if (typeof data !== 'string' || data.length > 65536) return;
    S.stats.inMsgs++; S.stats.inBytes += data.length;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!Array.isArray(m)) return;
    switch (m[0]) {
      case 'w':        // welcome: [ 'w', myId, myName, [[id, name, state | null], ...] ]
        if (!okId(m[1]) || !Array.isArray(m[3])) return;
        S.me = m[1]; S.name = okName(m[2]) ? m[2] : null;
        for (const o of m[3]) if (Array.isArray(o) && okId(o[0]) && o[0] !== S.me) { peer(o[0], o[1]); if (o[2]) applyState(o[0], o[2]); }
        drawCount(); break;
      case 'j': if (okId(m[1]) && m[1] !== S.me) { peer(m[1], m[2]); drawCount(); } break;
      case 's': if (okId(m[1]) && m[1] !== S.me) { if (!S.peers.has(m[1])) peer(m[1], null); applyState(m[1], m.slice(2)); } break;
      case 'p': { const p = S.peers.get(m[1]); if (p && p.walking) { p.walking = false; p.pending = null; if (avatars) avatars.remove(m[1]); } break; }
      case 'l': { if (S.peers.delete(m[1]) && avatars) avatars.remove(m[1]); drawCount(); break; }
      case 'f': S.status = 'full'; drawCount(); break;
    }
  }
  function loadAvatars() {
    if (avatarsLoading) return;
    const make = (M) => M.createAvatars({ THREE, scene, surface: ctx.surface, guests: ctx.getGuests ? ctx.getGuests() : null, manifest: ctx.getManifest ? ctx.getManifest() : null, game });
    avatarsLoading = import('./avatars.js').then(make).catch(() => import('./avatars-stub.js').then(make))
      .then((a) => {
        avatars = a; a.setVisible(enabled && getMode() !== 'tour');
        for (const p of S.peers.values()) if (p.walking && p.pending) { const q = p.pending; p.pending = null; a.upsert(p.id, { name: p.name, kind: q.kind === 1 ? 'wick' : 'fp', ...q, anim: q.kind === 1 ? q.anim : -1 }); }
      })
      .catch((e) => { console.warn('visitors: no figures', e); });
  }

  // ── what is sent: Walk sends the visitor's state (10 Hz moving, 2 Hz still); Tour, Explore and a hidden tab say "here" ──
  function local() {
    const pf = getPlatformer(), wick = !!(pf && pf.active);
    if (wick && !(pf.view && pf.view.s)) return null;            // the lamplighter is still waking
    const z = wick ? pf.view.pos.y : walk.z + (walk.hop || 0);
    const land = game && game.player && LANDS.has(game.player.land) ? game.player.land : null;
    return { kind: wick ? 1 : 2, x: walk.x, y: walk.y, z, yaw: walk.yaw, anim: wick ? pf.view.animID | 0 : -1, frame: wick ? Math.max(0, pf.view.frame || 0) : 0, land };
  }
  function frame(dt, time) {
    if (avatars) { avatars.setVisible(enabled && getMode() !== 'tour'); avatars.update(dt, time, ctx.camera); }
    if (S.status !== 'open') return;
    const now = performance.now(), L = S.last;
    const st = getMode() === 'walk' && !document.hidden ? local() : null;
    if (!st) {
      if (S.walking || now - S.lastAny > KEEPALIVE) { if (send(['p'])) S.walking = false; }
      return;
    }
    const moved = Math.abs(st.x - L.x) > 0.01 || Math.abs(st.y - L.y) > 0.01 || Math.abs(st.z - L.z) > 0.01 || Math.abs(st.yaw - L.yaw) > 0.01 || st.kind !== L.kind;
    const since = now - L.at, animChanged = st.anim !== L.anim;
    if (!(since >= (moved ? FAST : SLOW) || (animChanged && since >= MIN_GAP))) return;
    const yaw = Math.atan2(Math.sin(st.yaw), Math.cos(st.yaw));
    const msg = ['s', st.kind, r2(st.x), r2(st.y), r2(st.z), r3(yaw), st.anim, Math.round(st.frame * 10) / 10, Math.round(now), st.land];
    if (send(msg)) { S.walking = true; Object.assign(L, { at: now, x: st.x, y: st.y, z: st.z, yaw: st.yaw, anim: st.anim, kind: st.kind }); }
  }
  const keepalive = setInterval(() => { if (S.status === 'open' && performance.now() - S.lastAny > KEEPALIVE - 1000) { if (send(['p'])) S.walking = false; } }, KEEPALIVE);   // also while the tab is hidden (no frames)
  const onVis = () => { if (document.hidden && S.walking && send(['p'])) S.walking = false; };
  document.addEventListener('visibilitychange', onVis);

  function setEnabled(on) {
    enabled = on; row.setAttribute('aria-checked', String(on)); showRow();
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) { /* private mode: not remembered */ }
    if (on) { S.wsFails = 0; probe(); } else { clearTimeout(S.timer); S.timer = 0; drop(); S.status = 'idle'; if (avatars) avatars.setVisible(false); }
    drawCount();
  }
  probe();

  return {
    host, frame, setEnabled,
    get enabled() { return enabled; }, get status() { return S.status; }, get me() { return S.me; }, get name() { return S.name; },
    get count() { return S.peers.size; }, get peers() { return [...S.peers.values()].map(({ id, name, walking, land }) => ({ id, name, walking, land })); },
    get avatars() { return avatars; }, stats: S.stats,
    dispose() { setEnabled(false); clearInterval(keepalive); document.removeEventListener('visibilitychange', onVis); if (probeWorker) probeWorker.terminate(); row.remove(); style.remove(); if (avatars) avatars.dispose(); },
  };
}
