// Wick's animation layer: original clips for every animation the movement library asks for, blended, phase-locked
// to the ground where it matters, plus secondary motion (cape, hood tip, the swinging paper lantern).
//
// Input each frame: the interpolated library state (animation id + frame, speed, action, body angles) from index.js.
// Output: 19 bone matrices in world space for fx/platformer/character.js.
//
// A pose is a small set of named joint parameters (radians; metres for offsets), all 0 = standing straight with arms
// down. Clips are functions of u (0..1 through the animation) and of a context (time, speed, vertical speed); most are
// written as a few keyframes interpolated with smoothstep. Locomotion (tiptoe / walk / run / crawl / swim kicks) uses
// a gait phase integrated from the distance travelled, so the feet do not slide and walk -> run stays continuous.
import { B, BONES, PARENT, PIVOT, POLE, LANTERN_DROP } from './character.js';
import { CLIP, LEN, LOOP } from './anims.js';

const P0 = { lean: 0.02, side: 0, twist: 0, nod: 0, turn: 0, tilt: 0,
  aLf: 0.05, aLo: 0.14, aLb: 0.25, aLt: 0, aRf: 0.42, aRo: 0.16, aRb: 1.0, aRt: 0,
  lLf: 0, lLo: 0.03, lLk: 0, lLa: 0, lRf: 0, lRo: 0.03, lRk: 0, lRa: 0,
  py: 0, pz: 0, px: 0, pp: 0, pr: 0, pw: 0, poleT: 0.0, poleS: 0.05, poleY: 0, grip: 0, cape: 0, hood: 0, swim: 0 };
const KEYS = Object.keys(P0);
const TAU = Math.PI * 2;
const sm = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
// keyframes: [[u, {params}], ...]; params missing from a key keep the clip's base value
function keys(u, base, list, loop = false) {
  const out = { ...base };
  let i = 0; while (i < list.length - 1 && list[i + 1][0] <= u) i++;
  const [u0, k0] = list[i], [u1, k1] = i + 1 < list.length ? list[i + 1] : loop ? [1 + list[0][0], list[0][1]] : list[i];
  const t = u1 > u0 ? sm((u - u0) / (u1 - u0)) : 0;
  const ks = new Set([...Object.keys(k0), ...Object.keys(k1)]);
  for (const k of ks) { const a = k in k0 ? k0[k] : base[k], b = k in k1 ? k1[k] : base[k]; out[k] = mix(a, b, t); }
  return out;
}
const with_ = (p, o) => Object.assign({ ...p }, o);

// ── standing family ──
const breathe = (p, c, k = 1) => { p.lean += 0.012 * k * Math.sin(c.t * 1.7); p.nod += 0.02 * k * Math.sin(c.t * 1.7 - 0.6); p.aLf += 0.02 * k * Math.sin(c.t * 1.7 + 1); return p; };
const stand = (c) => breathe({ ...P0, pr: 0.012 * Math.sin(c.t * 0.7), lLf: 0.02, lRf: -0.02 }, c);
const CLIPS = {
  pose: (u, c) => stand(c),
  idleLook: (u, c) => keys(u, stand(c), [[0, {}], [0.25, { turn: 0.55, nod: 0.05 }], [0.6, { turn: 0.6, nod: -0.08 }], [1, {}]]),
  idleLookBack: (u, c) => keys(u, stand(c), [[0, {}], [0.3, { turn: -0.6, tilt: 0.08 }], [0.65, { turn: -0.5, tilt: 0.1, nod: -0.12 }], [1, {}]]),
  // trims the lantern: lifts the pole a little and reaches up to the paper with the free hand
  idleTrim: (u, c) => keys(u, stand(c), [[0, {}], [0.2, { aRf: 0.9, aRb: 0.7, poleT: -0.18, nod: -0.25, aLf: 1.9, aLo: -0.15, aLb: 1.2, lean: -0.06 }],
    [0.45, { aRf: 0.95, aRb: 0.7, poleT: -0.2, nod: -0.3, aLf: 2.1, aLo: -0.25, aLb: 1.0, lean: -0.08 }], [0.7, { aRf: 0.9, poleT: -0.18, nod: -0.2, aLf: 1.8, aLb: 1.3 }], [1, {}]]),
  wallLean: (u, c) => breathe({ ...P0, lean: -0.12, aLf: -0.2, aLo: 0.3, lLf: 0.15, lRf: -0.05, lRk: 0.2, nod: -0.05 }, c),
  lookAround: (u, c) => with_(stand(c), { turn: 0.7 * Math.sin(u * TAU), nod: -0.1 }),
  pant: (u, c) => ({ ...P0, lean: 0.55 + 0.05 * Math.sin(u * TAU * 2), py: -0.08, lLk: 0.35, lRk: 0.35, lLf: 0.2, lRf: 0.2, aLf: 0.9, aLb: 0.6, nod: -0.35 }),
  // sitting down for a nap, the pole across the lap
  sitDownStart: (u, c) => keys(u, stand(c), [[0, {}], [0.5, { py: -0.25, lLf: 0.9, lRf: 0.9, lLk: 1.4, lRk: 1.4, lean: 0.3 }], [1, SIT]]),
  sitStretch: (u, c) => keys(u, SIT, [[0, {}], [0.4, { aLf: 2.8, aLo: 0.3, aRf: 2.6, aRb: 0.4, poleT: -0.2, lean: -0.15, nod: -0.3 }], [0.7, { aLf: 2.9, aRf: 2.7, lean: -0.18 }], [1, {}]]),
  sitYawn: (u, c) => keys(u, SIT, [[0, {}], [0.35, { nod: -0.45, aLf: 1.7, aLb: 1.9, aLo: -0.2 }], [0.65, { nod: -0.4, aLf: 1.6, aLb: 2.0 }], [1, {}]]),
  sitDown: (u, c) => keys(u, SIT, [[0, {}], [1, DOZE]]),
  doze: (u, c) => with_(DOZE, { nod: DOZE.nod + 0.12 * Math.sin(u * TAU), lean: DOZE.lean + 0.03 * Math.sin(u * TAU) }),
  lieDown: (u, c) => keys(u, DOZE, [[0, {}], [1, LIE]]),
  sleepLying: (u, c) => with_(LIE, { lean: LIE.lean + 0.02 * Math.sin(u * TAU) }),
  wakeFromDoze: (u, c) => keys(u, DOZE, [[0, {}], [0.5, { ...SIT, nod: -0.1 }], [1, stand(c)]]),
  wakeFromLying: (u, c) => keys(u, LIE, [[0, {}], [0.5, SIT], [1, stand(c)]]),
  // Frostmere: warming the hands at the lantern, shivering
  warmHands: (u, c) => with_(WARM, { aLf: WARM.aLf + 0.05 * Math.sin(c.t * 9), aRf: WARM.aRf + 0.04 * Math.sin(c.t * 9 + 1) }),
  warmHandsEnd: (u, c) => keys(u, WARM, [[0, {}], [1, stand(c)]]),
  shiver: (u, c) => with_(WARM, { pr: 0.025 * Math.sin(c.t * 40), side: 0.03 * Math.sin(c.t * 37), nod: 0.2 }),

  // ── walking, running (gait phase c.ph in cycles) ──
  tiptoeStart: (u, c) => gait(c, 0.4),
  tiptoe: (u, c) => gait(c, 0.4),
  walk: (u, c) => gait(c, 1),
  run: (u, c) => gait(c, 2),
  skid: (u, c) => ({ ...P0, lean: -0.32, py: -0.1, pz: -0.05, lLf: 0.7, lLk: 0.15, lLa: -0.3, lRf: -0.15, lRk: 0.9, aLf: 0.9, aLo: 0.6, aLb: 0.3, aRf: 0.6, aRo: 0.5, poleT: -0.5, nod: 0.15, cape: 0.5 }),
  skidStop: (u, c) => keys(u, CLIPS.skid(u, c), [[0, {}], [1, stand(c)]]),
  turnPlant: (u, c) => keys(u, CLIPS.skid(u, c), [[0, {}], [1, { twist: 0.5, pw: 0.6, lean: -0.1 }]]),
  turnPush: (u, c) => keys(u, { ...P0, twist: -0.4, pw: -0.9, lean: 0.25, lLf: -0.3, lRf: 0.5, lRk: 0.4, aLf: -0.5, aRf: 0.8 }, [[0, {}], [1, { twist: 0, pw: 0, lean: 0.2 }]]),
  push: (u, c) => { const s = Math.sin(c.ph * TAU); return { ...P0, lean: 0.45, aLf: 1.45, aLb: 0.5, aLo: 0.05, aRf: 1.1, aRb: 0.9, poleT: 0.25, lLf: 0.35 + 0.35 * s, lRf: 0.35 - 0.35 * s, lLk: 0.4 + 0.3 * Math.max(0, -s), lRk: 0.4 + 0.3 * Math.max(0, s), py: -0.04, nod: -0.1 }; },
  sidestepLeft: (u, c) => sidestep(c, 1), sidestepRight: (u, c) => sidestep(c, -1),

  // ── crouching, crawling ──
  crouchDown: (u, c) => keys(u, stand(c), [[0, {}], [1, CROUCH]]),
  crouch: (u, c) => breathe({ ...CROUCH }, c, 0.6),
  crouchUp: (u, c) => keys(u, CROUCH, [[0, {}], [1, stand(c)]]),
  crawlStart: (u, c) => keys(u, CROUCH, [[0, {}], [1, crawl({ ph: 0 })]]),
  crawl: (u, c) => crawl(c),
  crawlStop: (u, c) => keys(u, crawl({ ph: 0 }), [[0, {}], [1, CROUCH]]),

  // ── jumps ──
  jump: (u, c) => air(c, keys(u, P0, [[0, { py: -0.08, lLk: 0.7, lRk: 0.7, lLf: 0.5, lRf: 0.4, aLf: -0.4, lean: 0.25 }], [0.2, { lLf: 0.9, lLk: 1.3, lRf: -0.2, lRk: 0.4, aLf: 2.2, aLo: 0.3, aRf: 0.9, aRb: 0.7, poleT: -0.25, lean: 0.05, nod: -0.15 }],
    [0.7, { lLf: 0.6, lLk: 0.9, lRf: 0.1, lRk: 0.5, aLf: 1.6, aLo: 0.5, aRf: 0.8, poleT: -0.15 }], [1, { lLf: 0.35, lLk: 0.4, lRf: 0.3, lRk: 0.35, aLf: 0.6, aLo: 0.8 }]])),
  jumpTwoRise: (u, c) => air(c, keys(u, P0, [[0, { lLf: 0.6, lLk: 0.9 }], [0.4, { lLf: 1.1, lLk: 1.5, lRf: -0.5, lRk: 0.3, aLf: 2.9, aLo: 0.2, aRf: 2.4, aRb: 0.3, poleT: -0.2, lean: -0.08, nod: -0.25 }], [1, { lLf: 0.9, lLk: 1.2, lRf: -0.3, aLf: 2.6, aLo: 0.5, aRf: 2.2, aRb: 0.4, nod: -0.2 }]])),
  jumpTwoFall: (u, c) => air(c, keys(u, P0, [[0, { lLf: 0.9, lLk: 1.2, lRf: -0.3, aLf: 2.6, aRf: 2.2, aRb: 0.4 }], [1, { lLf: 0.4, lLk: 0.5, lRf: 0.2, lRk: 0.3, aLf: 1.2, aLo: 1.0, aRf: 1.0, aRo: 0.7, aRb: 0.6, poleT: 0.15 }]])),
  // a forward somersault, tucked round the pole
  jumpThree: (u, c) => air(c, with_(tuckFlip(u, 0.08, 0.62, 1), { })),
  backflip: (u, c) => air(c, tuckFlip(u, 0.06, 0.66, -1)),
  // side flip: a cartwheel twist with the lantern held high
  sideFlip: (u, c) => { const f = sm((u - 0.05) / 0.62); return air(c, keys(u, P0, [[0, { lLk: 0.7, lRk: 0.7, py: -0.05 }], [0.2, { aLf: 0.2, aLo: 1.6, aRf: 2.8, aRb: 0.2, aRo: 0.3, lLo: 0.5, lRo: 0.5, lLk: 0.3, lRk: 0.3, poleT: -0.1 }], [0.75, { aLf: 0.6, aLo: 1.2, aRf: 2.2, lLk: 0.6, lRk: 0.6, lLf: 0.4, lRf: 0.3 }], [1, { aLo: 0.9, lLf: 0.3, lRf: 0.25, lLk: 0.4, lRk: 0.35 }]], false), { pr: -TAU * f }); },
  sideFlipLand: (u, c) => land(u, c, 0.9),
  longJump: (u, c) => air(c, keys(u, P0, [[0, { py: -0.2, lLk: 1.0, lRk: 1.0, lLf: 0.8, lRf: 0.8, lean: 0.6 }], [0.25, { pp: 1.05, aLf: 2.6, aLo: 0.1, aLb: 0.1, aRf: 2.7, aRb: 0.1, poleT: 1.35, lLf: -0.4, lRf: -0.25, lLk: 0.6, lRk: 0.4, nod: -0.6, cape: 0.6 }],
    [0.8, { pp: 0.75, aLf: 2.2, aRf: 2.4, poleT: 1.2, lLf: 0.2, lRf: 0.4, lLk: 0.7, lRk: 0.8, nod: -0.4 }], [1, { pp: 0.35, aLf: 1.2, aRf: 1.4, poleT: 0.7, lLf: 0.7, lRf: 0.8, lLk: 0.5, lRk: 0.5 }]])),
  longJumpLow: (u, c) => CLIPS.longJump(u, c),
  longJumpLand: (u, c) => keys(u, P0, [[0, { py: -0.22, lLf: 1.1, lRf: 0.6, lLk: 1.6, lRk: 1.2, lean: 0.55, aLf: 1.2, aLo: 0.5, aRf: 1.0, poleT: 0.6 }], [1, CROUCH]]),
  longJumpLandLow: (u, c) => CLIPS.longJumpLand(u, c),
  land: (u, c) => land(u, c, 0.6), landSoft: (u, c) => land(u, c, 0.5), landTwo: (u, c) => land(u, c, 0.8), landThree: (u, c) => land(u, c, 1.0),
  wallTouch: (u, c) => ({ ...P0, lean: 0.25, aLf: 1.6, aLb: 0.4, aRf: 1.3, aRb: 0.7, poleT: -0.3, lLf: 0.7, lLk: 1.1, lRf: 0.2, lRk: 0.6, nod: -0.2, pz: -0.05 }),
  wallKick: (u, c) => air(c, keys(u, P0, [[0, { lean: 0.3, lLf: 0.8, lLk: 1.2, aLf: 1.5, aRf: 1.3 }], [0.25, { lean: -0.2, lLf: -0.3, lLk: 0.1, lRf: -0.5, lRk: 0.2, aLf: 2.8, aLo: 0.4, aRf: 2.6, aRb: 0.2, poleT: -0.3, nod: -0.4, pr: 0.25 }], [1, { lLf: 0.5, lLk: 0.7, lRf: 0.2, lRk: 0.4, aLf: 1.4, aLo: 0.9, aRf: 1.2, poleT: 0 }]])),
  fall: (u, c) => air(c, { ...P0, aLf: 1.6 + 0.25 * Math.sin(c.t * 7), aLo: 1.1 + 0.2 * Math.sin(c.t * 5), aLb: 0.4, aRf: 1.6 + 0.2 * Math.sin(c.t * 6 + 1), aRo: 0.8, aRb: 0.5, poleT: -0.1, lLf: 0.5 + 0.35 * Math.sin(c.t * 8), lRf: 0.5 - 0.35 * Math.sin(c.t * 8), lLk: 0.7 + 0.3 * Math.cos(c.t * 8), lRk: 0.7 - 0.3 * Math.cos(c.t * 8), nod: 0.25, cape: 1 }),
  fallFromWater: (u, c) => CLIPS.fall(u, c),
  rollForward: (u, c) => air(c, with_(TUCK, { pp: TAU * u })),
  rollBack: (u, c) => air(c, with_(TUCK, { pp: -TAU * u })),
  slideFall: (u, c) => CLIPS.fall(u, c), slideKickFall: (u, c) => CLIPS.fall(u, c),

  // ── the lantern pole as a tool: jab, swing, sweeps ──
  jab: (u, c) => keys(u, P0, [[0, {}], [1, JAB]]),
  jabBack: (u, c) => keys(u, JAB, [[0, {}], [1, P0]]),
  swing: (u, c) => keys(u, JAB, [[0, {}], [1, SWING]]),
  swingBack: (u, c) => keys(u, SWING, [[0, {}], [1, P0]]),
  sweep: (u, c) => keys(u, P0, [[0, { py: -0.1 }], [0.15, { ...CROUCH, aRf: 1.2, aRo: 1.0, poleT: 1.3, poleS: 0.6 }], [0.7, { ...CROUCH, pw: TAU, aRf: 1.2, aRo: 1.0, poleT: 1.35, poleS: 0.6 }], [1, { pw: TAU }]]),
  spinSweep: (u, c) => keys(u, CROUCH, [[0, {}], [0.15, { py: -0.48, lLf: 1.6, lLk: 2.2, lRf: -0.4, lRo: 0.9, lRk: 0.1, aLf: 1.3, aLb: 0.2, aRf: 1.0, aRo: 1.2, poleT: 1.45, poleS: 0.9 }], [0.8, { py: -0.48, pw: TAU, lLf: 1.6, lLk: 2.2, lRf: -0.4, lRo: 0.9, aRo: 1.2, poleT: 1.45, poleS: 0.9 }], [1, { ...CROUCH, pw: TAU }]]),
  airSwing: (u, c) => air(c, keys(u, P0, [[0, { aRf: 2.8, aRb: 0.4, poleT: -0.6, lLk: 0.8, lRk: 0.6, lLf: 0.6 }], [0.3, { aRf: 0.9, aRb: 0.1, poleT: 1.6, lean: 0.4, lLf: -0.2, lRf: 0.7, lRk: 1.0, aLo: 1.2 }], [1, { aRf: 0.8, poleT: 0.9, lLf: 0.3, lRf: 0.4, lLk: 0.5, lRk: 0.6, aLo: 0.9 }]])),
  dive: (u, c) => air(c, keys(u, P0, [[0, { lean: 0.5, pp: 0.6, lLk: 0.6, lRk: 0.6, aLf: 1.8, aRf: 1.6 }], [0.3, DIVE], [1, DIVE]])),
  bellySlide: (u, c) => with_(BELLY, { aLf: BELLY.aLf + 0.06 * Math.sin(c.t * 12), lLf: -0.15 + 0.05 * Math.sin(c.t * 10) }),
  bellyGetUp: (u, c) => keys(u, BELLY, [[0, {}], [0.45, { pp: 0.9, py: -0.45, aLf: 0.6, aLb: 1.6, aRf: 0.6, aRb: 1.6, lLf: 0.8, lLk: 1.8, lRf: 0.2, lRk: 1.2, nod: -0.3 }], [0.75, CROUCH], [1, P0]]),
  seatSlide: (u, c) => ({ ...SEAT, aLf: SEAT.aLf + 0.1 * Math.sin(c.t * 8), cape: 0.8 }),
  seatSlideStop: (u, c) => keys(u, SEAT, [[0, {}], [0.5, { ...CROUCH, py: -0.35, lean: 0.4 }], [1, P0]]),
  slideKick: (u, c) => air(c, keys(u, P0, [[0, { lean: 0.3, py: -0.1 }], [0.25, KICK], [1, KICK]])),
  slideKickUp: (u, c) => keys(u, KICK, [[0, {}], [0.5, CROUCH], [1, P0]]),
  // ground pound: tuck spin, drop seat-first, thump
  poundStart: (u, c) => air(c, with_(TUCK, { pp: TAU * sm(u), py: 0.15 })),
  poundStartSpin: (u, c) => air(c, with_(TUCK, { pp: TAU * sm(u), py: 0.15 })),
  pound: (u, c) => air(c, POUND),
  poundLand: (u, c) => keys(u, POUND, [[0, { py: -0.45, lLf: 1.4, lRf: 1.4, lLk: 0.6, lRk: 0.6, aLo: 1.1, aRo: 0.8 }], [0.3, { py: -0.4 }], [1, CROUCH]]),

  // ── ledges (the library keeps the position on top of the ledge, 0.6 m in from the edge, while hanging) ──
  ledgeHang: (u, c) => with_(HANG, { lLf: HANG.lLf + 0.08 * Math.sin(c.t * 2.1), lRf: HANG.lRf - 0.08 * Math.sin(c.t * 2.1 + 0.4), pr: 0.02 * Math.sin(c.t * 1.3) }),
  ledgeClimbSlow: (u, c) => climb(u),
  ledgeClimbFast: (u, c) => climb(u),
  ledgeDrop: (u, c) => climb(1 - u),

  // ── knocked about ──
  airKnockBack: (u, c) => air(c, keys(u, P0, [[0, { lean: -0.5, pp: -0.4, aLf: 2.2, aLo: 1.2, aRf: 1.8, aRo: 1.0, lLf: 0.8, lRf: 0.5, lLk: 0.6, nod: 0.4 }], [1, { lean: -0.3, pp: -0.6, aLf: 2.6, aLo: 1.4, aRf: 2.2, lLf: 1.0, lRf: 0.9, lLk: 0.8, lRk: 0.7, nod: 0.3 }]])),
  airKnockForward: (u, c) => air(c, keys(u, P0, [[0, { lean: 0.5, pp: 0.4, aLf: -0.6, aLo: 1.0, aRf: -0.2, aRo: 0.8, lLf: -0.4, lRf: -0.2, nod: -0.4 }], [1, { lean: 0.4, pp: 0.7, aLf: 1.6, aRf: 1.4, lLf: -0.5, lRf: -0.3, nod: -0.3 }]])),
  fallBackHard: (u, c) => keys(u, P0, [[0, { pp: -0.5, lean: -0.3, aLf: 1.8, aLo: 1.2 }], [0.18, ON_BACK], [0.55, ON_BACK], [0.75, { ...SIT, nod: 0.2, aLf: 2.2, aLb: 2.2 }], [1, P0]]),
  fallFrontHard: (u, c) => keys(u, P0, [[0, { pp: 0.6, lean: 0.4, aLf: 1.6, aRf: 1.4 }], [0.2, BELLY], [0.5, BELLY], [0.75, CROUCH], [1, P0]]),
  knockBack: (u, c) => keys(u, P0, [[0, { lean: -0.4, aLf: 1.3, aLo: 1.2, nod: 0.3 }], [0.3, { ...SIT, py: -0.52 }], [0.6, SIT], [1, P0]]),
  knockForward: (u, c) => keys(u, P0, [[0, { lean: 0.5, aLf: 1.3, nod: -0.3 }], [0.3, { ...CROUCH, py: -0.5, pp: 0.5 }], [1, P0]]),
  stumbleBack: (u, c) => keys(u, P0, [[0, { lean: -0.35, aLf: 1.1, aLo: 1.0, lLf: 0.5, lRk: 0.4, nod: 0.25 }], [0.5, { lean: -0.2, lLf: 0.3, aLo: 0.7 }], [1, P0]]),
  stumbleForward: (u, c) => keys(u, P0, [[0, { lean: 0.4, aLf: -0.4, aLo: 0.9, lRf: 0.5, lLk: 0.4, nod: -0.25 }], [0.5, { lean: 0.2, aLo: 0.6 }], [1, P0]]),
  // ran into a wall: knocked onto the seat, rubs the hood, back up
  bonk: (u, c) => keys(u, P0, [[0, { lean: -0.4, nod: 0.5, aLf: 1.2, aLo: 1.1 }], [0.2, { ...SIT, py: -0.52, nod: 0.3 }], [0.45, { ...SIT, py: -0.52, aLf: 2.6, aLb: 2.4, aLo: 0.1, nod: -0.2 }], [0.75, { ...CROUCH, aLf: 2.4, aLb: 2.3 }], [1, P0]]),

  // ── water: the lantern is held up out of the water ──
  tread: (u, c) => treadPose(c),
  treadStart: (u, c) => keys(u, with_(treadPose(c), { py: -0.6 }), [[0, {}], [1, treadPose(c)]]),
  stroke: (u, c) => swimStroke(u, c),
  strokeGlide: (u, c) => swimGlide(u, c),
  flutter: (u, c) => flutterPose(c),
  waterSwing: (u, c) => with_(flutterPose(c), { aRf: mix(2.6, 1.0, u), poleT: mix(-0.2, 1.4, u) }),
  waterSwingBack: (u, c) => with_(flutterPose(c), { aRf: mix(1.0, 2.6, u), poleT: mix(1.4, -0.2, u) }),
  waterSwingEnd: (u, c) => flutterPose(c),
  waterKnockBack: (u, c) => with_(treadPose(c), { pp: -0.5 + 0.5 * u, aLo: 1.2 }),
  waterKnockForward: (u, c) => with_(treadPose(c), { pp: 0.5 - 0.5 * u, aLo: 1.0 }),
};
// ── shared poses ──
const SIT = { ...P0, py: -0.52, lLf: 1.45, lRf: 1.45, lLk: 0.55, lRk: 0.55, lLo: 0.25, lRo: 0.18, lean: 0.12, aLf: 0.5, aLb: 0.6, aRf: 0.8, aRb: 1.3, poleT: 1.35, poleS: 1.2, nod: 0.05 };
const DOZE = { ...SIT, nod: 0.55, lean: 0.35, aLf: 0.7, aLb: 1.2, turn: 0.15 };
const LIE = { ...SIT, py: -0.62, pp: -1.45, pz: -0.5, lean: 0, nod: -0.1, turn: 0.4, lLf: 0.2, lRf: 0.35, lLk: 0.2, lRk: 0.5, aLf: 2.6, aLb: 1.8, aRf: 0.3, aRb: 0.4, poleT: 1.5 };
const WARM = { ...P0, lean: 0.15, nod: 0.35, aLf: 1.0, aLb: 1.7, aLo: -0.35, aRf: 1.0, aRb: 1.6, aRo: -0.1, poleT: 0.2, grip: 0.55, lLk: 0.12, lRk: 0.12 };
const CROUCH = { ...P0, py: -0.33, lean: 0.38, lLf: 1.05, lRf: 0.95, lLk: 1.75, lRk: 1.6, lLa: -0.6, lRa: -0.55, aLf: 0.7, aLb: 0.6, aRf: 0.9, aRb: 1.0, poleT: 0.55, nod: -0.35, cape: 0.2 };
const TUCK = { ...P0, lean: 0.45, lLf: 1.7, lRf: 1.7, lLk: 2.3, lRk: 2.3, aLf: 1.2, aLb: 1.8, aRf: 1.0, aRb: 1.5, poleT: 0.2, nod: -0.4, py: 0.2 };
const JAB = { ...P0, lean: 0.25, twist: -0.35, aRf: 1.45, aRb: 0.05, aRo: 0.05, poleT: 1.5, poleS: -0.05, grip: 0.4, lLf: 0.45, lLk: 0.3, lRf: -0.3, aLf: -0.3, aLo: 0.4, pz: 0.08 };
const SWING = { ...P0, lean: 0.2, twist: 0.55, aRf: 1.35, aRo: -0.3, aRb: 0.15, poleT: 1.45, poleS: -0.9, grip: 0.4, lRf: 0.45, lRk: 0.3, lLf: -0.25, aLo: 0.6 };
const ON_BACK = { ...P0, py: -0.7, pp: -1.5, pz: -0.4, lean: -0.1, nod: 0.3, aLf: 1.2, aLo: 1.3, aLb: 0.3, aRf: 0.8, aRo: 1.0, poleT: 1.5, poleS: 1.0, lLf: 0.4, lRf: 0.7, lLk: 0.5, lRk: 1.0 };
const DIVE = { ...P0, pp: 1.35, lean: 0.05, aLf: 2.9, aLo: 0.05, aLb: 0.05, aRf: 2.9, aRb: 0.05, poleT: 1.5, lLf: -0.15, lRf: -0.05, lLk: 0.2, lRk: 0.35, nod: -1.0, cape: 0.8 };
const BELLY = { ...DIVE, py: -0.62, pp: 1.5, nod: -1.1, lLk: 0.1, lRk: 0.2 };
const SEAT = { ...P0, py: -0.58, lean: -0.35, lLf: 1.5, lRf: 1.5, lLk: 0.15, lRk: 0.2, lLa: 0.4, lRa: 0.4, aLf: -0.6, aLo: 0.5, aLb: 0.4, aRf: 0.6, aRo: 0.5, poleT: -0.6, nod: 0.25 };
const KICK = { ...P0, py: -0.55, pp: -0.9, lean: -0.15, lLf: 1.5, lLk: 0.05, lRf: 0.6, lRk: 1.2, aLf: 0.3, aLo: 1.3, aRf: 2.0, aRb: 0.3, poleT: -0.4, nod: 0.6, cape: 0.8 };
const POUND = { ...P0, py: 0.25, lean: 0.25, lLf: 1.6, lRf: 1.6, lLk: 2.2, lRk: 2.2, aLf: 2.6, aLo: 0.5, aLb: 0.4, aRf: 2.3, aRb: 0.5, poleT: -0.15, nod: -0.3, cape: 1 };
const HANG = { ...P0, py: -1.66, pz: -0.7, lean: 0.06, aLf: 2.95, aLo: 0.18, aLb: 0.1, aRf: 2.95, aRo: 0.12, aRb: 0.15, poleT: 0.15, grip: -0.1, lLf: 0.12, lRf: -0.08, lLk: 0.25, lRk: 0.15, nod: -0.25 };
function climb(u) {   // from hanging below the ledge to standing on it (+0.14 m forward, where the library puts the feet next)
  return keys(u, HANG, [[0, {}], [0.3, { py: -1.0, pz: -0.62, aLf: 1.6, aLb: 1.6, aRf: 1.5, aRb: 1.5, lean: 0.4, lLf: 0.6, lLk: 0.9 }],
    [0.6, { py: -0.38, pz: -0.32, aLf: 0.6, aLb: 0.4, aRf: 0.8, aRb: 0.9, lean: 0.6, lLf: 1.5, lLk: 2.0, lRf: 0.2, lRk: 0.8, nod: -0.2 }],
    [0.85, { ...CROUCH, pz: 0.06, py: -0.2 }], [1, { ...P0, pz: 0.14 }]]);
}
function land(u, c, k) { return keys(u, P0, [[0, { py: -0.16 * k, lean: 0.35 * k, lLf: 0.7 * k, lRf: 0.6 * k, lLk: 1.3 * k, lRk: 1.2 * k, lLa: -0.4 * k, lRa: -0.4 * k, aLf: 0.6, aLo: 0.7 * k, aRf: 0.7, aRo: 0.4 * k, nod: -0.2 * k }], [1, stand(c)]]); }
function tuckFlip(u, a, b, dir) {
  const f = sm((u - a) / (b - a));
  const p = keys(u, P0, [[0, { py: -0.05, lLk: 0.8, lRk: 0.8, lLf: 0.5, lRf: 0.5, aLf: 1.2 }], [a + 0.08, TUCK], [b - 0.05, TUCK], [Math.min(1, b + 0.12), { lLf: 0.5, lRf: 0.45, lLk: 0.6, lRk: 0.55, aLf: 1.6, aLo: 0.9, aRf: 1.4, aRo: 0.5, lean: 0.1 }], [1, { lLf: 0.35, lRf: 0.3, lLk: 0.45, lRk: 0.4, aLf: 0.9, aLo: 1.0, aRf: 0.9, aRo: 0.6 }]]);
  p.pp += dir * TAU * f; return p;
}
function air(c, p) {    // hood tip and cape react to the vertical speed
  p.cape = (p.cape || 0) + Math.max(0, Math.min(1.2, -c.vy * 0.09)); p.hood = (p.hood || 0) + Math.max(-0.5, Math.min(0.8, -c.vy * 0.06)); return p;
}
// gait: g 0.4 tiptoe, 1 walk, 2 run (blended by speed inside); c.ph cycles, c.speed m/s
function gait(c, g) {
  const t = c.ph * TAU, s = Math.sin(t), co = Math.cos(t);
  const run = sm((g - 1)), walk = 1 - run, tip = g < 1 ? 1 : 0;
  const sw = tip ? 0.28 : mix(0.42, 0.82, run);
  const p = { ...P0 };
  p.lLf = sw * s + (tip ? 0.05 : 0.08 * run); p.lRf = -sw * s + (tip ? 0.05 : 0.08 * run);
  // knee: bends through the swing (leg moving forward), more when running
  const kn = tip ? 0.45 : mix(0.65, 1.55, run);
  p.lLk = 0.08 + kn * Math.max(0, Math.sin(t + 1.2)) ** 2; p.lRk = 0.08 + kn * Math.max(0, Math.sin(t + 1.2 + Math.PI)) ** 2;
  p.lLa = -0.2 * s * (1 - tip); p.lRa = 0.2 * s * (1 - tip);
  p.py = -(tip ? 0.05 : mix(0.025, 0.06, run)) * Math.abs(co) + (tip ? -0.03 : 0) + 0.03 * run * Math.abs(s);
  p.lean = tip ? 0.12 : mix(0.06, 0.3, run);
  p.twist = 0.1 * s * (1 + run); p.pr = 0.025 * s;
  // free (left) arm swings against the left leg; the right arm carries the pole forward
  p.aLf = -mix(0.35, 0.9, run) * s * (tip ? 0.5 : 1) + 0.1 * run; p.aLb = mix(0.3, 1.4, run); p.aLo = tip ? 0.35 : 0.14;
  p.aRf = mix(0.5, 0.9, run) + 0.08 * s; p.aRb = mix(0.95, 1.2, run); p.poleT = mix(0.15, 0.75, run) + 0.05 * Math.sin(t * 2); p.poleS = 0.05;
  p.nod = -0.04 + 0.03 * Math.sin(2 * t); p.turn = -0.06 * s;
  p.cape = 0.25 * walk * (c.speed / 4) + run * 0.9; p.hood = 0.1 + run * 0.4;
  return p;
}
function sidestep(c, d) { const t = c.ph * TAU, s = Math.sin(t); return { ...P0, lean: -0.05, lLo: 0.12 + 0.18 * d * s, lRo: 0.12 - 0.18 * d * s, lLk: 0.2 + 0.2 * Math.max(0, s), lRk: 0.2 + 0.2 * Math.max(0, -s), aLf: -0.2, aLo: 0.25, aRf: 0.3, aRb: 0.8, poleT: -0.1, turn: 0.5 * d, py: -0.03 }; }
function crawl(c) {
  const t = (c.ph || 0) * TAU, s = Math.sin(t);
  return { ...P0, py: -0.47, pp: 0.95, lean: 0.25, nod: -0.75, lLf: 1.5 + 0.35 * s, lRf: 1.5 - 0.35 * s, lLk: 1.9, lRk: 1.9, lLa: 0.4, lRa: 0.4,
    aLf: 1.25 - 0.4 * s, aLb: 0.35, aLo: 0.1, aRf: 1.1 + 0.4 * s, aRb: 0.6, poleT: 1.45, poleS: -0.15, cape: 0.1 };
}
function treadPose(c) { const t = c.t * 2.2; return { ...P0, swim: 1, py: -0.42, lean: 0.12, lLf: 0.6 + 0.35 * Math.sin(t), lRf: 0.6 - 0.35 * Math.sin(t), lLk: 1.0 + 0.4 * Math.cos(t), lRk: 1.0 - 0.4 * Math.cos(t), aLf: 0.9 + 0.3 * Math.sin(t * 1.3), aLo: 0.9, aLb: 0.4, aRf: 2.75, aRb: 0.35, aRo: 0.05, poleT: 0.05, nod: -0.15, cape: 0.6 }; }
const SWIM_BASE = { ...P0, swim: 1, pp: 1.25, py: -0.2, lean: 0.05, nod: -1.0, aRf: 2.85, aRb: 0.1, poleT: 1.45, cape: 0.5 };
function swimStroke(u, c) { return keys(u, SWIM_BASE, [[0, { aLf: 2.9, aLo: 0.1, lLf: 0.1, lRf: 0.1, lLk: 0.2, lRk: 0.2 }], [0.45, { aLf: 0.9, aLo: 1.3, aLb: 0.4, lLf: 0.9, lRf: 0.9, lLk: 1.6, lRk: 1.6, lLo: 0.5, lRo: 0.5 }], [1, { aLf: 0.2, aLo: 0.3, lLf: -0.05, lRf: -0.05, lLk: 0.05, lRk: 0.05, lLo: 0.1, lRo: 0.1 }]]); }
function swimGlide(u, c) { return keys(u, SWIM_BASE, [[0, { aLf: 0.2, aLo: 0.3 }], [1, { aLf: 2.9, aLo: 0.1, lLk: 0.2, lRk: 0.2 }]]); }
function flutterPose(c) { const t = c.t * 13; return { ...SWIM_BASE, lLf: 0.25 * Math.sin(t), lRf: -0.25 * Math.sin(t), lLk: 0.25 + 0.2 * Math.max(0, Math.sin(t)), lRk: 0.25 + 0.2 * Math.max(0, -Math.sin(t)), aLf: 2.9, aLo: 0.1 }; }

// clips that use the gait phase; strides (m per cycle) match fx/platformer/anims.js (walk 40 frames x 4 cm, run 56 x 4 cm)
const GAIT = { tiptoeStart: 0.62, tiptoe: 0.62, walk: 1.6, run: 2.24, push: 1.0, sidestepLeft: 0.8, sidestepRight: 0.8, crawl: 0.75 };
const BLEND = { default: 0.12, jumpThree: 0.06, backflip: 0.06, sideFlip: 0.06, poundStart: 0.05, poundStartSpin: 0.05, rollForward: 0.05, rollBack: 0.05, ledgeHang: 0.08, ledgeClimbSlow: 0.04, ledgeClimbFast: 0.04, walk: 0.18, run: 0.2, tiptoe: 0.2 };

// ── rig evaluation ──
const BODY_C = [0, 0.85, 0];      // the clip's root moves about the body centre
export function createAnimator(THREE) {
  const NB = BONES.length;
  const local = Array.from({ length: NB }, () => new THREE.Matrix4()), world = Array.from({ length: NB }, () => new THREE.Matrix4());
  const tmp = new THREE.Matrix4(), tmp2 = new THREE.Matrix4(), clipRoot = new THREE.Matrix4(), hook = new THREE.Vector3(), hv = new THREE.Vector3(), acc = new THREE.Vector3(), cS = {},   // scratch: no allocation per frame (several remote Wicks run one each)
    e = new THREE.Euler(), q = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const st = { clip: 'pose', prevClip: 'pose', from: null, blendT: 1, blendDur: 0.12, ph: 0, cur: { ...P0 }, lanternWorld: new THREE.Vector3(), hookPrev: null, swing: [0, 0], swingV: [0, 0], cape: 0, hood: 0, t: 0 };
  // rotation about a pivot, local to the parent: T(p) R T(-p)
  const rotAbout = (out, p, rx, ry, rz, order = 'YXZ') => { e.set(rx, ry, rz, order); q.setFromEuler(e); out.makeRotationFromQuaternion(q); const [x, y, z] = p; v.set(x, y, z).applyMatrix4(out); out.elements[12] = x - v.x; out.elements[13] = y - v.y; out.elements[14] = z - v.z; return out; };
  function evalClip(name, u, c) { const f = CLIPS[name] || CLIPS.pose; return f(u, c); }
  // sample: { clip id (anim id), u, ctx }, body: { pos (three.js), yaw, pitch, roll }
  function update(dt, anim, ctx, body) {
    st.t += dt;
    const name = CLIP[anim.id] || 'pose';
    if (GAIT[name]) st.ph = (st.ph + (ctx.speed * dt) / GAIT[name]) % 1;
    const c = Object.assign(cS, ctx); c.t = st.t; c.ph = st.ph;
    if (name !== st.clip) { st.from = { ...st.cur }; st.prevClip = st.clip; st.clip = name; st.blendT = 0; st.blendDur = ctx.reduceMotion ? 0.06 : (BLEND[name] ?? BLEND.default); }
    let p = evalClip(name, anim.u, c);
    if (st.blendT < st.blendDur && st.from) { st.blendT += dt; const w = sm(st.blendT / st.blendDur); const o = {}; for (const k of KEYS) o[k] = mix(st.from[k] ?? P0[k], p[k] ?? P0[k], w); p = o; }
    for (const k of KEYS) if (p[k] === undefined) p[k] = P0[k];
    st.cur = p;
    // secondary: cape and hood tip lag behind speed changes
    st.cape += ((p.cape + Math.min(1.2, ctx.speed * 0.08)) - st.cape) * Math.min(1, dt * 6);
    st.hood += ((p.hood + Math.min(0.6, ctx.speed * 0.05)) - st.hood) * Math.min(1, dt * 5);
    return pose(p, body, dt, ctx);
  }
  function pose(p, body, dt, ctx) {
    // body: world transform = T(pos) Ry(yaw) Rx(pitch) Rz(roll), then the clip's root move about the body centre
    const root = tmp2.makeRotationFromQuaternion(q.setFromEuler(e.set(body.pitch, body.yaw, body.roll, 'YXZ'))).setPosition(body.pos);
    rotAbout(clipRoot, BODY_C, p.pp, p.pw, p.pr); clipRoot.elements[12] += p.px; clipRoot.elements[13] += p.py; clipRoot.elements[14] += p.pz;
    root.multiply(clipRoot);
    const L = local;
    rotAbout(L[B.hips], PIVOT[B.hips], 0, 0, 0);
    rotAbout(L[B.chest], PIVOT[B.chest], p.lean, p.twist, p.side);
    rotAbout(L[B.head], PIVOT[B.head], p.nod, p.turn, p.tilt);
    rotAbout(L[B.armL], PIVOT[B.armL], -p.aLf, p.aLt, p.aLo);
    rotAbout(L[B.foreL], PIVOT[B.foreL], -p.aLb, 0, 0);
    rotAbout(L[B.handL], PIVOT[B.handL], 0, 0, 0);
    rotAbout(L[B.armR], PIVOT[B.armR], -p.aRf, p.aRt, -p.aRo);
    rotAbout(L[B.foreR], PIVOT[B.foreR], -p.aRb, 0, 0);
    rotAbout(L[B.handR], PIVOT[B.handR], 0, 0, 0);
    rotAbout(L[B.thighL], PIVOT[B.thighL], -p.lLf, 0, p.lLo);
    rotAbout(L[B.shinL], PIVOT[B.shinL], p.lLk, 0, 0);
    rotAbout(L[B.footL], PIVOT[B.footL], p.lLa - (p.lLk - p.lLf) * 0.0, 0, 0);
    rotAbout(L[B.thighR], PIVOT[B.thighR], -p.lRf, 0, -p.lRo);
    rotAbout(L[B.shinR], PIVOT[B.shinR], p.lRk, 0, 0);
    rotAbout(L[B.footR], PIVOT[B.footR], p.lRa, 0, 0);
    // pole: absolute tilt (relative to the chest) = poleT forward, poleS sideways; compensate the right arm's bends
    rotAbout(L[B.pole], PIVOT[B.pole], (p.aRf + p.aRb) + p.poleT, p.poleY, p.aRo + p.poleS);
    L[B.pole].multiply(tmp.makeTranslation(0, -p.grip, 0));
    rotAbout(L[B.cape], PIVOT[B.cape], -Math.min(1.35, 0.12 + st.cape * 0.75 + (p.swim ? 0.3 : 0)) + 0.04 * Math.sin(st.t * 3.1), 0, 0.05 * Math.sin(st.t * 2.3));
    rotAbout(L[B.hoodTip], PIVOT[B.hoodTip], -0.15 - st.hood * 0.6 + 0.05 * Math.sin(st.t * 2.7), 0.08 * Math.sin(st.t * 1.9), 0);
    for (let i = 0; i < NB; i++) {
      if (i === B.lantern) continue;
      const pi = PARENT[i];
      if (pi < 0) world[i].multiplyMatrices(root, L[i]); else world[i].multiplyMatrices(world[pi], L[i]);
    }
    // lantern: hangs from the hook as a damped pendulum driven by the hook's acceleration (world space)
    const [gx, gy, gz] = PIVOT[B.pole];
    hook.set(gx, gy + POLE.above + 0.03, gz + POLE.hook).applyMatrix4(world[B.pole]);
    if (!st.hookPrev) { st.hookPrev = new THREE.Vector3(); st.hookV = new THREE.Vector3(); st.hookPrev.copy(hook); }
    else if (dt <= 0 || dt > 0.25) { st.hookPrev.copy(hook); st.hookV.set(0, 0, 0); }
    hv.copy(hook).sub(st.hookPrev).divideScalar(Math.max(dt, 1e-3)); acc.copy(hv).sub(st.hookV).divideScalar(Math.max(dt, 1e-3));
    st.hookV.copy(hv); st.hookPrev.copy(hook);
    const g = 9.81, len = 0.18, damp = ctx.reduceMotion ? 6 : 2.2;
    for (let k = 0; k < 2; k++) {            // swing[0] about x (tilts toward -z/+z), swing[1] about z
      const a = k === 0 ? -acc.z : acc.x;
      const ang = st.swing[k], alpha = -(g / len) * Math.sin(ang) - damp * st.swingV[k] + (Math.max(-30, Math.min(30, a)) / len) * Math.cos(ang) * (k === 0 ? 1 : -1);
      st.swingV[k] += alpha * Math.min(dt, 0.05); st.swing[k] = Math.max(-1.1, Math.min(1.1, st.swing[k] + st.swingV[k] * Math.min(dt, 0.05)));
    }
    world[B.lantern].makeRotationFromQuaternion(q.setFromEuler(e.set(st.swing[0], body.yaw, st.swing[1], 'XYZ'))).setPosition(hook);
    st.lanternWorld.set(0, -LANTERN_DROP - 0.11, 0).applyMatrix4(world[B.lantern]);
    return world;
  }
  return { update, st, clips: CLIPS, P0 };
}
export { CLIPS };
