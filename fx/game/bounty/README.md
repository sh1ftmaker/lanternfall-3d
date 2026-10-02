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

| Thing | x | y | z | walk grid |
|---|---|---|---|---|
| Bounty Board (use point, in front of the board; board at brinewatch local (2, 9)) | 170.9 | -63 | 0.13 | 0.13 |
| Reward counter hut (use point) | 165.4 | -70.8 | 0.13 | 0.13 |
| Strength bell platform, Guild Fair Midway | -131 | 8.9 | 0.5 | 0.42 |
| Strength bell tower foot (glow climbs from here) | -131 | 10.1 | 0.1 | off grid |
| Lost & Found counter (front, lakeward), the kiosk in the Wanderers' Hall grounds at wanderers local (33, -8) | 167.3 | 24.5 | 0.11 | 0.11 |
| Returned-things shelf plank (we add it above the back shelves; first slot, z = plank height) | 171.8 | 29.3 | 3.1 | off grid |
| Signing Tables letter tray | 165.3 | 87 | 0.2 | 0.2 |
| Brine & Barrel bar (cider) | 138.2 | -29 | 0.7 | 0.7 |
| Ferry master's log, tavern deck table | 133.2 | -22 | 0.7 | 0.7 |
| Cruise dock (jetty) | 76.3 | -41.6 | 0.12 | 0.12 |
| Frostmere gatekeeper, Snowbound Gate | -107.2 | 99.3 | 0.12 | 0.12 |
| Shrine of Wishes candle | 48.5 | -157 | 1.95 | 1.95 |
| Pip's balloon (hangs 2.6 m above the ground) | 50.1 | -141.8 | 0.11 | 0.11 |
| Pip, foot of the Pavilion of Wings | -123.7 | -124.2 | 0.45 | 0.45 |
| The busker's bow, Blossom Lane | -154 | -101.8 | 0.11 | 0.11 |
| The busker, Moonlit Promenade | -113.8 | -124.6 | 0.06 | 0.06 |

Stamp posts (grid: off grid means a roof or the island, Wick only):

| Land | x | y | z | walk grid |
|---|---|---|---|---|
| brinewatch: boat on the Boatwright's slipway (Wick) | 109.5 | -67.7 | 3.02 | off grid |
| wanderers: Hall east nave | 185.9 | 38 | 0.2 | 0.2 |
| meridian: monorail platform, upper level (grid layer at z 10) | 46.8 | 118.2 | 10 | 0.12 |
| frostmere: Frost Fair stall roof (Wick) | -149 | 101.3 | 2.98 | off grid |
| guildhollow: Midway stall roof (Wick) | -120 | -5 | 3.27 | off grid |
| rosewick: Rose Maze east exit | -113.9 | -146.5 | 0.11 | 0.11 |
| lantern-row: ghost-story stage | 24.8 | -177.2 | 2.06 | 2.06 |
| spire: Spire island (swim, Wick) | 8.5 | 0 | 0.6 | off grid |

Lost things:

| Thing | x | y | z | walk grid |
|---|---|---|---|---|
| mitten | -101.1 | 69.1 | 0.06 | 0.06 |
| crown | -93.8 | -152.4 | 0.12 | 0.12 |
| sword | -214 | 3 | 0.12 | 0.12 |
| ticket | 35.5 | 114.9 | 0.12 | 0.12 |
| cap | 107.1 | -32.8 | 0.13 | 0.13 |
| tag | 39.1 | -153.6 | 0.09 | 0.09 |
| net | -133.2 | -113.9 | 0.45 | 0.45 |
| postcard | 284 | 6 | 0.12 | 0.12 |


Notes: the Lost & Found in the park's Blender source is a kiosk in the Wanderers' Hall *grounds* (wanderers local (33, -8), lakeward of the Hall), not inside it; the desk and shelf are placed there. Roof posts only show their prompt when you are at the post's height (so a swing from the ground does not count). The Spire post cannot be reached in first person.

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
