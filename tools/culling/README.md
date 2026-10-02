# Culling: what ships, what was measured and rejected

`fx/cull/index.js` (frustum culling only; `#no-cull` turns it off, `window.__park.cull` has `.set(on)` and `.stats`):

- **Park chunks**: per camera, an exact box-against-frustum test on each chunk's world box (three.js tests only
  the bounding sphere). Applied inside `renderer.render()` for the park scene, so each pass (main view, lake mirror,
  environment cube, moon shadow, weather cover) culls against its own camera, and the chunks are visible again as soon
  as that call returns.
- **Forest**: one instance buffer per species, laid out by polar cell (24 sectors x 2 rings round the lake); per camera
  the visible cells are drawn as up to 3 contiguous runs per species. The trees drawn for any `Q.forest` fraction
  are exactly the ones drawn before, and all runs sort where the unsplit forest did, so pixels do not change.

Nothing is precomputed: no data file to regenerate when the park data changes. Chunk bounds come from the manifest
`bbox` (checked tight against the decoded vertices: 0 m outside, 0 loose).

## Numbers (RTX 4060 laptop, headless Chromium, ANGLE Vulkan, vsync off, HD)

Upper bounds, from `browser/gpu.mjs` and `browser/ideal.mjs` (GPU timer per `renderer.render()` call):

| 1920x1080 | park, main pass | park, mirror | park pixel shading | ideal chunk occlusion | depth pre-pass |
|---|---|---|---|---|---|
| aerial tour shots | 0.6-1.9 ms | 0.3-0.9 ms | 0.25-0.85 ms | 0-0.1 ms (0.6 ms in the gate walk) | +0.4-1.2 ms worse |
| street level (Walk) | 0.5-1.2 ms | 0-0.8 ms | 0.3-0.5 ms | 0.02-0.1 ms (0.4 ms on the gate avenue) | +0.1-0.9 ms worse |

"Ideal chunk occlusion" hides, in the main pass only, every chunk with no pixel in an exact ID-buffer render of that
same frame: no ray-cast, query or PVS can cull more at chunk level. It is under 5 % of the frame in 10 of 12 views.
Opaque chunks are already drawn front to back by three's sort, so overdraw is low and a pre-pass costs more vertex work
than it saves in shading.

three-mesh-bvh 0.9.15 (`bvhbench.mjs`, node, same CPU): BVH of the opaque park, 3.44 M triangles: build 1.7 s
(CENTER) / 7.4 s (SAH), 53-55 MB BVH + 109 MB geometry, 1 GB peak; base detail only (2.27 M): 1.0 / 4.8 s, 35 MB.
Ray casts: 270-500 rays/ms (firstHit, SAH). 20,736 rays through the screen (one per ~100 px) take 40-77 ms per view
and still miss 1-16 chunks that are visible (sliver views past corners, through arches): culling those would show
as missing geometry. Rejected for run-time occlusion (cost, memory on phones, popping), and for an offline PVS (still
sampled, so not provably complete, for at most the gains above).

## Re-running (after the park data changes, e.g. interiors)

```
node browser/measure.mjs http://127.0.0.1:<port>/index.html 1920 1080 1 --variants base,nocull   # ms, CPU, draws, tris
node browser/diff.mjs http://127.0.0.1:<port>/index.html [--mobile] [--q fast|hd|cinematic] [--weather snow] [--ctxloss]
node browser/gpu.mjs ... ; node browser/ideal.mjs ... --variants base,ideal,prepass                 # upper bounds
OUT=poses.json node browser/dumpposes.mjs ... --hash fp,weather=clear,no-cull                       # poses + exact sets
npm i three@0.186.1 three-mesh-bvh@0.9.15 && node bvhbench.mjs ../../data poses.json               # BVH route
```
The browser scripts need `puppeteer-core` (run them from a folder that has it, as the other `tools/*/browser` scripts).
`diff.mjs` freezes `performance.now()`, renders each pose with culling on, off, on, and counts differing pixels.
