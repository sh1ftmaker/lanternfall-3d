// Post-processing settings, read from the URL hash so effects can be compared one at a time.
//   #fx=hd          the recommended stack for the current quality tier (see PRESETS)
//   #ao=gtao|lite|n8|gtaopass|ssao|sao  #aa=fxaa|smaa|taa|msaa|none  #bloom=mip|unreal|off  #final
//   #tilt  #rays  #grain  #style=pixel|halftone  #fmt=rg11  #aohalf=0  #prof
// Tokens are '&' or ',' separated; a bare token means "on".
export const PRESETS = {
  // what ships: non-HD keeps rendering straight to the canvas; HD gets the combined final pass,
  // mip bloom and half-res AO; ultra adds the tour-only tilt-shift and temporal AA.
  off: {},
  hd: { final: true, bloom: 'mip', ao: 'lite' },
  ultra: { final: true, bloom: 'mip', ao: 'lite', tilt: true, aa: 'taa', streaks: true },
};
export function readFx(hash = location.hash) {
  const out = { final: false, bloom: 'unreal', ao: '', aa: '', tilt: false, rays: false, grain: false, style: '', fmt: '', aohalf: true, streaks: false, prof: false, aodebug: false, preset: '' };
  const tok = hash.replace(/^#/, '').split(/[&,]/).filter(Boolean);
  const kv = tok.map((t) => { const i = t.indexOf('='); return i < 0 ? [t, true] : [t.slice(0, i), t.slice(i + 1)]; });
  for (const [k, v] of kv) if (k === 'fx' && PRESETS[v]) { Object.assign(out, PRESETS[v]); out.preset = v; }
  for (const [k, v] of kv) {
    if (k === 'fx' || !(k in out)) continue;
    const b = typeof out[k] === 'boolean';
    out[k] = b ? !(v === '0' || v === 'off' || v === 'false') : (v === true ? defaultFor(k) : v);
  }
  return out;
}
function defaultFor(k) { return { ao: 'lite', aa: 'fxaa', bloom: 'mip', style: 'pixel', fmt: 'rg11' }[k] || ''; }
