# daynight: dusk to night, driven by the clock

`game.clock.t` (minutes since midnight) decides the light. 17:30 is low sun in the west (due west, so from the East Gate
the sun sits behind the Spire), an orange-to-violet sky, no stars, lamps and windows dark. The sun sets about 18:00, stars
and the moon come in, the baked lamp / lantern / window light fades up (global 0 -> 1 by 19:15, sweeping out from the East
Gate: the avenue first, the far lands last) and from 19:30 the picture is exactly the night one (`uDay = 0`; every dusk
term is behind `if (uDay > 0.0)`, so night costs nothing extra and renders bit for bit as before; see the test).

## Files
- `uniforms.js`: the shared uniforms (`createDayUniforms()`, all at night values) and GLSL (`DN_DECL`, `DN_LAMP` the lamp
  sweep from the gate at (288, 0), `DN_SKY` sun disc / glow / sunset belt). Created once in `app.js` (`DN`).
- `index.js`: `at(t)` (pure state), per-frame easing (about 2 s when the clock jumps), writes the uniforms, the sun shadow
  map, dimming of beams / flames / dance floor, the fog hook.

## Run-time props and the shadow map
- `game.props.materials` (a live Set, fx/game/core.js) and the `'prop'` event are read if they exist (both are feature-detected). A lit
  `props.mesh` material gets one shared shader multiplier (lamps + sun and sky light as the park's surfaces get them), a glowing one
  (colour >= 0.9 in a channel) is dimmed with the lamps, a `props.glow` sprite by its opacity. At night every factor is exactly 1.
- The sun's shadow map (a 4096 x 4096 depth target on desktop) is disposed when night comes and rebuilt at the next dusk.

## API
`game.modules.daynight`: `.state` (`{ t, phase, night, el, sun, sunCol, zen, mid, hor, ambSky, ambGnd, ambGlow, fog, stars,
moon, lamps }`), `.at(t)` for tests, `.time` (eased clock), `.snap(t)` (set the clock and show it at once), `.props` (`{ gain, emit, count }`, for tests).
Event `daynight:phase` `{ phase: 'dusk' | 'night' }` on change. Saved state: none. Hash tokens: none (`#no-daynight` is the
core's switch; `#noshadow` also turns off the sun's shadows).

## Where it hooks in (edits outside this folder, all marked `game hook: daynight`)
- `fx/surface.js`: uniforms, lamp factor, sun + sky ambient light on albedo (reusing the moon's detail / bump normal), a
  second shadow map for the sun (`buildSunShadow`; allocated only when the sun is first up, re-rendered when it has moved
  ~1.2 degrees, about five times in the whole dusk).
- `app.js`: sky shader (gradient, glow, stars, moon amount, sun), glass (windows follow the lamps), forest, fog hook
  (`dayFog.pre/post` around `weather.update`: the dusk fog colour is added to whatever the weather wrote), `DN` to the lake.
- `fx/water.js`: sky reflection, sun glitter path, moon amounts, `recaptureEnv()` (the no-mirror tier's cube is re-captured as the light changes).
- `fx/guests/render.js`, `fx/platformer/character.js`: ground light follows the lamps, plus sun (shadow-mapped) and sky light.
- The weather's sky deck is lit by the dusk through `uSkyLift` (added after the deck in the sky shader).

## Test
`PUPPETEER_CORE=<puppeteer-core.js> node tools/game/daynight.test.mjs [url] [outDir]`: five times x four views, night
pixel comparison against `#no-daynight` in 11 views (time frozen, guests / motes / fireworks / emitters off; pixels that
shimmer between two shots of the same build, the lake's mirror, are excluded), rain / storm at dusk and night, the three
picture tiers, context loss, phone layout, rough frame times.
