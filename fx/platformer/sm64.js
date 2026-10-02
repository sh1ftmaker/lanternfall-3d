// Thin wrapper around fx/platformer/sm64.wasm (libsm64's movement code, built without a ROM by
// tools/platformer/build-wasm.sh). Works in a Worker, on the main thread and in Node.
//
// Units: the library's own (1 unit = 1 cm here: the park is scaled 100 units per metre), axes as three.js
// (x east, y up, z south). Angles: faceAngle in radians as the library reports it (0 = facing +z, +pi/2 = +x).
//
// const sm = await loadSM64(bytesOrUrl); sm.init(animTable()); sm.loadSurfaces(packed, n); const id = sm.create(x, y, z);
// sm.input.stickX = ...; const s = sm.tick(id);   // s: { pos, vel, faceAngle, fwd, health, action, animID, animFrame, ... }

const TICK_EXTRA = 24;

export async function loadSM64(src) {
  let bytes = src;
  if (typeof src === 'string' || src instanceof URL) {
    const res = await fetch(src); if (!res.ok) throw new Error('sm64.wasm: ' + res.status);
    bytes = await res.arrayBuffer();
  }
  let mem = null, log = [];
  const view = () => new DataView(mem.buffer);
  // minimal WASI: the library only reaches stdio through sprintf's FILE plumbing and malloc's seed
  const wasi = {
    fd_write(fd, iov, iovcnt, nwritten) {
      const dv = view(); let n = 0, s = '';
      for (let i = 0; i < iovcnt; i++) { const p = dv.getUint32(iov + i * 8, true), l = dv.getUint32(iov + i * 8 + 4, true); s += new TextDecoder().decode(new Uint8Array(mem.buffer, p, l)); n += l; }
      if (s.trim()) log.push(s.trim()); dv.setUint32(nwritten, n, true); return 0;
    },
    fd_close: () => 0, fd_seek: () => 70, fd_fdstat_get: () => 0, proc_exit: (c) => { throw new Error('exit ' + c); },
    random_get(p, n) { const a = new Uint8Array(mem.buffer, p, n); for (let i = 0; i < n; i++) a[i] = (Math.random() * 256) | 0; return 0; },
    environ_sizes_get: (a, b) => { view().setUint32(a, 0, true); view().setUint32(b, 0, true); return 0; }, environ_get: () => 0,
    clock_time_get: (id, prec, out) => { view().setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
  };
  const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: new Proxy(wasi, { get: (t, k) => t[k] || (() => 52) }), env: {} });
  const X = instance.exports; mem = X.memory;
  if (X._initialize) X._initialize();
  // struct layout check (the wrapper hard-codes these offsets)
  const L = (k) => X.park_layout(k);
  const layout = { surface: L(0), inputs: L(1), state: L(2), health: L(3), action: L(4), animID: L(5), animFrame: L(6), flags: L(7), particles: L(8), invinc: L(9), buttonA: L(10), verts: L(11) };
  const want = { surface: 44, inputs: 20, state: 60, health: 32, action: 36, animID: 40, animFrame: 44, flags: 48, particles: 52, invinc: 56, buttonA: 16, verts: 8 };
  for (const k in want) if (layout[k] !== want[k]) throw new Error(`sm64.wasm layout: ${k} = ${layout[k]}, expected ${want[k]}`);
  const pIn = X.park_inputs(), pSt = X.park_state(), pEx = X.park_extra();
  let surfPtr = 0, surfCap = 0;
  const state = { pos: [0, 0, 0], vel: [0, 0, 0], faceAngle: 0, fwd: 0, health: 0, action: 0, animID: 0, animFrame: 0, flags: 0, particles: 0, invinc: 0,
    floorY: 0, ceilY: 0, waterY: 0, actionState: 0, actionTimer: 0, actionArg: 0, prevAction: 0, intendedMag: 0, intendedYaw: 0,
    pitch: 0, yaw: 0, roll: 0, gfxPitch: 0, gfxYaw: 0, gfxRoll: 0, animAccel: 0, animFrameF: 0, floorN: [0, 1, 0], peakY: 0, inputBits: 0, torsoPitch: 0, torsoRoll: 0 };
  const S16 = Math.PI / 32768;
  const api = {
    exports: X, layout, log,
    get memoryBytes() { return mem.buffer.byteLength; },
    input: { camLookX: 0, camLookZ: 1, stickX: 0, stickY: 0, a: 0, b: 0, z: 0 },
    init(animTable) {
      const p = X.malloc(animTable.byteLength); new Int16Array(mem.buffer, p, animTable.length).set(animTable);
      X.sm64_global_init_norom(p, animTable.length / 6); X.free(p);
    },
    // packed: Int32Array, 11 per surface: [type | force << 16, terrain, x1, y1, z1, x2, y2, z2, x3, y3, z3]
    loadSurfaces(packed, n) {
      const bytes = n * 44;
      if (bytes > surfCap) { if (surfPtr) X.free(surfPtr); surfCap = Math.ceil(bytes * 1.25); surfPtr = X.malloc(surfCap); }
      new Int32Array(mem.buffer, surfPtr, n * 11).set(packed.subarray(0, n * 11));
      X.sm64_static_surfaces_load(surfPtr, n);
    },
    create(x, y, z) { return X.sm64_mario_create(x, y, z); },
    remove(id) { X.sm64_mario_delete(id); },
    tick(id) {
      const I = api.input, f = new Float32Array(mem.buffer, pIn, 4), u = new Uint8Array(mem.buffer, pIn + 16, 3);
      f[0] = I.camLookX; f[1] = I.camLookZ; f[2] = I.stickX; f[3] = I.stickY; u[0] = I.a ? 1 : 0; u[1] = I.b ? 1 : 0; u[2] = I.z ? 1 : 0;
      X.park_tick(id);
      const dv = new DataView(mem.buffer, pSt, 60), e = new Float32Array(mem.buffer, pEx, TICK_EXTRA);
      for (let k = 0; k < 3; k++) { state.pos[k] = dv.getFloat32(k * 4, true); state.vel[k] = dv.getFloat32(12 + k * 4, true); }
      state.faceAngle = dv.getFloat32(24, true); state.fwd = dv.getFloat32(28, true); state.health = dv.getInt16(32, true);
      state.action = dv.getUint32(36, true); state.animID = dv.getInt32(40, true); state.animFrame = dv.getInt16(44, true);
      state.flags = dv.getUint32(48, true); state.particles = dv.getUint32(52, true); state.invinc = dv.getInt16(56, true);
      state.floorY = e[0]; state.ceilY = e[1]; state.waterY = e[2]; state.actionState = e[3]; state.actionTimer = e[4]; state.actionArg = e[5];
      state.prevAction = e[6] >>> 0; state.intendedMag = e[7]; state.intendedYaw = e[8] * S16;
      state.pitch = e[9] * S16; state.yaw = e[10] * S16; state.roll = e[11] * S16; state.gfxPitch = e[12] * S16; state.gfxYaw = e[13] * S16; state.gfxRoll = e[14] * S16;
      state.animAccel = e[15]; state.animFrameF = e[16]; state.floorN[0] = e[17]; state.floorN[1] = e[18]; state.floorN[2] = e[19];
      state.peakY = e[20]; state.inputBits = e[21]; state.torsoPitch = e[22] * S16; state.torsoRoll = e[23] * S16;
      return state;
    },
    setWaterLevel(id, y) { X.sm64_set_mario_water_level(id, Math.round(y)); },
    setHealth(id, h) { X.sm64_set_mario_health(id, h); },
    setPosition(id, x, y, z) { X.sm64_set_mario_position(id, x, y, z); },
    setVelocity(id, x, y, z) { X.sm64_set_mario_velocity(id, x, y, z); },
    setForwardVel(id, v) { X.sm64_set_mario_forward_velocity(id, v); },
    setFaceAngle(id, a) { X.sm64_set_mario_faceangle(id, a); },
    setAction(id, a, arg = 0) { X.sm64_set_mario_action_arg(id, a >>> 0, arg >>> 0); },
    setInvincibility(id, t) { X.sm64_set_mario_invincibility(id, t); },
    findFloor(x, y, z) { return X.sm64_surface_find_floor_height(x, y, z); },
    findCeil(x, y, z) { return X.sm64_surface_find_ceil(x, y, z, 0); },
    findWall(x, y, z, offY, radius) {          // returns pushed-out position
      const p = X.malloc(12), f = new Float32Array(mem.buffer, p, 3); f[0] = x; f[1] = y; f[2] = z;
      const n = X.sm64_surface_find_wall_collision(p, p + 4, p + 8, offY, radius); const r = [f[0], f[1], f[2], n]; X.free(p); return r;
    },
  };
  return api;
}

// action groups and flags (the library's public numbering)
export const ACT_GROUP = { mask: 0x1C0, stationary: 0x000, moving: 0x040, airborne: 0x080, submerged: 0x0C0, cutscene: 0x100, automatic: 0x140, object: 0x180 };
export const ACT_FLAG = { air: 1 << 11, intangible: 1 << 12, swimming: 1 << 13, invulnerable: 1 << 17, buttOrStomachSlide: 1 << 18, diving: 1 << 19, onPole: 1 << 20, hanging: 1 << 21, attacking: 1 << 23 };
