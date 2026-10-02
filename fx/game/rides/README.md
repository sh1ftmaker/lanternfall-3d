# rides

Three things to ride. Module `fx/game/rides/` (`index.js` wires them, `session.js` is the shared camera loan).

## What the visitor can do

- **The monorail.** On the south platform of the Meridian Loop station the prompt "Board the monorail" appears. The camera
  moves to the platform edge and watches the next train come in ("The next train is N seconds away" in the tracker), then
  joins the front seat of its lead car (behind the glass nose, eye 1.85 m above the car's origin, 12.9 m above the ground)
  and rides one full lap of the loop (about 104 s). The tracker names the land being passed. "Get off at the next stop"
  (bottom centre, also `Esc`) ends it at the station at once with a short camera blend. The trains never stop in
  `app.js` (`updateTrains`: steady 8.5 m/s), so the camera joins and leaves a moving train; the timetable is untouched.
- **The harbor cruise.** A run-time launch (low-poly hull, striped canopy, lantern at the bow) waits at a jetty on the
  Brinewatch shore. "Take the harbor cruise" seats the visitor under the canopy; the boat backs off, crosses Stillwater to the
  Spire, circles the island once (radius 27 m rising to 31 m) and comes home (about 420 m, 2 min 45 s). It bobs
  gently (not with Reduce motion) and pushes the lake's ripple simulation aside with the same wake sources as the lantern
  punt (`fxWater.sim.events`). "Return to the jetty" ends it early. When nobody is aboard the boat rocks at the jetty.
- **The carousel.** Twelve seated riders (eight adults, four children) on the Pavilion of Wings' horses, one InstancedMesh,
  matrices rebuilt each frame from the carousel's own clock and parameters (`CAROUSEL`, `CAROUSEL_MOTION`, `horseAngleDeg`
  exported from `fx/animate.js`), so they turn and rise and fall with the horses. "Ride the carousel" seats the camera on
  an empty horse for one minute.

While riding: drag (mouse or one finger) looks round within limits; Wick is hidden and restored; the walker is put back
where the ride began (`game.teleport`, then the height of the platform or jetty is restored); switching to Tour or
Explore ends the ride cleanly; another module taking the camera ends it too.

## Where things are (Blender frame)

| What | Where |
|---|---|
| Monorail boarding point | (37.26, 110.95), z = 10 (south platform, middle, at the station's centre; the station is the point of the loop nearest Meridian's centre) |
| Harbor cruise jetty | land end about (56.7, -44.3), runs out over the water towards the lake centre on bearing -38 degrees; boat moored on its left side |
| Carousel prompt | (-128.0, -118.9) at the pavilion's edge, facing Rosewick's centre (radius 5.2) |
| Carousel riders | outer ring radius 8.15 (horses 1, 3, 5 ... 15), inner ring radius 6.25 (4 of the 12), saddle height 2.62 |

## Events

- `rides:board` `{ ride: 'monorail' | 'cruise' | 'carousel' }` when the ride proper starts (the monorail only once the train arrives).
- `rides:leave` `{ ride, why }`, `why`: `button`, `done` (natural end), `mode`, `taken`.

## Saved state

Key `rides`: `{ monorail: n, cruise: n, carousel: n }`, times ridden. Journal section "Rides" shows where to board and the counts.

## Hash tokens

None. `#no-rides` skips the module (core).

## Edits outside this folder

`fx/animate.js`: exports `CAROUSEL`, adds `CAROUSEL_MOTION` and `horseAngleDeg`, and the shader string uses them (same numbers as before).
Marked `// game hook: rides`.

## Testing

`node tools/game/rides.test.mjs http://127.0.0.1:PORT/index.html` (puppeteer-core, system Chromium). It rides the monorail
and the cruise (early leave and one natural end), checks camera height and travel, drag look, the walker coming back and
Wick moving again, mode switches during a ride, and takes carousel screenshots. Desktop and 390x844 touch. Takes several minutes.
Test hooks: `game.modules.rides.monorail` (`board`, `distTo`), `.cruise` (`board`, `boat`, `length`, `run`), `.carousel` (`mesh`, `horse(i, t, motion)`).
