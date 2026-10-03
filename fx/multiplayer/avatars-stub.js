// Stand-in for ./avatars.js (the remote Wicks), same interface: a small glowing marker and a name label per visitor,
// moved ~120 ms behind each sender's own timeline. Used only when avatars.js is missing.
export function createAvatars({ THREE, scene }) {
  const geo = new THREE.SphereGeometry(0.35, 12, 8), DELAY = 120, list = new Map();
  const group = new THREE.Group(); group.name = 'mp-stub'; scene.add(group);
  function label(text) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 48; const g = c.getContext('2d');
    g.font = '600 26px Figtree, system-ui, sans-serif'; g.textAlign = 'center'; g.fillStyle = 'rgba(13,11,38,.7)'; g.fillRect(0, 4, 256, 40); g.fillStyle = '#f5ecdc'; g.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(c), m = new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true, fog: false });
    const s = new THREE.Sprite(m); s.scale.set(1.6, 0.3, 1); s.position.y = 1.2; s.userData.tex = tex; return s;
  }
  const api = {
    upsert(id, st) {
      let a = list.get(id);
      if (!a) {
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: st.kind === 'wick' ? 0xffb547 : 0x9fd0ff, transparent: true, opacity: 0 }));
        mesh.add(label(st.name)); group.add(mesh);
        a = { mesh, buf: [], off: null, fade: 0, out: false, anim: st.anim }; list.set(id, a);
      }
      a.out = false; a.anim = st.anim; a.name = st.name; a.kind = st.kind;
      const o = st.t - performance.now(); a.off = a.off === null ? o : Math.max(o, a.off);      // sender clock -> ours (the least delayed sample)
      a.buf.push({ t: st.t, x: st.x, y: st.y, z: st.z }); if (a.buf.length > 20) a.buf.shift();
    },
    remove(id) { const a = list.get(id); if (a) a.out = true; },
    update(dt) {
      const now = performance.now();
      for (const [id, a] of list) {
        a.fade = Math.max(0, Math.min(1, a.fade + (a.out ? -dt : dt)));
        if (a.out && a.fade <= 0) { group.remove(a.mesh); a.mesh.material.dispose(); a.mesh.children[0].material.dispose(); a.mesh.children[0].userData.tex.dispose(); list.delete(id); continue; }
        a.mesh.material.opacity = a.fade; a.mesh.children[0].material.opacity = a.fade;
        const T = now + a.off - DELAY, b = a.buf; if (!b.length) continue;
        let p = b[b.length - 1];
        for (let i = b.length - 1; i > 0; i--) if (b[i - 1].t <= T) { const q = b[i - 1], r = b[i], f = Math.min(1.5, (T - q.t) / Math.max(1, r.t - q.t)); p = { x: q.x + (r.x - q.x) * f, y: q.y + (r.y - q.y) * f, z: q.z + (r.z - q.z) * f }; break; }
        a.mesh.position.set(p.x, p.z + 0.9, -p.y);
      }
    },
    get count() { return list.size; },
    get list() { return [...list].map(([id, a]) => ({ id, name: a.name, kind: a.kind, anim: a.anim, fade: a.fade, pos: a.mesh.position.clone() })); },
    setVisible(on) { group.visible = on; },
    dispose() { for (const id of [...list.keys()]) { const a = list.get(id); group.remove(a.mesh); a.mesh.material.dispose(); a.mesh.children[0].material.dispose(); } list.clear(); scene.remove(group); geo.dispose(); },
  };
  return api;
}
