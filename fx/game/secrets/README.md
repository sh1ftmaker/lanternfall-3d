# secrets: mysteries and Easter eggs

Hidden things that reward curiosity. None is announced. Each is written in the journal's **Curiosities** section once found (one short, slightly
cryptic line; unfound ones show as a dash, and after three finds a faint hint appears under them). Frame everywhere: Blender (x east, y north, z up);
"land-local" is the Blender scripts' frame (+y outward, -y toward the lake, x to the right looking outward):
`world = centre + lx * (sin phi, -cos phi) + ly * (cos phi, sin phi)` (`lib.world(landId, lx, ly)`).

Files: `index.js` (found / journal / paper-white fade), `lib.js` (land-local to world, `goTo`), `figure.js` (flat-shaded low-poly figure and part builder),
one file per secret (`doors`, `redcoat`, `lakebed`, `bell`, `nap`, `keep`, `snow`, `garden`). Each exports `init(S)`; a broken one cannot stop the others.

## What is where

| # | Secret | Where | How it is found |
|---|---|---|---|
| 1 | The Paper Doors | Wanderers' Hall, door VI (land-local (-1.33, 22.6), z 0.95; world about (187.4, 68.1)) | Use the door. It opens onto: clear, the Spire island's north terrace (0, 7.9, z 0.6, away from the stamp post and the jetty), or in first person the lake steps at the East Gate end (99.5, 0) facing the Spire; mist, the Shrine of Wishes (Lantern Row local (0, 26.6), a step back from the offering box); rain, the Launch Deck (Meridian local (14, 4.5), z 35); storm, the Guildhollow courtyard (local (0, 22.6)); snow, Frostmere's Crystal Court (local (36, 5)). A fade to paper-white and back (instant with Reduce motion), then a faint glowing paper frame (return door) stands 2.6 m from where you arrive for a minute and takes you back: ahead, or to a side or behind when the walk grid says the way ahead is blocked or drops. In first person the deck is not on the walk grid, so the walker lands on the nearest grid spot (under it). |
| 2 | The figure in the keep | Guildhollow keep, top storey, middle window (local (0, 29.86), z 17.62; world about (-215.9, 0)) | Only in a storm (fades with `weather.now.storm`). A dark silhouette against a faint glow that rises with each flash (`weather.shade.lightning`: `t`, `amp`; its own pulses if that is missing; no flash with Reduce motion). Be within 55 m and look at it for 2 s: in first person within about 17 degrees of the view; as Wick (whose camera cannot tilt that far up) the window held on screen near the middle across and below the top edge, which works from about 30-50 m with the view tilted up. |
| 3 | The footprints | Rosewick, from the fountain axis (local (-2.5, -55.5)) west to the pond rim (local (-12.9, -61.7)); the music box at its end, about (-61.4, -75.2) | Only while it snows: 20 or so small dark prints fade in, then the half-buried music box and its glow. "Open the music box" finds it. Absent in other weather. |
| 4 | The guest in the red coat | One vantage per land (land-local: wanderers (3,-14), meridian (0,-12), frostmere (0,-3), guildhollow (0,2), rosewick (2,3), lantern-row (-4,14), brinewatch (-3,0), snapped to the walk grid), then the lake rail at the Spire viewpoint (85.5, 31.1) | A red-coated figure (about 1.7 m, flat-shaded) fades in when you look toward it from 16 to 95 m and fades out when you come within 12 m or look away for about 3 s; it is back once you have been 130 m away. Seen 1.4 s in a land counts that land. After all seven it stands once more at the rail facing the Spire, goes when you come within 7 m and leaves a red button on the rail ("Pick up the red button"). Works in first person. |
| 5 | The rooftop garden | The flat roof of the Neon Arcade in Meridian, centre (80.6, 118.2), z 6.1 | Wick only: the roof is not on the walk grid. Route proved in the test: run at the arcade's east wall (plane through (90.5, 115.6), normal (0.94, -0.33)) from 28 m away, along `(-0.94, +0.33)`, and triple-jump (three jumps in a row, each pressed as Wick lands): he lands on the roof at z 6.1. (No wall-kick route exists: walls near it are single faces; a wall kick reaches 5.4-5.8 m and throws Wick away from the roof.) The triple jump is tight by hand (review: first jump 18-22 m from the wall, within about 4 degrees, second landing pressed within 2 ticks). An easier way up, found in review: stand 0.5-1.2 m from the east wall facing away from it, backflip (crouch + jump) and hold toward the wall: he lands on the 5.5 m ledge there, one jump below the roof. Planters, a bench, a lantern with a glow and a cat. Standing on the roof finds it. |
| 6 | The lake bed | Sunken carousel horse at (-37.8, -35.7), bed z -4.8, about 20 m out from the Rosewick shore | Faint glow on the bed; a faint shimmer on the surface above is the only clue. Wick dives within 3.4 m of it. |
| 7 | The bell, 23 times | Guildhollow strength bell, foot at about (-130.2, 8.6) | Counts `use` events for `strength-bell` (the bounty module registers it). Ten seconds after load, if none has been used and the bounty module is absent, it registers `secrets-bell` ("Ring the bell") there; a real `strength-bell` use switches ours off. The 23rd ring in one visit: a deep bell (`spire_bell` at half speed, if sound is on) and a column of light up the Spire for about 6 s. |
| 8 | The long nap | A bench on the west side of the lake promenade, near (-100.4, -8.2), facing the Spire | Wick asleep (`action` = `sleeping`, about 70 s alone) within 3.2 m of it for 5 s: fade to dark blue, he wakes on the Spire's lowest gallery (-4.3, 0, z 24.4) facing west, with a toast. |

## Events and saved state

- Emits `secrets:found` `{ id, count, total }` (ids: `doors`, `redcoat`, `lakebed`, `bell`, `nap`, `keep`, `snow`, `garden`) and `secrets:coat` `{ id, seen }` when a land counts for the red coat.
- Listens to: `use`, `action`, `weather`, `frame`.
- Saved under the key `secrets`: `{ found: { id: 1 }, coat: { seen: [landId], button: null | 'left' | 'taken' } }`.
- Interactable ids: `secrets-door`, `secrets-door-back`, `secrets-bell`, `secrets-button`, `secrets-musicbox`.
- Hash tokens: none (`#no-secrets` skips the module, as for every module).
- `game.modules.secrets`: `{ found(id), isFound(id), state(), lib, fade, S }`; `S.api.<file>` holds each secret's test handles.

## Cost

Per frame: a few comparisons and one camera direction per secret that is awake; nothing else. Figures, the garden, the horse and the footprints are
built once (about 1,000 triangles each at most) and only drawn while visible. The bell's column is an open cylinder with a small shader, drawn for 6 s.

## Testing

`tools/game/secrets.test.mjs` (needs puppeteer-core next to it, or `node --preserve-symlinks --preserve-symlinks-main` from a folder that has it):
`node secrets.test.mjs http://127.0.0.1:8905/index.html`; `ONLY=desktop|mobile|fp` runs one pass, `SHOTS=dir` sets where screenshots go.
It finds each secret by script (Wick on desktop; the short set at 390x844 touch; first person where only Wick can reach things must stay unfound), checks
that `secrets:found` fires, that the journal shows the lines, and that finds survive a reload. The nap test waits about 80 s for Wick to fall asleep.
