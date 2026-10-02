# Platformer: how to test it, and what was measured

The Platformer needs no game data: everything below runs from this repository.

## 1. Try it (two minutes)

1. Open the park, wait for it to load, choose **Walk** (or press `3`).
2. Enter Walk mode (the lamplighter is its default player; **P** or the lantern-pole button in the top bar switches to first person and back, `#fp` starts in first person). The first time, the
   status pill says "Waking the lamplighter…" and "Mapping the park for the lamplighter… N %" (about half a second
   of preparation, a few milliseconds per frame). Wick appears where the walker stood, seen from behind.
3. Controls:
   - Keyboard: **WASD / arrows** move (relative to the camera), **Space** jump, **Shift** or **C** (or Z) crouch,
     **E** or **F** swing the lantern pole (dive when running), **Q** turns the view, mouse **drag** orbits, wheel zooms,
     **P** to first person at the same spot, **Esc** to Explore. `1` `2` `3` still switch modes.
   - Gamepad: left stick moves, right stick orbits, **A** jump, **X / B** swing, triggers or bumpers crouch.
   - Touch: drag on the left of the screen for a stick, **Jump / Crouch / Swing** buttons on the right, drag
     anywhere else to orbit; the lantern-pole button in the top bar goes back to Walk.
4. Things to try: run and jump three times in a row (triple jump), crouch + jump (backflip), run then crouch + jump
   (long jump), run, reverse and jump (side flip), jump at a wall and press jump again as you touch it (wall kick),
   jump at a wall a little taller than you and hold toward it (ledge grab; push forward to climb, jump to climb fast),
   jump then crouch (ground pound), run and swing (dive, then belly slide), crouch and walk (crawl), run off the lake
   promenade into Stillwater and swim (jump = stroke; stick up/down pitches; push forward + jump at a quay to climb out),
   swim west to the Spire island, skate on Frostmere's rink (ice), stand still for a minute (Wick sits down for a nap;
   on Frostmere's snow, warms the hands at the lantern instead).

Add `#pfdebug` to the URL for the overlay: the library's action (name and number), animation slot and frame,
position (three.js and Blender frame), speed, floor / ceiling / water heights, floor normal, the collision window's
surface counts (floors, walls, turned-over floors, ice, lake bed, perimeter) and gather time, window reloads with their
library load times, respawns, tick cost in the worker and per-frame cost on the main thread. Please include a copy of
it when reporting a problem.

## 2. Automated checks (all run here; numbers below are from this machine)

| Check | Command | What it shows |
|---|---|---|
| Build + audit | `tools/platformer/build-wasm.sh <wasi-sdk-34 dir>` | reproducible build from libsm64 `fd11813` + patch; `audit-wasm.mjs` passes (imports WASI only, exports `park_*`, 26 KB data, no model / texture / audio / ROM symbols, no game title or character name in the binary) |
| Movement in Node | `node tools/platformer/sim-lab.mjs` | the real library on a synthetic level (`testworld.mjs`): every move below on known geometry |
| Collision export | `node tools/platformer/validate-collision.mjs --shots` (needs puppeteer-core) | per window: triangle counts by kind, coordinate range, facing, gather and library load time, and agreement of the library's floor with the walk grid at 600 random walkable cells |
| Park moves | `tools/platformer/browser/moves.mjs` (see the header of that file) | the real library in the park, scripted inputs, action traces (table below) |
| Functional / console | `tools/platformer/browser/pfunc.mjs` | desktop and 390x844 touch: lazy loading, button / P / Esc, keys and touch stick + buttons, orbit, Fast / HD / Cinematic, Reduce motion, WebGL context loss, leaving to Explore / Tour; console errors |
| Cost | `tools/platformer/browser/pfperf.mjs W H DSF` | GPU (character on vs off) and main-thread cost while running through reloads |

### Moves measured in the park (real library, real park collision, 30 Hz ticks; heights are the feet above the start)

| Move | Where | Result | Timing (ticks of 1/30 s) and clip |
|---|---|---|---|
| idle | gate plaza | three idle beats (look, look back, trim the lantern), nap after ~69 s (Node: sleep at tick 2066) | idleLook 66, idleLookBack 66, idleTrim 72 frames |
| walk | gate plaza | 2.2 m/s at 45 % stick | walk clip 40 frames per 1.6 m (phase-locked to distance) |
| run | gate avenue | 9.7 m/s top speed | run clip 2.24 m per cycle |
| turn-around skid | gate avenue | reversing at speed: turning 7 + finishing 6 ticks | turnPlant 8, turnPush 10 |
| stop / skid | gate (stone) vs Frostmere rink (ice) | braking 6 ticks on stone, 59 ticks on ice | skid (loop) then skidStop 12 |
| single jump | gate plaza | 2.15 m standing (0.54 m tap), 3.06 m running | 21 ticks in the air; land 4 + 5 ticks (land 8 frames) |
| double / triple jump | gate avenue | triple jump peak 6.0 m, 59 m from start of the run-up to landing | jump 25, double 24, triple 35 ticks; jumpThree 36 frames |
| long jump | gate avenue | 15.3 m/s, 2.1 m high, ~15 m long | 31 ticks; longJumpLand 14 |
| backflip | gate plaza | 4.85 m high, 3.4 m backwards | 32 ticks; backflip 30 frames |
| side flip | gate avenue | 4.85 m high | 31 ticks; sideFlip 24 frames |
| wall kick | a real park wall at three.js (218.9, 24.8) | jump, air-hit-wall, kick: 4.7 m; Node: three chained kicks to 8.8 m | wallTouch 10, wallKick 20 |
| ground pound | gate plaza | jump 2.9 m, wind-up 14 ticks (clip length 10 + 4), landing 17 ticks then stand | poundStart 10, poundLand 16 |
| dive and slide | gate avenue | dive 11 ticks, belly slide 29, get up 23 | dive 20, bellySlide (loop), bellyGetUp 22 |
| swings (B) | gate plaza | jab, swing, sweep in 32 ticks | jab 6, swingBack 8, sweep 16 |
| crouch and crawl | gate plaza | crawl 0.9 m/s | crouchDown 8, crawl 40 frames per 0.75 m |
| slide kick | gate avenue | 10.7 m/s slide | slideKick 20, slideKickUp 14 |
| ledge grab + climb | a real 3.0 m gate pier at (261.0, 23.5) | grab 17 ticks after the jump, hang, climb (slow) 30 ticks, stand on top | ledgeHang (loop), ledgeClimbSlow 30, ledgeClimbFast 16 |
| swimming | lake promenade (103, 0) to the Spire island | 86 m across Stillwater in ~20 s of strokes; out onto the island with a water jump | stroke 18, strokeGlide 20, tread 48 |
| stairs | real stairs at (-122.0, -176.6) | rise 1.07 m in 6 m, walked up (1.76 m reached) | walk |
| slope | real ramp at (247.7, 54.5); Node: 30 degree ramp | climbed; Node: up 3 m | walk / run |
| fall 14 m | above the gate plaza | ordinary landing (the library's damage threshold is 11.5 m; Wick takes no damage) | fall, landSoft |
| fall 32 m | above the gate plaza | hard knockback onto the back, 73 ticks, gets up | fallBackHard 72 |
| park boundary | east end of the gate plaza | stopped at x = 347.5 | - |
| whole lake promenade | 535 m lap at a run | 39 collision reloads, 0 respawns, frame p50 16.7 / p99 18.6 / max 38.7 ms (60 Hz vsync), 2 frames over 25 ms in 58 s | - |

### What could not come from the original data, and what the park does instead

- **Animation timing**: the original lengths are not used. Each slot's length is this project's choice, at least two
  frames past every frame the action code tests (`tools/platformer/anim-frames.txt` lists every test). Durations
  that depend on it: landings, getting up, ledge climbs, turning round, crouch/crawl transitions, the ground-pound
  wind-up (length + 4 ticks), swim strokes. Walking, running, tiptoeing and crawling advance in proportion to speed,
  so their lengths set the stride, matched to Wick's legs.
- **Root motion**: none of the park's reachable actions moves the body from animation data (only doors, poles and
  cutscenes do), so every slot has zero root translation. Where the body must be offset from the library's position
  (hanging below a ledge, climbing up, lying down), the clips do it visually.
- **Sounds**: the library's sound requests are dropped (the audio engine is not built). `park_stubs.c` funnels them
  through one `play_sound` stub, so they could be handed to the park's own sound engine later as event numbers.
- **Health**: there are no enemies; damage, drowning and death sequences are kept out by topping health up every
  tick. Knockbacks still happen (bonking into walls, very long falls).

## 3. Not verified

- Real touch hardware (only Chromium's 390x844 touch emulation), real gamepads (the Gamepad API code path is not
  exercised headless), Safari / Firefox, low-end phones' frame times.
- The monorail is not solid for the Platformer (the trains are not in its collision).
- Brinewatch's tavern basin has no water for the Platformer (only Stillwater does).
- Collision is the park's base-detail triangles with small walls (< 0.16 m^2: posts, rails, trim) left out, so
  Wick passes through thin railings and lamp posts; some raised spots on the walk grid have no matching floor
  (0-2 % of samples per window in `validate-collision.mjs`).

`tools/platformer/browser/smooth.mjs` measures per-frame smoothness (displayed character and camera speed, frames where the
character did not move). The display samples the 30 Hz states 1.5 ticks behind the tick being posted (`DELAY` in `index.js`).
