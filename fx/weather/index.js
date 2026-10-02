// Weather for Lanternfall 3D: Clear (the default, exactly the park as it always was, at no cost), Mist, Rain, Storm, Snow.
// Every change cross-fades over several seconds. Each state is a set of targets (below) that the live amounts ease
// toward; everything else reads the live amounts:
//   precip.js  rain streaks, snow, splash rings (instanced, all motion in the vertex shader)
//   cover.js   the park from above, rendered once: where rain cannot fall, and the light a wet floor mirrors
//   shade.js   wet / snowy ground (patched into fx/surface.js), rain on the lake (fx/water.js), cloud deck, fog,
//              moonlight, lightning
//   audio.js   rain, wind and thunder through the sound engine (fx/audio/), only once sound is on
// By default the weather changes by itself every two minutes (CYCLE); picking one in the settings holds it.
// Control: the "Weather" row in the settings sheet, '#weather=rain' (held) or '#weather=auto' in the URL,
// window.__park.weather (set, setAuto, auto, state, now).
import { createCover } from './cover.js';
import { createPrecip } from './precip.js';
import { createShade } from './shade.js';

// targets per state. rain/snow: precipitation (rain 1.6 = storm), wet: wetness, dust: snow cover, cloud: cloud deck,
// fog: fog density multiplier, mist: lake-mist density multiplier, wind: 0..1, storm: lightning on
export const STATES = {
  clear: { rain: 0, snow: 0, wet: 0, dust: 0, cloud: 0, fog: 1, mist: 1, wind: 0, storm: 0 },
  mist: { rain: 0, snow: 0, wet: 0.3, dust: 0, cloud: 0.8, fog: 45, mist: 2.6, wind: 0, storm: 0 },
  rain: { rain: 1, snow: 0, wet: 1, dust: 0, cloud: 0.9, fog: 12, mist: 1.6, wind: 0.15, storm: 0 },
  storm: { rain: 1.6, snow: 0, wet: 1, dust: 0, cloud: 1, fog: 16, mist: 1.3, wind: 1, storm: 1 },
  snow: { rain: 0, snow: 1, wet: 0, dust: 1, cloud: 0.8, fog: 20, mist: 1.2, wind: 0.2, storm: 0 },
};
// fog colour (linear, before tone mapping) the air takes on; Clear keeps the park's own
const FOGC = { mist: [0.040, 0.041, 0.060], rain: [0.026, 0.028, 0.046], storm: [0.022, 0.024, 0.040], snow: [0.046, 0.048, 0.066] };
const LABELS = { clear: 'Clear', mist: 'Mist', rain: 'Rain', storm: 'Storm', snow: 'Snow' };
const NOTES = { clear: 'A clear, starlit night.', mist: 'Fog over the lake and between the lands.', rain: 'Steady rain: wet paving, rain on the lake.', storm: 'Wind, heavy rain and distant lightning (no flashes with Reduce motion).', snow: 'Slow snow settling on the park.' };
// seconds to ease most of the way (wetness and snow cover change slowly, like the real thing)
const TAU = { rain: 2.2, snow: 2.5, wet: 6, dust: 12, cloud: 4, fog: 4, mist: 4, wind: 3, storm: 1.5 };
const STORE = 'lanternfall.weather';
// the changing weather: starts clear, comes back to clear between the wet spell and the snow
const CYCLE = ['clear', 'rain', 'storm', 'mist', 'clear', 'snow'], PERIOD = 120;

export function createWeather(opts) {
  if (/(^|[#,&+])no-weather($|[,&+])/.test(location.hash)) return { set: () => false, setAuto() {}, auto: false, update() {}, state: 'clear', now: { ...STATES.clear }, blend: { ...STATES.clear }, STATES, setReduceMotion() {}, degrade() {}, off: true };   // '#no-weather': not even the shader patches
  const { THREE, scene, camera, renderer, Q, surface, uTime, mobile } = opts;
  const now = { ...STATES.clear };
  let state = 'clear', target = STATES.clear, reduceMotion = !!opts.reduceMotion, degrade = 0;
  const cover = createCover({ renderer, scene, mobile, hdr: Q.hdr !== false });
  let precip = null, shade = null, audio = null, audioLoading = null;
  const shadeAll = () => (shade ||= createShade({ THREE, scene, surface, cover, getWater: opts.getWater, getFx: opts.getFx, FOG: opts.FOG, uTime }));
  shadeAll();                                  // patches the shaders now, before they first compile (Clear = untouched path)
  const idle = () => Object.keys(now).every((k) => now[k] === STATES.clear[k]);

  let auto = false, autoT = 0, autoI = 0;                           // changing by itself: seconds in this weather, place in CYCLE
  const save = (v) => { try { localStorage.setItem(STORE, v); } catch (e) { /* not remembered */ } };
  // picking a weather (the settings row, set() from a script, '#weather=rain') holds it; keep: a step of the cycle
  function set(name, { user = false, instant = false, keep = false } = {}) {
    if (!STATES[name]) return false;
    state = name; target = STATES[name];
    if (!keep) auto = false;
    if (instant) Object.assign(now, target);
    if (user) save(name);
    ui.sync();
    return true;
  }
  function setAuto(on, { user = false } = {}) {
    auto = !!on; autoT = 0; const i = CYCLE.indexOf(state); autoI = i < 0 ? 0 : i;      // carries on from the weather it is in
    if (user) save(auto ? 'auto' : state);
    ui.sync();
  }

  /* cover map: rendered when first needed, again when more of the park has loaded or after a context restore */
  let builtAt = -1;                                                  // park meshes when the map was rendered
  renderer.domElement.addEventListener('webglcontextrestored', () => { cover.st.dirty = true; builtAt = -1; });
  function ensureCover() {
    const park = opts.getPark(); if (!park || opts.glLost()) return;
    const n = park.children.length, loaded = opts.isLoaded();
    if (cover.ready && (n === builtAt || (!loaded && builtAt >= 0))) return;      // while streaming: once, then at the end
    cover.build(park.children.filter((o) => o.isMesh && o.geometry.attributes.aCol), surface.uniforms.uRange.value);
    builtAt = n;
  }

  let wasIdle = true, patched = false;
  function update(dt, time) {
    if (auto && (autoT += Math.min(dt, 0.25)) >= PERIOD) { autoT = 0; autoI = (autoI + 1) % CYCLE.length; set(CYCLE[autoI], { keep: true }); }
    // ease toward the target
    for (const k in now) {
      const t = target[k], d = t - now[k];
      if (d === 0) continue;
      now[k] += d * Math.min(1, dt / TAU[k]);
      if (Math.abs(t - now[k]) < (k === 'fog' ? 0.002 * Math.max(1, t) : 0.0015)) now[k] = t;
    }
    if (!patched) patched = shade.patch();
    const isIdle = idle();
    if (isIdle && wasIdle) return;                                   // Clear and settled: nothing runs, nothing is drawn
    if (!isIdle && opts.isReady()) ensureCover();
    const scale = (Q.fx ? Q.fx.scale : 1) * (Q.hd ? 1 : 0.6) * (degrade >= 4 ? 0.5 : degrade >= 2 ? 0.75 : 1);
    if (now.rain > 0 || now.snow > 0) precip ||= createPrecip({ scene, camera, uTime, cover, mobile });
    if (precip) precip.update({ rainAmt: now.rain, snowAmt: now.snow, wind: now.wind, scale, motion: !reduceMotion });
    const quiet = shade.update(dt, time, now, { reduceMotion, state, wxFog: FOGC[state] });
    const hush = audio ? audio.update(dt, time, now, shade) : true;
    wasIdle = isIdle && quiet && hush;                              // a flash, the fog colour or the sound still settling
    if (!audio && !audioLoading && !isIdle && opts.getSound && opts.getSound()) audioLoading = import('./audio.js').then((m) => { audio = m.createWeatherAudio({ ...opts, cover, getEngine: opts.getSound }); }).catch((e) => console.warn('weather: no sound', e));
  }

  /* the settings row (a radio group like "Picture") */
  const ui = (() => {
    const box = document.querySelector('#wx-set');
    if (!box) return { sync() {} };
    box.hidden = false;
    const seg = box.querySelector('.seg'), note = box.querySelector('.seg-note');
    const btns = Object.keys(STATES).map((id) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = LABELS[id]; b.dataset.w = id; b.setAttribute('role', 'radio');
      b.addEventListener('click', () => set(id, { user: true }));
      seg.appendChild(b); return b;
    });
    seg.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return; e.preventDefault(); e.stopPropagation();
      const i = (btns.findIndex((b) => b.dataset.w === state) + d + btns.length) % btns.length; btns[i].focus(); btns[i].click();
    });
    const tog = document.createElement('button'); tog.type = 'button'; tog.className = 'tog'; tog.setAttribute('role', 'switch');
    tog.innerHTML = '<span>Changes every two minutes</span><i aria-hidden="true"></i>';
    tog.addEventListener('click', () => setAuto(!auto, { user: true }));
    const togs = document.createElement('div'); togs.className = 'toggles'; togs.appendChild(tog); box.appendChild(togs);
    return { sync() { for (const b of btns) { const on = b.dataset.w === state; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; } note.textContent = NOTES[state]; tog.setAttribute('aria-checked', String(auto)); } };
  })();

  // start: '#weather=rain' wins (held), then the saved choice (a held weather, or changing); otherwise it starts
  // clear and changes by itself. A page opened in a held weather starts in it.
  const hw = /(?:^|[#,&+])weather=(\w+)/.exec(location.hash);
  let saved = null; try { saved = localStorage.getItem(STORE); } catch (e) { /* none */ }
  const held = hw && STATES[hw[1]] ? hw[1] : !hw && saved && STATES[saved] ? saved : null;
  set(held || 'clear', { instant: true });
  if (!held) setAuto(true);

  return {
    set: (n, o) => set(n, o || {}), setAuto, get auto() { return auto; }, get autoIn() { return auto ? PERIOD - autoT : Infinity; }, CYCLE, update,
    get state() { return state; }, now, get blend() { return { ...now }; }, STATES,
    setReduceMotion(on) { reduceMotion = !!on; },
    degrade(step) { degrade = step; },
    get cover() { return cover; }, get precip() { return precip; }, get shade() { return shade; }, get audio() { return audio; },
  };
}
