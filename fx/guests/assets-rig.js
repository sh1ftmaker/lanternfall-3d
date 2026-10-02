// GLSL shared by every guest draw (bodies at two levels of detail, impostors, glow halos, contact shadows):
// fetch a guest's state and look from float textures, evaluate its procedural pose (walk, idle, photo, wave/point,
// sit, lean, blended over a few hundred ms when the animation changes), and give bone transforms in character space.
// Character space: x = the figure's left, y = up, z = forward, metres for a 1.72 m reference adult.
//
// State texture (fx/guests/render.js), 4 texels per guest:
//   s0 (x, y, z, yaw)                Blender frame, as the crowd state
//   s1 (speed, anim, phase, seed)    speed smoothed by the renderer; phase as given (walk: cycles of 1.4 m)
//   s2 (prevAnim, prevPhase, t0, prevZoff)    blend source; t0 = time of the change; z offset of the old pose
//   s3 (prevSpeed, 0, 0, 0)
// Look texture, 8 texels per guest: see packLook() in render.js.
export const RIG = /* glsl */`
  precision highp int; precision highp sampler2D;
  uniform highp sampler2D tState, tLook;
  uniform float uTime, uMotion, uBlend;
  const float PI = 3.14159265, TAU = 6.2831853;
  vec4 gS(int gi, int k){ int i = gi * 4 + k; return texelFetch(tState, ivec2(i & 1023, i >> 10), 0); }
  vec4 gL(int gi, int k){ int i = gi * 8 + k; return texelFetch(tLook, ivec2(i & 1023, i >> 10), 0); }
  struct G { float h, girth, shape, belly, lf, hs, stoop, swing, bounce, seed, bglow, child; int mask, hair, top, lower, item, arms; };
  G look(int gi, float seed){
    vec4 a = gL(gi, 0), b = gL(gi, 1), c = gL(gi, 2), d = gL(gi, 3);
    G g; g.h = a.x; g.girth = a.y; g.shape = a.z; g.belly = a.w; g.lf = b.x; g.hs = b.y; g.stoop = b.z; g.mask = int(b.w + 0.5);
    g.hair = int(c.x + 0.5); g.top = int(c.y + 0.5); g.lower = int(c.z + 0.5); g.item = int(c.w + 0.5);
    g.arms = int(d.x + 0.5); g.swing = d.y; g.bounce = d.z; g.bglow = fract(d.w); g.child = floor(d.w); g.seed = seed;
    return g;
  }
  vec3 unpackCol(float v){ int c = int(v + 0.5); vec3 s = vec3(float((c >> 16) & 255), float((c >> 8) & 255), float(c & 255)) / 255.0; return s * s * (0.7 + 0.3 * s); }  // ~sRGB -> linear

  // ── pose: 8 vec4 channels, blended linearly ──
  // a: rootX, rootZ, rootPitch, rootYaw          b: rootRoll, chestPitch, chestYaw, chestRoll
  // c: headPitch, headYaw, headRoll, sitW         d: L shoulder flex, abduction, twist, elbow   e: same, right
  // f: L hip flex, abduction, knee, ankle extra   g: same, right
  // h: pelvis y extra, phone tilt, hang sway, balloon sway
  struct Pose { vec4 a; vec4 b; vec4 c; vec4 d; vec4 e; vec4 f; vec4 g; vec4 h; };
  Pose mixP(Pose p, Pose q, float t){ return Pose(mix(p.a, q.a, t), mix(p.b, q.b, t), mix(p.c, q.c, t), mix(p.d, q.d, t), mix(p.e, q.e, t), mix(p.f, q.f, t), mix(p.g, q.g, t), mix(p.h, q.h, t)); }
  float nz(float x){ return (sin(x) + 0.5 * sin(2.31 * x + 1.7) + 0.25 * sin(4.13 * x + 4.1)) / 1.75; }   // smooth wander -1..1

  Pose poseStand(float t, G g){
    Pose P;
    float s = g.seed * 37.0;
    float w = 0.75 * sin(t * 0.8 + s) + 0.25 * sin(t * 0.33 + s * 1.7);               // weight shift between the feet
    P.a = vec4(0.026 * w, 0.0, 0.0, 0.05 * nz(t * 0.21 + s));
    P.b = vec4(-0.03 * w, 0.03 + g.stoop + 0.012 * sin(t * 1.6 + s), 0.06 * nz(t * 0.23 + s + 3.0), 0.0);
    P.c = vec4(0.03 + 0.07 * nz(t * 0.17 + s + 5.0), 0.42 * nz(t * 0.13 + s * 2.3), 0.03 * nz(t * 0.29 + s), 0.0);
    float abd = 0.08 + 0.13 * max(g.girth - 1.0, 0.0);
    vec4 arm = vec4(0.04 + 0.02 * sin(t * 0.5 + s), abd, 0.0, 0.18);
    if (g.arms == 1) arm = vec4(-0.1, abd + 0.1, 0.25, 0.6);                              // hands in pockets
    else if (g.arms == 2) arm = vec4(-0.36, abd, 0.0, 0.75);                              // hands behind the back
    P.d = arm; P.e = arm;
    P.f = vec4(0.03 + 0.06 * max(-w, 0.0), 0.05, 0.03 + 0.2 * max(-w, 0.0), 0.0);
    P.g = vec4(0.03 + 0.06 * max(w, 0.0), 0.05, 0.03 + 0.2 * max(w, 0.0), 0.0);
    P.h = vec4(0.0, 0.0, 0.0, 0.0);
    return P;
  }
  Pose poseWalk(float ph, float spd, G g){
    Pose P;
    float t = ph * TAU, amp = smoothstep(0.03, 0.45, spd);
    float A = 0.42 * amp, sn = sin(t), cs = cos(t);
    P.a = vec4(-0.022 * amp * cs, 0.0, 0.02 * amp, -0.08 * amp * sn);
    P.b = vec4(-0.035 * amp * cs, 0.05 * amp + g.stoop + 0.015 * amp * cos(2.0 * t), 0.13 * amp * sn, 0.0);
    P.c = vec4(0.03, -0.05 * amp * sn, 0.0, 0.0);
    float aa = 0.38 * amp * g.swing, abd = 0.08 + 0.13 * max(g.girth - 1.0, 0.0);
    float fl = -aa * sn + 0.03, fr = aa * sn + 0.03;
    P.d = vec4(fl, abd, 0.0, 0.2 + 0.55 * max(fl, 0.0));
    P.e = vec4(fr, abd, 0.0, 0.2 + 0.55 * max(fr, 0.0));
    float kl = 0.05 + amp * (0.95 * pow(max(cos(t - 0.3), 0.0), 2.0) + 0.13 * max(sin(2.0 * t - PI), 0.0));
    float kr = 0.05 + amp * (0.95 * pow(max(cos(t + PI - 0.3), 0.0), 2.0) + 0.13 * max(sin(2.0 * t + PI), 0.0));
    P.f = vec4(A * sn + 0.04, 0.035, kl, -0.2 * amp * sn);
    P.g = vec4(-A * sn + 0.04, 0.035, kr, 0.2 * amp * sn);
    P.h = vec4(0.012 * g.bounce * amp * cos(2.0 * t), 0.0, 0.0, 0.0);
    if (g.item == 5) { P.c.x += 0.28; P.e = vec4(0.45, -0.18, 0.0, 1.25); P.h.y = 1.0; }   // walking with a phone, reading it
    return P;
  }
  Pose posePhoto(float t, G g){
    Pose P = poseStand(t * 0.6, g);
    float s = g.seed * 37.0;
    P.b.y = -0.04 + g.stoop * 0.5; P.b.z = 0.12 * sin(t * 0.35 + s);
    P.c.x = 0.1; P.c.y = 0.0;
    P.e = vec4(1.3, -0.32, 0.0, 1.05);
    if (g.item == 0 || g.item == 5) P.d = vec4(1.18, -0.42, 0.0, 1.2);
    P.h.y = 0.12;
    return P;
  }
  Pose poseWave(float t, G g){
    Pose P = poseStand(t * 0.6, g);
    float s = g.seed * 37.0;
    bool point = fract(g.seed * 7.31) < 0.5;
    float env = smoothstep(-0.2, 0.4, sin(t * 1.3 + s));
    P.b.y = -0.08 + g.stoop * 0.5;
    if (point) { P.e = vec4(2.72, 0.22, 0.0, 0.06); P.c.x = -0.55; P.c.y = 0.1 * nz(t * 0.3 + s); }
    else { P.e = vec4(2.45, 0.42 + 0.28 * sin(t * 9.0) * env, 0.0, 0.5 + 0.2 * env); P.c.x = -0.3; }
    return P;
  }
  Pose poseSit(float t, G g){
    Pose P;
    float s = g.seed * 37.0;
    bool fwd = fract(g.seed * 5.17) < 0.3;                                               // elbows on the knees
    P.a = vec4(0.0, -0.04, fwd ? 0.05 : -0.12, 0.0);
    P.b = vec4(0.0, (fwd ? 0.35 : 0.1) + g.stoop + 0.01 * sin(t * 1.5 + s), 0.08 * nz(t * 0.2 + s), 0.0);
    P.c = vec4(fwd ? -0.2 : 0.06 + 0.06 * nz(t * 0.2 + s), 0.45 * nz(t * 0.12 + s * 2.0), 0.0, 1.0);
    float fl = fwd ? 1.25 : 0.65, el = fwd ? 1.1 : 0.7;
    P.d = vec4(fl, 0.12, 0.0, el); P.e = vec4(fl, 0.12, 0.0, el);
    float hip = 1.42 + P.a.z, kn = 1.5 - 0.25 * g.child + 0.22 * g.child * sin(t * 2.2 + s);
    float kn2 = 1.5 - 0.25 * g.child + 0.22 * g.child * sin(t * 2.2 + s + 2.0);
    float ab = g.lower >= 2 ? 0.03 : 0.11;
    P.f = vec4(hip, ab, kn, 0.0); P.g = vec4(hip, ab, kn2, 0.0);
    P.h = vec4(0.0);
    return P;
  }
  Pose poseLean(float t, G g){
    Pose P;
    float s = g.seed * 37.0;
    P.a = vec4(0.0, -0.08, 0.22, 0.0);
    P.b = vec4(0.0, 0.32 + 0.01 * sin(t * 1.4 + s), 0.06 * nz(t * 0.2 + s), 0.0);
    P.c = vec4(-0.42 + 0.05 * nz(t * 0.15 + s), 0.35 * nz(t * 0.1 + s * 3.0), 0.0, 0.0);
    P.d = vec4(0.85, 0.14, 0.0, 1.25); P.e = vec4(0.85, 0.14, 0.0, 1.25);
    P.f = vec4(0.22, 0.05, 0.03, 0.0); P.g = vec4(0.3, -0.1, 0.32, 0.0);
    P.h = vec4(0.0);
    return P;
  }
  // item held in the left hand: the arm keeps a holding pose (blends with whatever the anim wants)
  void holdItem(inout Pose P, G g, int anim){
    if (anim == 4 && g.item != 4) return;
    vec4 hold = vec4(0.0);
    if (g.item == 1) hold = vec4(0.25, 0.12, 0.0, 1.35);                // lantern on a stick, held out in front
    else if (g.item == 2) hold = vec4(0.12, 0.14, 0.0, 0.25);           // hand lantern, arm low
    else if (g.item == 3) hold = vec4(0.22, 0.1, 0.0, 0.55);            // balloon string
    else if (g.item == 4) hold = vec4(0.25, 0.08, 0.0, 1.45);           // cup
    else return;
    P.d = mix(P.d, hold, anim == 0 ? 0.85 : 1.0);
  }
  Pose poseFor(int anim, float ph, float spd, G g){
    float t = uTime * uMotion + g.seed * 100.0;
    Pose P;
    if (anim == 0) P = poseWalk(ph / max(g.h, 0.3), spd * uMotion, g);
    else if (anim == 2) P = posePhoto(t, g);
    else if (anim == 3) P = poseWave(t, g);
    else if (anim == 4) P = poseSit(t, g);
    else if (anim == 5) P = poseLean(t, g);
    else P = poseStand(t, g);
    holdItem(P, g, anim);
    P.h.z = uMotion * (0.12 * sin(uTime * 1.9 + g.seed * 50.0) + 0.06 * sin(uTime * 3.1 + g.seed * 20.0));   // hanging lantern sway
    P.h.w = uMotion * 0.1 * sin(uTime * 0.9 + g.seed * 30.0);
    return P;
  }
  // the guest's blended pose; *zoff returns nothing: the old pose's height offset is folded into h.x
  Pose guestPose(int gi, vec4 s1, vec4 s2, vec4 s3, G g, out float blendT){
    int anim = int(s1.y + 0.5);
    Pose P = poseFor(anim, s1.z, s1.x, g);
    float bt = clamp((uTime - s2.z) / uBlend, 0.0, 1.0); bt = bt * bt * (3.0 - 2.0 * bt);
    blendT = bt;
    if (bt < 1.0) {
      Pose Q = poseFor(int(s2.x + 0.5), s2.y, s3.x, g);
      Q.h.x += s2.w / max(g.h, 0.3);
      P = mixP(Q, P, bt);
    }
    return P;
  }

  // ── bones ──
  mat3 rX(float a){ float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }
  mat3 rY(float a){ float c = cos(a), s = sin(a); return mat3(c, 0, -s, 0, 1, 0, s, 0, c); }
  mat3 rZ(float a){ float c = cos(a), s = sin(a); return mat3(c, s, 0, -s, c, 0, 0, 0, 1); }
  mat4 TR(vec3 t, mat3 r){ return mat4(vec4(r[0], 0.0), vec4(r[1], 0.0), vec4(r[2], 0.0), vec4(t, 1.0)); }
  // pelvis height: feet planted (standing anims) or on the seat (sit)
  float pelvisY(Pose P, G g){
    float Lt = 0.415 * g.lf, Ls = 0.41 * g.lf, rp = P.a.z, rr = P.b.x;
    float aL = P.f.x - rp, aR = P.g.x - rp;
    float dL = (Lt * cos(aL) + Ls * cos(aL - P.f.z)) * cos(P.f.y), dR = (Lt * cos(aR) + Ls * cos(aR - P.g.z)) * cos(P.g.y);
    float hipW = 0.092 * (1.0 + 0.5 * (g.girth - 1.0));
    float yL = -0.05 * cos(rp) + hipW * sin(rr) - dL, yR = -0.05 * cos(rp) - hipW * sin(rr) - dR;
    float stand = 0.075 - min(yL, yR);
    return mix(stand, 0.13, P.c.w) + P.h.x;
  }
  mat4 Mpelvis(Pose P, G g){ return TR(vec3(P.a.x, pelvisY(P, g), P.a.y), rY(P.a.w) * rX(P.a.z) * rZ(P.b.x)); }
  mat4 Mchest(Pose P, G g){ return Mpelvis(P, g) * TR(vec3(0.0, 0.03, 0.0), rY(P.b.z) * rX(P.b.y) * rZ(P.b.w)); }
  mat4 Marm(Pose P, G g, float side, int lvl){
    vec4 q = side > 0.0 ? P.d : P.e;
    float shW = (1.0 + 0.55 * (g.girth - 1.0)) * (1.0 - 0.07 * g.shape);
    mat4 M = Mchest(P, g) * TR(vec3(side * 0.185 * shW, 0.415, -0.01), rX(-q.x) * rZ(side * q.y) * rY(side * q.z));
    if (lvl > 1) M = M * TR(vec3(side * 0.02, -0.28, -0.01), rX(-q.w));
    return M;
  }
  mat4 Mleg(Pose P, G g, float side, int lvl){
    vec4 q = side > 0.0 ? P.f : P.g;
    float hipW = (1.0 + 0.5 * (g.girth - 1.0)) * (1.0 + 0.06 * g.shape);
    mat4 M = Mpelvis(P, g) * TR(vec3(side * 0.092 * hipW, -0.05, 0.0), rX(-q.x) * rZ(side * q.y));
    if (lvl > 1) M = M * TR(vec3(side * 0.003, -0.415 * g.lf, 0.01), rX(q.z));
    if (lvl > 2) { float shin = q.x - P.a.z - q.z; M = M * TR(vec3(side * 0.002, -0.41 * g.lf, -0.015), rX(shin + q.w)); }
    return M;
  }
  // pseudo-bones: things that hang or float keep upright (in character space)
  vec3 hangAnchor(G g){ return g.item == 1 ? vec3(0.012, -0.767, 0.646) : vec3(0.013, -0.345, 0.025); }
  mat4 boneM(int b, Pose P, G g){
    if (b == 0) return Mpelvis(P, g);
    if (b == 1) return Mchest(P, g);
    if (b == 2) return Mchest(P, g) * TR(vec3(0.0, 0.49, -0.01), rY(P.c.y) * rX(P.c.x) * rZ(P.c.z));
    if (b == 3) return Marm(P, g, 1.0, 1);
    if (b == 4) return Marm(P, g, 1.0, 2);
    if (b == 5) return Marm(P, g, -1.0, 1);
    if (b == 6) return Marm(P, g, -1.0, 2);
    if (b == 7) return Mleg(P, g, 1.0, 1);
    if (b == 8) return Mleg(P, g, 1.0, 2);
    if (b == 9) return Mleg(P, g, -1.0, 1);
    if (b == 10) return Mleg(P, g, -1.0, 2);
    if (b == 11) return Mleg(P, g, 1.0, 3);
    if (b == 12) return Mleg(P, g, -1.0, 3);
    if (b == 13) { vec3 hnd = (Marm(P, g, 1.0, 2) * vec4(0.012, -0.325, 0.02, 1.0)).xyz;
      return TR(hnd + vec3(0.06 + P.h.w * 0.5, 0.95, -0.04), rZ(P.h.w) * rX(0.5 * P.h.w)); }
    if (b == 14) { vec3 anc = (Marm(P, g, 1.0, 2) * vec4(hangAnchor(g), 1.0)).xyz;
      return TR(anc, rZ(P.h.z) * rX(0.6 * P.h.z)); }
    // 15: phone at the right hand, upright, screen towards the face
    vec3 hnd = (Marm(P, g, -1.0, 2) * vec4(-0.012, -0.30, 0.03, 1.0)).xyz;
    return TR(hnd, rY(P.a.w + P.b.z + P.c.y * 0.5) * rX(P.h.y));
  }
  // morphed bone-local vertex position
  vec3 morph(vec3 p, vec3 off, vec4 w, int bone, G g){
    float k = 1.0 + w.y * (g.girth - 1.0) + w.z * g.shape;
    vec3 q = p + off * k;
    if (w.w > 0.0) q.z += w.w * g.belly * 0.055 * g.girth;
    else if (w.w < 0.0) q.z += -w.w * max(g.shape, 0.0) * 0.032 * (1.0 - g.child);
    if (bone >= 7 && bone <= 10) q.y *= g.lf;
    if (bone == 2) q *= g.hs;
    return q;
  }
  vec3 pivRef(int b){
    if (b == 0) return vec3(0.0, 0.95, 0.0);
    if (b == 7) return vec3(0.092, 0.90, 0.0);
    if (b == 9) return vec3(-0.092, 0.90, 0.0);
    return vec3(0.0);
  }
  // character space -> world (three.js) for a guest at Blender (x, y, z) with heading yaw
  vec3 toWorld(vec3 cp, vec4 s0, float h){
    float c = cos(s0.w), s = sin(s0.w);
    return vec3(s0.x, s0.z, -s0.y) + (vec3(-s, 0.0, -c) * cp.x + vec3(0.0, cp.y, 0.0) + vec3(c, 0.0, -s) * cp.z) * h;
  }
`;

// ground light (RGBM grid in the Blender frame) and the moon's shadow map, as fx/surface.js
export const LIGHT = /* glsl */`
  uniform sampler2D tLight; uniform vec4 uLightXf; uniform float uLightRange, uLightOn; uniform vec3 uLightFallback;
  vec3 groundLight(vec2 bxy){
    if (uLightOn < 0.5) return uLightFallback;
    vec4 t = texture2D(tLight, (bxy - uLightXf.xy) * uLightXf.zw);
    return t.rgb * t.a * uLightRange;
  }
  uniform sampler2D tShadow; uniform mat4 uShadowM; uniform float uShadowOn, uSSize, uMoonOn;
  #include <packing>
  float shTap(vec2 uv, float z){ return step(z, unpackRGBAToDepth(texture2D(tShadow, uv))); }
  float moonShadow(vec3 p){
    if (uShadowOn < 0.5) return 1.0;
    vec4 sc = uShadowM * vec4(p + vec3(0.0, 0.25, 0.0), 1.0); vec3 q = sc.xyz * 0.5 + 0.5;
    if (any(lessThan(q.xy, vec2(0.002))) || any(greaterThan(q.xy, vec2(0.998))) || q.z > 0.999) return 1.0;
    float z = q.z - 0.0006;
    vec2 t = q.xy * uSSize - 0.5, f = fract(t), b = (floor(t) + 0.5) / uSSize, o = vec2(1.0 / uSSize, 0.0);
    return mix(mix(shTap(b, z), shTap(b + o.xy, z), f.x), mix(shTap(b + o.yx, z), shTap(b + o.xx, z), f.x), f.y);
  }
`;
