// Guests: debug view of the crowd simulation (no renderer needed). Instanced figures — a body and a heading marker —
// coloured by what each guest is doing, and an optional top-down overlay canvas of the walk grid, sites and guests.
// Colours: walk white, stand cyan, look/photo magenta, wave yellow, sit green, lean blue.
const COL = [[0.95, 0.95, 0.95], [0.2, 0.8, 1.0], [1.0, 0.25, 1.0], [1.0, 0.95, 0.2], [0.2, 1.0, 0.3], [0.35, 0.5, 1.0]];

export function createSimDebug({ THREE, scene, crowd, overlay = false }) {
  const n = crowd.count;
  const body = new THREE.CapsuleGeometry(0.2, 1.05, 3, 8); body.translate(0, 0.725, 0);
  const nose = new THREE.BoxGeometry(0.24, 0.1, 0.1); nose.translate(0.24, 1.32, 0);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const mb = new THREE.InstancedMesh(body, mat, n), mn = new THREE.InstancedMesh(nose, new THREE.MeshBasicMaterial({ color: 0xff3020, toneMapped: false }), n);
  for (const m of [mb, mn]) { m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); }
  mb.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3); mb.instanceColor.setUsage(THREE.DynamicDrawUsage);
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  // overlay
  let cv = null, ctx = null, bg = null;
  function makeOverlay() {
    const D = crowd.debug.D; if (!D || cv) return;
    const N = D.N, W = N.W >> 1, H = N.H >> 1;
    cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    Object.assign(cv.style, { position: 'fixed', left: '8px', top: '60px', width: Math.min(620, innerWidth - 16) + 'px', zIndex: 50, background: '#000', opacity: 0.92, pointerEvents: 'none', imageRendering: 'pixelated' });
    document.body.appendChild(cv); ctx = cv.getContext('2d');
    bg = ctx.createImageData(W, H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = (2 * j) * N.W + 2 * i, o = ((H - 1 - j) * W + i) * 4, c = N.clr[k];
      const v = N.A[k] ? (c ? 40 + Math.min(60, c * 3) : 25) : 0;
      bg.data[o] = v; bg.data[o + 1] = v; bg.data[o + 2] = v + 8; bg.data[o + 3] = 255;
    }
    // sites
    const S = D.P.slots;
    for (let k = 0; k < S.n; k++) {
      const i = Math.floor((S.x[k] - N.x0) / 1), j = H - 1 - Math.floor((S.y[k] - N.y0) / 1); if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const site = D.P.sites[S.site[k]], o = (j * W + i) * 4;
      const c = site.kind === 'rail' ? [40, 70, 160] : site.kind === 'sit' ? [30, 120, 40] : site.kind === 'queue' ? [160, 110, 30] : site.kind === 'walk' ? [120, 110, 20] : [140, 40, 140];
      bg.data[o] = c[0]; bg.data[o + 1] = c[1]; bg.data[o + 2] = c[2];
    }
  }
  function drawOverlay() {
    const D = crowd.debug.D; if (!ctx) return;
    const N = D.N, W = cv.width, H = cv.height, st = crowd.state;
    ctx.putImageData(bg, 0, 0);
    for (let i = 0; i < n; i++) {
      const o = i * 8, a = st[o + 5]; if (a === 255) continue;
      const c = COL[a] || [1, 0, 0];
      ctx.fillStyle = `rgb(${c[0] * 255 | 0},${c[1] * 255 | 0},${c[2] * 255 | 0})`;
      ctx.fillRect((st[o] - N.x0) - 0.5, H - (st[o + 1] - N.y0) - 0.5, 1.5, 1.5);
    }
    const f = crowd.debug.focus; ctx.strokeStyle = '#f00'; ctx.strokeRect(f.x - N.x0 - 3, H - (f.y - N.y0) - 3, 6, 6);
  }
  let tick = 0;
  return {
    meshes: [mb, mn],
    update() {
      const st = crowd.state, col = mb.instanceColor.array;
      for (let i = 0; i < n; i++) {
        const o = i * 8, a = st[o + 5];
        if (a === 255) { mb.setMatrixAt(i, zero); mn.setMatrixAt(i, zero); continue; }
        // Blender (x, y, z) -> three (x, z, -y); yaw about +z -> rotation about three's +y
        p.set(st[o], st[o + 2], -st[o + 1]);
        const sit = a === 4, lean = a === 5;
        e.set(0, st[o + 3], lean ? -0.25 : 0, 'YXZ'); q.setFromEuler(e);
        s.set(1, sit ? 0.62 : 1, 1);
        // walking: a little bob from the phase so foot cadence is visible
        if (a === 0) p.y += Math.abs(Math.sin(st[o + 6] * Math.PI * 2)) * 0.05;
        M.compose(p, q, s); mb.setMatrixAt(i, M); mn.setMatrixAt(i, M);
        const c = COL[a] || [1, 0, 0]; col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      }
      mb.instanceMatrix.needsUpdate = mn.instanceMatrix.needsUpdate = true; mb.instanceColor.needsUpdate = true;
      if (overlay) { if (!cv) makeOverlay(); if ((tick++ & 3) === 0) drawOverlay(); }
    },
    setOverlay(b) { overlay = b; if (cv) cv.style.display = b ? '' : 'none'; },
    setVisible(b) { mb.visible = mn.visible = b; },
  };
}
