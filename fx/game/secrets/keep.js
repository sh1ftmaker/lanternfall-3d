// 2. Storm-only: the figure in the keep. In a storm a dark figure stands in a high window of the Guildhollow keep, a silhouette against a
// faint glow that brightens a little with each flash of lightning. Look at it from the courtyard for two seconds to find it.
import { buildFigure, SHADOW } from './figure.js';

const WIN = { lx: 0, ly: 29.86, z: 17.62 };           // the keep's lake-facing front, top storey, middle window (1.0 m wide, 2.6 m tall, glass at ly = 29.95)
const RANGE = 55, MIN = 4, AIM = 0.955, NEED = 2;

// the weather's own flash curve (fx/weather/shade.js flash()), so ours rises and falls with the sky
const flash = (t) => { if (t < 0) return 0; const r = Math.min(1, t / 0.15), e = r * r * (3 - 2 * r); return e * (Math.exp(-t / 0.55) + 0.35 * Math.exp(-Math.pow((t - 0.45) / 0.18, 2))); };

export function init(S) {
  const { game, lib, THREE } = S;
  const [wx, wy] = lib.world('guildhollow', WIN.lx, WIN.ly), yaw = lib.outward('guildhollow') + Math.PI;     // faces the courtyard
  const grp = new THREE.Group(); game.v3(wx, wy, WIN.z, grp.position); grp.rotation.y = Math.atan2(Math.cos(yaw), -Math.sin(yaw)); grp.visible = false; game.scene.add(grp);
  const fmat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, fog: false });
  const fig = new THREE.Mesh(buildFigure(THREE, SHADOW), fmat); fig.scale.set(1, 1, 0.22); fig.position.z = 0.02; fig.renderOrder = 6; grp.add(fig);
  const gmat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.62, 0.3), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 2.7), gmat); pane.position.set(0, 1.3, 0.0); pane.renderOrder = 5; grp.add(pane);
  const eye = new THREE.Vector3(), dir = new THREE.Vector3(), tgt = new THREE.Vector3(), win = new THREE.Vector3(wx, WIN.z + 1.3, -wy), ndc = new THREE.Vector3(); tgt.copy(win);
  let own = { next: 4 + Math.random() * 6, t: -1 }, look = 0, vis = 0;
  game.on('frame', ({ dt }) => {
    const w = game.weather, now = w && w.now, storm = w && w.state === 'storm' ? Math.min(1, Math.max(0, ((now ? now.storm : 1) - 0.4) * 2)) : 0;
    vis += (storm - vis) * Math.min(1, dt * 1.5); if (storm === 0 && vis < 0.01) vis = 0;
    if (vis <= 0) { grp.visible = false; look = 0; return; }
    grp.visible = true;
    // flash: from the weather module if it exposes it (weather.shade.lightning: { t, amp }), else our own random pulses
    let f = 0; const L = w.shade && w.shade.lightning;
    if (L && typeof L.t === 'number') f = L.t >= 0 ? flash(L.t) * (L.amp || 1) : 0;
    else { own.next -= dt; if (own.next < 0) { own.next = 8 + Math.random() * 14; own.t = 0; } if (own.t >= 0) { own.t += dt; f = flash(own.t) * 0.9; if (own.t > 3) own.t = -1; } }
    if (game.reduceMotion) f = 0;
    fmat.opacity = vis; gmat.opacity = vis * Math.min(1, 0.2 + 0.85 * f);
    // found: within range and looking straight at it for two seconds
    if (S.isFound('keep')) return;
    const p = game.player; if (p.mode !== 'walk' || vis < 0.8) { look = 0; return; }
    game.camera.getWorldDirection(dir); eye.copy(game.camera.position); tgt.set(wx, WIN.z + 1.3, -wy).sub(eye); const d = tgt.length();
    // Wick's camera cannot tilt up 17 degrees of the window from anywhere in range (it looks down at him and the ground stops it
    // going lower), so for him "looking at it" is: the window held on screen, near the middle across and below the top edge
    let at = false;
    if (d < RANGE && d > MIN) { if (p.wick) {
        ndc.copy(win).project(game.camera); at = ndc.z < 1 && Math.abs(ndc.x) < 0.3 && ndc.y > -0.6 && ndc.y < 0.95;
        // Wick's camera sits above him: standing in the courtyard facing the keep in a storm, ease it down so the window comes into view
        const C = game.platformer && game.platformer.S && game.platformer.S.cam;
        if (!at && C && ndc.z < 1 && Math.abs(ndc.x) < 0.5 && ndc.y >= 0.95 && C.pitch > -0.35 && game.player.speed < 1 && (game.platformer.S.t - (C.lastUser || -10)) > 1.5) C.pitch = Math.max(-0.35, C.pitch - dt * 0.35);
      } else at = tgt.normalize().dot(dir) > AIM; }
    if (at) look += dt; else look = Math.max(0, look - dt * 2);
    if (look >= NEED) S.found('keep');
  });
  return { pos: [wx, wy, WIN.z], get visible() { return grp.visible; }, get look() { return look; } };
}
