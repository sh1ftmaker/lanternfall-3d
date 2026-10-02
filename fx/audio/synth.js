// Placeholder sounds for the audio engine (fx/audio/engine.js), synthesised in code so the engine works, and can be
// judged for panning, distance and crossfades, before (or without) the real content in data/audio/. Every zone gets
// its own noise colour, drone pitch and music timbre so they are easy to tell apart on a recording. Nothing here is
// meant to be the final sound of the park; it is deterministic (seeded) and cheap: buffers at 22.05 kHz, generated
// on demand, a few tens of milliseconds each.
export const SR = 22050;

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296); }; }
const TAU = Math.PI * 2;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ── tiny DSP kit ──
function biquad(type, f, q = 0.707) {          // RBJ cookbook; returns a per-sample function
  const w = TAU * Math.min(f, SR * 0.45) / SR, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
  let b0, b1, b2, a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
  else { b0 = a; b1 = 0; b2 = -a; }                                  // band-pass, 0 dB peak
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
function pinkGen(r) { let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return () => { const w = r() * 2 - 1; b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898; const o = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926; return o * 0.11; }; }
function brownGen(r) { let l = 0; return () => { l = (l + 0.02 * (r() * 2 - 1)) / 1.02; return l * 3.5; }; }
function noiseGen(colour, r) { return colour === 'pink' ? pinkGen(r) : colour === 'brown' ? brownGen(r) : () => r() * 2 - 1; }

// a loop of n samples per channel; fill(ch, buf, r) writes n + F samples, the tail is cross-faded into the head
function loopBuf(ctx, seconds, channels, fill, seed = 1) {
  const n = Math.round(seconds * SR), F = Math.round(0.6 * SR);
  const ab = ctx.createBuffer(channels, n, SR);
  for (let ch = 0; ch < channels; ch++) {
    const tmp = new Float32Array(n + F); fill(ch, tmp, rng(seed * 7919 + ch * 104729 + 13));
    const out = ab.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] = tmp[i];
    for (let i = 0; i < F; i++) { const t = i / F; out[i] = tmp[i] * Math.sqrt(t) + tmp[n + i] * Math.sqrt(1 - t); }
  }
  return ab;
}
// adds events into a circular buffer of n samples (seamless by construction)
function ring(n) { const b = new Float32Array(n); return { b, add(i, v) { b[((i % n) + n) % n] += v; } }; }
function normalise(a, peak) { let m = 1e-9; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); const k = peak / m; for (let i = 0; i < a.length; i++) a[i] *= k; return a; }
function oneShot(ctx, seconds, render, seed = 1, peak = 0.7) {
  const n = Math.max(1, Math.round(seconds * SR)), ab = ctx.createBuffer(1, n, SR), d = ab.getChannelData(0);
  render(d, rng(seed)); normalise(d, peak);
  const f = Math.min(n, Math.round(0.004 * SR)); for (let i = 0; i < f; i++) { d[i] *= i / f; d[n - 1 - i] *= i / f; }   // no edge clicks
  return ab;
}

// ── zone beds: wide stereo noise of a zone-specific colour + a soft drone + a zone texture ──
const BEDS = {
  guildhollow: { colour: 'brown', lp: 900, drone: 55, texture: 'crackle' },
  frostmere: { colour: 'white', lp: 6000, hp: 1500, drone: 0, texture: 'wind', chime: 84 },
  meridian: { colour: 'pink', lp: 4000, drone: 60, texture: 'hum' },
  wanderers: { colour: 'pink', lp: 2500, drone: 87.3, texture: 'air' },
  brinewatch: { colour: 'brown', lp: 700, drone: 49, texture: 'lap' },
  'lantern-row': { colour: 'pink', lp: 3000, drone: 65.4, texture: 'chime', chime: 79 },
  rosewick: { colour: 'pink', lp: 1800, drone: 58.3, texture: 'crickets' },
  lake: { colour: 'brown', lp: 500, drone: 0, texture: 'lap' },
  gate: { colour: 'pink', lp: 2200, drone: 0, texture: 'air' },
  gap: { colour: 'pink', lp: 1200, drone: 0, texture: 'crickets' },
  sky: { colour: 'brown', lp: 1400, drone: 41.2, texture: 'wind' },
};
export function bed(ctx, land, seed = 1) {
  const P = BEDS[land] || BEDS.gap;
  return loopBuf(ctx, 12, 2, (ch, o, r) => {
    const nz = noiseGen(P.colour, r), lp = biquad('lp', P.lp), hp = P.hp ? biquad('hp', P.hp) : null, bp = biquad('bp', 2200 + ch * 300, 4);
    const n = o.length; let crack = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR; let v = lp(nz()); if (hp) v = hp(v);
      let a = 0.5;
      if (P.texture === 'wind') a = 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(TAU * t / 6 + ch)) * (0.6 + 0.4 * Math.sin(TAU * t / 2.3));
      if (P.texture === 'lap') a = 0.4 + 0.35 * Math.max(0, Math.sin(TAU * t * 0.42 + ch * 1.3)) ** 2;
      v *= a;
      if (P.drone) v += 0.10 * Math.sin(TAU * P.drone * t + ch) + 0.04 * Math.sin(TAU * P.drone * 1.5 * t);
      if (P.texture === 'hum') v += 0.03 * Math.sign(Math.sin(TAU * 120 * t)) * 0.4;
      if (P.texture === 'crackle') { if (r() < 0.0008) crack = 0.6 * r(); v += crack * (r() * 2 - 1); crack *= 0.985; }
      if (P.texture === 'crickets') { const c = Math.sin(TAU * 4400 * t) * Math.max(0, Math.sin(TAU * 18 * t)) * (Math.sin(TAU * 0.7 * t + ch * 2) > 0.2 ? 1 : 0); v += 0.05 * c; }
      if (P.texture === 'air') v += 0.08 * bp(r() * 2 - 1);
      o[i] = v;
    }
    if (P.chime) for (let k = 0; k < 9; k++) {                           // sparse chimes / ice bells
      const at = Math.floor(r() * (n - SR)), f = mtof(P.chime + [0, 3, 5, 7, 10, 12][Math.floor(r() * 6)]);
      for (let i = 0; i < SR * 1.5 && at + i < n; i++) { const t = i / SR; o[at + i] += 0.06 * Math.exp(-t * 3) * (Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * f * 2.76 * t)); }
    }
  }, seed);
}

// ── zone music: a seamless 8-bar loop per land, each with its own key, tempo and timbre (mono: it is a point source) ──
const MUSIC = {
  guildhollow: { root: 50, bpm: 100, wave: 'pluck', scale: [0, 2, 3, 5, 7, 9, 10] },      // D dorian lute
  frostmere: { root: 76, bpm: 66, wave: 'bell', scale: [0, 2, 4, 7, 9] },                 // E pentatonic bells
  meridian: { root: 57, bpm: 124, wave: 'saw', scale: [0, 3, 5, 7, 10] },                 // A minor synth arp
  wanderers: { root: 65, bpm: 80, wave: 'tri', scale: [0, 2, 4, 5, 7, 9, 11] },           // F lydian harp
  brinewatch: { root: 55, bpm: 132, wave: 'accordion', scale: [0, 2, 4, 5, 7, 9, 11], waltz: true },
  'lantern-row': { root: 60, bpm: 90, wave: 'pluck', scale: [0, 2, 4, 7, 9] },             // C pentatonic koto
  rosewick: { root: 58, bpm: 72, wave: 'strings', scale: [0, 2, 4, 5, 7, 9, 11], waltz: true },
};
function voiceSample(wave, f, t, dur) {
  const env = Math.min(1, t / 0.01) * Math.exp(-t * (wave === 'bell' ? 1.6 : wave === 'pluck' ? 4.5 : 1.2)) * (t < dur ? 1 : Math.exp(-(t - dur) * 12));
  const p = TAU * f * t;
  switch (wave) {
    case 'bell': return env * (Math.sin(p) + 0.5 * Math.sin(p * 2.76) + 0.25 * Math.sin(p * 5.4));
    case 'pluck': return env * (Math.sin(p) + 0.45 * Math.sin(2 * p) + 0.2 * Math.sin(3 * p));
    case 'saw': { let s = 0; for (let k = 1; k < 7; k++) s += Math.sin(k * p) / k; return env * 0.8 * s; }
    case 'tri': return env * (Math.sin(p) - Math.sin(3 * p) / 9 + Math.sin(5 * p) / 25);
    case 'accordion': { const q = TAU * f * 1.006 * t; let s = 0; for (let k = 1; k < 6; k += 1) s += (Math.sin(k * p) + Math.sin(k * q)) / (k * 1.6); return Math.min(1, t / 0.03) * (t < dur ? 1 : Math.exp(-(t - dur) * 15)) * 0.5 * s; }
    default: { const v = 1 + 0.004 * Math.sin(TAU * 5.5 * t); return Math.min(1, t / 0.12) * (t < dur ? 1 : Math.exp(-(t - dur) * 5)) * 0.6 * (Math.sin(p * v) + 0.3 * Math.sin(2 * p * v)); }
  }
}
export function music(ctx, land, seed = 1) {
  const P = MUSIC[land] || MUSIC.wanderers, r = rng(seed * 31 + land.length);
  const beat = 60 / P.bpm, per = P.waltz ? 3 : 4, bars = 8, n = Math.round(bars * per * beat * SR);
  const R = ring(n), ab = ctx.createBuffer(1, n, SR);
  const prog = [0, 5, 3, 4, 0, 5, 3, 4];                                    // degrees of the bar chords
  const deg = (d) => P.root + P.scale[((d % P.scale.length) + P.scale.length) % P.scale.length] + 12 * Math.floor(d / P.scale.length);
  const note = (at, m, dur, amp, wave) => { const f = mtof(m), len = Math.round((dur + 0.8) * SR); for (let i = 0; i < len; i++) R.add(at + i, amp * voiceSample(wave, f, i / SR, dur)); };
  for (let b = 0; b < bars; b++) {
    const c = prog[b], t0 = Math.round(b * per * beat * SR);
    note(t0, deg(c) - 12, per * beat * 0.9, 0.35, P.wave === 'bell' ? 'strings' : P.wave === 'saw' ? 'saw' : 'strings');      // bass
    if (P.waltz) for (let k = 1; k < 3; k++) for (const d of [c + 2, c + 4]) note(t0 + Math.round(k * beat * SR), deg(d), beat * 0.5, 0.18, P.wave);
    const steps = P.bpm > 110 ? per * 2 : per;                                  // melody / arpeggio
    for (let s = 0; s < steps; s++) {
      if (r() < 0.18) continue;
      const d = c + [0, 2, 4, 7, 4, 2][Math.floor(r() * 6)] + (r() < 0.3 ? 1 : 0);
      note(t0 + Math.round(s * (per * beat / steps) * SR), deg(d) + 12, per * beat / steps * 0.8, 0.3, P.wave);
    }
  }
  ab.getChannelData(0).set(normalise(R.b, 0.6));
  return ab;
}

// ── point emitters (mono loops) and one-shots ──
export const EMITTERS = {
  fountain: (o, r) => { const bp = biquad('bp', 3200, 0.6), lp = biquad('lp', 400); for (let i = 0; i < o.length; i++) { const w = r() * 2 - 1; o[i] = 0.7 * bp(w) + 0.5 * lp(w) * (0.6 + 0.4 * Math.sin(i / SR * TAU * 1.7)); } },
  kettle: (o, r) => { const bp = biquad('bp', 5000, 2); let bub = 0; for (let i = 0; i < o.length; i++) { const t = i / SR; if (r() < 0.003) bub = 0.5; bub *= 0.996; o[i] = 0.25 * Math.sin(TAU * 1860 * t + 0.4 * Math.sin(TAU * 6 * t)) * (0.6 + 0.4 * Math.sin(TAU * 0.3 * t)) + 0.4 * bp(r() * 2 - 1) + bub * Math.sin(TAU * (300 + 400 * bub) * t); } },
  organ: (o, r) => {                                                          // carousel organ: a bright square-wave waltz
    const R = ring(o.length), beat = 60 / 168, prog = [0, 7, 5, 7];
    for (let k = 0; k * beat * SR < o.length; k++) {
      const bar = Math.floor(k / 3), root = 60 + prog[bar % 4], m = k % 3 === 0 ? root - 12 : root + [4, 7][k % 3 - 1];
      const f = mtof(m), at = Math.round(k * beat * SR);
      for (let i = 0; i < beat * SR * 0.9; i++) { const t = i / SR; R.add(at + i, 0.3 * Math.exp(-t * 3) * Math.sign(Math.sin(TAU * f * t)) * 0.5 + 0.2 * Math.sin(TAU * mtof(root + 12 + [0, 4, 7, 12][(k >> 1) % 4]) * t) * Math.exp(-t * 2)); }
    }
    o.set(R.b.subarray(0, o.length));
  },
  creak: (o, r) => { const lp = biquad('lp', 300), lap = biquad('lp', 600); let at = 0; for (let i = 0; i < o.length; i++) o[i] = 0.25 * lap(r() * 2 - 1) * (0.5 + 0.5 * Math.sin(i / SR * TAU * 0.35));
    while (at < o.length) { const f = 160 + 200 * r(), len = Math.round((0.4 + r() * 0.9) * SR); const b = biquad('bp', f, 12); for (let i = 0; i < len && at + i < o.length; i++) { const t = i / len; o[at + i] += 0.8 * b((r() < 0.08 ? 1 : 0) * (r() * 2 - 1)) * Math.sin(Math.PI * t); } at += Math.round((1.5 + r() * 3) * SR); } void lp; },
  chatter: (o, r) => babble(o, r, 8, 0.6),
  tavern: (o, r) => { babble(o, r, 12, 0.6); const R = ring(o.length); for (let k = 0; k < 14; k++) { const at = Math.floor(r() * o.length), f = 2500 + r() * 2500; for (let i = 0; i < SR * 0.25; i++) R.add(at + i, 0.15 * Math.exp(-i / SR * 25) * Math.sin(TAU * f * i / SR)); } for (let i = 0; i < o.length; i++) o[i] += R.b[i]; },
  neon: (o, r) => { const hp = biquad('hp', 2000); let fl = 1; for (let i = 0; i < o.length; i++) { const t = i / SR; if (r() < 0.0003) fl = 0.2; fl += (1 - fl) * 0.0005; o[i] = fl * (0.3 * Math.sin(TAU * 120 * t) + 0.15 * Math.sin(TAU * 240 * t) + 0.1 * Math.sign(Math.sin(TAU * 120 * t)) * 0.3) + 0.05 * hp(r() * 2 - 1); } },
  torch: (o, r) => { const lp = biquad('lp', 500); let c = 0; for (let i = 0; i < o.length; i++) { if (r() < 0.002) c = r(); c *= 0.97; o[i] = 0.5 * lp(r() * 2 - 1) + c * (r() * 2 - 1) * 0.6; } },
  train: (o, r) => { const lp = biquad('lp', 1200), bp = biquad('bp', 700, 0.8); for (let i = 0; i < o.length; i++) { const t = i / SR; o[i] = 0.35 * Math.sin(TAU * 92 * t) + 0.2 * Math.sin(TAU * 184 * t + 0.3) + 0.08 * Math.sin(TAU * 552 * t) + 0.5 * lp(r() * 2 - 1) + 0.25 * bp(r() * 2 - 1) * (0.7 + 0.3 * Math.sin(TAU * 3.1 * t)); } },
  punt: (o, r) => { const lp = biquad('lp', 900); for (let i = 0; i < o.length; i++) { const t = i / SR, ph = (t % 3.2) / 3.2; o[i] = lp(r() * 2 - 1) * (0.25 + 0.75 * Math.exp(-ph * 9) * (ph > 0 ? 1 : 0)) * 0.8; } },
  hum: (o) => { for (let i = 0; i < o.length; i++) { const t = i / SR; o[i] = 0.4 * Math.sin(TAU * 100 * t) + 0.2 * Math.sin(TAU * 200 * t); } },
};
export function emitterLoop(ctx, kind, seed = 1) {
  const fill = EMITTERS[kind] || EMITTERS.hum, n = Math.round(8 * SR);
  const ab = loopBuf(ctx, 8, 1, (ch, o, r) => fill(o, r), seed); void n;
  normalise(ab.getChannelData(0), 0.6); return ab;
}
function babble(o, r, talkers, gain) {           // a crowd from pitched pulse trains through moving formants, syllable-gated
  for (let k = 0; k < talkers; k++) {
    const f0 = 95 + r() * 130, f1 = biquad('bp', 500 + r() * 400, 5), f2 = biquad('bp', 1300 + r() * 900, 6);
    let ph = 0, syl = 0, sylLen = 1, env = 0, on = r() < 0.6, fA = 1, gap = 0;
    let fa = biquad('bp', 600, 4), fb = biquad('bp', 1700, 5);
    for (let i = 0; i < o.length; i++) {
      if (--syl <= 0) {                               // next syllable or pause
        sylLen = Math.round((0.12 + r() * 0.16) * SR); syl = sylLen;
        if (gap > 0) { gap--; on = false; } else { on = r() < 0.85; if (r() < 0.06) gap = 3 + Math.floor(r() * 8); }
        fA = 0.8 + r() * 0.5; fa = biquad('bp', (450 + r() * 500) * fA, 4); fb = biquad('bp', (1200 + r() * 1200) * fA, 5);
      }
      const tgt = on ? Math.sin(Math.PI * (1 - syl / sylLen)) : 0; env += (tgt - env) * 0.004;
      ph += f0 * (1 + 0.04 * Math.sin(i / SR * 3 + k)) / SR; const pulse = ph % 1 < 0.08 ? 1 : 0;
      const src = pulse * 0.7 + (r() * 2 - 1) * 0.15;
      o[i] += gain * env * (fa(src) + 0.6 * fb(src) + 0.2 * f1(src) + 0.1 * f2(src)) / Math.sqrt(talkers);
    }
  }
}
export function crowd(ctx, level, seed = 1) {   // 0 sparse chatter, 1 murmur, 2 dense crowd
  const talkers = [4, 10, 16][level] || 10;
  return loopBuf(ctx, 10, 2, (ch, o, r) => { babble(o, r, talkers, 1); if (level === 2) { const lp = biquad('lp', 900); for (let i = 0; i < o.length; i++) o[i] += 0.15 * lp(r() * 2 - 1); } normalise(o, 0.5); }, seed + level * 101);
}

export const ONESHOTS = {
  firework_launch: (d, r) => { const hp = biquad('hp', 2000); let ph = 0; for (let i = 0; i < d.length; i++) { const t = i / SR, u = t / 1.45; const f = 700 + 2100 * u; ph += f / SR; d[i] = (0.5 * Math.sin(TAU * ph) * Math.min(1, t / 0.08) + 0.3 * hp(r() * 2 - 1)) * (u < 1 ? 1 - 0.3 * u : Math.exp(-(t - 1.45) * 30)); } },
  firework_burst: (d, r) => { const lp = biquad('lp', 180), lp2 = biquad('lp', 2500); let cr = 0; for (let i = 0; i < d.length; i++) { const t = i / SR; if (t > 0.25 && r() < 0.004 * Math.exp(-t)) cr = 0.7; cr *= 0.97;
    d[i] = 1.6 * lp(r() * 2 - 1) * Math.exp(-t * 4) * 6 + 0.6 * lp2(r() * 2 - 1) * Math.exp(-t * 2.5) + cr * (r() * 2 - 1); } },
  lantern_release: (d, r) => { const bp = biquad('bp', 900, 0.7); for (let i = 0; i < d.length; i++) { const t = i / d.length; d[i] = bp(r() * 2 - 1) * Math.sin(Math.PI * t) ** 2 * (0.7 + 0.3 * Math.sin(TAU * 1.3 * t * 6)); } },
  splash: (d, r) => { const lp = biquad('lp', 2600); for (let i = 0; i < d.length; i++) { const t = i / SR; d[i] = lp(r() * 2 - 1) * Math.exp(-t * 14) + 0.3 * Math.sin(TAU * (600 + 900 * t) * t) * Math.exp(-((t - 0.12) ** 2) * 900); } },
  footstep_stone: (d, r) => { const hp = biquad('hp', 1500), lp = biquad('lp', 250); for (let i = 0; i < d.length; i++) { const t = i / SR; d[i] = 0.6 * hp(r() * 2 - 1) * Math.exp(-t * 90) + 0.8 * lp(r() * 2 - 1) * Math.exp(-t * 40); } },
  footstep_wood: (d, r) => { const bp = biquad('bp', 190, 6), bp2 = biquad('bp', 900, 3); for (let i = 0; i < d.length; i++) { const t = i / SR, x = (r() * 2 - 1) * Math.exp(-t * 120); d[i] = 3 * bp(x) + 0.8 * bp2(x); } },
  footstep_snow: (d, r) => { const bp = biquad('bp', 2500, 0.8); for (let i = 0; i < d.length; i++) { const t = i / SR, g = r() < 0.25 ? 1 : 0.15; d[i] = bp(r() * 2 - 1) * g * Math.sin(Math.PI * Math.min(1, t / 0.16)); } },
  footstep_grass: (d, r) => { const bp = biquad('bp', 3500, 0.6); for (let i = 0; i < d.length; i++) { const t = i / SR; d[i] = bp(r() * 2 - 1) * Math.sin(Math.PI * Math.min(1, t / 0.12)) * 0.6; } },
  footstep_gravel: (d, r) => { const bp = biquad('bp', 1800, 0.9); for (let i = 0; i < d.length; i++) { const t = i / SR, g = r() < 0.15 ? 1 : 0.1; d[i] = bp(r() * 2 - 1) * g * Math.exp(-t * 18); } },
  ui_click: (d) => { for (let i = 0; i < d.length; i++) { const t = i / SR; d[i] = Math.sin(TAU * 2600 * t) * Math.exp(-t * 400); } },
  owl: (d) => { for (let i = 0; i < d.length; i++) { const t = i / SR, n1 = Math.exp(-((t - 0.2) ** 2) * 60), n2 = Math.exp(-((t - 0.75) ** 2) * 25); d[i] = Math.sin(TAU * (380 + 20 * Math.sin(t * 9)) * t) * (n1 + n2); } },
  bell: (d) => { for (let i = 0; i < d.length; i++) { const t = i / SR; let s = 0; for (const [k, a, dec] of [[1, 1, 0.9], [2.0, 0.6, 1.3], [2.4, 0.5, 1.7], [3.0, 0.35, 2.2], [4.2, 0.3, 3], [0.5, 0.5, 0.6]]) s += a * Math.sin(TAU * 220 * k * t) * Math.exp(-t * dec); d[i] = s * Math.min(1, t / 0.002); } },
  laughter: (d, r) => { const bp = biquad('bp', 900, 3); for (let i = 0; i < d.length; i++) { const t = i / SR, ph = (t * 5.5) % 1, on = t < 1.1 ? Math.exp(-ph * 6) : 0; d[i] = bp(Math.sin(TAU * (210 - 40 * t) * t) + 0.3 * (r() * 2 - 1)) * on; } },
  coin: (d) => { for (let i = 0; i < d.length; i++) { const t = i / SR; d[i] = (Math.sin(TAU * 3900 * t) + 0.6 * Math.sin(TAU * 6100 * t) + 0.4 * Math.sin(TAU * 8300 * t)) * Math.exp(-t * 14) * (1 + 0.6 * Math.exp(-((t - 0.09) ** 2) * 9000)); } },
};
const ONESHOT_LEN = { firework_launch: 1.55, firework_burst: 2.6, lantern_release: 5.5, splash: 0.5, footstep_stone: 0.12, footstep_wood: 0.15, footstep_snow: 0.2, footstep_grass: 0.16, footstep_gravel: 0.18, ui_click: 0.03, owl: 1.2, bell: 4.5, laughter: 1.4, coin: 0.5 };
export function oneshot(ctx, name, seed = 1) {
  const key = ONESHOTS[name] ? name : /^footstep/.test(name) ? 'footstep_stone' : 'ui_click';
  return oneShot(ctx, ONESHOT_LEN[key] || 0.5, ONESHOTS[key], seed, key === 'ui_click' ? 0.3 : 0.8);
}

// impulse response for the reverb sends: decaying stereo noise, darker as it decays (air and soft surfaces)
export function impulse(ctx, seconds, { bright = 0.5, predelay = 0.01 } = {}) {
  const sr = ctx.sampleRate, n = Math.round(seconds * sr), ab = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const r = rng(77 + ch * 991), d = ab.getChannelData(ch), pd = Math.round(predelay * sr); let lp = 0;
    for (let i = pd; i < n; i++) {
      const t = (i - pd) / sr, decay = Math.exp(-6.9 * t / seconds);              // -60 dB at the end
      const k = Math.min(1, (bright * 0.8 + 0.1) * Math.exp(-t * 3 / seconds * (1.4 - bright)) + 0.03);
      lp += k * ((r() * 2 - 1) - lp);
      d[i] = lp * decay * (i - pd < 0.003 * sr ? (i - pd) / (0.003 * sr) : 1);
    }
  }
  let e = 0; for (let ch = 0; ch < 2; ch++) { const d = ab.getChannelData(ch); for (let i = 0; i < n; i++) e += d[i] * d[i]; }
  const k = 1 / Math.sqrt(e / 2 + 1e-9); for (let ch = 0; ch < 2; ch++) { const d = ab.getChannelData(ch); for (let i = 0; i < n; i++) d[i] *= k; }
  return ab;
}
// scale a buffer so its RMS (over all channels) is `db` dBFS, peaks kept under -1 dBFS
export function rmsNorm(ab, db) {
  let e = 0, m = 1e-9, n = 0;
  for (let ch = 0; ch < ab.numberOfChannels; ch++) { const d = ab.getChannelData(ch); for (let i = 0; i < d.length; i++) { e += d[i] * d[i]; m = Math.max(m, Math.abs(d[i])); } n += d.length; }
  const rms = Math.sqrt(e / Math.max(1, n)) || 1e-9, k = Math.min(Math.pow(10, db / 20) / rms, 0.89 / m);
  for (let ch = 0; ch < ab.numberOfChannels; ch++) { const d = ab.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= k; }
  return ab;
}

// placeholder buffers by key ('bed:<zone>', 'music:<land>', 'emit:<kind>', 'crowd:<0..2>', 'one:<name>'), normalised to a
// common loudness per role
export function synthKey(ctx, key, seed = 1) {
  const [kind, arg] = key.split(':');
  if (kind === 'bed') return rmsNorm(bed(ctx, arg, seed), -24);
  if (kind === 'music') return rmsNorm(music(ctx, arg, seed), -20);
  if (kind === 'emit') return rmsNorm(emitterLoop(ctx, arg, seed), -21);
  if (kind === 'crowd') return rmsNorm(crowd(ctx, +arg, seed), -24);
  return oneshot(ctx, arg, seed);
}
