// GPU timing of the post chain with EXT_disjoint_timer_query_webgl2 (#prof, or __park.post.prof.start()).
// Each composer pass becomes a segment; the water mirror render is split out of the scene pass.
export function makeProfiler(renderer) {
  const gl = renderer.getContext(); let ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const P = { on: false, acc: {}, frames: 0, pending: [], cur: null, curName: null, ext: !!ext };
  if (!ext) return Object.assign(P, { seg() {}, poll() {}, start() {}, report() { return 'no timer query'; }, wrapComposer() {}, wrapMirror() {} });
  P.seg = (name) => {
    if (!P.on) return;
    if (P.cur) { gl.endQuery(ext.TIME_ELAPSED_EXT); P.pending.push([P.curName, P.cur, P.frames]); P.cur = null; }
    if (name) { P.cur = gl.createQuery(); P.curName = name; gl.beginQuery(ext.TIME_ELAPSED_EXT, P.cur); }
  };
  P.poll = () => {
    if (!P.on) return;
    P.frames++;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    const keep = [];
    for (const e of P.pending) {
      const [n, q, f] = e;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) { keep.push(e); continue; }
      if (!disjoint) { const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; const fr = (P.acc[f] ||= {}); fr[n] = (fr[n] || 0) + ms; }
      gl.deleteQuery(q);
    }
    P.pending = keep;
  };
  P.start = () => { ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); P.on = !!ext; P.acc = {}; P.frames = 0; P.pending = []; P.cur = null; };
  P.report = () => {
    const per = {}; const frames = Object.keys(P.acc).map(Number).sort((a, b) => a - b).slice(5, -2);
    for (const f of frames) for (const [n, ms] of Object.entries(P.acc[f])) (per[n] ||= []).push(ms);
    const rows = Object.entries(per).map(([n, a]) => { a.sort((x, y) => x - y); return [n, a[a.length >> 1]]; });
    const tot = rows.reduce((s, r) => s + r[1], 0);
    return rows.map(([n, m]) => n + ' ' + m.toFixed(2)).join(' | ') + ' || sum ' + tot.toFixed(2);
  };
  P.wrapComposer = (composer) => {
    composer.passes.forEach((p, i) => {
      if (p.__prof) return; p.__prof = true;
      const r = p.render, name = (p.__name || p.constructor.name) + (composer.passes.filter((q) => q.constructor === p.constructor).length > 1 ? '#' + i : '');
      p.render = function (...a) { P.seg(name); const o = r.apply(this, a); P.seg(null); return o; };
    });
  };
  P.wrapMirror = (water) => {
    if (!water || water.__prof) return; water.__prof = true;
    const inner = water.onBeforeRender;
    water.onBeforeRender = function (...a) { const prev = P.curName, was = !!P.cur; if (was) P.seg('mirror'); const o = inner.apply(this, a); if (was) P.seg(prev); return o; };
  };
  return P;
}
