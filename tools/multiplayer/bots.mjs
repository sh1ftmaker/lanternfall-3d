// Pretend visitors for trying the figures and measuring cost: N walkers on circles around a spot, sending Wick states
// at 10 Hz like a real page (running animation, frames advancing), or first-person states with --fp.
// usage: node tools/multiplayer/bots.mjs N [--host 127.0.0.1:8970] [--at 288,0] [--fp] [--secs 0 (forever)]
const args = process.argv.slice(2), opt = (k, d) => (args.includes('--' + k) ? args[args.indexOf('--' + k) + 1] : d);
const N = +(args[0] || 8), HOST = opt('host', '127.0.0.1:8970'), [CX, CY] = opt('at', '288,0').split(',').map(Number), FP = args.includes('--fp'), SECS = +opt('secs', 0);
const RUN = 0x72, RUN_LEN = 56, local = /^(localhost|127\.|10\.|192\.168\.)/.test(HOST);
const bots = [];
for (let i = 0; i < N; i++) {
  const ws = new WebSocket(`${local ? 'ws' : 'wss'}://${HOST}/parties/main/park?_pk=bot${i}${Math.random().toString(36).slice(2, 8)}`);
  const b = { ws, r: 3 + (i % 6) * 1.4, a: (i / N) * Math.PI * 2, w: (0.35 + (i % 3) * 0.12) * (i % 2 ? 1 : -1), frame: 0, name: null };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m[0] === 'w') b.name = m[2]; };
  bots.push(b);
}
const t0 = performance.now();
let last = t0;
const timer = setInterval(() => {
  const now = performance.now(), dt = (now - last) / 1000; last = now;
  for (const b of bots) {
    if (b.ws.readyState !== 1) continue;
    b.a += b.w * dt; const x = CX + Math.cos(b.a) * b.r, y = CY + Math.sin(b.a) * b.r, speed = Math.abs(b.w) * b.r;
    const yaw = b.a + Math.sign(b.w) * Math.PI / 2;           // heading along the circle (game.player.yaw: atan2 of the direction, x east, y north)
    b.frame = (b.frame + speed * dt / 0.04) % RUN_LEN;
    b.ws.send(JSON.stringify(['s', FP ? 2 : 1, +x.toFixed(2), +y.toFixed(2), 0.1, +Math.atan2(Math.sin(yaw), Math.cos(yaw)).toFixed(3), FP ? -1 : RUN, FP ? 0 : +b.frame.toFixed(1), Math.round(now), 'gate']));
  }
  if (SECS && now - t0 > SECS * 1000) { clearInterval(timer); for (const b of bots) b.ws.close(); }
}, 100);
setTimeout(() => console.log(`${bots.filter((b) => b.name).length} of ${N} bots in: ${bots.map((b) => b.name).join(', ')}`), 2000);
