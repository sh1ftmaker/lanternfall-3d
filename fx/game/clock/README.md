# clock: the evening as a clock

`game.clock.t` runs 17:30 -> 23:40 and loops to 17:30. The page opens at 23:00 in Tour, which holds the clock in the fall
(today's look). Explore and Walk let it run. `#no-clock` turns the module off (the park then stands at 23:00, as before).

## What it does
- **Clock** (`index.js`): sets `clock.rate` each frame (`rateAt`: 0.5 / 0.45 / 0.2 / 0.4 park min per second, 0.121 in the fall, so the
  evening is about 20 real minutes and the fall 5.5). Wraps at 23:40 with `clock.set(17:30)` (`jump: true`, as documented). Tour entry
  jumps to 23:10 unless already inside 23:04-23:40 (or exactly at the opening 23:00) and freezes; leaving Tour resumes. The
  clock also stops while a module holds the camera and while "Hold the time" is on.
- **Tracker line** `clock` (order 90): "21:04 · Ghost stories at 21:15". Hidden in Tour.
- **Journal "Tonight"** (order 5): the programme (tap a row to jump), the current row marked, the "Hold the time" switch, the storyteller's
  state and the keepsakes.
- **Programme events**, each once per evening, a toast each (queued 2.2 s apart; none in Tour): `gates` 17:30, `frostfair` 19:00,
  `stories` 21:15, `fall` 23:00, `hush` 23:00-23:04, `close` 23:40. Emitted as `clock:event { id, t }`. Going back in time (a jump
  to an earlier time, or the wrap) re-arms the later ones.
- **Lantern fall** (`fx/lanterns.js`, `setFall(state, now)`): `classic` (everything always there: the opening look, and a jump into
  23:04-23:40), `none` (only ~0.3 % strays, 17:30-23:00), `fall` (released from the Spire gallery over 70 s from 23:00; a lantern that
  is not hanging at that moment waits for its next rise), `thin` (after 23:40 the sky empties over ~50 s, then `none`). The lake's reflected
  lanterns and the planar mirror share the uniforms. The closing fireworks (`fireworks.userData.finale`) run 23:34-23:40.
- **Crowd** (`crowd.js` -> `fx/guests/sim.js` `params.bias`, sent to the Worker with `crowd.setParams`): land weights and point weights on
  goal choice only (nobody turns round mid-walk): Frostmere 19:00-21:15, Lantern Row + the stage 21:15-22:00, then the lake rail x1.2 / x1.7 / x2.4.
  `params.hush`: during the silent four minutes walkers inside the lake ring (r < 122 m) stop and turn to the Spire.
- **Silent four minutes** (`hush.js`): ducks the engine's music and ambience buses (`engine.debug.nodes.music/amb`, only once the
  sound button has started the engine) to 3 % / 8 %, and shows one great lantern at (42, -24, z 2.8) low over the water that is drawn only
  when the rendering camera is the water's mirror camera (`onBeforeRender`), so only the lake shows it. It needs a planar mirror (tier 1
  and 2; absent where the water has none). Depth test is off for it because the mirror's depth hid it.
- **Storyteller** (`story.js`): 21:15-22:00 a hooded figure with a staff lantern and a circle of light on the ghost-story stage in Lantern
  Row (33.6, -181, z 3.19). `E` / prompt / Wick's swing: tells the next unheard story on a small card (three pages). Each story names a
  spot where a glowing keepsake then waits (picked up with a `game.interact`): the pagoda terrace (68.9, -178.6), the great torii
  (35.6, -127.8), the Night Market square (3.4, -186.2).

## Events I emit
`clock:event { id, t }`, `clock:story { id }` (a story was heard for the first time), `clock:keepsake { id }`.
Public API: `game.modules.clock = { EVENTS, rateAt, hold, hush, story, say, announced, lanterns() }`.

## Saved state (`game.save` key `clock`)
`{ hold: bool, heard: [story ids], found: [story ids] }`.

## Edits outside this folder (all marked `game hook: clock`)
`fx/lanterns.js` (gate / launch / thin uniforms and `userData.setFall`), `fx/fireworks.js` (`finale` flag), `fx/guests/sim.js`
(`params.bias`, `params.hush`).

## Test
Serve the repo, then `PP=<path to puppeteer-core.js> node tools/game/clock.test.mjs http://127.0.0.1:8901/index.html <outDir>`
(desktop and 390x844 touch: events, toasts, journal taps, hold, Tour hold, story and keepsake, crowd bias, sky screenshots at
22:00 / 23:01 / 23:20, and a `#no-clock` comparison at 23:20).
