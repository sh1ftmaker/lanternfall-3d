// The Platformer's animation set: timing for the movement library + the clip each animation id shows.
//
// libsm64 normally reads the original game's animations from a ROM. This build reads none: the movement code only
// needs an animation CLOCK (how long each animation lasts, whether it loops), because some actions wait for an
// animation to end (landings, ledge climbs, turning round, getting up) or test a frame number (attack windows, the
// ground-pound wind-up). The lengths below are this project's own design, chosen to satisfy those frame tests (see
// tools/platformer/anim-frames.txt for every test in the decompiled source, and fx/platformer/TESTING.md for the
// measured timings) and to give strides that match the character's legs. Ids are the library's animation slots
// (0 ... 208); the names are ours. The pose of each clip lives in fx/platformer/animator.js.
//
// Frames are 1/30 s. Walking / running / crawling / swimming animations are advanced by the library at a rate
// proportional to speed (walk and run: 1 frame per 4 cm travelled), so `len` sets the stride: walk 40 frames = 1.6 m per
// two steps, run 56 frames = 2.24 m.

const NOLOOP = 1;
// [id, name, length, loops?]
const SET = [
  // ── standing ──
  [0xC3, 'idleLook', 66, false], [0xC4, 'idleLookBack', 66, false], [0xC5, 'idleTrim', 72, false],   // three idle beats (~2.2 s each)
  [0x7E, 'wallLean', 60, true], [0xC2, 'lookAround', 30, true],
  [0x81, 'sitDownStart', 30, false], [0x82, 'sitStretch', 56, false], [0x83, 'sitYawn', 50, false], [0x84, 'sitDown', 40, false],
  [0x85, 'doze', 64, true], [0x86, 'lieDown', 30, false], [0x87, 'sleepLying', 64, true],
  [0xC8, 'wakeFromDoze', 20, false], [0xC9, 'wakeFromLying', 30, false],
  [0x19, 'warmHands', 88, false], [0x1A, 'warmHandsEnd', 20, false], [0x1B, 'shiver', 50, true],
  [0xBA, 'pant', 30, true],
  // ── walking, running ──
  [0xCA, 'tiptoeStart', 30, true], [0x92, 'tiptoe', 60, true], [0x48, 'walk', 40, true], [0x72, 'run', 56, true],
  [0x0F, 'skid', 12, true], [0x10, 'skidStop', 12, false], [0xBC, 'turnPlant', 8, false], [0xBD, 'turnPush', 10, false],
  [0x6C, 'push', 40, true], [0x7F, 'sidestepLeft', 40, true], [0x80, 'sidestepRight', 40, true],
  // ── crouching ──
  [0x97, 'crouchDown', 8, false], [0x98, 'crouch', 48, true], [0x96, 'crouchUp', 8, false],
  [0x9B, 'crawlStart', 8, false], [0x99, 'crawl', 40, true], [0x9A, 'crawlStop', 8, false],
  // ── jumps ──
  [0x4D, 'jump', 20, false], [0x4E, 'land', 8, false], [0x57, 'landSoft', 8, false],
  [0x50, 'jumpTwoRise', 18, false], [0x4C, 'jumpTwoFall', 18, false], [0x4B, 'landTwo', 10, false],
  [0xC1, 'jumpThree', 36, false], [0xC0, 'landThree', 14, false],
  [0x04, 'backflip', 30, false],
  [0xBF, 'sideFlip', 24, false], [0xBE, 'sideFlipLand', 10, false],
  [0x13, 'longJump', 20, false], [0x14, 'longJumpLow', 20, false], [0x11, 'longJumpLand', 14, false], [0x12, 'longJumpLandLow', 14, false],
  [0xCC, 'wallTouch', 10, false], [0xCB, 'wallKick', 20, false],
  [0x56, 'fall', 30, true], [0x6F, 'rollForward', 16, true], [0x70, 'rollBack', 16, true], [0xA9, 'fallFromWater', 20, true],
  // ── attacks (the lantern pole) ──
  [0x67, 'jab', 6, false], [0x69, 'jabBack', 8, false], [0x68, 'swing', 6, false], [0x6A, 'swingBack', 8, false],
  [0x66, 'sweep', 16, false], [0x71, 'spinSweep', 20, false], [0x4F, 'airSwing', 18, false],
  [0x88, 'dive', 20, false], [0x89, 'bellySlide', 10, true], [0x5A, 'bellyGetUp', 22, false],
  [0x91, 'seatSlide', 10, true], [0x8F, 'seatSlideStop', 14, false], [0x90, 'slideFall', 10, false],
  [0x8C, 'slideKick', 20, false], [0x8D, 'slideKickUp', 14, false], [0x53, 'slideKickFall', 10, false],
  [0x3C, 'poundStart', 10, false], [0x3B, 'poundStartSpin', 10, false], [0x3D, 'pound', 10, false], [0x3A, 'poundLand', 16, false],
  // ── ledges ──
  [0x33, 'ledgeHang', 40, true], [0x00, 'ledgeClimbSlow', 30, false], [0x34, 'ledgeClimbFast', 16, false], [0x1C, 'ledgeDrop', 16, false],
  // ── knocked about ──
  [0x02, 'airKnockBack', 20, false], [0x2D, 'airKnockForward', 20, false],
  [0x01, 'fallBackHard', 72, false], [0x2C, 'fallFrontHard', 50, false],
  [0x7B, 'knockBack', 40, false], [0x7C, 'knockForward', 40, false], [0x74, 'stumbleBack', 30, false], [0x75, 'stumbleForward', 30, false],
  [0x8A, 'bonk', 40, false],
  // ── water ──
  [0xB2, 'tread', 48, true], [0xAD, 'treadStart', 14, false], [0xAA, 'stroke', 18, false], [0xAB, 'strokeGlide', 20, false],
  [0xAC, 'flutter', 14, true], [0xB0, 'waterSwing', 10, false], [0xAF, 'waterSwingBack', 10, false], [0xAE, 'waterSwingEnd', 10, false],
  [0x9E, 'waterKnockBack', 20, false], [0xA8, 'waterKnockForward', 20, false],
];
export const COUNT = 209;
export const CLIP = new Array(COUNT).fill('pose');            // id -> clip name ('pose' = neutral stand-in for unused slots)
export const LEN = new Int16Array(COUNT).fill(20);
export const LOOP = new Uint8Array(COUNT);
export const ID = {};                                         // clip name -> id
for (const [id, name, len, loop] of SET) { CLIP[id] = name; LEN[id] = len; LOOP[id] = loop ? 1 : 0; ID[name] = id; }

// The table sm64_global_init_norom() takes: 6 int16 per id (flags, startFrame, loopStart, loopEnd, yTransDivisor, 0).
// No animation moves the root (no translation flags): the decompiled actions that read root motion are doors, poles
// and cutscenes, none of which exist in the park.
export function animTable() {
  const t = new Int16Array(COUNT * 6);
  for (let i = 0; i < COUNT; i++) { t[i * 6] = LOOP[i] ? 0 : NOLOOP; t[i * 6 + 1] = 0; t[i * 6 + 2] = 0; t[i * 6 + 3] = LEN[i]; }
  return t;
}
