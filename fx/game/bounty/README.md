# fx/game/bounty

The Bounty Board at Brinewatch Wharf, the strength bell, the stamp passport, the reward hut (colours for Wick's lantern)
and the Lost & Found. Everything is a run-time prop (`art.js` builds low-poly models in code, no assets); the baked park
is untouched. Hash token to skip it: `#no-bounty`.

## What the visitor can do

- **Bounty Board** (Brinewatch): three jobs a night, drawn from a pool of eight by the calendar date (`drawJobs(day)` is
  seeded by the local date string, so everyone gets the same three). Take a job at the board card; a tracker line follows
  you; the thing to find / the person to reach is a prop with a `game.interact`; completing a job toasts, stamps the
  board ("Done" in the card and the journal) and emits `bounty:job`.
  Jobs: `balloon` (fetch Pip's red balloon from a lamp post in Lantern Row, give it to Pip at the Pavilion of Wings),
  `letter` (to the Signing Tables tray in the Wanderers' Hall), `bell` (ring the strength bell), `boats` (count the boats
  we float off the wharf: 3 to 6, by date; answer on the board card), `bow` (find the busker's bow in Blossom Lane, give it
  to her on the Moonlit Promenade), `drink` (hot cider from the Brine & Barrel bar to the Frostmere gatekeeper within three
  minutes; the timer shows in the tracker, a cold cider is lost and can be fetched again), `candle` (light a candle at the
  Shrine of Wishes, it stays lit that day), `log` (the ferry master's log from the tavern deck to the cruise dock).
- **Strength bell** (Guildhollow, Guild Fair Midway): `game.interact({ id: 'strength-bell' })`. Using it always rings it: a
  glow climbs the tower and a bell (synthesised in the page with WebAudio, only if the visitor's sound is on) sounds. It
  can be used any number of times; each use also emits the core's `use` event with `id: 'strength-bell'` and
  `bounty:ring { count }`.
- **Stamp passport**: eight posts, one per land plus the Spire island. Using one stamps the passport (a ring flourish, a
  toast, the flag lights up). The journal has a "Passport" section with eight drawn stamps (SVG in each land's colour) and
  a one-line clue for each empty one.
- **Reward hut** (Brinewatch): colours for Wick's lantern, earned: Marsh green (three jobs done, or a full passport),
  Wanderer violet (full passport), Rosewick rose (all eight lost things back), Frost blue (six jobs in all). Claim them
  at the hut card; choose among earned ones with the swatches in the journal ("Bounty Board" section). The colour is
  applied to `__park.platformer.character.uniforms.uLanternCol` whenever that exists (polled twice a second, re-applied
  after the platformer is created). In first person there is no lantern: a gentle toast says so and the reward is kept.
- **Lost & Found**: eight lost things with a glint, in eight places. Pick one up (it shows in the tracker), carry it to the
  desk in the Wanderers' Hall grounds and hand it in: it appears on a shelf plank we add above the back shelves, and the
  journal's "Lost & Found" section gets its line.

## Where things are (world metres, Blender frame; local = the land's frame, +y outward, -y lakeward)

Land-local to world: `world = centre + x * (sin phi, -cos phi) + y * (cos phi, sin phi)` (`data.js: world()`).
Every position below is checked with `game.ground()` by `tools/game/bounty.test.mjs` and by screenshots; roofs and the
Spire island are off the walk grid on purpose (Wick only).

POSITIONS_TABLE

## Events emitted

- `bounty:job { id, state }`, state is `active` (taken), `done`, `dropped` (given back) or `failed` (the cider went cold)
- `bounty:stamp { land, count }`
- `bounty:found { id, count }` (a lost thing handed in)
- `bounty:ring { count }`, `bounty:reward { id }` (a lantern colour claimed)

## Saved state (key `bounty`)

`day`, `ids` (today's three jobs), `jobs` (`{ id: { s: 'active'|'done' } }`), `jobsDone` (in all), `stamps`
(`{ land: time }`), `rings`, `carry` (item ids; lost things are `lost:<id>`), `lost` (`{ id: time }` handed in),
`colors` (earned), `color` (chosen), `claimed`, `hinted`, `notified`, `drinkT0` (when the cider was taken), `candle` (day lit).
A new calendar day redraws the jobs and drops the day's carried job items; stamps, lost things, colours persist.

## Public API (`game.modules.bounty`)

`state()`, `jobsToday()`, `accept(id)`, `complete(id)`, `stamp(land)`, `claim(id)`, `chooseColor(id)`, `ringBell()`,
`boatCount()`, `positions()`, `stampPosts()`, `lostPos()`, `lanternColour()`, and `test.setJobs(ids)`, `test.newDay(key)`,
`test.reset()` for tests.

## How to test

Serve the repo, then `node tools/game/bounty.test.mjs http://127.0.0.1:8904/index.html [screenshot-dir]` (needs
`puppeteer-core`; desktop and 390x844 touch). It walks to the board, takes and finishes three jobs, rings the bell five
times, stamps posts (a roof post by the pole swing with `__park.platformer.test.input`, others in first person with `E`),
returns a lost thing, reloads to check persistence and claims a lantern colour.
