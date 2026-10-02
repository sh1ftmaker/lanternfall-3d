# Lanternfall 3D

A fictional night-time theme park you can fly over, orbit and walk through in the browser.

**Live:** https://sh1ftmaker.github.io/lanternfall-3d/

![The Spire and its lanterns reflected in the lake](screenshots/social.jpg)

Seven lands ring a still, black lake. A needle tower stands on an island in the middle, a monorail loops over
every land, and at eleven ten thousand paper lanterns come down onto the water.

| | |
|---|---|
| ![Tour passing the galleon](screenshots/brinewatch-tour.jpg) | ![The park from above](screenshots/overview.jpg) |

## Controls

| Mode | What it does | Mouse and keyboard | Touch |
|---|---|---|---|
| **Tour** (`1`) | A 2½-minute guided flight over the gate, the Spire, each land and the monorail, on a loop | Drag to take over | Drag to take over |
| **Explore** (`2`) | Free orbit; the place chips fly you to each land | Drag, scroll, right-drag; arrows or WASD, `+`/`-`, Shift+arrows to pan | Drag, pinch, two-finger pan |
| **Walk** (`3`) | First person on the ground; the chips drop you at each land | WASD or arrows, drag to look, Shift to run, Space to hop, `Esc` to leave | Left thumb walks, right thumb looks, Hop button |

Press `H` or the eye button to hide the controls for an unobstructed view; `H`, `Esc` or the faint button in the corner brings them back.

`F` toggles full screen. The settings button (top right) has the picture quality (**Fast**, **HD**, **Cinematic**),
switches for fireworks, lake mist and searchlights, and **Reduce motion** (also taken from the system setting).
Cinematic is the default on computers, HD on phones.
Choices are remembered in the browser. The page also lowers quality by itself if frames run slow.

## What moves

- The lantern fall is a living cycle: lanterns are released from the Spire, rise, hang over the lake, settle on the
  water and burn out.
- The lake has interactive ripples (tap or click the water), rings from the floating lanterns, and a lamp-lit punt
  circling the island.
- The carousel in Rosewick turns, the monorail runs, it snows in Frostmere, there are fireflies and petals in the
  gardens, steam and smoke at the stalls, and fireworks during the tour's Spire shot and finale.

## Guests

About 2,400 guests walk the park in ones, pairs and small groups. They stroll the promenades, queue
at stalls, sit on benches, take photos and line the lake rail to watch the lanterns. The figures are generated in
code (`fx/guests/assets.js`), animated in the vertex shader and lit by where they stand; the crowd simulation
(`fx/guests/sim.js`) runs in a Worker on the walk grid, using benches, stall fronts and viewpoints extracted from
the Blender model (`data/guests.json`, generator in `tools/guests/`). A "Guests" switch is in the settings sheet.

## Platformer

In Walk mode, the lantern-pole button in the top bar (or `P`) swaps the first-person walker for Wick, a lamplighter
you steer in third person: run, triple jump, long jump, backflip, wall kick, ledge grab, ground pound, dive, crawl
and swim across Stillwater. On a keyboard: WASD, Space to jump, Shift to crouch, E to swing the lantern pole, drag to
turn the camera. On a phone: a stick under the left thumb, Jump, Crouch and Swing buttons under the right, drag
elsewhere to turn the camera. Gamepads work too. `P` or `Esc` returns to walking at the same spot.

The movement runs on [libsm64](https://github.com/libsm64/libsm64) compiled to a 122 KB WebAssembly module with every
ROM, model, texture and audio path removed; it needs no ROM. The character, its rig and all of its animations were
made for this project, and collision comes from the park's own geometry. What exactly is in the module, and its
licences, are listed in [`fx/platformer/CREDITS.md`](fx/platformer/CREDITS.md). Nothing of it is downloaded until
the first switch.

## Sound

Press the speaker button (or `M`) for sound; headphones are best. Every land has its own ambience and music, placed
in the world: music comes from the bandstand, the tavern or the dance floor and fades with distance, the monorail
passes overhead, the carousel organ circles with the carousel, and fireworks arrive a moment after the flash.
Nothing audio is downloaded until sound is switched on. All music is synthesised from code (`tools/audio/`);
ambiences mix synthesis with CC0 field recordings credited in `fx/audio/CREDITS.md`. Volume and separate Music and
Ambience switches are in the settings sheet.

## Optional switches

Add these after `#` in the address, separated by commas, then reload.

| Token | Effect |
|---|---|
| `fx=hd` | The Cinematic post chain: ambient occlusion, mip bloom, SMAA (same as the setting) |
| `fx=ultra` | The above plus temporal anti-aliasing, tilt-shift on aerial tour shots and light streaks |
| `fx=legacy` | The HD chain (bloom), whatever the saved setting |
| `nodetail` | Turn off the procedural paving, plank, masonry and roof detail |
| `noshadow` | Turn off moon shadows |
| `aurora` | Aurora in the night sky |
| `no-guests` | Hide the guests |
| `guests=N` | Set the number of guests |
| `no-motes`, `no-fireworks`, `no-beams`, `no-mist`, `no-carousel` | Turn individual effects off |
| `nosim`, `noboat` | No ripple simulation on the lake, no punt |

## How it is built

- The park was modelled procedurally in Blender (Python scripts, headless) and lit in Cycles.
- Lantern, lamp and window light is baked into vertex colours, so the page needs no real-time lights for them.
  Moonlight is the one live light: it is added per pixel with a shadow map rendered once from the moon.
- Surfaces get crisp detail from a small procedural shader (`fx/surface.js`): each vertex carries a surface class
  (paving, wood, masonry, roof, organic) that selects setts, planks, block courses or tile rows.
- Geometry is quantised, delta-filtered and gzip-compressed into `data/*.bin` (about 33 MB in total).
  The browser unpacks it with `DecompressionStream`; there is no build step (the only WebAssembly is the
  optional platformer's movement module).
- Rendering uses [three.js](https://threejs.org/) from a CDN. The viewer is `app.js` plus small modules in `fx/`:
  the lake (planar mirror and ripple simulation), the lantern fall, particles, depth-precision handling, the post
  chain, the settings sheet and WebGL context-loss recovery.
- Walk mode uses a precomputed 0.5 m navigation grid (`data/nav.bin`) instead of mesh collision.
- Needs WebGL 2 (any current desktop or phone browser).

## Run locally

Any static file server works:

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765/.

## Notes

Lanternfall is a fictional park. This repository contains only the 3D park model and the viewer.
