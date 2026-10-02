# lamps

Light the park. 56 dark lamps (8 in each land, run-time props: one InstancedMesh for posts, one for heads, one for light pools, 12 pooled glow sprites, one Points for sparks, one InstancedMesh of small lanterns) plus the extra lamp in the Brine & Barrel tavern (Brinewatch reads "x / 9").

- Light a lamp: Wick's pole swing, tap the prompt, or `E` in first person. Flare, glow, pool of light, sparks (sound: existing `lantern_release`).
- Tracker line "<Land> lamps n / 8" in Walk; journal sections "Lamps" (counts and a compass hint to the nearest dark lamp in the land), "The lamplighter before you", "Wish lanterns".
- Land complete: toast, 40 lanterns rise from the land centre. All lit: finale of 110 lanterns over the lake.
- The lamplighter before Wick: five posts carry initials (`story.js` TRAIL: frostmere:2, guildhollow:2, rosewick:7, lantern-row:3, brinewatch:2). "Look closer" on a lit one shows the line. The tavern lamp at (140.6, -24.4) reveals an old pole at (141.2, -16.4) and a note card.
- Wish lantern: "Write a wish" at the lake rail (guests.json view POIs with `rail:1`, land core). Max 80 chars, Enter or Release sends, Escape cancels, local only. Last 12 hang 2.6-5.6 m over the lake (radius 32-84 m), brighter than the rest.

Positions: `positions.js` (Blender frame, x y z). "// up" ones stand on a plinth, platform or the monorail platform (Meridian, z 10). Chosen from guests.json POIs offset to the side, then filtered by raycast (level, nothing overhead, 1.4 m free air) and eyeballed.

Events: `lamps:lit {id,land,count,total}`, `lamps:land {land}`, `lamps:all {}`, `lamps:read {n}`, `lamps:pole {}`, `lamps:wish {text,t}`.
Saved state (key `lamps`): `lit` [ids "land:k"], `read` [1-5], `done` [land ids], `all`, `pole`, `wishes` [{t,text}] (newest first, max 12).
Hash tokens: none (`#no-lamps` from the core).
Test hooks: `game.modules.lamps.lightAllBut(land, id)`, `.lightAll(exceptId)`, `.light(lamp)`, `.byId`, `.railPoints()`.
Test: `node tools/game/lamps.test.mjs [url]` (puppeteer-core beside it; SHOTS=dir).
