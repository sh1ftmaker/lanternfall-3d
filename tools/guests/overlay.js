// Debug overlay for data/guests.json (guests-data agent; not part of the viewer).
// Load from the console or a test script:  import('./tools/guests/overlay.js').then((m) => m.install(window.__park))
// Draws every POI as a coloured post with a facing arrow; benches as a bar along the seat at seat height, with the
// approach point; stalls with their queue line. Blender (x, y, z) -> three (x, z, -y).
import * as THREE from 'three';

const COL = { bench: 0x50c8ff, stall: 0xffaa28, queue: 0xff7800, view: 0x78ff78, photo: 0xff50c8, stage: 0xffff50, table: 0xc88cff };

export async function install(park, url = 'data/guests.json') {
  const g = await (await fetch(url, { cache: 'no-cache' })).json();
  const B = (x, y, z) => new THREE.Vector3(x, z, -y);
  const pos = [], col = [];
  const seg = (a, b, c) => { pos.push(a.x, a.y, a.z, b.x, b.y, b.z); const k = new THREE.Color(c); col.push(k.r, k.g, k.b, k.r, k.g, k.b); };
  const ball = new THREE.SphereGeometry(0.09, 8, 6);
  const balls = new THREE.InstancedMesh(ball, new THREE.MeshBasicMaterial({ toneMapped: false }), g.pois.length * 2);
  let nb = 0; const M = new THREE.Matrix4();
  const dot = (v, c) => { M.makeTranslation(v.x, v.y, v.z); balls.setMatrixAt(nb, M); balls.setColorAt(nb, new THREE.Color(c)); nb++; };
  for (const p of g.pois) {
    const c = COL[p.type] || 0xffffff, fx = Math.cos(p.yaw), fy = Math.sin(p.yaw);
    if (p.type === 'bench') {
      const L = (p.len || 0.6) / 2, rx = fy, ry = -fx;
      seg(B(p.x - rx * L, p.y - ry * L, p.z + 0.02), B(p.x + rx * L, p.y + ry * L, p.z + 0.02), c);
      seg(B(p.x, p.y, p.z + 0.02), B(p.x + fx * 0.5, p.y + fy * 0.5, p.z + 0.02), 0xffffff);
      for (let k = 0; k < p.cap; k++) { const t = ((k + 0.5) / p.cap - 0.5) * (p.len || 0.6); dot(B(p.x + rx * t, p.y + ry * t, p.z + 0.06), c); }
      if (p.ax !== undefined) { const a = B(p.ax, p.ay, p.z - 0.4); seg(a, B(p.ax, p.ay, p.z + 0.3), 0xffffff); }
    } else if (p.type === 'table') {
      for (let k = 0; k < 16; k++) { const a = k / 16 * 6.283, b = (k + 1) / 16 * 6.283; seg(B(p.x + p.r * Math.cos(a), p.y + p.r * Math.sin(a), p.z), B(p.x + p.r * Math.cos(b), p.y + p.r * Math.sin(b), p.z), c); }
      dot(B(p.x, p.y, p.z + 0.05), c);
    } else {
      seg(B(p.x, p.y, p.z), B(p.x, p.y, p.z + 1.7), c);
      seg(B(p.x, p.y, p.z + 1.5), B(p.x + fx * 0.9, p.y + fy * 0.9, p.z + 1.5), c);
      dot(B(p.x + fx * 0.9, p.y + fy * 0.9, p.z + 1.5), c);
      if (p.rail) dot(B(p.x, p.y, p.z + 1.1), 0xffffff);
      if (p.qyaw !== undefined) seg(B(p.x, p.y, p.z + 0.05), B(p.x + Math.cos(p.qyaw) * (p.qlen || 0.01), p.y + Math.sin(p.qyaw) * (p.qlen || 0.01), p.z + 0.05), 0xff3000);
    }
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); lg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false, depthTest: true }));
  balls.count = nb; balls.instanceMatrix.needsUpdate = true; if (balls.instanceColor) balls.instanceColor.needsUpdate = true;
  lines.frustumCulled = false; balls.frustumCulled = false; lines.renderOrder = 20; balls.renderOrder = 20;
  park.scene.add(lines); park.scene.add(balls);
  park.pois = g.pois;
  return { lines, balls, pois: g.pois };
}
