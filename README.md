# Lanternfall 3D

A fictional night-time theme park you can fly over, orbit and walk through in the browser.

**Live:** https://sh1ftmaker.github.io/lanternfall-3d/

![The park from above](screenshots/overview.jpg)

Seven lands ring a still, black lake. A needle tower stands on an island in the middle, a monorail loops over
every land, and at eleven ten thousand paper lanterns come down onto the water.

| | |
|---|---|
| ![Tour passing the galleon](screenshots/brinewatch-tour.jpg) | ![Walking the lake shore](screenshots/walk-lakeside.jpg) |

## Controls

| Mode | What it does | Desktop | Touch |
|---|---|---|---|
| **Tour** | A looping guided flight over the gate, the Spire, each land and the monorail | Drag to take over | Drag to take over |
| **Explore** | Free orbit, with chips to fly to any land | Drag, scroll, right-drag | Drag, pinch, two-finger pan |
| **Walk** | First person on the ground, with collisions | WASD or arrows, drag to look, Shift to run | Left thumb walks, right thumb looks |

The **HD** button toggles water reflections and glow. The page also lowers quality by itself if frames run slow.

## How it is built

- The park was modelled procedurally in Blender (Python scripts, headless) and lit in Cycles.
- Lighting, colour and emission are baked into vertex colours, so the page needs no real-time lights.
- Geometry is quantised, delta-filtered and gzip-compressed into `data/*.bin` (about 34 MB in total).
  The browser unpacks it with `DecompressionStream`; there is no WebAssembly and no build step.
- Rendering uses [three.js](https://threejs.org/) from a CDN: a baked-colour shader, the `Water` reflective surface
  from the three.js examples, a procedural night sky, point-sprite lanterns, bloom and a light colour grade.
- Walk mode uses a precomputed 0.5 m navigation grid (`data/nav.bin`) instead of mesh collision.

## Run locally

Any static file server works:

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765/.

## Notes

Lanternfall is a fictional park. This repository contains only the 3D park model and the viewer.
