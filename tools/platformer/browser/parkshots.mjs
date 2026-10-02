// close-up screenshots of Wick in the park, driven by the real library
export default async (page, ctx) => {
  await page.evaluate(() => __park.setMode('walk', { at: [270, 0], yaw: Math.PI }));
  await ctx.sleep(500);
  await page.evaluate(() => __park.setPlatformer(true));
  await page.waitForFunction(() => __park.platformer && __park.platformer.active && __park.platformer.S.latest > 5, { timeout: 90000 });
  const pf = 'const pf = __park.platformer;';
  const place = (x, y, z, face, camYaw, dist, pitch) => page.evaluate(`(()=>{${pf} pf.test.input = () => ({}); pf.teleport(${x}, ${y}, ${z}, ${face}); pf.S.cam.yaw = ${camYaw}; pf.S.cam.dist = ${dist}; pf.S.cam.distNow = ${dist}; pf.S.cam.pitch = ${pitch};})()`);
  const drive = (fn) => page.evaluate(`(()=>{${pf} const t0 = pf.S.t; pf.test.input = (t, v) => (${fn})(t - t0, v); })()`);
  const shots = (ctx.opt('only', '') || '').split(',').filter(Boolean);
  const S = [
    ['idle', [266, 0.4, 2, 1.0, 1.0, 3.4, 0.12], '(t) => ({})', 2600],
    ['run', [300, 0.4, 0, -1.57, 0.0, 4.2, 0.18], '(t) => ({ world: [-1, 0] })', 1500],
    ['jump', [290, 0.4, 0, -1.57, -0.6, 5.0, 0.15], '(t) => ({ world: [-0.3, 0], a: t > 0.3 && t < 1.0 })', 640],
    ['backflip', [288, 0.4, 0, -1.57, -0.5, 5.0, 0.1], '(t) => ({ z: t > 0.2, a: t > 0.45 && t < 0.6 })', 860],
    ['crawl', [266, 0.4, 2, -1.57, -0.9, 3.2, 0.35], '(t) => ({ z: true, world: t > 0.6 ? [-0.6, 0] : [0, 0] })', 2400],
    ['dive', [300, 0.4, 0, -1.57, -1.2, 5.5, 0.15], '(t) => ({ world: [-1, 0], b: t > 1.3 && t < 1.4 })', 1600],
    ['swing', [266, 0.4, 2, 1.0, 1.4, 3.6, 0.15], '(t) => ({ b: (t > 0.3 && t < 0.4) || (t > 0.55 && t < 0.65) })', 820],
    ['ledgeHang', [261.0, 0.42, 23.49, -1.6557, -1.2, 4.5, 0.25], '(t) => ({ world: t < 1.0 ? [Math.sin(-1.6557) * 0.45, Math.cos(-1.6557) * 0.45] : [0, 0], a: t > 0.15 && t < 0.7 })', 1250],
    ['swim', [92, -1.3, 0, -1.57, -0.3, 4.5, 0.4], '(t) => ({ a: (t % 0.6) < 0.15 })', 1800],
  ];
  for (const [name, p, fn, ms] of S) {
    if (shots.length && !shots.includes(name)) continue;
    await place(...p); await ctx.sleep(1100); await drive(fn); await ctx.sleep(ms); await ctx.shot('park_' + name);
  }
  return 'ok';
};
