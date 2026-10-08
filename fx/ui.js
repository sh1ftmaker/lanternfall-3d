// Interface helpers that are not about the 3D scene: failure messages in the loading veil.
const $ = (s) => document.querySelector(s);

// What this browser can do, checked before the renderer is made, so a visitor gets a message instead of a blank page
// and the renderer is not asked for features that only produce console warnings.
//   fail: {title, text} when the viewer cannot run; clip: EXT_clip_control (reversed depth); hdr: float colour targets
// With context attributes (attrs) the context is kept and handed to the renderer (out.canvas, out.gl): making a WebGL
// context is slow (~0.2 s on this laptop, ~0.8 s at 4x CPU throttle), and the throw-away one cost a second one.
export function probe(attrs) {
  let gl = null; const canvas = document.createElement('canvas');
  try { gl = canvas.getContext('webgl2', attrs); } catch (e) { gl = null; }
  if (!gl) return { fail: { title: 'This browser cannot show the park.', text: 'Lanternfall needs WebGL 2. It works in current Chrome, Edge, Firefox and Safari (15 or newer); if you use one of those, check that hardware acceleration is turned on.' } };
  const out = { fail: null, clip: !!gl.getExtension('EXT_clip_control'), hdr: !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')) };
  if (attrs) { canvas.style.display = 'block'; out.canvas = canvas; out.gl = gl; }      // (as three's own canvas)
  else { const lc = gl.getExtension('WEBGL_lose_context'); if (lc) lc.loseContext(); }      // free the probe context
  if (typeof DecompressionStream === 'undefined') out.fail = { title: 'This browser is too old for the park.', text: 'Lanternfall unpacks its 3D data with DecompressionStream, available in browsers from 2023 on. Updating the browser will fix it.' };
  return out;
}

// Show a failure in the loading veil (or, once the park is open, in the small status pill). retry: true adds a
// "Try again" button that reloads the page (finished downloads come from the browser cache).
export function veilFail(title, text, retry = true) {
  const veil = $('#veil');
  if (veil && !veil.classList.contains('done')) {
    veil.classList.add('failed');
    const p = veil.querySelector('.veil-in p'); if (p) p.textContent = title;
    const msg = $('#veil-msg'); if (msg) { msg.textContent = text; msg.setAttribute('role', 'alert'); }
    if (retry && !veil.querySelector('.retry')) veil.querySelector('.veil-in').appendChild(retryButton());
    return;
  }
  const pill = $('#loadpill'); if (!pill) return;
  pill.hidden = false; pill.classList.add('failed'); pill.textContent = title + ' ';
  pill.setAttribute('role', 'alert');
  if (retry) pill.appendChild(retryButton());
}
function retryButton() {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'retry'; b.textContent = 'Try again';
  b.addEventListener('click', () => location.reload());
  return b;
}

// ── Settings sheet ──
// A small popover under the top-right settings button: picture quality (three levels), a few effect switches and
// "reduce motion". Choices persist in localStorage (when available); URL hash tokens still win on load.
const STORE = 'lanternfall.settings';
export function loadPrefs() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
function savePrefs(p) { try { localStorage.setItem(STORE, JSON.stringify(p)); } catch (e) { /* private mode: not remembered */ } }

// opts: { qualities: [{id, label, note}], quality, onQuality(id), toggles: [{id, label, on}], onToggle(id, on) }
export function buildSettings(opts) {
  const btn = $('#btn-set'), sheet = $('#sheet'), prefs = loadPrefs();
  const qBox = sheet.querySelector('.seg'), note = sheet.querySelector('.seg-note'), tBox = sheet.querySelector('.toggles');
  const qBtns = opts.qualities.map((q) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = q.label; b.dataset.q = q.id;
    b.setAttribute('role', 'radio'); if (q.disabled) { b.disabled = true; b.title = q.disabled; }
    b.addEventListener('click', () => { set(q.id, true); opts.onQuality(q.id); });
    qBox.appendChild(b); return b;
  });
  let current = opts.quality;
  function set(id, user) {
    current = id;
    for (const b of qBtns) { const on = b.dataset.q === id; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    const q = opts.qualities.find((x) => x.id === id); note.textContent = q ? q.note : '';
    if (user) { prefs.quality = id; savePrefs(prefs); }
  }
  qBox.addEventListener('keydown', (e) => {     // radio group: arrows move the choice
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return; e.preventDefault(); e.stopPropagation();
    let i = opts.qualities.findIndex((x) => x.id === current);
    for (let k = 0; k < qBtns.length; k++) { i = (i + d + qBtns.length) % qBtns.length; if (!qBtns[i].disabled) break; }
    qBtns[i].focus(); qBtns[i].click();
  });
  const tBtns = {};
  for (const t of opts.toggles) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'tog'; row.setAttribute('role', 'switch');
    row.innerHTML = `<span></span><i aria-hidden="true"></i>`; row.firstChild.textContent = t.label;
    row.setAttribute('aria-checked', String(t.on));
    row.addEventListener('click', () => { const on = row.getAttribute('aria-checked') !== 'true'; row.setAttribute('aria-checked', String(on)); prefs[t.id] = on; savePrefs(prefs); opts.onToggle(t.id, on); });
    tBox.appendChild(row); tBtns[t.id] = row;
  }
  set(current, false);
  const open = (v) => {
    sheet.hidden = !v; btn.setAttribute('aria-expanded', String(v));
    if (v) (qBtns.find((b) => b.dataset.q === current) || qBtns[0]).focus();
  };
  btn.addEventListener('click', () => open(sheet.hidden));
  sheet.querySelector('.sheet-close').addEventListener('click', () => { open(false); btn.focus(); });
  document.addEventListener('pointerdown', (e) => { if (!sheet.hidden && !sheet.contains(e.target) && !btn.contains(e.target)) open(false); }, true);
  return {
    get open() { return !sheet.hidden; }, close() { open(false); btn.focus(); },
    setQuality: (id) => set(id, false),
    setToggle: (id, on) => { if (tBtns[id]) tBtns[id].setAttribute('aria-checked', String(on)); },
  };
}
