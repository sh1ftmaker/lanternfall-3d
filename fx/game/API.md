# The game layer: contract for modules (`fx/game/<name>/index.js`)

`fx/game/core.js` is shared and owned by the orchestrator: **do not edit it** (ask for what is missing in your final
report, and work around it in your own module meanwhile). A module is one folder, `fx/game/<name>/`, whose `index.js`
exports `init(game)`. It is imported once the whole park has loaded (`game.start()` in `app.js`), unless the address
has `#no-<name>` or `#no-game`. Whatever `init` returns is kept as `game.modules.<name>` (your public API for tests and
for other modules; other modules may be missing, so guard: `game.modules.clock?.something`).

**Frame:** everything is in the Blender frame the walk code uses: `x` east, `y` north, `z` up, metres. three.js world
is `(x, z, -y)`; `game.v3(x, y, z)` converts. The lake is centred on (0, 0); the East Gate plaza is near (288, 0).

## What `game` gives you

| | |
|---|---|
| `game.THREE, scene, camera, renderer, Q, uTime, mobile, coarse, hash` | the viewer's objects; `hash` is the Set of `#` tokens |
| `game.ctx` | everything app.js passed: `setMode, gotoPlace, nearestPlace, sound, weather, surface, FOG, MOON, DATA, fetchBin, getPark(), getTrains(), getWater(), getFx(), isClean(), setClean()` |
| `game.manifest, places, nav, guests, platformer, weather, reduceMotion` | live getters |
| `game.save.get(key, default)`, `.set(key, value)`, `.update(key, fn, default)`, `.flush()`, `.size` | persisted JSON (localStorage `lanternfall.game.v1`, written 0.4 s after the last `set` and when the page is hidden). **Use one key: your module name**, and keep it small (tens of KB; the whole origin has about 5 MB). Only keys this tab changed are written, merged into what is stored, so a second tab does not undo another module's progress (the same key in two tabs: the last write wins). A key that does not fit keeps its last stored value and the new one lasts this visit only; an unreadable blob is kept aside as `lanternfall.game.v1.bad`. `.size` is the stored length in characters. Treat what you read back as untrusted: old or partial shapes must not throw. |
| `game.on(type, fn)` → unsubscribe, `game.emit(type, data)` | events, below |
| `game.player` | `{ x, y, z (feet), yaw, mode: 'tour'|'orbit'|'walk', wick: bool, action: string, speed, land, three: Vector3 }`, refreshed every frame. Outside Walk it is the camera. `land` is the caption's place, checked twice a second in Walk: `'spire'` anywhere within 112 m of the lake centre (the whole ring promenade and the lake), else the land whose direction from the lake is nearest (within about 20 degrees: a land id), `'gate'` on the avenue east of x = 150, else `null`; always `null` outside Walk. It is coarse: test positions yourself for exact areas. |
| `game.interact({ id, x, y, z, r = 2.2, label, use(it), show?(), swing = true })` → `{ remove(), move(x, y, z), enabled }` | something the visitor can use. The nearest usable one within `r` shows a prompt button with `label` (string or function); it is used by tapping the prompt, by `E` / `Enter` in first person, or by Wick swinging the lantern pole within `r + 0.9` (unless `swing: false`; a swing uses the nearest thing that takes a swing). `show()` returning false hides it. `label` is plain text (never markup). No prompt shows, and swings use nothing, while a module holds the camera. Calling `remove()` from inside your own `use` is fine. `game.interactables` lists them all (for tests). |
| `game.toast(html, { ms, tone: 'good' })` | a short message at the top (three at most at once: a fourth pushes out the oldest). `html` is markup you wrote; anything the visitor typed or that was read back from storage must go through `game.esc(text)` first, or pass `{ text }` (plain text) or a DOM `Node` instead of a string. The same holds for `game.track`. |
| `game.track(id, text | null, { order })` | a line in the tracker pill (at most three show, lowest `order` first; `null` removes). In Tour the pill shows only while it has a line. |
| `game.journal.section({ id, title, order, render(el) })`, `.refresh()`, `.open()`, `.close()`, `.isOpen` | your section in the journal sheet (`B`, or tap the tracker). `render` fills `el` each time it opens or `refresh()` runs. The sheet is `box-sizing: border-box` and fits a 390 px screen: no workaround needed. |
| `game.ground(x, y, zRef?)` | walk-grid height there, or `null` off the grid |
| `game.lightAt(x, y)` | baked light `[r, g, b]` (linear) at the ground there, or `null` |
| `game.props.glow({ x, y, z, color: [r, g, b], size })` → `{ sprite, set({...}), remove() }` | a soft additive light (colour above 1 blooms) |
| `game.props.mesh(geometry, { x, y, z, yaw, color, emissive, lit, scale })` → `THREE.Mesh` (`.userData.remove()`) | a small prop; geometry in three.js axes (y up). Lit once from the baked light at its spot. |
| `game.clock` | `{ t (minutes since midnight), running, rate (park minutes per real second), set(t), fmt(), at('21:15', fn) }`. Stands at 23:00 unless the `clock` module runs it. `at` fires when the running clock passes that time (however large `rate` is, and across midnight) or when `set()` lands within the minute after it; the `clock` module's 23:40 → 17:30 loop is a `set`, so `at('17:30')` fires on it and nothing between is replayed. |
| `game.sound(name, pos?)` | a one-shot through the sound engine (ignored while sound is off) |
| `game.teleport(x, y, yaw, { z }?)` → height or `null`, `game.setMode(mode, opts)` | move the visitor into Walk at (x, y). Without `z`: the nearest walk-grid spot, on its lowest level, never on the Spire island. With `z`: exactly there on the walk-grid level nearest `z` if one is within 1.5 m (a station platform, an upper deck, the island); otherwise Wick is placed at (x, y, z) as given (a roof, a ledge, the lake bed: Wick's collision decides), and the first-person walker, which lives on the grid, gets the nearest grid spot. Works for both players, from any mode. |
| `game.esc(text)` | text escaped for use inside the markup you pass to `toast`, `track` or your own `innerHTML` |
| `game.takeCamera(fn, { name })` → `release()` | borrow the camera: `fn(dt)` runs every frame and must place `game.camera` itself; the mode's own update (tour, orbit, the walker, Wick) is paused until you call `release()`. One holder at a time. `game.cameraHeld` says who has it. |

## Events (`game.on`)

| type | data | when |
|---|---|---|
| `start` | `{}` | all modules are in |
| `frame` | `{ dt, time }` | every rendered frame, after the player has moved (not before `start`, nor with `#no-game`) |
| `mode` | `{ mode, wick }` | Tour / Explore / Walk, or lamplighter ↔ first person |
| `land` | `{ id, prev }` | the place the caption shows changed (Walk only; a place id such as `meridian`, `spire`, `gate`, or `null`). For exact areas test positions yourself. |
| `action` | `{ name, prev }` | Wick's movement action changed. Names are in `fx/platformer/actions.js`: `idle`, `punching`, `ground pound land`, `wall kick air`, `triple jump`, `long jump`, `sleeping`, `ledge grab`, `dive`, ... |
| `swing` | `{ x, y, z }` | Wick swung the lantern pole |
| `pound` | `{ x, y, z }` | Wick landed a ground pound |
| `use` | `{ id }` | an interactable was used |
| `weather` | `{ state, prev }` | `clear`, `mist`, `rain`, `storm`, `snow` |
| `clock` | `{ t, prev, jump }` | the clock moved (every frame while it runs) |
| `journal` | `{ open }` | the journal opened or closed |
| `camera` | `{ held, by, why }` | a module took or released the camera (hide your prompts while it is held). If another module takes it while you hold it, you get `{ held: false, by: <you>, why: 'replaced' }`: clean up. |

A listener that throws is reported once (`game: <type>` in the console) and the others still run; one that throws 30 times within ten seconds is switched off. An `init` that throws leaves that module out and the rest load.

Modules may emit their own events, prefixed with the module name (`lamps:lit`, `clock:event`, ...); list them in your
module's README section (below) so others can listen.

## Rules for modules

- Runtime only. The park's geometry and light are baked; do not touch `data/*.bin`, the export pipeline or Blender.
  Add what you need as run-time props (`game.props`, or your own meshes / instanced meshes / shaders in the scene).
- Stay in your folder. Edits elsewhere (`app.js`, `index.html`, other `fx/` files) only where your task names them,
  small, and marked `// game hook: <name>`. Never edit another module's folder or `core.js`.
- Must work for both players: Wick (third person, the default) and first person (`#fp`), with keyboard and with
  touch (390 px wide). Tour and Explore must be unaffected unless your task is about them.
- Cheap: your per-frame work must be well under 0.2 ms; no per-frame allocations in hot paths; build things lazily.
  Respect Reduce motion (`game.reduceMotion`) and the clean view (`body.clean` hides the interface).
- Words on screen: short, plain, in the park's voice. No emoji. Follow the look of the existing interface (CSS
  variables `--paper`, `--amber`, `--glass`, `--line`, `--ui`).
- Positions you place things at must be checked against the walk grid (`game.ground`) and looked at in a screenshot.
- Text fields: keys typed into an `<input>` / `<textarea>` never reach the page's key handlers (walking, Wick, shortcuts),
  so a form just works. Close it on `Enter` / `Escape` yourself (listen on the field).
