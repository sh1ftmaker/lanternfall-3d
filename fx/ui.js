// Interface helpers that are not about the 3D scene: failure messages in the loading veil.
const $ = (s) => document.querySelector(s);

// What this browser lacks for the viewer, or null. Checked before the renderer is made so a visitor gets a message
// instead of a blank page.
export function unsupported() {
  let gl = null;
  try { gl = document.createElement('canvas').getContext('webgl2'); } catch (e) { gl = null; }
  if (!gl) return { title: 'This browser cannot show the park.', text: 'Lanternfall needs WebGL 2. It works in current Chrome, Edge, Firefox and Safari (15 or newer); if you use one of those, check that hardware acceleration is turned on.' };
  const lc = gl.getExtension('WEBGL_lose_context'); if (lc) lc.loseContext();            // free the probe context
  if (typeof DecompressionStream === 'undefined') return { title: 'This browser is too old for the park.', text: 'Lanternfall unpacks its 3D data with DecompressionStream, available in browsers from 2023 on. Updating the browser will fix it.' };
  return null;
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
