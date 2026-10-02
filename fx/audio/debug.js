// '#audiodebug': a top-down map of the sound of the park, to check the engine without ears. Zones (land centres
// sized by weight), emitters, playing voices (rings sized by level, red = HRTF), recent one-shots, the listener
// (arrow) and its zone point (cross), plus a text panel: state, latency, voices, zone weights, crowd, reverb, loading.
export function audioDebug(engine, opts) {
  const dbg = engine.debug, S = 260, VIEW = 640;                 // px, metres across
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:12px;top:86px;z-index:30;pointer-events:none;font:11px/1.35 ui-monospace,monospace;color:#f5ecdc;background:rgba(7,6,26,.78);border:1px solid rgba(245,236,220,.2);border-radius:10px;padding:8px;max-width:calc(100vw - 24px)';
  const cv = document.createElement('canvas'); cv.width = S * 2; cv.height = S * 2; cv.style.cssText = `width:${S}px;height:${S}px;display:block`;
  const txt = document.createElement('pre'); txt.style.cssText = 'margin:6px 0 0;white-space:pre-wrap;width:' + S + 'px';
  wrap.append(cv, txt); document.body.appendChild(wrap);
  const g = cv.getContext('2d'), k = (S * 2) / VIEW;
  const X = (x) => S + x * k, Y = (y) => S - y * k;                // Blender frame: x east, y north (up on the map)
  const COL = { guildhollow: '#ff7b5c', frostmere: '#9fd8ff', meridian: '#7ff0d8', wanderers: '#c3a6ff', brinewatch: '#f0c667', 'lantern-row': '#ffb547', rosewick: '#ff8fb1', lake: '#5c7cff', gate: '#ffffff', gap: '#6fbf73', sky: '#8888aa' };
  let last = 0;
  function draw(t) {
    requestAnimationFrame(draw);
    if (t - last < 100) return; last = t;
    const man = typeof opts.manifest === 'function' ? opts.manifest() : opts.manifest; if (!man) return;
    const D = dbg.D, L = dbg.listener;
    g.clearRect(0, 0, S * 2, S * 2);
    g.strokeStyle = 'rgba(92,124,255,.7)'; g.lineWidth = 2; g.beginPath();
    (man.lake || []).forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.closePath(); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.12)'; g.beginPath(); g.ellipse(S, S, 160 * k, 119 * k, 0, 0, Math.PI * 2); g.stroke();   // monorail
    for (const l of man.lands) { const w = D.zone[l.id] || 0; g.fillStyle = COL[l.id] || '#fff'; g.globalAlpha = 0.25 + 0.75 * w; g.beginPath(); g.arc(X(l.center[0]), Y(l.center[1]), 4 + 26 * w, 0, 7); g.fill(); }
    g.globalAlpha = 1;
    for (const s of dbg.sources) {
      if (!s.positional && !s.shots) continue;
      const x = s.pos.x, y = -s.pos.z;
      g.fillStyle = s.kind === 'music' ? (COL[s.zone] || '#fff') : s.shots ? '#888' : '#ddd';
      g.fillRect(X(x) - 2, Y(y) - 2, 4, 4);
      if (s.playing && !s.stopAt) {
        const lv = Math.max(0, 60 + 20 * Math.log10(Math.max(1e-6, s.target)));     // 0..60 for -60..0 dB
        g.strokeStyle = s.ch && s.ch.hrtf ? '#ff5050' : '#ffd27a'; g.lineWidth = 2; g.beginPath(); g.arc(X(x), Y(y), 3 + lv * 0.5, 0, 7); g.stroke();
      }
    }
    for (const e of D.events) { const age = performance.now() / 1000 - e.wall; if (!(age < 3)) continue; g.strokeStyle = `rgba(120,255,160,${1 - age / 3})`; g.beginPath(); g.arc(X(e.x), Y(-e.z), 6 + age * 10, 0, 7); g.stroke(); }
    // listener and zone point
    const lx = L.p.x, ly = -L.p.z, a = Math.atan2(-L.f.z, L.f.x);
    g.fillStyle = '#fff'; g.save(); g.translate(X(lx), Y(ly)); g.rotate(-a); g.beginPath(); g.moveTo(12, 0); g.lineTo(-6, 6); g.lineTo(-6, -6); g.closePath(); g.fill(); g.restore();
    g.strokeStyle = '#fff'; g.beginPath(); const fx = X(D.focus[0]), fy = Y(D.focus[1]); g.moveTo(fx - 6, fy - 6); g.lineTo(fx + 6, fy + 6); g.moveTo(fx + 6, fy - 6); g.lineTo(fx - 6, fy + 6); g.stroke();
    const z = Object.entries(D.zone).filter(([, v]) => v > 0.02).sort((p, q) => q[1] - p[1]).map(([kk, v]) => kk + ' ' + v.toFixed(2)).join(' · ');
    const lat = dbg.latency() || {}, ld = dbg.loaded(), vs = dbg.voices().sort((p, q) => q.db - p.db).slice(0, 8);
    txt.textContent = `${lat.state} ${dbg.st.specFrom}  base ${(lat.base * 1000 || 0).toFixed(1)} ms  out ${(lat.output * 1000 || 0).toFixed(1)} ms\n` +
      `voices ${D.voices}  h ${D.h.toFixed(0)} m  air ${D.A.toFixed(2)}  crowd ${D.density.toFixed(2)}  rev ${D.rev.map((v) => v.toFixed(2)).join('/')}\n` +
      `zones ${z}\nloaded ${ld.ready}/${ld.assets}  ${(ld.bytes / 1024).toFixed(0)} kB  decoded ${ld.decodedMB} MB  ${D.ground ? 'ground ' + D.ground : ''}\n` +
      vs.map((v) => `${v.db.toFixed(0).padStart(4)} dB ${v.id}${v.d !== null ? ' ' + v.d.toFixed(0) + ' m' : ''}${v.hrtf ? ' HRTF' : ''}${v.dop ? ' x' + v.dop.toFixed(3) : ''}`).join('\n');
  }
  requestAnimationFrame(draw);
}
