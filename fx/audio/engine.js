// Lanternfall 3D: the spatial audio engine. Web Audio API directly; the listener is the camera.
//
//   createAudio({ THREE, camera, manifest, DATA, Q, getMode, getWalk, getTrains, fx, crowd?, getTour?, getWater?,
//                 getCrowd?, getGround?, ctx?, elements?, mobile?, stream?, synth?, offline? })
//   -> { enable(), disable(), enabled, setVolume(v), setMusic(b), setAmbience(b), update(dt, time), play(name, pos?),
//        setCrowd(crowd), setGround(grid), dispose(), debug }
//
// Content comes from data/audio/audio.json (written by the sound-music work; format in the shared brief and in
// data/audio/README.md); anything missing is replaced by placeholder sounds synthesised in fx/audio/synth.js, distinct
// per zone. Nothing is fetched or decoded before enable() (the sound button).
//
// The mix, top down:
//   zone BEDS (wide, non-positional): level from the listener's zone weights (fx/audio/space.js), equal-power
//     crossfades; above ~30 m they give way to one "sky" bed (the whole park, far away) which owns the mix by ~110 m.
//   zone MUSIC (point sources through PannerNodes, direction only: distance gain, air absorption and ducking are
//     computed here): falls off with distance; the loudest piece ducks and low-passes the others so neighbours are
//     audible across a border without fighting; in Tour/Explore the land the camera looks at keeps a floor level that
//     fades with height, so music swells as the camera descends into a land.
//   EMITTERS: looped point sources (fountains, a kettle, the carousel organ, neon, torches, the ship), moving sources
//     (the three monorail trains with a manual Doppler, the punt) and one-shots repeated at random in an area.
//   EVENTS: fireworks (launch at the pad, burst at the shell, both delayed by distance / 343 m/s), the lantern
//     release waves at the Spire, splashes for taps on the lake, footsteps in Walk mode by ground type, UI clicks.
//   CROWD: murmur layers following local density (a guess from the map, or the guests' crowd state when present).
//   REVERB: two generated impulse responses (short/bright, long/dark) on a send from music + effects, levels by place.
//   MASTER: compressor + limiter -> volume. Voices are sorted by audibility; at most MAX play; HRTF for the nearest few.
import * as S from './synth.js';
import { makeZoner, reverbFor, groundType, makeDensity, smoothstep } from './space.js';

const C = 343;                                   // speed of sound, m/s
const FLIGHT = 1.5;                              // fx/fireworks.js: seconds from launch to burst
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const db = (g) => (g > 1e-6 ? 20 * Math.log10(g) : -120);
const blend3 = (v) => [v[0], v[2], -v[1]];      // Blender (x, y, z-up) -> three (x, y-up, z)
const CAROUSEL = { x: -135.04, z: 125.18 };     // three coords (fx/animate.js)
const ONESHOT_RANGE = { firework_burst: [70, 1400], firework_launch: [25, 600], lantern_release: [30, 300], splash: [4, 70], bell: [45, 900],
  owl: [12, 170], laughter: [6, 90], coin: [2, 22] };

// Placeholder content in the audio.json format, `synth` instead of `file` (the engine synthesises those).
function placeholderSpec(lands) {
  const MUSIC_AT = { guildhollow: [-181.8, 28.8, 2], frostmere: [-164.2, 100.1, 2], meridian: [16.5, 145.4, 2], wanderers: [190.8, 67.3, 3],
    brinewatch: [122.8, -24.8, 2.5], 'lantern-row': [26.0, -176.3, 3], rosewick: [-100.8, -62.8, 2] };
  const zones = [];
  for (const l of lands) zones.push({ id: l.id, land: l.id, bed: { synth: 'bed:' + l.id, gain: 0.6 }, music: MUSIC_AT[l.id] ? { synth: 'music:' + l.id, gain: 0.55, pos: MUSIC_AT[l.id], ref: 14, max: 190 } : undefined });
  for (const k of ['lake', 'gate', 'gap', 'sky']) zones.push({ id: k, land: k, bed: { synth: 'bed:' + k, gain: 0.6 } });
  const E = (id, kind, pos, ref, max, gain = 0.6, extra = {}) => ({ id, synth: 'emit:' + kind, pos, ref, max, gain, loop: true, ...extra });
  const emitters = [
    E('fountain-rosewick', 'fountain', [-79.6, -72.4, 1], 4, 45), E('fountain-wanderers', 'fountain', [153.4, 57.1, 1], 4, 45),
    E('tavern', 'tavern', [128.2, -31.2, 2], 6, 70, 0.55), E('cider-kettle', 'kettle', [-118.9, 88.5, 1.2], 2, 24, 0.5),
    E('carousel-organ', 'organ', null, 6, 95, 0.6, { follow: 'carousel' }), E('ship', 'creak', [69.6, -24.8, 3], 8, 90, 0.6),
    E('market-lantern-row', 'chatter', [3.6, -161.9, 1.5], 8, 80, 0.5), E('market-brinewatch', 'chatter', [166.0, -59.6, 1.5], 8, 70, 0.45),
    E('neon-arcade', 'neon', [80.5, 116.9, 3], 4, 40, 0.4), E('neon-towers', 'neon', [64.5, 149.2, 4], 4, 40, 0.35),
    E('torch-gate-n', 'torch', [-195, 9.5, 1.6], 1.5, 18, 0.5), E('torch-gate-s', 'torch', [-195, -9.5, 1.6], 1.5, 18, 0.5),
    E('torch-yard', 'torch', [-171, -17, 3.1], 1.5, 18, 0.5), E('torch-wall', 'torch', [-201.5, 12.4, 5.6], 1.5, 18, 0.5), E('torch-shrine', 'torch', [46.7, -130.8, 1.6], 1.5, 18, 0.45),
    E('train', 'train', null, 10, 230, 0.7, { follow: 'train' }), E('punt', 'punt', null, 3, 40, 0.5, { follow: 'punt' }),
    { id: 'owl-north', synth: 'one:owl', pos: [-60, 175, 8], area: { r: 35 }, every: [14, 35], ref: 12, max: 170, gain: 0.5 },
    { id: 'owl-west', synth: 'one:owl', pos: [-235, -85, 8], area: { r: 35 }, every: [18, 40], ref: 12, max: 170, gain: 0.5 },
    { id: 'spire-bell', synth: 'one:bell', pos: [0, 0, 40], schedule: 'quarter', ref: 45, max: 900, gain: 0.7 },
    { id: 'laughter-gate', synth: 'one:laughter', pos: [255, 0, 1.6], area: { r: 28 }, every: [6, 16], ref: 6, max: 90, gain: 0.45 },
    { id: 'laughter-midway', synth: 'one:laughter', pos: [-130, 0, 1.6], area: { r: 18 }, every: [8, 20], ref: 6, max: 90, gain: 0.45 },
    { id: 'coin-market', synth: 'one:coin', pos: [5, -160, 1], area: { r: 14 }, every: [4, 11], ref: 2, max: 22, gain: 0.5 },
    { id: 'coin-rogues', synth: 'one:coin', pos: [166, -59.6, 1], area: { r: 10 }, every: [5, 13], ref: 2, max: 22, gain: 0.5 },
    { id: 'strength-bell', synth: 'one:bell', pos: [-129.2, 7.8, 2.5], every: [10, 26], ref: 10, max: 120, gain: 0.4, rate: 2.2 },
  ];
  const oneshots = {};
  for (const k of ['firework_launch', 'firework_burst', 'lantern_release', 'splash', 'footstep_stone', 'footstep_wood', 'footstep_snow', 'footstep_grass', 'footstep_gravel', 'ui_click'])
    oneshots[k] = [{ synth: 'one:' + k }, { synth: 'one:' + k, seed: 2 }];
  const crowd = [{ synth: 'crowd:0', gain: 0.5, density: [0.05, 0.35] }, { synth: 'crowd:1', gain: 0.5, density: [0.2, 0.6] }, { synth: 'crowd:2', gain: 0.5, density: [0.55, 1] }];
  return { version: 1, master: { gain: 1 }, zones, emitters, oneshots, crowd, placeholder: true };
}
// placeholder synthesis runs in a worker (fx/audio/synth-worker.js) so it never blocks a frame; main thread fallback
let worker = null, wseq = 0; const wjobs = new Map();
function synthAsync(ctx, key, seed) {
  if (worker === null) {
    try { worker = new Worker(new URL('./synth-worker.js', import.meta.url), { type: 'module' }); worker.onmessage = (e) => { const j = wjobs.get(e.data.id); wjobs.delete(e.data.id); if (j) j(e.data); }; worker.onerror = () => { worker = false; for (const j of wjobs.values()) j(null); wjobs.clear(); }; }
    catch (e) { worker = false; }
  }
  const local = () => S.synthKey(ctx, key, seed);
  if (!worker) return new Promise((r) => setTimeout(() => r(local()), 0));
  return new Promise((r) => { const id = ++wseq; wjobs.set(id, (m) => {
    if (!m) return r(local());
    const ab = ctx.createBuffer(m.data.length, m.data[0].length, m.sr); m.data.forEach((d, c) => ab.copyToChannel ? ab.copyToChannel(d, c) : ab.getChannelData(c).set(d)); r(ab);
  }); worker.postMessage({ id, key, seed }); });
}

export function createAudio(opts) {
  const { THREE, camera, DATA = 'data/', getMode = () => 'tour', getWalk = () => null, getTrains = () => [], getTour = () => -1, getWater = () => null } = opts;
  const mobile = !!opts.mobile, MAX = mobile ? 14 : 24, HRTF_N = mobile ? 2 : 4;
  const getManifest = typeof opts.manifest === 'function' ? opts.manifest : () => opts.manifest;
  const getFx = typeof opts.fx === 'function' ? opts.fx : () => (opts.fx && opts.fx.fxState ? opts.fx.fxState() : opts.fx);
  const st = { enabled: false, volume: 0.8, music: true, ambience: true, ready: false, loading: false, specFrom: 'none', bytes: 0, decoded: 0, err: null };
  let ctx = opts.ctx || null, N = null, spec = null, zoner = null, density = null, ground = null;
  const sources = [], assets = new Map(), oneshotPool = [];
  const L = { p: new THREE.Vector3(), prev: new THREE.Vector3(), v: new THREE.Vector3(), f: new THREE.Vector3(), u: new THREE.Vector3(), r: new THREE.Vector3(), pf: new THREE.Vector3(0, 0, -1), w: 0, slowFor: 0, hrtfOk: true, cutUntil: 0, first: true };
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  const D = { zone: {}, A: 0, h: 0, density: 0, rev: [0, 0], voices: 0, ground: '', focus: [0, 0], events: [], cpu: {} };
  let solo = null, aer = 0, snap = true, time = 0, lastTour = -1, wave = -1, bob = null, quarterNext = 0, memTimer = 0;
  const shellSeen = new Float64Array(16).fill(-1e9); const splashSeen = new WeakSet();

  /* ───────── graph ───────── */
  function build() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    N = { amb: g(st.ambience ? 1 : 0), music: g(st.music ? 1 : 0), fx: g(1), ui: g(1), mix: g(1), send: g(1), out: g(0) };
    const comp = ctx.createDynamicsCompressor();       // glue: gentle, slow
    comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 2.5; comp.attack.value = 0.02; comp.release.value = 0.35;
    const lim = ctx.createDynamicsCompressor();        // safety limiter (the built-in has a few ms of look-ahead)
    lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12;
    N.comp = comp; N.lim = lim;
    // cut stage after the positional buses: a 30 ms dip hides listener teleports (HRTF kernels jumping) like a film cut
    N.cut = g(1); N.music.connect(N.cut); N.fx.connect(N.cut);
    for (const b of [N.amb, N.cut, N.ui]) b.connect(N.mix);
    N.mix.connect(comp); comp.connect(lim); lim.connect(N.out); N.out.connect(ctx.destination);
    // reverb: music + effects feed the send; two generated rooms (one on phones)
    N.cut.connect(N.send);
    N.revS = g(0); N.revL = g(0);
    const cs = ctx.createConvolver(); cs.normalize = false; cs.buffer = S.impulse(ctx, mobile ? 1.2 : 0.9, { bright: 0.85, predelay: 0.006 });
    N.send.connect(N.revS); N.revS.connect(cs); cs.connect(N.mix); N.convS = cs;
    if (!mobile) { const cl = ctx.createConvolver(); cl.normalize = false; cl.buffer = S.impulse(ctx, 2.8, { bright: 0.35, predelay: 0.025 }); N.send.connect(N.revL); N.revL.connect(cl); cl.connect(N.mix); N.convL = cl; }
    else N.send.connect(N.revL), N.revL.connect(cs);
    for (let i = 0; i < (mobile ? 8 : 14); i++) oneshotPool.push(makeChain(true, false));
    const lis = ctx.listener;
    L.modern = !!lis.positionX;
  }
  // a voice chain: [src] -> gain -> lowpass -> panner (positional) or stereo panner (beds) -> bus
  function makeChain(positional, bedPan) {
    const ch = { gain: ctx.createGain(), filter: null, panner: null, span: null, busy: 0, connected: null, hrtf: false };
    ch.gain.gain.value = 0;
    if (positional) {
      ch.filter = ctx.createBiquadFilter(); ch.filter.type = 'lowpass'; ch.filter.frequency.value = 18000; ch.filter.Q.value = 0.5;
      const p = ch.panner = ctx.createPanner(); p.panningModel = 'equalpower'; p.distanceModel = 'linear'; p.refDistance = 1; p.maxDistance = 1e5; p.rolloffFactor = 0;
      ch.gain.connect(ch.filter); ch.filter.connect(p);
      ch.out = p;
    } else if (bedPan && ctx.createStereoPanner) { ch.span = ctx.createStereoPanner(); ch.gain.connect(ch.span); ch.out = ch.span; }
    else ch.out = ch.gain;
    return ch;
  }
  function setPannerPos(p, x, y, z, now, tau = 0.03) {
    if (p.positionX) { p.positionX.setTargetAtTime(x, now, tau); p.positionY.setTargetAtTime(y, now, tau); p.positionZ.setTargetAtTime(z, now, tau); }
    else p.setPosition(x, y, z);
  }

  /* ───────── content ───────── */
  function asset(def, role) {
    const key = def.file ? 'f:' + def.file : 's:' + def.synth + ':' + (def.seed || 1);
    // long music streams through a media element unless it asks to be decoded or has loop points (pre/post-roll)
    const stream = role === 'music' && !!def.file && opts.stream !== false && (def.stream === true || (def.stream !== false && !Array.isArray(def.loop)));
    if (!assets.has(key)) assets.set(key, { key, file: def.file, synth: def.synth || null, seed: def.seed || 1, role, state: 'idle', buffer: null, bytes: 0, used: 0, prio: 1e9, stream });
    return assets.get(key);
  }
  function fallbackSynth(a) {           // the role's placeholder, when a file is missing or cannot be decoded
    const r = a.role;
    return r === 'music' ? 'music:wanderers' : r === 'bed' ? 'bed:gap' : r === 'crowd' ? 'crowd:1' : r === 'emitter' ? 'emit:hum' : 'one:' + (a.name || 'ui_click');
  }
  async function loadAsset(a) {
    if (a.state !== 'idle' || a.stream) return;
    a.state = 'loading';
    try {
      if (a.file && !opts.synth) {
        const res = await fetch(DATA + 'audio/' + a.file);
        if (!res.ok) throw new Error(a.file + ' ' + res.status);
        const ab = await res.arrayBuffer(); a.bytes = ab.byteLength; st.bytes += ab.byteLength;
        a.buffer = await new Promise((ok, bad) => { const p = ctx.decodeAudioData(ab, ok, bad); if (p && p.catch) p.catch(bad); });
      } else {
        a.buffer = await synthAsync(ctx, a.synth || fallbackSynth(a), a.seed);
      }
      st.decoded += a.buffer.length * a.buffer.numberOfChannels * 4;
      a.state = 'ready';
    } catch (e) {
      if (a.file && !a.synth) { a.synth = fallbackSynth(a); a.file = null; a.state = 'idle'; return loadAsset(a); }
      a.state = 'failed'; st.err = String(e && e.message || e);
    }
  }
  const queue = new Set(); let inflight = 0;
  function request(a, prio) { if (a.state === 'idle' && !a.stream) { a.prio = Math.min(a.prio, prio); queue.add(a); } }
  function pump() {
    while (inflight < (mobile ? 2 : 3) && queue.size) {
      let best = null; for (const a of queue) if (!best || a.prio < best.prio) best = a;
      queue.delete(best); if (best.state !== 'idle') continue;
      inflight++; loadAsset(best).finally(() => { inflight--; best.prio = 1e9; });
    }
  }

  function addSource(kind, def, zone, extra = {}) {
    const positional = !!(def.pos || def.follow) && kind !== 'bed';
    const s = { kind, def, zone, positional, gain: def.gain ?? 0.5, ref: def.ref ?? 10, max: def.max ?? 150, pos: new THREE.Vector3(), vel: new THREE.Vector3(), prevPos: new THREE.Vector3(),
      hasPrev: false, target: 0, level: 0, ch: null, node: null, el: null, playing: false, stopAt: 0, rate: def.rate || 1, hrtfWant: false, hrtfSince: 0, swapUntil: 0,
      loop: def.loop, every: def.every, nextAt: 0, d: 1e9, id: def.id || (zone + ':' + kind), ...extra };
    if (def.pos) s.pos.fromArray(blend3(def.pos));
    const variants = Array.isArray(def.files) && def.files.length ? def.files : null;   // several recordings of one thing
    if (!def.every && !def.schedule) s.asset = asset(variants ? { ...def, file: variants[Math.floor(Math.random() * variants.length)] } : def, kind === 'layer' ? 'bed' : kind);
    else {
      s.shots = (variants || [null]).map((f) => asset(f ? { ...def, file: f } : def, 'oneshot'));
      for (const a of s.shots) a.name = def.synth ? def.synth.replace('one:', '') : (def.id || 'shot');
    }
    sources.push(s); return s;
  }
  function buildSources() {
    const lands = getManifest().lands;
    zoner = makeZoner(lands); density = makeDensity(lands);
    if (opts.crowd) density.setCrowd(opts.crowd);
    for (const z of spec.zones || []) {
      const land = z.land || z.id;
      if (z.bed) addSource('bed', z.bed, land);
      if (z.music) addSource('music', z.music, land);
      for (const l of z.layers || []) addSource(l.pos ? 'emitter' : 'bed', l, land, { layer: true });
    }
    for (const e of spec.emitters || []) {
      if (e.follow === 'train') {
        const ids = trainGroups().map((t) => t.id);
        for (const id of ids.length ? ids : ['meridian', 'lanternrow', 'guildhollow']) addSource('emitter', e, 'train', { train: id, doppler: e.doppler !== false, id: (e.id || 'train') + ':' + id });
      } else addSource('emitter', e, e.land || 'any', { doppler: e.follow === 'punt' ? e.doppler !== false : !!e.doppler });
    }
    for (const c of spec.crowd || []) addSource('crowd', c, 'crowd', { range: c.density || [0, 1] });
    spec.shots = {};
    for (const [name, list] of Object.entries(spec.oneshots || {})) spec.shots[name] = (Array.isArray(list) ? list : [list]).map((f) => { const a = asset(typeof f === 'string' ? { file: f } : f, 'oneshot'); a.name = name; return a; });
    for (const s of sources) if (s.shots) { const n = s.shots[0].name; if (n && !spec.shots[n]) spec.shots[n] = s.shots; }   // play('owl_1') etc.
    for (const name of ['firework_launch', 'firework_burst', 'lantern_release', 'splash', 'footstep_stone', 'footstep_wood', 'footstep_snow', 'footstep_grass', 'footstep_gravel', 'ui_click'])
      if (!spec.shots[name]) { const a = asset({ synth: 'one:' + name }, 'oneshot'); a.name = name; spec.shots[name] = [a]; }
  }
  // the monorail: cars grouped into trains by name (transit_train_<line>_car3 / _gang2), ordered along the rail
  let trainCache = null;
  function trainGroups() {
    const list = getTrains() || [];
    if (trainCache && trainCache.n === list.length) return trainCache.groups;
    const by = new Map();
    for (const g of list) { const m = /train_([a-z]+)_/.exec(g.userData && g.userData.name || ''); const id = m ? m[1] : 'train'; if (!by.has(id)) by.set(id, []); by.get(id).push(g); }
    const groups = [...by].map(([id, cars]) => ({ id, cars: cars.sort((a, b) => a.userData.s - b.userData.s), c: new THREE.Vector3(), prevC: new THREE.Vector3(), v: new THREE.Vector3(), has: false }));
    trainCache = { n: list.length, groups }; return groups;
  }

  /* ───────── voices ───────── */
  function startVoice(s, now) {
    const a = s.asset;
    if (!s.ch) {
      s.ch = makeChain(s.positional, s.kind === 'bed' || s.kind === 'crowd');
      if (s.positional && s.def.cone) {
        const c = s.def.cone, p = s.ch.panner; p.coneInnerAngle = c.inner ?? 360; p.coneOuterAngle = c.outer ?? 360; p.coneOuterGain = c.outerGain ?? 0;
        const d = blend3(c.dir || [1, 0, 0]); if (p.orientationX) { p.orientationX.value = d[0]; p.orientationY.value = d[1]; p.orientationZ.value = d[2]; } else p.setOrientation(d[0], d[1], d[2]);
      }
    }
    const ch = s.ch, bus = s.kind === 'music' ? N.music : s.kind === 'bed' || s.kind === 'crowd' ? N.amb : N.fx;
    if (s.positional) { ch.hrtf = s.hrtfWant; ch.panner.panningModel = ch.hrtf ? 'HRTF' : 'equalpower'; setPannerPos(ch.panner, s.pos.x, s.pos.y, s.pos.z, now, 0.001); }
    ch.gain.gain.cancelScheduledValues(now); ch.gain.gain.setValueAtTime(0, now);
    ch.out.connect(bus); ch.connected = bus;
    if (a.stream) {
      if (!s.el) {
        s.el = (opts.elements && opts.elements.shift()) || new Audio();
        s.el.loop = true; s.el.preload = 'auto'; s.el.src = DATA + 'audio/' + a.file;
        s.node = ctx.createMediaElementSource(s.el); s.node.connect(ch.gain);
      } else if (!s.el.getAttribute('src')) s.el.src = DATA + 'audio/' + a.file;
      const p = s.el.play(); if (p && p.catch) p.catch(() => { s.failed = (s.failed || 0) + 1; });
      a.used = time;
    } else {
      const src = ctx.createBufferSource(); src.buffer = a.buffer; src.loop = true;
      const lp = s.def.loop;
      if (Array.isArray(lp) && lp[1] > lp[0]) { src.loopStart = lp[0]; src.loopEnd = Math.min(lp[1], a.buffer.duration); }
      const ls = src.loopStart || 0, le = src.loopEnd || a.buffer.duration;
      src.playbackRate.value = s.rate;
      src.connect(ch.gain); src.start(now, ls + Math.random() * Math.max(0.01, le - ls));   // random offset: copies of a loop never phase
      s.node = src; a.used = time;
    }
    s.playing = true; s.stopAt = 0; s.started = now; s.swapAt = 0; s.swapUntil = 0; s.hrtfSince = 0;
  }
  function stopVoice(s, now, fade = 0.12) {
    if (!s.playing || s.stopAt) return;
    const g = s.ch.gain.gain; g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + fade);
    s.stopAt = now + fade + 0.02;
    if (s.node && s.node.stop) s.node.stop(s.stopAt);
  }
  function reapVoice(s, now) {
    if (!s.stopAt || now < s.stopAt) return;
    if (s.el) { s.el.pause(); if (mobile && !st.enabled) { /* keep */ } }
    else if (s.node) { s.node.disconnect(); s.node = null; }
    if (s.ch.connected) { s.ch.out.disconnect(); s.ch.connected = null; }
    s.playing = false; s.stopAt = 0;
  }

  /* ───────── one-shots ───────── */
  function pick(name) { const list = spec && spec.shots[name]; if (!list || !list.length) return null; return list[Math.floor(Math.random() * list.length)]; }
  function toThree(pos, out) {
    if (!pos) return null;
    if (Array.isArray(pos)) return out.set(pos[0], pos[2] ?? 0, -pos[1]);
    return out.set(pos.x, pos.y, pos.z);
  }
  const _sp = new THREE.Vector3();
  // play(name, pos?, {gain, delay, rate, ref, max, a}) ; pos: [x, y, z] in the Blender frame, or a three.js Vector3;
  // without pos the sound is at the listener (UI, footsteps). delay in seconds from now.
  function play(name, pos, o = {}) {
    if (!st.enabled || !ctx || (ctx.state !== 'running' && !opts.offline)) return false;
    if (solo && !o.force && !solo.test(name)) return false;
    const a = o.a || pick(name); if (!a) return false;
    if (a.state !== 'ready') { request(a, 0); pump(); return false; }
    const now = ctx.currentTime, p = toThree(pos, _sp);
    const [ref, max] = [o.ref ?? ONESHOT_RANGE[name]?.[0] ?? 8, o.max ?? ONESHOT_RANGE[name]?.[1] ?? 120];
    const sg = spec.oneshot_gains && !o.a ? spec.oneshot_gains[name] : undefined;
    let g = (sg !== undefined ? sg * (o.scale ?? 1) : (o.gain ?? 0.7)) * Math.pow(10, (Math.random() - 0.5) * 0.2), d = 0;
    if (p) { d = p.distanceTo(L.p); g *= distGain(d, ref, max); if (g < 2e-4) return false; }
    let ch = null, oldest = null;
    for (const c of oneshotPool) { if (c.busy < now) { ch = c; break; } if (!oldest || c.busy < oldest.busy) oldest = c; }
    let when = now + Math.max(0, o.delay || 0) + 0.005;
    const gg = (ch || oldest).gain.gain;
    if (!ch) {                                   // all busy: steal the one that ends first, with a 15 ms fade
      ch = oldest; gg.cancelScheduledValues(now); gg.setValueAtTime(gg.value, now); gg.linearRampToValueAtTime(0, now + 0.015);
      if (ch.src) { try { ch.src.stop(now + 0.02); } catch (e) { /* already stopped */ } }
      when = Math.max(when, now + 0.025); gg.setValueAtTime(g, when);
    } else { gg.cancelScheduledValues(now); gg.setValueAtTime(g, now); }
    const src = ctx.createBufferSource(); src.buffer = a.buffer; src.playbackRate.value = (o.rate || 1) * (1 + (Math.random() - 0.5) * 0.08);
    ch.src = src;
    if (p) {
      ch.filter.frequency.setValueAtTime(airCut(d), now);
      ch.panner.panningModel = d < 25 ? 'HRTF' : 'equalpower';
      setPannerPos(ch.panner, p.x, p.y, p.z, now, 0.001);
    } else { ch.filter.frequency.setValueAtTime(20000, now); ch.panner.panningModel = 'equalpower'; setPannerPos(ch.panner, L.p.x + L.f.x * 0.5 + L.r.x * (o.pan || 0), L.p.y - 1.2, L.p.z + L.f.z * 0.5 + L.r.z * (o.pan || 0), now, 0.001); }
    if (ch.connected !== (name === 'ui_click' ? N.ui : N.fx)) { if (ch.connected) ch.out.disconnect(); ch.connected = name === 'ui_click' ? N.ui : N.fx; ch.out.connect(ch.connected); }
    src.connect(ch.gain); src.start(when); src.onended = () => src.disconnect();
    ch.busy = when + a.buffer.duration / src.playbackRate.value + 0.05;
    a.used = time;
    if (D.events.length > 40) D.events.shift();
    D.events.push({ name, t: time, wall: performance.now() / 1000, at: +(when - now).toFixed(3), d: +d.toFixed(1), g: +db(g).toFixed(1), x: p ? p.x : L.p.x, z: p ? p.z : L.p.z });
    return true;
  }

  /* ───────── mix math ───────── */
  function distGain(d, ref, max) { return (ref / (ref + Math.max(0, d - ref))) * (1 - smoothstep(0.6 * max, max, d)); }
  function airCut(d) { return clamp(20000 * Math.exp(-d / 220), 1500, 20000); }

  /* ───────── per frame ───────── */
  function listener(dt, now) {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    L.p.set(e[12], e[13], e[14]); L.f.set(-e[8], -e[9], -e[10]).normalize(); L.u.set(e[4], e[5], e[6]).normalize(); L.r.set(e[0], e[1], e[2]).normalize();
    let jump = false;
    if (L.first || dt <= 0) { L.prev.copy(L.p); L.pf.copy(L.f); L.v.set(0, 0, 0); L.first = false; snap = true; }
    else {
      tmp.subVectors(L.p, L.prev); const step = tmp.length(), turn = Math.acos(clamp(L.f.dot(L.pf), -1, 1));
      jump = step > 6 + 40 * dt || turn > 0.2;                               // a teleport or a cut (or a whip pan), not motion
      L.whip = turn / dt > 4;
      tmp.divideScalar(dt); if (jump || tmp.length() > 400) tmp.set(0, 0, 0); L.v.lerp(tmp, Math.min(1, dt * 6));
      L.w += ((jump ? 0 : turn / dt) - L.w) * Math.min(1, dt * 8);              // angular speed, rad/s
      L.prev.copy(L.p); L.pf.copy(L.f);
    }
    // Chrome's HRTF panner is clean for steady motion but crackles on fast swings; fast flights use equal-power
    const fast = L.v.length() > 14 || L.w > 2.2 || L.whip;
    if (fast) L.slowFor = 0; else L.slowFor += dt;
    L.hrtfOk = L.slowFor > 1.2;
    const lis = ctx.listener;
    if (jump && L.modern) {
      const c = N.cut.gain; c.cancelScheduledValues(now); c.setValueAtTime(c.value, now); c.linearRampToValueAtTime(0, now + 0.025); c.setValueAtTime(0, now + 0.11); c.linearRampToValueAtTime(1, now + 0.2);
      for (const [prm, v] of [[lis.positionX, L.p.x], [lis.positionY, L.p.y], [lis.positionZ, L.p.z], [lis.forwardX, L.f.x], [lis.forwardY, L.f.y], [lis.forwardZ, L.f.z], [lis.upX, L.u.x], [lis.upY, L.u.y], [lis.upZ, L.u.z]]) { prm.cancelScheduledValues(now); prm.setValueAtTime(v, now + 0.032); }
      L.cutUntil = now + 0.04; D.cuts = (D.cuts || 0) + 1;
      return;
    }
    if (now < L.cutUntil) return;
    if (L.modern) {
      const t = 0.02;
      lis.positionX.setTargetAtTime(L.p.x, now, t); lis.positionY.setTargetAtTime(L.p.y, now, t); lis.positionZ.setTargetAtTime(L.p.z, now, t);
      lis.forwardX.setTargetAtTime(L.f.x, now, t); lis.forwardY.setTargetAtTime(L.f.y, now, t); lis.forwardZ.setTargetAtTime(L.f.z, now, t);
      lis.upX.setTargetAtTime(L.u.x, now, t); lis.upY.setTargetAtTime(L.u.y, now, t); lis.upZ.setTargetAtTime(L.u.z, now, t);
    } else { lis.setPosition(L.p.x, L.p.y, L.p.z); lis.setOrientation(L.f.x, L.f.y, L.f.z, L.u.x, L.u.y, L.u.z); }
  }
  function sourcePositions(dt) {
    const tg = trainGroups();
    for (const t of tg) {
      t.c.set(0, 0, 0); for (const g of t.cars) t.c.add(g.position); t.c.divideScalar(Math.max(1, t.cars.length));
      if (t.has && dt > 0) { tmp.subVectors(t.c, t.prevC).divideScalar(dt); if (tmp.length() < 60) t.v.lerp(tmp, Math.min(1, dt * 5)); }
      t.prevC.copy(t.c); t.has = true;
    }
    const water = getWater();
    for (const s of sources) {
      if (!s.positional) continue;
      const f = s.def.follow;
      if (f === 'train') {
        const t = tg.find((q) => q.id === s.train); if (!t || !t.cars.length) { s.d = 1e9; continue; }
        // the point of the train nearest the listener (a 40 m train passes by, it does not pass through one point)
        let best = 1e18;
        for (let i = 0; i < t.cars.length; i++) {
          const a = t.cars[i].position, b = t.cars[Math.min(i + 1, t.cars.length - 1)].position;
          tmp2.subVectors(b, a); const l2 = tmp2.lengthSq(); let u = l2 > 0 ? tmp.subVectors(L.p, a).dot(tmp2) / l2 : 0; u = clamp(u, 0, 1);
          tmp.copy(a).addScaledVector(tmp2, u); const d2 = tmp.distanceToSquared(L.p);
          if (d2 < best && (i === 0 || l2 < 400)) { best = d2; s.pos.copy(tmp); }
        }
        s.pos.y += 1.6; s.vel.copy(t.v);
      } else if (f === 'carousel') {
        const a = time * 0.24 * (getFx()?.animated?.uniforms?.uFxMotion?.value ?? 1);
        s.pos.set(CAROUSEL.x + 3.5 * Math.cos(a), 3.2, CAROUSEL.z + 3.5 * Math.sin(a));
      } else if (f === 'punt') {
        const g = water && water.boat && water.boat.grp; if (!g) { s.d = 1e9; continue; }
        s.pos.copy(g.position); s.pos.y += 0.8;
        if (s.hasPrev && dt > 0) { tmp.subVectors(s.pos, s.prevPos).divideScalar(dt); s.vel.lerp(tmp, Math.min(1, dt * 4)); }
        s.prevPos.copy(s.pos); s.hasPrev = true;
      }
      s.d = s.pos.distanceTo(L.p);
    }
  }
  function mix(dt, now) {
    const mode = getMode();
    // where the listener is, in zone terms. From the air the zone point slides toward what the camera looks at, so
    // a land shot sounds like the land, not like the lake under the camera.
    const h = Math.max(0, L.p.y - 1.0);
    const k = mode === 'walk' ? 0 : smoothstep(6, 60, h) * 0.75;
    let fx = L.p.x, fz = L.p.z;
    if (k > 0) {
      let t = L.f.y < -0.05 ? clamp(L.p.y / -L.f.y, 0, 320) : 160;
      fx = L.p.x + (L.p.x + L.f.x * t - L.p.x) * k; fz = L.p.z + (L.p.z + L.f.z * t - L.p.z) * k;
    }
    const gx = fx, gy = -fz;
    const w = zoner.weights(gx, gy); D.zone = w; D.focus = [gx, gy]; D.h = h;
    // aerial factor: the park becomes one far sound with height. Eased (~1.2 s) so the tour's hops between lands
    // (the camera rises ~40 m for two seconds) swell the sky a little instead of pumping the whole mix
    const A0 = mode === 'walk' ? 0 : smoothstep(40, 135, h);
    aer += (A0 - aer) * (A0 > aer ? Math.min(1, dt / 1.2) : Math.min(1, dt / 0.8)); if (snap || mode === 'walk') aer = A0; snap = false;
    const A = aer; D.A = A;
    const sky = smoothstep(0.05, 1, A) ** 0.75;
    const dens = density.at(mode === 'walk' ? L.p.x : gx, mode === 'walk' ? -L.p.z : gy, dt); D.density = dens;
    // music: distance + focus floor, then the loudest ducks the rest
    let gmax = 0;
    for (const s of sources) {
      let g = 0;
      if (s.kind === 'bed') {
        if (s.zone === 'sky') g = s.gain * sky;
        else g = s.gain * Math.sqrt(w[s.zone] || 0) * (1 - A);
      } else if (s.kind === 'music') {
        const geo = distGain(s.d, s.ref, s.max);
        const floor = mode === 'walk' ? 0 : 0.3 * (w[s.zone] || 0) * (1 - smoothstep(50, 150, h));
        g = s.gain * Math.max(geo, floor) * (1 - 0.6 * A);
        s.geo = geo;
        if (g > gmax) gmax = g;
      } else if (s.kind === 'emitter') {
        g = s.d < s.max ? s.gain * distGain(s.d, s.ref, s.max) : 0;
      } else if (s.kind === 'crowd') {
        const [d0, d1] = s.range; g = s.gain * smoothstep(d0, d1, dens) * (d1 < 0.9 ? 1 - 0.5 * smoothstep(d1, d1 + 0.4, dens) : 1) * (1 - A);
      }
      s.target = g;
    }
    for (const s of sources) if (s.kind === 'music' && gmax > 0) { const rel = s.target / gmax; s.duck = rel; s.target *= 0.4 + 0.6 * rel * rel; }
    if (!st.music) for (const s of sources) if (s.kind === 'music') s.target = 0;
    if (!st.ambience) for (const s of sources) if (s.kind === 'bed' || s.kind === 'crowd' || s.kind === 'emitter') s.target = 0;
    if (solo) for (const s of sources) if (!solo.test(s.id)) s.target = 0;      // tests: debug.solo = /regex/
    // reverb by place
    const rv = reverbFor(w, gx, gy, A); D.rev = rv;
    N.revS.gain.setTargetAtTime(rv[0], now, 0.5); N.revL.gain.setTargetAtTime(rv[1], now, 0.5);
    return { mode, w, A };
  }
  function voices(dt, now) {
    // audibility order; continuous sources only (one-shot emitters are events)
    const cand = [];
    for (const s of sources) { if (s.asset) { reapVoice(s, now); if (s.target > 1e-3 || (s.playing && !s.stopAt && s.target > 3e-4)) cand.push(s); } }
    cand.sort((a, b) => b.target - a.target);
    let n = 0, posRank = 0;
    for (const s of cand) {
      if (n >= MAX) break;
      const a = s.asset;
      if (!a.stream && a.state !== 'ready') { request(a, -s.target); continue; }
      n++;
      s.chosen = true;
      if (s.positional) { s.hrtfWant = L.hrtfOk && (posRank < HRTF_N || (!!(s.ch && s.ch.hrtf) && posRank < HRTF_N + 2)); posRank++; }   // hysteresis: rarely swapped
      if (!s.playing) startVoice(s, now);
    }
    let active = 0;
    for (const s of sources) {
      if (!s.asset) continue;
      if (s.playing && !s.stopAt && !s.chosen) stopVoice(s, now, 0.2);
      if (s.playing && !s.stopAt) { active++; apply(s, dt, now); }
      s.chosen = false;
      s.level += ((s.playing && !s.stopAt ? s.target : 0) - s.level) * Math.min(1, dt * 4);
    }
    D.voices = active;
  }
  function apply(s, dt, now) {
    const ch = s.ch, tau = s.kind === 'bed' || s.kind === 'crowd' ? 0.35 : s.kind === 'music' ? 0.25 : 0.1;
    if (now >= s.swapUntil) ch.gain.gain.setTargetAtTime(s.target, now, now - s.started < 0.05 ? 0.15 : tau);
    if (s.positional) {
      if (now < L.cutUntil) setPannerPos(ch.panner, s.pos.x, s.pos.y, s.pos.z, L.cutUntil - 0.008, 0.001); else setPannerPos(ch.panner, s.pos.x, s.pos.y, s.pos.z, now);
      let cut = airCut(s.d); if (s.kind === 'music' && s.duck !== undefined) cut = Math.min(cut, 1200 + 18000 * s.duck * s.duck);
      ch.filter.frequency.setTargetAtTime(cut, now, 0.15);
      if (s.doppler && s.node && s.node.playbackRate) {     // manual Doppler: f' = f c / (c + v_r), v_r > 0 moving apart
        tmp.subVectors(s.pos, L.p); const d = Math.max(1, tmp.length()); tmp.divideScalar(d);
        const vr = clamp(tmp2.subVectors(s.vel, L.v).dot(tmp), -25, 25);
        s.dop = C / (C + vr); s.node.playbackRate.setTargetAtTime(s.rate * s.dop, now, 0.12);
      }
      if (s.swapAt && now >= s.swapAt) { ch.hrtf = !ch.hrtf; ch.panner.panningModel = ch.hrtf ? 'HRTF' : 'equalpower'; s.swapAt = 0; s.swapUntil = now + 0.03; }   // resume after the kernels settle
      else if (ch.hrtf !== s.hrtfWant && !s.swapAt) {                         // HRTF <-> equal-power: only after a second, with a dip
        if (!s.hrtfSince) s.hrtfSince = time || 1e-6;
        if (time - s.hrtfSince >= (L.hrtfOk ? 1.5 : 0) && now >= s.swapUntil) {
          const g = ch.gain.gain; g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + 0.03); s.swapUntil = 1e9; s.swapAt = now + 0.04;
          s.hrtfSince = 0;
        }
      } else s.hrtfSince = 0;
    } else if (ch.span && s.kind === 'bed' && s.zone !== 'sky') {   // beds lean gently toward their land
      const l = landCentre(s.zone); let pan = 0;
      if (l) { tmp.set(l[0] - L.p.x, 0, -l[1] - L.p.z); const d = tmp.length(); if (d > 1) pan = 0.35 * tmp.divideScalar(d).dot(L.r) * (1 - (D.zone[s.zone] || 0)); }
      ch.span.pan.setTargetAtTime(pan, now, 0.3);
    }
  }
  let centres = null;
  function landCentre(id) {
    if (!centres) { centres = {}; for (const l of getManifest().lands) centres[l.id] = l.center; centres.gate = [250, 0]; centres.lake = [0, 0]; }
    return centres[id];
  }
  function events(dt, now, mode) {
    const fxs = getFx() || {};
    // fireworks: a shell slot whose burst time changed has just been launched (fx/fireworks.js keeps 10 slots)
    const fw = fxs.fireworks;
    if (fw && fw.material && fw.material.uniforms.uShell) {
      const sh = fw.material.uniforms.uShell.value, pads = fw.material.uniforms.uPad.value;
      for (let i = 0; i < sh.length; i++) {
        const tb = sh[i].w; if (tb === shellSeen[i]) continue; const fresh = shellSeen[i] > -1e8 || time < 1; shellSeen[i] = tb;
        if (!fresh || !fw.visible || tb < time) continue;
        const pad = pads[i], burst = sh[i];
        const dl = pad.distanceTo(L.p) / C, db_ = tmp.set(burst.x, burst.y, burst.z).distanceTo(L.p) / C;
        const late = time - (tb - FLIGHT);                     // frames can come late: the launch was this long ago
        if (late < dl + 0.5) play('firework_launch', pad, { delay: dl - late, gain: 0.55 });
        play('firework_burst', tmp.clone(), { delay: (tb - time) + db_, gain: 0.7 });
      }
    }
    // lanterns leave the Spire gallery in waves every 12.5 s (fx/lanterns.js: PERIOD 300 s / 24 waves), each over ~5.6 s
    const lan = fxs.lanterns;
    if (lan && lan.material && lan.material.uniforms.uMotion && lan.material.uniforms.uMotion.value > 0.5 && lan.visible !== false) {
      const k = Math.floor(time / 12.5);
      if (k !== wave) { if (wave >= 0) play('lantern_release', [0, 0, 45.6], { gain: 0.6 }); wave = k; }
    }
    // taps on the lake: fx/water.js queues a splat {x, z, amp, r, cont: false} that its update() consumes this frame
    const wtr = getWater();
    if (wtr && wtr.sim && wtr.sim.events) for (const e of wtr.sim.events) {
      if (e.cont || splashSeen.has(e)) continue; splashSeen.add(e);
      { const k = clamp(Math.abs(e.amp) * 5, 0.2, 0.9); play('splash', tmp.set(e.x, -0.8, e.z).clone(), { gain: k, scale: k / 0.7 }); }
    }
    // footsteps in Walk mode, on the low point of the walk bob (app.js: camera y += sin(walk.bob) * 0.035)
    const wk = getWalk();
    if (mode === 'walk' && wk) {
      const ph = Math.floor((wk.bob - 1.5 * Math.PI) / (2 * Math.PI));
      if (bob !== null && ph > bob && ph - bob < 3) {
        const kind = groundType(wk.x, wk.y, wk.z, D.zone, ground, inLake);
        D.ground = kind; footSide = -footSide;
        const name = 'footstep_' + kind; play(spec.shots[name] ? name : 'footstep_stone', null, { gain: 0.45, pan: 0.12 * footSide });
      }
      bob = ph;
    } else bob = null;
    // one-shot emitters: random repeats (in an area) and the Spire bell on the quarters of the tour
    const tour = getTour();
    for (const s of sources) {
      if (!s.shots) continue;
      const def = s.def;
      if (def.schedule === 'quarter') {
        let due = false;
        if (tour >= 0) { const q = 158 / 4, a = Math.floor(lastTour / q), b = Math.floor(tour / q); due = lastTour >= 0 && (b !== a); }
        else { if (!quarterNext) quarterNext = time + 60; if (time >= quarterNext) { due = true; quarterNext = time + 60; } }
        if (due) shoot(s);
        continue;
      }
      if (!s.nextAt) s.nextAt = time + def.every[0] * Math.random() + 1;
      if (time >= s.nextAt) { s.nextAt = time + def.every[0] + Math.random() * (def.every[1] - def.every[0]); shoot(s); }
    }
    lastTour = tour;
  }
  let footSide = 1;
  function shoot(s) {
    const a = s.shots[Math.floor(Math.random() * s.shots.length)], def = s.def;
    if (solo && !solo.test(s.id)) return;
    if (s.pos.distanceTo(L.p) > (def.max ?? 150) + (def.area ? def.area.r : 0)) return;
    if (a.state !== 'ready') { for (const b of s.shots) request(b, 5); return; }
    const p = s.pos.clone();
    if (def.area) { const r = def.area.r * Math.sqrt(Math.random()), t = Math.random() * Math.PI * 2; p.x += r * Math.cos(t); p.z += r * Math.sin(t); }
    play(a.name, p, { a, force: true, gain: def.gain ?? 0.6, ref: def.ref, max: def.max, rate: def.rate || 1, delay: s.pos.distanceTo(L.p) / C });
  }
  let lakePoly = null;
  function inLake(x, y) {
    if (!lakePoly) lakePoly = getManifest().lake || [];
    let c = false; for (let i = 0, j = lakePoly.length - 1; i < lakePoly.length; j = i++) { const [xi, yi] = lakePoly[i], [xj, yj] = lakePoly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; }
    return c;
  }
  // phones: free decoded buffers nobody has needed for a while (they are reloaded when the listener comes back)
  function releaseMemory() {
    for (const s of sources) {
      const a = s.asset; if (!a || s.playing || a.state !== 'ready' || a.stream) continue;
      if (time - a.used > 45 && s.target < 1e-4 && (!s.positional || s.d > s.max * 1.5)) { st.decoded -= a.buffer.length * a.buffer.numberOfChannels * 4; a.buffer = null; a.state = 'idle'; }
    }
    for (const s of sources) if (s.el && !s.playing && s.el.getAttribute('src') && time - s.asset.used > 45) { s.el.removeAttribute('src'); s.el.load(); }
  }
  // desktop: once what is audible is in, fetch the rest nearest-first in the background
  function background() {
    if (queue.size || inflight) return;
    let best = null, bd = 1e9;
    for (const s of sources) for (const a of s.asset ? [s.asset] : s.shots || []) {
      if (a.state !== 'idle' || a.stream) continue;
      const d = s.positional || s.shots ? s.d : (s.kind === 'bed' ? 1 - (D.zone[s.zone] || 0) : 0.5) * 300;
      if (mobile && (s.positional || s.shots ? d > s.max * 1.3 : d > 250)) continue;
      if (d < bd) { bd = d; best = a; }
    }
    if (best) request(best, 1e6 + bd);
  }

  function update(dt, t) {
    time = t;
    if (!st.ready || !ctx || (ctx.state !== 'running' && !opts.offline)) { if (st.ready && wantTrack) trackOnly(); return; }
    const now = ctx.currentTime;
    listener(dt, now);
    sourcePositions(dt);
    const { mode } = mix(dt, now);
    voices(dt, now);
    events(dt, now, mode);
    pump();
    if ((memTimer -= dt) < 0) {
      memTimer = 2; if (mobile) releaseMemory(); background();
      // late wiring: the guests' crowd state and ground grid, when the app provides getters for them
      if (opts.getCrowd) { const c = opts.getCrowd(); if (c && c.state && !density.live) density.setCrowd(c); }
      if (opts.getGround && !ground) { const g = opts.getGround(); if (g && g.data) ground = g; }
    }
  }
  // while suspended keep the fireworks' slot record current so nothing old is played on resume
  const wantTrack = true;
  function trackOnly() {
    const fw = (getFx() || {}).fireworks;
    if (fw && fw.material && fw.material.uniforms.uShell) { const sh = fw.material.uniforms.uShell.value; for (let i = 0; i < sh.length; i++) shellSeen[i] = sh[i].w; }
    const wtr = getWater(); if (wtr && wtr.sim && wtr.sim.events) for (const e of wtr.sim.events) splashSeen.add(e);
    wave = Math.floor(time / 12.5); bob = null; lastTour = getTour();
  }

  /* ───────── lifecycle ───────── */
  async function loadSpec() {
    const lands = getManifest().lands;
    const base = placeholderSpec(lands);
    if (opts.synth) { st.specFrom = 'synth'; return base; }
    try {
      const res = await fetch(DATA + 'audio/audio.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('audio.json ' + res.status);
      const j = await res.json(); st.specFrom = 'audio.json';
      const out = { ...base, ...j, placeholder: false };
      out.zones = Array.isArray(j.zones) ? j.zones : base.zones;
      out.emitters = Array.isArray(j.emitters) ? j.emitters : base.emitters;
      out.crowd = Array.isArray(j.crowd) ? j.crowd : base.crowd;
      out.oneshots = { ...base.oneshots, ...(j.oneshots || {}) };
      return out;
    } catch (e) { st.specFrom = 'placeholder'; st.err = String(e.message || e); return base; }
  }
  let starting = null;
  async function start() {
    st.loading = true;
    if (!N) build();
    spec = await loadSpec();
    N.mix.gain.value = spec.master && spec.master.gain ? spec.master.gain : 1;
    buildSources();
    st.ready = true; st.loading = false;
    L.first = true; trackOnly();
    for (const list of Object.values(spec.shots)) for (const a of list) request(a, 50);      // small: footsteps, splashes, fireworks
  }
  function rampOut(to, t = 0.12) { if (!N) return; const g = N.out.gain, now = ctx.currentTime; g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(to, now + t); }
  function enable() {
    st.enabled = true;
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    if (navigator.audioSession) try { navigator.audioSession.type = 'playback'; } catch (e) { /* not settable */ }   // iOS: play with the silent switch on
    if (!opts.offline) { const r = ctx.resume && ctx.resume(); if (r && r.catch) r.catch(() => {}); }
    if (!starting) starting = start();
    return starting.then(() => { if (!st.enabled) return; L.first = true; if (!document.hidden) { const go = () => rampOut(st.volume * st.volume, 0.6); ctx.state === 'running' || opts.offline ? go() : ctx.resume().then(go, () => {}); } });
  }
  function disable() {
    st.enabled = false;
    if (!ctx || !N) return;
    rampOut(0, 0.15);
    const c = ctx; setTimeout(() => { if (!st.enabled && c.state === 'running') c.suspend().catch(() => {}); }, 220);
    for (const s of sources) if (s.el && s.playing) { const el = s.el; setTimeout(() => { if (!st.enabled) el.pause(); }, 200); }
  }
  // hidden tab: fade out and suspend; back: resume and fade in. iOS: an 'interrupted' (or re-suspended) context is
  // resumed on the next touch, since Safari only allows that inside a gesture.
  function onVis() {
    if (!ctx || !N || !st.enabled) return;
    if (document.hidden) { rampOut(0, 0.05); setTimeout(() => { if (document.hidden) ctx.suspend().catch(() => {}); }, 80); for (const s of sources) if (s.el && s.playing) s.el.pause(); }
    else { ctx.resume().then(() => { L.first = true; trackOnly(); rampOut(st.volume * st.volume, 0.4); for (const s of sources) if (s.el && s.playing && !s.stopAt) s.el.play().catch(() => {}); }, () => {}); }
  }
  document.addEventListener('visibilitychange', onVis);
  const kick = () => { if (st.enabled && ctx && ctx.state !== 'running' && !document.hidden) ctx.resume().then(() => { trackOnly(); rampOut(st.volume * st.volume, 0.3); }, () => {}); };
  for (const ev of ['touchend', 'pointerup', 'keydown']) addEventListener(ev, kick, { passive: true, capture: true });
  if (ctx) ctx.onstatechange = () => { D.state = ctx.state; };

  function setVolume(v) { st.volume = clamp(v, 0, 1); if (N && st.enabled) { const g = N.out.gain, now = ctx.currentTime; g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.setTargetAtTime(st.volume * st.volume, now, 0.05); } }
  function setMusic(b) { st.music = !!b; if (N) N.music.gain.setTargetAtTime(b ? 1 : 0, ctx.currentTime, 0.15); }
  function setAmbience(b) { st.ambience = !!b; if (N) N.amb.gain.setTargetAtTime(b ? 1 : 0, ctx.currentTime, 0.15); }
  function dispose() {
    document.removeEventListener('visibilitychange', onVis);
    for (const ev of ['touchend', 'pointerup', 'keydown']) removeEventListener(ev, kick, { capture: true });
    for (const s of sources) { if (s.el) { s.el.pause(); s.el.removeAttribute('src'); s.el.load(); } }
    if (ctx && !opts.ctx) ctx.close().catch(() => {});
    sources.length = 0; assets.clear(); st.ready = false; st.enabled = false;
  }

  const api = {
    enable, disable, get enabled() { return st.enabled; }, setVolume, setMusic, setAmbience, update, play, dispose,
    setCrowd(c) { if (density) density.setCrowd(c); else opts.crowd = c; },
    // ground-class grid {w, h, x0, y0, cell, data: Uint8Array} (guests-data's guestground.bin), for footsteps
    setGround(g) { ground = g && g.data ? g : null; },
    debug: {
      st, D, get ctx() { return ctx; }, get nodes() { return N; }, get spec() { return spec; }, sources, assets, listener: L,
      voices: () => sources.filter((s) => s.playing && !s.stopAt).map((s) => ({ id: s.id, kind: s.kind, zone: s.zone, db: +db(s.target).toFixed(1), d: s.positional ? +s.d.toFixed(1) : null, hrtf: s.ch && s.ch.hrtf, dop: s.dop ? +s.dop.toFixed(4) : undefined, x: s.pos.x, z: s.pos.z })),
      latency: () => ctx ? { base: ctx.baseLatency, output: ctx.outputLatency, rate: ctx.sampleRate, state: ctx.state } : null,
      loaded: () => { let n = 0, r = 0; for (const a of assets.values()) { n++; if (a.state === 'ready' || a.stream) r++; } return { assets: n, ready: r, bytes: st.bytes, decodedMB: +(st.decoded / 1048576).toFixed(1) }; },
      // tests: a looped pure tone at a Blender-frame point (clicks show up as broadband energy around it)
      addTone(pos, freq = 441, gain = 0.5) { const s = addSource('emitter', { id: 'test-tone', synth: 'tone:' + freq, pos, gain, ref: 10, max: 2000, loop: true }, 'test'); return s.id; },
      distGain, play: (n, p, o = {}) => play(n, p, { ...o, force: true }), get solo() { return solo; }, set solo(r) { solo = r ? new RegExp(r) : null; },
    },
  };
  return api;
}
