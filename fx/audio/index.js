// Sound for Lanternfall 3D: the button in the top bar, the settings entries, the M key, the first-run nudge, and the
// lazy start of the engine (fx/audio/engine.js). Until the button is pressed nothing audio-related is fetched or
// decoded (the engine module itself is imported on the first press). The AudioContext is created and unlocked
// synchronously inside the gesture (iOS Safari needs that), together with a few media elements for streamed music.
//
//   const sound = createSound({ THREE, camera, manifest: () => manifest, DATA, Q, getMode, getWalk, getTrains, fx,
//                               getTour, getWater, mobile });
//   sound.update(dt, time)     every frame (cheap no-op while sound is off)
//   sound.play(name, pos?)     one-shots from other code (ignored while off)
//   sound.engine               the engine once started (see engine.js for its API), else null
// Choices persist in localStorage 'lanternfall.sound' = {on, vol, music, amb, nudged}.

const STORE = 'lanternfall.sound';
const $ = (s) => document.querySelector(s);
function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
function save(p) { try { localStorage.setItem(STORE, JSON.stringify(p)); } catch (e) { /* private mode: not remembered */ } }
// 0.1 s of silence as a WAV data URL: media elements played once inside the gesture may play later on iOS
function silentWavUrl() {
  const n = 2205, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer), w = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 22050, true); v.setUint32(28, 44100, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return 'data:audio/wav;base64,' + btoa(s);
}

export function createSound(opts) {
  const prefs = { vol: 0.8, music: true, amb: true, ...load() };
  const btn = $('#btn-snd'), vol = $('#snd-vol'), tMusic = $('#snd-music'), tAmb = $('#snd-amb');
  const hash = new Set(decodeURIComponent(location.hash.slice(1)).split(/[,&+\s]/).filter(Boolean));
  let engine = null, ctx = null, elements = [], starting = null, on = false;

  function setButton(state) {           // off | loading | on
    if (!btn) return;
    btn.dataset.state = state; btn.setAttribute('aria-pressed', String(state !== 'off'));
    btn.title = (state === 'off' ? 'Sound is off: turn it on' : 'Sound is on: turn it off') + ' (M)';
  }
  // inside a user gesture: create + unlock the context and the media elements, then load the engine
  function unlock() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ctx = new AC({ latencyHint: 'playback' });
    const r = ctx.resume && ctx.resume(); if (r && r.catch) r.catch(() => {});
    const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
    const url = silentWavUrl();
    for (let i = 0; i < 8; i++) { const el = new Audio(); el.src = url; el.setAttribute('playsinline', ''); const p = el.play(); if (p && p.then) p.then(() => el.pause(), () => {}); elements.push(el); }
  }
  async function start() {
    const { createAudio } = await import('./engine.js');
    engine = createAudio({ ...opts, ctx, elements, synth: hash.has('audiosynth') });
    engine.setVolume(prefs.vol); engine.setMusic(prefs.music); engine.setAmbience(prefs.amb);
    if (window.__park) window.__park.audio = engine;
    if (hash.has('audiodebug')) import('./debug.js').then((m) => m.audioDebug(engine, opts));
    return engine;
  }
  function turnOn() {
    on = true; prefs.on = true; save(prefs); setButton(engine ? 'on' : 'loading');
    unlock();
    if (!starting) starting = start();
    return starting.then((e) => { if (!on) return; return e.enable().then(() => { if (on) { setButton('on'); e.play('ui_click'); } }); }).catch(() => setButton('off'));
  }
  function turnOff() { on = false; prefs.on = false; save(prefs); setButton('off'); if (engine) { engine.play('ui_click'); setTimeout(() => engine.disable(), 40); } }
  const toggle = () => (on ? turnOff() : turnOn());

  setButton('off');
  if (btn) btn.addEventListener('click', toggle);
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    toggle();
  });
  // returning visitors who left sound on: start on their first interaction with the page (browsers require one)
  if (prefs.on) {
    setButton('off'); if (btn) btn.classList.add('armed');
    const first = (e) => { if (e.code === 'KeyM' || (e.target && e.target.closest && e.target.closest('#btn-snd'))) return done(); if (!on) turnOn(); done(); };
    const done = () => { for (const ev of ['pointerup', 'keydown']) removeEventListener(ev, first, true); if (btn) btn.classList.remove('armed'); };
    for (const ev of ['pointerup', 'keydown']) addEventListener(ev, first, true);
  }

  // settings sheet: volume, Music, Ambience
  const sw = (el, v) => el && el.setAttribute('aria-checked', String(v));
  if (vol) {
    vol.value = Math.round(prefs.vol * 100);
    vol.addEventListener('input', () => { prefs.vol = vol.value / 100; vol.setAttribute('aria-valuetext', vol.value + '%'); if (engine) engine.setVolume(prefs.vol); });
    vol.addEventListener('change', () => save(prefs));
  }
  sw(tMusic, prefs.music); sw(tAmb, prefs.amb);
  if (tMusic) tMusic.addEventListener('click', () => { prefs.music = !prefs.music; sw(tMusic, prefs.music); save(prefs); if (engine) engine.setMusic(prefs.music); });
  if (tAmb) tAmb.addEventListener('click', () => { prefs.amb = !prefs.amb; sw(tAmb, prefs.amb); save(prefs); if (engine) engine.setAmbience(prefs.amb); });

  // first visit: once the park is open and the controls hint has gone, mention sound once in the hint line
  if (!prefs.nudged) {
    const veil = $('#veil'), hint = $('#hint');
    const go = () => setTimeout(() => {
      if (on || !hint) return; prefs.nudged = true; save(prefs);
      const coarse = matchMedia('(pointer: coarse)').matches;
      hint.textContent = coarse ? 'This park has sound · tap the speaker, headphones on' : 'This park has sound · press the speaker or M, headphones on';
      hint.classList.remove('off'); if (btn) btn.classList.add('nudge');
      setTimeout(() => { hint.classList.add('off'); if (btn) btn.classList.remove('nudge'); }, 5500);
    }, 6500);
    if (veil && !veil.classList.contains('done')) new MutationObserver((m, o) => { if (veil.classList.contains('done')) { o.disconnect(); go(); } }).observe(veil, { attributes: true, attributeFilter: ['class'] });
  }

  return {
    update(dt, time) { if (engine) engine.update(dt, time); },
    play(name, pos) { return engine && on ? engine.play(name, pos) : false; },
    get engine() { return engine; }, get on() { return on; },
    toggle, turnOn, turnOff,
  };
}
